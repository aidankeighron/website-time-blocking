const { test, expect } = require('./fixture');
const {
    REDDIT_HOME, REDDIT_POPULAR, POST_A, POST_A_ALT, POST_B,
    expectBlocked, expectAllowed, submitDuration, waitForSiteAccess,
} = require('./helpers');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

// ── 1. Basic blocking ────────────────────────────────────────────────────────

test('Reddit homepage is blocked with no session', async ({ page }) => {
    await expectBlocked(page, REDDIT_HOME);
    await expect(page.locator('#target-site-display')).toContainText('reddit.com');
});

test('Reddit subreddit page is blocked with no session', async ({ page }) => {
    await expectBlocked(page, REDDIT_POPULAR);
    await expect(page.locator('h1')).toContainText('Intervention');
});

test('Reddit post page is blocked with no session', async ({ page }) => {
    await expectBlocked(page, POST_A);
});

// ── 2. Duration session ──────────────────────────────────────────────────────

test('Full flow: Reddit block → start duration session → access granted', async ({ page }) => {
    await expectBlocked(page, REDDIT_HOME);
    await submitDuration(page, 15);
    await waitForSiteAccess(page, 'reddit.com');
    await expect(page.locator('[data-testid="page-loaded"]')).toBeVisible();
});

test('Reddit: active duration session allows homepage', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'duration',
                startTime: now - 60000,
                endTime: now + 300000,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, REDDIT_HOME);
});

test('Reddit: active duration session allows post pages', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'duration',
                startTime: now - 60000,
                endTime: now + 300000,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, POST_A);
});

// ── 3. Single-URL session (post-ID matching) ──────────────────────────────────

test('Reddit: single_url session allows the exact target post', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: POST_A,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, POST_A);
});

test('Reddit: single_url session matches same post ID with different URL slug', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: POST_A,            // has /some_title/ trailing slug
                timeRangeLastCheck: now,
            },
        },
    });
    // POST_A_ALT has the same post ID (abc123) but no trailing slug — should still match
    await expectAllowed(page, POST_A_ALT);
});

test('Reddit: single_url session blocks a different post (different ID)', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: POST_A,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectBlocked(page, POST_B);
    // Session ended because user navigated away; prompt shows "Finished"
    await expect(page.locator('#error-msg')).toContainText('Finished');
});

test('Reddit: single_url session blocks navigation to homepage (Finished)', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: POST_A,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectBlocked(page, REDDIT_HOME);
    await expect(page.locator('#error-msg')).toContainText('Finished');
});

// ── 4. After single_url session ends, the next navigation requires a new session ─

test('Reddit: after single_url ends, next post access requires new session', async ({ page, context, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: POST_A,
                timeRangeLastCheck: now,
            },
        },
    });
    // Navigate away from the session target — session ends
    const tab1 = await context.newPage();
    await expectBlocked(tab1, POST_B);
    await tab1.close();

    // A fresh tab navigating to POST_B should also require a new session
    const tab2 = await context.newPage();
    await expectBlocked(tab2, POST_B);
    await tab2.close();
});

// ── 5. Cooldown ───────────────────────────────────────────────────────────────

test('Reddit: active cooldown shows Cooldown Active UI', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'reddit.com': {
                startTime: now - 2 * 60 * 1000,
                duration: 30 * 60 * 1000,
                originalType: 'duration',
            },
        },
    });
    await expectBlocked(page, REDDIT_HOME);
    await expect(page.locator('h1')).toContainText('Cooldown Active');
});

test('Reddit: Finish button visible during cooldown on a post page', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'reddit.com': {
                startTime: now - 2 * 60 * 1000,
                duration: 30 * 60 * 1000,
                originalType: 'duration',
            },
        },
        extensionDuration: 0, // no extend button
    });
    // Navigate to a specific post — isSpecificContent() returns true for Reddit posts
    await expectBlocked(page, POST_A);
    await expect(page.locator('#finish-btn')).toBeVisible();
});

test('Reddit: Finish button starts single_url session for the post', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'reddit.com': {
                startTime: now - 2 * 60 * 1000,
                duration: 30 * 60 * 1000,
                originalType: 'duration',
            },
        },
        extensionDuration: 0,
        inputDelay: 0,
    });
    await expectBlocked(page, POST_A);
    await expect(page.locator('#finish-btn')).toBeEnabled({ timeout: 3000 });
    await Promise.all([
        page.waitForURL(/^https:\/\/(www\.)?reddit\.com\//, { timeout: 10000 }),
        page.click('#finish-btn'),
    ]);
    expect(page.url()).not.toContain('prompt.html');
});

test('Reddit: expired session within cooldown shows Cooldown Active', async ({ page, storage }) => {
    const now = Date.now();
    const endTime = now - 5 * 60 * 1000;
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'duration',
                startTime: now - 35 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await expectBlocked(page, REDDIT_HOME);
    await expect(page.locator('h1')).toContainText('Cooldown Active');
});

test('Reddit: session + cooldown both expired shows Session Expired', async ({ page, storage }) => {
    const now = Date.now();
    const endTime = now - 120 * 60 * 1000;
    await storage.set({
        activeSessions: {
            'reddit.com': {
                type: 'duration',
                startTime: now - 160 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await expectBlocked(page, REDDIT_HOME);
    await expect(page.locator('#error-msg')).toContainText('Session Expired');
    await expect(page.locator('#confirm-btn')).toBeVisible();
});
