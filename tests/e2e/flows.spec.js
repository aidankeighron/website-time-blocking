/**
 * Cross-site and shared flows:
 *   - Session shared across multiple tabs
 *   - No double-prompt regression
 *   - Prompt error validation
 *   - Custom targetSites configuration
 *
 * Scheduled-limit blocking behavior lives in tests/e2e/scheduled-limits.spec.js.
 */

const { test, expect } = require('./fixture');
const {
    YT_HOME, VIDEO_A, IG_HOME, REDDIT_HOME, POST_A,
    expectBlocked, expectAllowed, submitDuration, waitForSiteAccess,
} = require('./helpers');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

// ── Multi-tab session sharing ─────────────────────────────────────────────────

test('Single domain session shared: second tab is not re-prompted', async ({ page, context, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: now,
                endTime: now + 30 * 60 * 1000,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, YT_HOME);

    const page2 = await context.newPage();
    await expectAllowed(page2, VIDEO_A);
    await page2.close();
});

test('Count session shared: video counts accumulate across tabs', async ({ page, context, storage }) => {
    // Start count session on homepage (no video counted yet)
    await expectBlocked(page, YT_HOME);

    // Fill count prompt
    await page.waitForSelector('#count-btn', { state: 'visible' });
    await page.click('[data-type="count"]');
    await page.fill('#count-input', '2');
    await page.click('#confirm-btn');
    await waitForSiteAccess(page, 'youtube.com');

    // Open video A in a new tab — 1st video counted
    const p1 = await context.newPage();
    await expectAllowed(p1, VIDEO_A);
    await p1.close();

    // Open video B in another tab — 2nd = Nth video counted, cooldown starts
    const p2 = await context.newPage();
    await expectAllowed(p2, VIDEO_A.replace('aaa111', 'bbb222'));
    await p2.close();

    // Third new video in yet another tab — over limit → blocked
    const p3 = await context.newPage();
    await expectBlocked(p3, VIDEO_A.replace('aaa111', 'ccc333'));
    await expect(p3.locator('h1')).toContainText('Cooldown Active');
    await p3.close();
});

// ── Full user flows ───────────────────────────────────────────────────────────

test('Full flow: all three sites in one session', async ({ page, context, storage }) => {
    // 1. Block Instagram → start session → access
    await expectBlocked(page, IG_HOME);
    await submitDuration(page, 20);
    await waitForSiteAccess(page, 'instagram.com');

    // 2. YouTube in a new tab with its own session
    const ytPage = await context.newPage();
    await expectBlocked(ytPage, YT_HOME);
    await submitDuration(ytPage, 15);
    await waitForSiteAccess(ytPage, 'youtube.com');
    await ytPage.close();

    // 3. Reddit in a new tab — still blocked (separate domain sessions)
    const rdPage = await context.newPage();
    await expectBlocked(rdPage, REDDIT_HOME);
    await rdPage.close();
});

// ── No double-prompt regression ───────────────────────────────────────────────

test('No double-prompt on YouTube: prompt URL remains stable after 1.5s', async ({ page }) => {
    await expectBlocked(page, YT_HOME);
    const firstPromptUrl = page.url();
    await page.waitForTimeout(1500); // past the 1000ms processingTabs lock
    expect(page.url()).toBe(firstPromptUrl);
});

test('No double-prompt on Instagram: prompt URL remains stable after 1.5s', async ({ page }) => {
    await expectBlocked(page, IG_HOME);
    const firstPromptUrl = page.url();
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(firstPromptUrl);
});

test('No double-prompt on Reddit: prompt URL remains stable after 1.5s', async ({ page }) => {
    await expectBlocked(page, REDDIT_HOME);
    const firstPromptUrl = page.url();
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(firstPromptUrl);
});

// ── Prompt validation ─────────────────────────────────────────────────────────

test('Prompt: submitting empty duration shows error message', async ({ page }) => {
    await expectBlocked(page, IG_HOME);
    await page.click('#confirm-btn');
    await expect(page.locator('#error-msg')).toContainText('valid positive duration');
    // Still on prompt — did not navigate away
    expect(page.url()).toMatch(/prompt\.html|playwright-ext-prompt\.invalid/);
});

test('Prompt: submitting zero duration shows error', async ({ page }) => {
    await expectBlocked(page, YT_HOME);
    await page.fill('#duration-input', '0');
    await page.click('#confirm-btn');
    await expect(page.locator('#error-msg')).toContainText('valid positive duration');
});

test('YouTube prompt: submitting empty count shows error', async ({ page }) => {
    await expectBlocked(page, YT_HOME);
    await page.waitForSelector('#count-btn', { state: 'visible' });
    await page.click('[data-type="count"]');
    await page.click('#confirm-btn');
    await expect(page.locator('#error-msg')).toContainText('valid positive number');
});

// ── Custom targetSites ────────────────────────────────────────────────────────

test('Custom targetSites: only configured domains are blocked', async ({ page, storage }) => {
    // Override to only block Instagram
    await storage.set({ targetSites: ['instagram.com'] });

    // Instagram should be blocked
    await expectBlocked(page, IG_HOME);

    // YouTube should NOT be blocked (not in targetSites)
    const ytPage = await page.context().newPage();
    await expectAllowed(ytPage, YT_HOME);
    await ytPage.close();
});

// ── Prompt page itself is never blocked ───────────────────────────────────────

test('Extension prompt.html does not trigger another redirect', async ({ page, extCtx, browserName }) => {
    // On Firefox, Playwright's Juggler can't navigate to moz-extension:// via page.goto.
    // Use the test redirect URL (playwright-ext-prompt.invalid) which serves the same
    // prompt.html content and is routable. The extension won't re-block it (not a target site).
    const promptUrl = browserName === 'firefox'
        ? `https://playwright-ext-prompt.invalid/?url=${encodeURIComponent(YT_HOME)}`
        : `${extCtx.extensionUrl}/prompt.html?url=${encodeURIComponent(YT_HOME)}`;
    await page.goto(promptUrl, { waitUntil: 'domcontentloaded' });
    // Should stay on the prompt page — no further redirect
    expect(page.url()).toMatch(/prompt\.html|playwright-ext-prompt\.invalid/);
    await expect(page.locator('h1')).toContainText('Intervention');
});
