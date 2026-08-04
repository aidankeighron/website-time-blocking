/**
 * Custom Playwright fixtures that load the unpacked extension into Chrome and Firefox.
 *
 * Chrome:   chromium.launchPersistentContext + --load-extension (officially supported)
 * Firefox:  Firefox Remote Debugging Protocol (RDP) installTemporaryAddon — the same
 *           mechanism used by about:debugging and web-ext. This bypasses signature
 *           requirements and works with Playwright's bundled Firefox Nightly build.
 *           Storage access uses a content-script bridge (moz-extension:// page navigation
 *           is blocked by Playwright's Juggler protocol).
 *
 * Fixtures:
 *   extCtx   (worker-scoped) — BrowserContext with extension loaded + extensionUrl
 *   storage  (worker-scoped) — chrome.storage.local read/write helper
 *   context  (test-scoped)   — alias for extCtx.context (BrowserContext)
 *   page     (test-scoped)   — fresh tab per test, closed after
 */

const { test: base, chromium, firefox, expect } = require('@playwright/test');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT_DIR = path.resolve(__dirname, '../..');

const FIREFOX_EXT_ID = 'website-time-blocking@example.com';
// Pre-set UUID so we can construct the moz-extension:// URL deterministically.
const FIREFOX_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
// RDP ports for each worker (one per parallel Firefox worker).
const RDP_BASE_PORT = 19200;

const SKIP_COPY = new Set(['node_modules', 'tests', '.git', 'playwright-report', 'test-results', '.gitignore']);
const SKIP_FF   = new Set([...SKIP_COPY, 'package.json', 'package-lock.json', 'playwright.config.js', 'PROMPT.md', 'README.md', 'design', 'images', 'CLAUDE.md']);

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (SKIP_COPY.has(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else fs.copyFileSync(s, d);
    }
}

function copyExtForFirefox(dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(EXT_DIR, { withFileTypes: true })) {
        if (SKIP_FF.has(entry.name)) continue;
        const s = path.join(EXT_DIR, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else fs.copyFileSync(s, d);
    }
    // Replace the generic manifest with the Firefox-specific one.
    fs.copyFileSync(path.join(EXT_DIR, 'manifest-firefox.json'), path.join(dest, 'manifest.json'));
}

// The storage helper page uses this URL — not in the extension's block list,
// so background.js will never redirect it away.
const HELPER_URL = 'https://playwright-ext-helper.invalid/';

// When background.js redirects to prompt.html in Firefox, Playwright's Juggler protocol
// drops the page (can't track moz-extension:// navigations). The fixture sets
// __testPromptBase in extension storage so background.js redirects here instead.
// Playwright routes this URL to serve the actual extension prompt files.
const TEST_PROMPT_BASE = 'https://playwright-ext-prompt.invalid/';

// Route all three target domains + the helper URL to local HTML (no network needed).
async function routeTargetSites(context) {
    const isTarget = (url) => {
        try {
            const h = new URL(url).hostname.replace(/^(www\.|m\.)/, '');
            return ['instagram.com', 'reddit.com', 'youtube.com', 'playwright-ext-helper.invalid']
                .some(d => h === d || h.endsWith('.' + d));
        } catch { return false; }
    };
    await context.route(isTarget, (route) => {
        const hostname = new URL(route.request().url()).hostname;
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!DOCTYPE html><html><body data-domain="${hostname}"><h1 data-testid="page-loaded">${hostname} Test Page</h1></body></html>`,
        });
    });
}

// ── Chrome ────────────────────────────────────────────────────────────────────

async function launchChromium() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ext-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
            `--disable-extensions-except=${EXT_DIR}`,
            `--load-extension=${EXT_DIR}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
    });
    await routeTargetSites(context);
    // Wait for the background service worker to register.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).hostname;
    return {
        context,
        extensionUrl: `chrome-extension://${extensionId}`,
        cleanup() { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} },
    };
}

// ── Firefox RDP client ────────────────────────────────────────────────────────
// Firefox RDP uses LENGTH:JSON framing over a raw TCP socket. We use raw Buffers
// (not strings) so byteLength matches the LENGTH prefix exactly.

