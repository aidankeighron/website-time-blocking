const { test, expect } = require('./fixture');
const { IG_HOME, IG_POST, expectBlocked, expectAllowed, submitDuration, waitForSiteAccess } = require('./helpers');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

// ── 1. Basic blocking ────────────────────────────────────────────────────────

test('Instagram homepage is blocked with no session', async ({ page }) => {
    await expectBlocked(page, IG_HOME);
    // Prompt shows the target domain
    await expect(page.locator('#target-site-display')).toContainText('instagram.com');
});

test('Instagram post page is blocked with no session', async ({ page }) => {
    await expectBlocked(page, IG_POST);
    await expect(page.locator('h1')).toContainText('Intervention');
});

// ── 2. Duration session ──────────────────────────────────────────────────────

test('Full flow: Instagram block → start duration session → access granted', async ({ page }) => {
    await expectBlocked(page, IG_HOME);
    await submitDuration(page, 30);
    await waitForSiteAccess(page, 'instagram.com');
    await expect(page.locator('[data-testid="page-loaded"]')).toBeVisible();
});

test('Instagram: pre-existing active duration session allows navigation', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: now - 60000,
                endTime: now + 300000,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, IG_HOME);
    await expect(page.locator('[data-testid="page-loaded"]')).toBeVisible();
});

test('Instagram: active session allows post page too', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: now - 60000,
                endTime: now + 300000,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, IG_POST);
});

// ── 3. Session expiry ────────────────────────────────────────────────────────

test('Instagram: expired session within cooldown window shows Cooldown Active UI', async ({ page, storage }) => {
    const now = Date.now();
    const endTime = now - 5 * 60 * 1000; // ended 5 min ago
    await storage.set({
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: now - 35 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await expectBlocked(page, IG_HOME);
    // Extension detects expired session → starts cooldown → prompt shows cooldown UI
    await expect(page.locator('h1')).toContainText('Cooldown Active');
});

test('Instagram: session + cooldown both expired shows Session Expired prompt', async ({ page, storage }) => {
    const now = Date.now();
    const endTime = now - 120 * 60 * 1000; // ended 2h ago
    await storage.set({
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: now - 160 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await expectBlocked(page, IG_HOME);
    await expect(page.locator('#error-msg')).toContainText('Session Expired');
    // Normal form should be visible so user can start a new session
    await expect(page.locator('#confirm-btn')).toBeVisible();
});

// ── 4. Cooldown UI ───────────────────────────────────────────────────────────

test('Instagram: active cooldown redirects to cooldown UI', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'instagram.com': {
                startTime: now - 5 * 60 * 1000,
                duration: 30 * 60 * 1000,
                originalType: 'duration',
            },
        },
    });
    await expectBlocked(page, IG_HOME);
    await expect(page.locator('h1')).toContainText('Cooldown Active');
    await expect(page.locator('body')).toContainText('instagram.com');
});

test('Instagram: expired cooldown results in a fresh prompt', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'instagram.com': {
                startTime: now - 60 * 60 * 1000, // started 60 min ago
                duration: 30 * 60 * 1000,         // 30 min duration → expired 30 min ago
            },
        },
    });
    await expectBlocked(page, IG_HOME);
    // Expired cooldown cleaned up → fresh intervention prompt
    await expect(page.locator('h1')).toContainText('Intervention');
});

// ── 5. Single-URL session ─────────────────────────────────────────────────────

test('Instagram: single_url session allows the exact target post', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'instagram.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: IG_POST,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, IG_POST);
});

test('Instagram: single_url session blocks navigation to homepage (Finished)', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'instagram.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: IG_POST,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectBlocked(page, IG_HOME);
    await expect(page.locator('#error-msg')).toContainText('Finished');
});

// ── 6. No double-prompt regression ──────────────────────────────────────────

test('No double-prompt: URL stays at prompt.html after initial redirect', async ({ page }) => {
    await expectBlocked(page, IG_HOME);
    const promptUrl = page.url();
    // Wait well past the 1000ms processingTabs lock — a second redirect must NOT occur.
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(promptUrl);
});

// ── 7. Count button hidden for non-YouTube ───────────────────────────────────

test('Instagram prompt: Count button is hidden (YouTube-only feature)', async ({ page }) => {
    await expectBlocked(page, IG_HOME);
    // count-btn always starts display:none and is only shown for youtube.com
    await expect(page.locator('#count-btn')).toBeHidden();
});

// ── 8. Error message for invalid input ──────────────────────────────────────

test('Instagram prompt: submitting without a duration shows error', async ({ page }) => {
    await expectBlocked(page, IG_HOME);
    await page.click('#confirm-btn'); // no value entered
    await expect(page.locator('#error-msg')).toContainText('valid positive duration');
});
