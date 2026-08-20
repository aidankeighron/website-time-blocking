/**
 * End-to-end coverage for the unified "Scheduled Limits" feature (days of week + time
 * window + minutes-allowed, where 0 = a full/direct block): the blocking decision driven
 * via storage presets, and the full options-page UI flow driven exactly as a user would use
 * it. Supersedes the old separate schedule-block.spec.js and flows.spec.js's time-range
 * section.
 *
 * The UI-driven tests are Chrome only: Playwright's Firefox/Juggler backend cannot navigate
 * to moz-extension:// pages (see fixture.js), so the options page itself is unreachable there.
 */

const { test, expect } = require('./fixture');
const {
    YT_HOME, IG_HOME, REDDIT_HOME,
    expectBlocked, expectAllowed, submitDuration,
    exhaustedScheduledLimit,
} = require('./helpers');

const DAY_FULL_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function todayDateKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

// ── Storage-preset-driven blocking decision ─────────────────────────────────────

test('Scheduled limit exhausted blocks YouTube even with an active duration session', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        ...exhaustedScheduledLimit(),
        activeSessions: {
            'youtube.com': { type: 'duration', startTime: now - 60000, endTime: now + 300000 },
        },
    });
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('h1')).toContainText('Access Blocked (Scheduled Limit)');
});

test('Scheduled limit exhausted blocks Instagram with no session', async ({ page, storage }) => {
    await storage.set(exhaustedScheduledLimit());
    await expectBlocked(page, IG_HOME);
    await expect(page.locator('h1')).toContainText('Access Blocked (Scheduled Limit)');
});

test('Scheduled limit exhausted blocks Reddit with no session', async ({ page, storage }) => {
    await storage.set(exhaustedScheduledLimit());
    await expectBlocked(page, REDDIT_HOME);
    await expect(page.locator('h1')).toContainText('Access Blocked (Scheduled Limit)');
});

test('Scheduled limit NOT yet exhausted allows site with active session', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        scheduledLimits: [{ id: 'limit1', days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 60 }],
        scheduledUsage: { limit1: { dateKey: todayDateKey(), bankedSeconds: 10 } },
        activeSessions: {
            'youtube.com': { type: 'duration', startTime: now - 60000, endTime: now + 300000 },
        },
    });
    await expectAllowed(page, YT_HOME);
});

test('Full-block (0 minute) scheduled limit blocks with no session', async ({ page, storage }) => {
    const today = new Date().getDay();
    await storage.set({
        scheduledLimits: [{ id: 'limit_full', days: [today], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 0 }],
    });
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('h1')).toContainText('Access Blocked (Scheduled Limit)');
    await expect(page.locator('.time-range-block-info')).toContainText('fully blocked');
});

// ── UI-driven: create/remove a scheduled limit exactly as a user would ──────────

async function addScheduledLimit(page, dayValue, startTime, endTime, minutes) {
    await page.click('#add-scheduled-limit-btn');
    await page.waitForSelector('#scheduled-limit-modal', { state: 'visible' });
    await page.click(`.day-label:has(input.day-cb[value="${dayValue}"])`);
    await page.fill('#sl-start', startTime);
    await page.fill('#sl-end', endTime);
    await page.fill('#sl-limit', String(minutes));
    await page.click('#sl-save-btn');
    await page.waitForSelector('#scheduled-limit-modal', { state: 'hidden' });
}

test('Adding a full-block (0 min) scheduled limit for today via the UI blocks the site, removing it unblocks', async ({ page, context, extCtx, browserName }) => {
    test.skip(browserName === 'firefox', 'options page not navigable via Playwright/Firefox');
    const today = new Date().getDay();

    await page.goto(`${extCtx.extensionUrl}/options.html`);
    await addScheduledLimit(page, today, '00:00', '23:59', 0);

    await expect(page.locator('#scheduled-limit-list')).toContainText(DAY_FULL_NAMES[today]);
    await expect(page.locator('#scheduled-limit-list')).toContainText('Full block');

    // A real user opening the target site in a new tab is hard-blocked.
    const sitePage = await context.newPage();
    await expectBlocked(sitePage, YT_HOME);
    await expect(sitePage.locator('h1')).toContainText('Access Blocked (Scheduled Limit)');
    await sitePage.close();

    // Removing it via the UI lifts the block. YouTube is still a target site with no active
    // session, so it still redirects to the normal intervention prompt — the point is it's no
    // longer scheduled-limit-blocked.
    await page.click('#scheduled-limit-list .remove-btn');
    await expect(page.locator('#scheduled-limit-list')).not.toContainText(DAY_FULL_NAMES[today]);

    const sitePage2 = await context.newPage();
    await expectBlocked(sitePage2, YT_HOME);
    await expect(sitePage2.locator('h1')).not.toContainText('Access Blocked (Scheduled Limit)');
    await expect(sitePage2.locator('h1')).toContainText('Intervention');
    await sitePage2.close();
});

