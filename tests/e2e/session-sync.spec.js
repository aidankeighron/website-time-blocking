/**
 * Cross-tab session sync: starting a FRESH session (duration or count) from any blocked tab's
 * initial picker should apply to every other tab currently blocked on the same domain, exactly
 * as if each of those tabs had been reloaded — a count session correctly consumes a slot per
 * already-open tab (and sends any tab beyond the target to the cooldown screen), a duration
 * session simply lets everyone through. Extend and "Finish Video/Post" (used during a cooldown)
 * are explicitly excluded — those stay exclusive to the tab that clicked them.
 */
const { test, expect } = require('./fixture');
const {
    YT_HOME, VIDEO_A, VIDEO_B, VIDEO_C,
    expectBlocked, expectAllowed, submitDuration, submitCount, waitForSiteAccess,
} = require('./helpers');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

function isBlockedUrl(url) {
    const href = typeof url === 'string' ? url : url.href;
    return href.includes('prompt.html') || href.includes('playwright-ext-prompt.invalid');
}

test('Duration session sync: starting a fresh session in one blocked tab unlocks other blocked tabs', async ({ page, context }) => {
    await expectBlocked(page, VIDEO_A);

    const p2 = await context.newPage();
    await expectBlocked(p2, VIDEO_B);
    const p3 = await context.newPage();
    await expectBlocked(p3, VIDEO_C);

    // Start a fresh duration session on the first tab.
    await submitDuration(page, 30);
    await waitForSiteAccess(page, 'youtube.com');

    // The other two blocked tabs should sync through on their own, without any interaction.
    await waitForSiteAccess(p2, 'youtube.com');
    await waitForSiteAccess(p3, 'youtube.com');

    await p2.close();
    await p3.close();
});

test('Count session sync: each already-blocked tab consumes one slot (3 tabs, target 5 -> 3/5)', async ({ page, context, storage }) => {
    await expectBlocked(page, VIDEO_A);
    const p2 = await context.newPage();
    await expectBlocked(p2, VIDEO_B);
    const p3 = await context.newPage();
    await expectBlocked(p3, VIDEO_C);

    await submitCount(page, 5);
    await waitForSiteAccess(page, 'youtube.com');
    await waitForSiteAccess(p2, 'youtube.com');
    await waitForSiteAccess(p3, 'youtube.com');

    const data = await storage.get(['activeSessions']);
    expect(data.activeSessions['youtube.com'].videosWatched).toBe(3);
    expect(data.activeSessions['youtube.com'].watchedVideoIds.sort()).toEqual(['aaa111', 'bbb222', 'ccc333']);

    await p2.close();
    await p3.close();
});

test('Count session sync with overflow: 3 blocked tabs, target 2 -> two get through, the third lands on the cooldown screen', async ({ page, context, storage }) => {
    await expectBlocked(page, VIDEO_A);
    const p2 = await context.newPage();
    await expectBlocked(p2, VIDEO_B);
    const p3 = await context.newPage();
    await expectBlocked(p3, VIDEO_C);

    await submitCount(page, 2);
    await waitForSiteAccess(page, 'youtube.com');

    // Exactly one of {p2, p3} gets through (order isn't guaranteed); the other must land on
    // the cooldown screen, not stay stuck on a stale/blank prompt.
    await Promise.all([p2.waitForLoadState('domcontentloaded').catch(() => {}), p3.waitForLoadState('domcontentloaded').catch(() => {})]);
    await page.waitForTimeout(500); // let the background sync settle both tabs

    const p2Allowed = p2.url().includes('youtube.com') && !isBlockedUrl(p2.url());
    const p3Allowed = p3.url().includes('youtube.com') && !isBlockedUrl(p3.url());
    expect(p2Allowed !== p3Allowed).toBe(true); // exactly one, not both, not neither

    const blockedPage = p2Allowed ? p3 : p2;
    await expect(blockedPage.locator('h1')).toContainText('Cooldown Active');

    const data = await storage.get(['activeSessions']);
    expect(data.activeSessions['youtube.com'].videosWatched).toBe(2);

    await p2.close();
    await p3.close();
});

test('Extend during cooldown stays exclusive: does not unlock another tab blocked on the same domain', async ({ page, context, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'youtube.com': { startTime: now - 2 * 60 * 1000, duration: 30 * 60 * 1000, originalType: 'duration' },
        },
    });

    await expectBlocked(page, VIDEO_A);
    await expect(page.locator('h1')).toContainText('Cooldown Active');
    const p2 = await context.newPage();
    await expectBlocked(p2, VIDEO_B);
    await expect(p2.locator('h1')).toContainText('Cooldown Active');

    await expect(page.locator('#extend-btn')).toBeEnabled({ timeout: 3000 });
    await page.click('#extend-btn');
    await waitForSiteAccess(page, 'youtube.com');

    // p2 must NOT have been pulled through by the extend grant.
    await page.waitForTimeout(800);
    expect(isBlockedUrl(p2.url())).toBe(true);

    await p2.close();
});

test('Finish Video/Post during cooldown stays exclusive: does not unlock another blocked tab', async ({ page, context, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'youtube.com': { startTime: now - 2 * 60 * 1000, duration: 30 * 60 * 1000, originalType: 'duration' },
        },
    });

    await expectBlocked(page, VIDEO_A);
    const p2 = await context.newPage();
    await expectBlocked(p2, VIDEO_B);

    await expect(page.locator('#finish-btn')).toBeEnabled({ timeout: 3000 });
    await page.click('#finish-btn');
    await waitForSiteAccess(page, 'youtube.com');

    await page.waitForTimeout(800);
    expect(isBlockedUrl(p2.url())).toBe(true);

    await p2.close();
});

test('A tab not on the block screen is left alone by the sync pass', async ({ page, context }) => {
    // An unrelated tab, nowhere near prompt.html or even a target site.
    const bystander = await context.newPage();
    await bystander.goto('https://playwright-ext-helper.invalid/');
    const bystanderUrlBefore = bystander.url();

    await expectBlocked(page, VIDEO_A);
    const p2 = await context.newPage();
    await expectBlocked(p2, VIDEO_B);

    await submitDuration(page, 30);
    await waitForSiteAccess(page, 'youtube.com');
    await waitForSiteAccess(p2, 'youtube.com');

    // The bystander tab must be completely untouched by the sync pass.
    expect(bystander.url()).toBe(bystanderUrlBefore);

    await bystander.close();
    await p2.close();
});
