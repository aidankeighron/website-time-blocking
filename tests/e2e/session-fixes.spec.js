/**
 * Regression coverage for two pre-release fixes:
 *   1. Extend resumes the ORIGINAL cooldown instead of arming a brand-new full-length one.
 *   2. A stale, un-reloaded "fresh picker" tab can no longer bypass an active cooldown by
 *      submitting a session after the cooldown started elsewhere.
 */
const { test, expect } = require('./fixture');
const { YT_HOME, VIDEO_A, expectBlocked } = require('./helpers');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

test('Extend resumes the original cooldown instead of resetting a fresh one', async ({ page, storage }) => {
    const now = Date.now();
    // Original cooldown: 30 min, started 25 min ago -> ~5 min remaining.
    await storage.set({
        cooldowns: { 'youtube.com': { startTime: now - 25 * 60 * 1000, duration: 30 * 60 * 1000, originalType: 'duration' } },
        extensionDuration: 1, // 1-second extend grant, so the test doesn't have to wait long
    });
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('#extend-btn')).toBeEnabled({ timeout: 3000 });
    await page.click('#extend-btn');
    await page.waitForTimeout(500);

    // Let the 1-second extend grant expire, then trigger a fresh check.
    await page.waitForTimeout(1500);
    await page.goto(YT_HOME, { waitUntil: 'commit' }).catch(() => null);
    await page.waitForTimeout(500);

    const data = await storage.get({ cooldowns: {} });
    const cd = data.cooldowns['youtube.com'];
    expect(cd).toBeTruthy();
    const remainingMs = (cd.startTime + cd.duration) - Date.now();
    // Should be close to the original ~5 min remaining (allow generous slack for test timing),
    // NOT a fresh 30-minute cooldown (which the bug would have produced).
    expect(remainingMs).toBeLessThan(10 * 60 * 1000);
    expect(remainingMs).toBeGreaterThan(0);
});

test('Cooldown countdown auto-releases once the real cooldown ends, without a manual reload', async ({ page, storage }) => {
    // Regression test: the "X minutes left" text used to be computed once at render time and
    // never updated — a cooldown tab left open just sat on a stale, eventually-wrong number
    // forever, even long after the real cooldown had actually ended.
    const now = Date.now();
    await storage.set({
        cooldowns: { 'youtube.com': { startTime: now - 30 * 1000, duration: 32 * 1000, originalType: 'duration' } }, // ~2s left
    });
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('h1')).toContainText('Cooldown Active');

    // Wait past the real end time with no interaction at all — the page must notice on its own
    // and move on to the real, now-cooldown-free access check (a fresh prompt).
    await expect(page.locator('h1')).not.toContainText('Cooldown Active', { timeout: 6000 });
});

test('A stale fresh-picker tab cannot bypass a cooldown that started after it rendered', async ({ page, storage }) => {
    await expectBlocked(page, VIDEO_A);
    // expectBlocked only confirms the URL landed on the block screen — prompt.js's own init()
    // (which reads storage asynchronously, slower via Firefox's test-bridge polling) may still
    // be mid-flight. Wait for the picker to actually be rendered before writing a cooldown
    // "elsewhere", otherwise that write can race init()'s own in-flight read and get picked up
    // by THIS tab's first render — which is a real timing gap in the test, not the bug under test.
    await page.waitForSelector('#duration-input', { state: 'visible', timeout: 5000 });

    // Simulate a cooldown starting elsewhere AFTER this tab already rendered its picker —
    // this tab has no idea the cooldown exists.
    const now = Date.now();
    await storage.set({
        cooldowns: { 'youtube.com': { startTime: now, duration: 30 * 60 * 1000, originalType: 'duration' } },
    });

    // Submit the stale picker anyway.
    await page.fill('#duration-input', '10');
    await page.click('#confirm-btn');
    await page.waitForTimeout(800);

    // Must NOT have created a session that overrides the cooldown for the whole domain.
    const data = await storage.get({ activeSessions: {} });
    expect(data.activeSessions['youtube.com']).toBeUndefined();

    // The tab should now reflect the real cooldown screen instead of being left stuck.
    expect(page.url()).toContain('cooldown=30');
    await expect(page.locator('h1')).toContainText('Cooldown Active');
});