class RDPClient {
    constructor(socket) {
        this._socket = socket;
        this._buf = Buffer.alloc(0);
        this._pending = [];
        socket.on('data', (chunk) => {
            this._buf = Buffer.concat([this._buf, chunk]);
            this._flush();
        });
    }

    _flush() {
        while (true) {
            const colonIdx = this._buf.indexOf(':');
            if (colonIdx === -1) break;
            const len = parseInt(this._buf.slice(0, colonIdx).toString('ascii'), 10);
            if (isNaN(len)) { this._buf = Buffer.alloc(0); break; }
            const start = colonIdx + 1;
            if (this._buf.length < start + len) break;
            const msgBuf = this._buf.slice(start, start + len);
            this._buf = this._buf.slice(start + len);
            let msg;
            try { msg = JSON.parse(msgBuf.toString('utf8')); } catch { continue; }
            if (this._pending.length > 0) this._pending.shift()(msg);
        }
    }

    read() { return new Promise(resolve => this._pending.push(resolve)); }
    send(msg) {
        const json = JSON.stringify(msg);
        this._socket.write(`${Buffer.byteLength(json, 'utf8')}:${json}`);
    }
    async request(msg) { this.send(msg); return this.read(); }
    destroy() { try { this._socket.destroy(); } catch {} }
}