test('Scheduled limit for a different day does not block access today', async ({ page, context, extCtx, browserName }) => {
    test.skip(browserName === 'firefox', 'options page not navigable via Playwright/Firefox');
    const today = new Date().getDay();
    const notToday = (today + 1) % 7;

    await page.goto(`${extCtx.extensionUrl}/options.html`);
    await addScheduledLimit(page, notToday, '00:00', '23:59', 0);

    await expect(page.locator('#scheduled-limit-list')).toContainText(DAY_FULL_NAMES[notToday]);

    const sitePage = await context.newPage();
    await expectBlocked(sitePage, YT_HOME);
    await expect(sitePage.locator('h1')).not.toContainText('Access Blocked (Scheduled Limit)');
    await sitePage.close();
});

// ── Real end-to-end proof of the mid-session bug fix ────────────────────────────
//
// Reported bug: a usage-capped limit created immediately before a session that outlasted
// its remaining budget never actually blocked, because the only enforcement mechanism was a
// 60s content-script heartbeat with no reliable fallback until after it first succeeded.
// This test proves the real, unmocked chrome.alarms-based fix in a live browser: a session
// gets interrupted mid-flight once its scheduled limit's usage cap is hit, with ZERO further
// navigation or test-driven check-in after the session starts.

test('A live session gets blocked mid-flight once its scheduled limit usage cap is hit, with no navigation', async ({ page, context, extCtx, storage, browserName }) => {
    test.skip(browserName === 'firefox', 'options page not navigable via Playwright/Firefox');
    test.setTimeout(150000);

    const today = new Date().getDay();

    await page.goto(`${extCtx.extensionUrl}/options.html`);
    await addScheduledLimit(page, today, '00:00', '23:59', 1); // 1-minute usage cap, active all day

    // Pre-seed banked usage at 20/60s used so ~40s of real budget remains once the session's
    // span opens — enough margin for the browser's real chrome.alarms scheduler to fire
    // naturally (not a manually-fired mock alarm, as the unit tests use).
    const stored = await storage.get({ scheduledLimits: [] });
    const entryId = stored.scheduledLimits[0].id;
    await storage.set({
        scheduledUsage: { [entryId]: { dateKey: todayDateKey(), bankedSeconds: 20 } },
    });

    const sitePage = await context.newPage();
    await expectBlocked(sitePage, YT_HOME);
    await submitDuration(sitePage, 5); // a 5-minute session — far longer than the ~40s left

    // Wait for the post-session-start navigation to reach youtube.com. Deliberately using
    // waitUntil: 'commit' (not the default 'load') — under full-suite system load the fake
    // youtube.com page's 'load' event can still be pending when the real, later block redirect
    // fires, which would otherwise abort that in-flight 'load' wait with a flaky
    // net::ERR_ABORTED. Waiting for 'commit' only needs the navigation to have started, which
    // is unaffected by anything that happens afterwards.
    await sitePage.waitForURL(
        (url) => url.href.includes('youtube.com') && !url.href.includes('prompt.html') && !url.href.includes('playwright-ext-prompt.invalid'),
        { timeout: 10000, waitUntil: 'commit' },
    );

    // No further navigation from here on — only a real wait for the browser's own
    // chrome.alarms to fire and the background script to redirect this tab unprompted.
    await sitePage.waitForURL(
        (url) => url.href.includes('prompt.html') || url.href.includes('playwright-ext-prompt.invalid'),
        { timeout: 90000, waitUntil: 'commit' },
    );
    await expect(sitePage.locator('h1')).toContainText('Access Blocked (Scheduled Limit)');
    await sitePage.close();
});
