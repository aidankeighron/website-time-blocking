/**
 * v1.37/v1.38 block screens in a real browser: short-form block, Emergency Override passes on
 * the cooldown screen, the Close Tab button, and the morning block screen.
 */
const { test, expect } = require('./fixture');
const { YT_HOME, VIDEO_A, VIDEO_B, SHORTS_A, expectBlocked, waitForSiteAccess } = require('./helpers');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

function cooldownNow() {
    return { 'youtube.com': { startTime: Date.now() - 60000, duration: 30 * 60000, originalType: 'duration' } };
}

test('Blocked YouTube Shorts show the short-form screen; its button goes to the YouTube home page', async ({ page, storage }) => {
    await storage.set({ shortFormBlock: { youtubeShorts: true } });
    await expectBlocked(page, SHORTS_A);
    await expect(page.locator('h1')).toHaveText('YouTube Shorts Blocked');
    await page.click('#short-form-home-btn');
    // YouTube itself is a target site with no session, so it lands on the normal picker.
    await page.waitForURL(u => u.href.includes('prompt') && !u.href.includes('SHORT_FORM'), { timeout: 10000 });
    await expect(page.locator('#confirm-btn')).toBeVisible();
});

test('Shorts are not blocked while the switch is off', async ({ page, storage }) => {
    await storage.set({ shortFormBlock: { youtubeShorts: false } });
    await expectBlocked(page, SHORTS_A);
    await expect(page.locator('#confirm-btn')).toBeVisible();
});

test('Emergency override grants access and spends one of the week\'s passes', async ({ page, storage }) => {
    await storage.set({ cooldowns: cooldownNow(), overrideEnabled: true, overrideType: 'emergency' });
    await expectBlocked(page, VIDEO_A);
    await expect(page.locator('.override-note')).toContainText('2 of 2');
    await expect(page.locator('#extend-btn')).toHaveCount(0);
    await page.click('#emergency-btn');
    await waitForSiteAccess(page, 'youtube.com');
    const data = await storage.get(['emergencyOverrideUsage', 'activeSessions']);
    expect(data.emergencyOverrideUsage.used).toBe(1);
    expect(data.activeSessions['youtube.com'].origin).toBe('emergency');
});

test('With no passes left the cooldown screen says so and offers no override', async ({ page, storage }) => {
    await storage.set({ cooldowns: cooldownNow(), overrideEnabled: true, overrideType: 'emergency', emergencyOverridesPerWeek: 1 });
    await storage.set({ emergencyOverrideUsage: { weekKey: await page.evaluate(() => {
        const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }), used: 1 } });
    await expectBlocked(page, VIDEO_B);
    await expect(page.locator('.override-note')).toContainText('No emergency overrides left');
    await expect(page.locator('#emergency-btn')).toHaveCount(0);
});

test('No override at all by default: the cooldown screen has no Extend or Emergency button', async ({ page, storage }) => {
    await storage.set({ cooldowns: cooldownNow() });
    await expectBlocked(page, VIDEO_A);
    await expect(page.locator('h1')).toHaveText('Cooldown Active');
    await expect(page.locator('#extend-btn, #emergency-btn')).toHaveCount(0);
});

test('Close Tab closes the tab, even during the input delay', async ({ context, storage }) => {
    await storage.set({ inputDelay: 30 });
    const p = await context.newPage();
    await expectBlocked(p, YT_HOME);
    await expect(p.locator('#confirm-btn')).toBeDisabled();
    await expect(p.locator('#close-tab-btn')).toBeEnabled();
    await Promise.all([p.waitForEvent('close', { timeout: 5000 }), p.click('#close-tab-btn')]);
    expect(p.isClosed()).toBe(true);
});

test('Morning block screen counts down and lifts when switched off', async ({ page, storage, browserName }) => {
    // The live "switched off" reaction needs chrome.storage.onChanged, which the Firefox test
    // bridge page doesn't have (see fixture.js).
    test.skip(browserName === 'firefox', 'prompt storage watcher is extension-page only');
    // Start time "now" with a late end time, so this works whatever time of day the suite runs
    // (before 4 AM the block never applies, so skip then).
    test.skip(new Date().getHours() < 4, 'morning blocking never applies before 4 AM');
    const d = new Date();
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await storage.set({
        morningBlockEnabled: true, morningBlockMinutes: 30, morningBlockEndHour: 23, morningBlockEndMinute: 59,
        morningBlock: { dateKey, startTime: Date.now() },
    });
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('h1')).toHaveText('Morning Block Active');
    await expect(page.locator('#mb-timer')).toHaveText(/^(29|30)$/);
    await storage.set({ morningBlockEnabled: false });
    await page.waitForURL(u => !u.href.includes('MORNING_BLOCK'), { timeout: 10000 });
});