async function rdpConnect(port, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        try {
            return await new Promise((resolve, reject) => {
                const s = net.createConnection(port, '127.0.0.1');
                s.once('connect', () => resolve(s));
                s.once('error', reject);
            });
        } catch {
            if (Date.now() >= deadline) throw new Error(`Firefox RDP connect timeout on port ${port}`);
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

// ── Firefox ───────────────────────────────────────────────────────────────────

async function launchFirefox(workerIndex) {
    const rdpPort = RDP_BASE_PORT + workerIndex;

    // 1. Assemble the extension source in a temp dir (kept alive for the entire session).
    const extSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ext-src-'));
    copyExtForFirefox(extSrcDir);

    // 2. Build a minimal Firefox profile.
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-profile-'));
    fs.writeFileSync(path.join(profileDir, 'user.js'), [
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("startup.homepage_welcome_url", "about:blank");',
        'user_pref("startup.homepage_welcome_url.additional", "");',
    ].join('\n'));

    // 3. Launch Firefox with the RDP server enabled.
    const context = await firefox.launchPersistentContext(profileDir, {
        headless: false,
        args: [`--start-debugger-server=${rdpPort}`, '--remote-allow-hosts=127.0.0.1'],
        firefoxUserPrefs: {
            'devtools.debugger.remote-enabled': true,
            'devtools.debugger.prompt-connection': false,
            // Pin the extension to a known UUID so tests can build the moz-extension:// URL.
            'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_EXT_ID]: FIREFOX_UUID }),
        },
    });
    await routeTargetSites(context);

    // Serve the extension's prompt files at TEST_PROMPT_BASE so Playwright can track the
    // navigation. background.js redirects to this URL (instead of moz-extension://) when
    // __testPromptBase is set in storage. The content script still runs here (matches
    // <all_urls>) and provides __extBridge so prompt.js can reach extension APIs.
    await context.route(
        url => url.href.startsWith(TEST_PROMPT_BASE),
        async (route) => {
            const u = new URL(route.request().url());
            const file = u.pathname === '/' ? 'prompt.html' : u.pathname.slice(1);
            const fp = path.join(extSrcDir, file);
            try {
                const body = fs.readFileSync(fp);
                const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
                await route.fulfill({ status: 200, contentType: ct, body });
            } catch {
                await route.fulfill({ status: 404, body: 'not found' });
            }
        }
    );

    // 4. Connect via RDP and install the extension as a temporary addon.
    //    installTemporaryAddon bypasses signature requirements — the same mechanism
    //    used by about:debugging and web-ext.
    await new Promise(r => setTimeout(r, 2000));
    const socket = await rdpConnect(rdpPort, 15000);
    const rdp = new RDPClient(socket);
    const greeting = await rdp.read();
    const rootResp = await rdp.request({ to: greeting.from, type: 'getRoot' });
    const installResp = await rdp.request({
        to: rootResp.addonsActor,
        type: 'installTemporaryAddon',
        addonPath: extSrcDir,
        openDevTools: false,
    });
    rdp.destroy();

    if (installResp.error) {
        await context.close().catch(() => {});
        fs.rmSync(profileDir, { recursive: true, force: true });
        fs.rmSync(extSrcDir, { recursive: true, force: true });
        throw new Error(`Firefox RDP installTemporaryAddon failed: ${installResp.message}`);
    }

    // Brief pause for the extension background script to start.
    await new Promise(r => setTimeout(r, 800));

    return {
        context,
        extensionUrl: `moz-extension://${FIREFOX_UUID}`,
        cleanup() {
            try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
            try { fs.rmSync(extSrcDir, { recursive: true, force: true }); } catch {}
        },
    };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const test = base.extend({
    // One browser context per worker (= one per test file per project).
    extCtx: [
        async ({ browserName }, use, workerInfo) => {
            const setup = browserName === 'firefox'
                ? await launchFirefox(workerInfo.workerIndex)
                : await launchChromium();
            await use(setup);
            await setup.context.close().catch(() => {});
            setup.cleanup();
        },
        { scope: 'worker' },
    ],

    // Storage helper — one helper page per worker, reused across tests.
    // Chrome: options page (full extension context, direct chrome.storage.local access).
    // Firefox: content-script bridge on a stub page (Playwright's Juggler protocol blocks
    //          moz-extension:// page navigation; content scripts CAN access storage).
    storage: [
        async ({ extCtx, browserName }, use) => {
            const { context, extensionUrl } = extCtx;

            if (browserName === 'firefox') {
                // Use a non-blocked helper URL so background.js never redirects this page away.
                const hp = await context.newPage();
                await hp.goto(HELPER_URL, { waitUntil: 'domcontentloaded' });
                // Brief pause for the content script (and exportFunction bridge) to register.
                await hp.waitForTimeout(400);

                // __extBridge is exported by content.js via Firefox's exportFunction().
                // It uses a callback (not a Promise return) because privileged Promises
                // can't be .then'd from page context (Xray "Permission denied" error).
                const callBridge = (op, data) => hp.evaluate(
                    ({ op, dataStr }) => new Promise((resolve) =>
                        window.__extBridge(op, dataStr, (json) => resolve(JSON.parse(json)))
                    ),
                    { op, dataStr: data === null ? null : JSON.stringify(data) }
                );

                await use({
                    set: (data) => callBridge('set', data),
                    get: (keys) => callBridge('get', keys),
                    // Re-set __testPromptBase after clearing so background.js keeps redirecting
                    // to the routable test URL (not moz-extension://) throughout the test run.
                    clear: async () => {
                        await callBridge('clear', null);
                        await callBridge('set', { __testPromptBase: TEST_PROMPT_BASE });
                    },
                });

                await hp.close().catch(() => {});
            } else {
                const hp = await context.newPage();
                await hp.goto(`${extensionUrl}/options.html`, { waitUntil: 'domcontentloaded' });

                await use({
                    set: (data) => hp.evaluate((d) => chrome.storage.local.set(d), data),
                    get: (keys) => hp.evaluate((k) => chrome.storage.local.get(k), keys),
                    clear: () => hp.evaluate(() => Promise.all([
                        chrome.storage.local.clear(),
                        chrome.alarms.clearAll(),
                    ])),
                });

                await hp.close().catch(() => {});
            }
        },
        { scope: 'worker' },
    ],

    // Expose the BrowserContext so tests can open additional tabs.
    context: async ({ extCtx }, use) => {
        await use(extCtx.context);
    },

    // Fresh tab for each test.
    page: async ({ extCtx }, use) => {
        const p = await extCtx.context.newPage();
        await use(p);
        await p.close().catch(() => {});
    },
});

module.exports = { test, expect };
