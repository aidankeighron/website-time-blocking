const { test, expect } = require('./fixture');
const {
    YT_HOME, YT_SUBS, VIDEO_A, VIDEO_B, VIDEO_C, VIDEO_D,
    SHORTS_A, VIDEO_A_EXTRA,
    expectBlocked, expectAllowed, submitDuration, submitCount, waitForSiteAccess,
} = require('./helpers');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

// ── 1. Basic blocking ────────────────────────────────────────────────────────

test('YouTube homepage is blocked with no session', async ({ page }) => {
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('#target-site-display')).toContainText('youtube.com');
    await expect(page.locator('h1')).toContainText('Intervention');
});

test('YouTube subscriptions feed is blocked with no session', async ({ page }) => {
    await expectBlocked(page, YT_SUBS);
});

test('YouTube video page is blocked with no session', async ({ page }) => {
    await expectBlocked(page, VIDEO_A);
});

// ── 2. Count button only on YouTube ─────────────────────────────────────────

test('YouTube prompt shows the Count button', async ({ page }) => {
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('#count-btn')).toBeVisible();
});

// ── 3. Duration session ──────────────────────────────────────────────────────

test('Full flow: YouTube block → start duration session → access granted', async ({ page }) => {
    await expectBlocked(page, YT_HOME);
    await submitDuration(page, 30);
    await waitForSiteAccess(page, 'youtube.com');
    await expect(page.locator('[data-testid="page-loaded"]')).toBeVisible();
});

test('YouTube: pre-existing duration session allows homepage', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: now - 60000,
                endTime: now + 300000,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, YT_HOME);
});

test('YouTube: active duration session allows video pages', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: now - 60000,
                endTime: now + 300000,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, VIDEO_A);
});

// ── 4. Count session — full user flow ────────────────────────────────────────

test('Full flow: YouTube count session — block → start → watch N videos → Nth starts cooldown', async ({ page, context, storage }) => {
    // Step 1: Blocked on homepage → start a 3-video count session
    await expectBlocked(page, YT_HOME);
    await submitCount(page, 3);
    await waitForSiteAccess(page, 'youtube.com');

    // Step 2: Open video A — 1st new video, allowed and counted
    const p1 = await context.newPage();
    await expectAllowed(p1, VIDEO_A);
    await p1.close();

    // Step 3: Open video B — 2nd new video, allowed
    const p2 = await context.newPage();
    await expectAllowed(p2, VIDEO_B);
    await p2.close();

    // Step 4: Open video C — 3rd = Nth video, allowed but cooldown starts
    const p3 = await context.newPage();
    await expectAllowed(p3, VIDEO_C);
    await p3.close();

    // Verify storage: 3 videos watched, cooldown set
    const data = await storage.get(['activeSessions', 'cooldowns']);
    expect(data.activeSessions?.['youtube.com']?.videosWatched).toBe(3);
    expect(data.cooldowns?.['youtube.com']).toBeTruthy();

    // Step 5: Open video D — 4th video, over limit → blocked
    const p4 = await context.newPage();
    await expectBlocked(p4, VIDEO_D);
    await expect(p4.locator('h1')).toContainText('Cooldown Active');
    await p4.close();
});

// ── 5. Count session — re-watching same video ────────────────────────────────

test('YouTube: re-watching a video with the same ID does not count again', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: now,
                targetCount: 3,
                videosWatched: 1,
                watchedVideoIds: ['aaa111'],
                lastActive: now,
                timeRangeLastCheck: now,
            },
        },
        countCooldown: 30,
    });
    await expectAllowed(page, VIDEO_A); // same ID aaa111 — already watched
    const data = await storage.get(['activeSessions']);
    expect(data.activeSessions['youtube.com'].videosWatched).toBe(1); // unchanged
});

test('YouTube: same video with extra query params (?t=30s) is not counted again', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: now,
                targetCount: 3,
                videosWatched: 1,
                watchedVideoIds: ['aaa111'],
                lastActive: now,
                timeRangeLastCheck: now,
            },
        },
        countCooldown: 30,
    });
    await expectAllowed(page, VIDEO_A_EXTRA); // ?v=aaa111&t=30s
    const data = await storage.get(['activeSessions']);
    expect(data.activeSessions['youtube.com'].videosWatched).toBe(1);
});

// ── 6. Shorts URL ─────────────────────────────────────────────────────────────

test('YouTube Shorts: video ID extracted from /shorts/ path and counted correctly', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: now,
                targetCount: 3,
                videosWatched: 0,
                watchedVideoIds: [],
                lastActive: now,
                timeRangeLastCheck: now,
            },
        },
        countCooldown: 30,
    });
    await expectAllowed(page, SHORTS_A);
    const data = await storage.get(['activeSessions']);
    expect(data.activeSessions['youtube.com'].videosWatched).toBe(1);
    expect(data.activeSessions['youtube.com'].watchedVideoIds).toContain('sss999');
});

// ── 7. Count session — homepage is not a video ───────────────────────────────

test('YouTube: count session allows homepage (no video ID — does not count)', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: now,
                targetCount: 3,
                videosWatched: 0,
                watchedVideoIds: [],
                lastActive: now,
                timeRangeLastCheck: now,
            },
        },
        countCooldown: 30,
    });
    await expectAllowed(page, YT_HOME);
    const data = await storage.get(['activeSessions']);
    expect(data.activeSessions['youtube.com'].videosWatched).toBe(0); // unchanged
});

// ── 8. Count session — over limit ────────────────────────────────────────────

test('YouTube: (N+1)th video is blocked and shows Cooldown Active', async ({ page, storage }) => {
    const now = Date.now();
    // Already at limit: 3 of 3 videos watched, cooldown active
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: now - 10 * 60 * 1000,
                targetCount: 3,
                videosWatched: 3,
                watchedVideoIds: ['aaa111', 'bbb222', 'ccc333'],
                lastActive: now - 1000,
                cooldownEndTime: now + 30 * 60 * 1000,
                timeRangeLastCheck: now,
            },
        },
        cooldowns: {
            'youtube.com': { startTime: now - 1000, duration: 30 * 60 * 1000 },
        },
    });
    await expectBlocked(page, VIDEO_D);
    await expect(page.locator('h1')).toContainText('Cooldown Active');
});

// ── 9. 2-hour inactivity expiry ────────────────────────────────────────────

test('YouTube: count session expires after 2 hours of inactivity', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: now - 5 * 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: now - 2 * 60 * 60 * 1000 - 1, // just over 2 hours ago
                timeRangeLastCheck: now - 2 * 60 * 60 * 1000,
            },
        },
    });
    await expectBlocked(page, VIDEO_C);
    await expect(page.locator('#error-msg')).toContainText('Session Expired');
});

// ── 10. Count session cooldown expiry ────────────────────────────────────────

test('YouTube: count session with expired cooldownEndTime shows Session Expired', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: now - 3 * 60 * 60 * 1000,
                targetCount: 2,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: now - 5000,
                cooldownEndTime: now - 5 * 60 * 1000, // expired 5 min ago
                timeRangeLastCheck: now,
            },
        },
    });
    await expectBlocked(page, VIDEO_C);
    await expect(page.locator('#error-msg')).toContainText('Session Expired');
});

// ── 11. Single-URL session (video ID matching) ────────────────────────────────

test('YouTube: single_url session allows the same video (by ID)', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: VIDEO_A,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, VIDEO_A);
});

test('YouTube: single_url session allows same video with extra query params', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: VIDEO_A,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectAllowed(page, VIDEO_A_EXTRA); // same ID aaa111
});

test('YouTube: single_url session blocks a different video (Finished)', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: VIDEO_A,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectBlocked(page, VIDEO_B);
    await expect(page.locator('#error-msg')).toContainText('Finished');
});

test('YouTube: single_url session blocks navigation to homepage (Finished)', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'single_url',
                startTime: now,
                targetUrl: VIDEO_A,
                timeRangeLastCheck: now,
            },
        },
    });
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('#error-msg')).toContainText('Finished');
});

// ── 12. Cooldown extend button (duration cooldown only) ────────────────────────

test('YouTube: extend button is visible during a duration cooldown', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'youtube.com': {
                startTime: now - 2 * 60 * 1000,
                duration: 30 * 60 * 1000,
                originalType: 'duration', // extend requires this
            },
        },
        extensionDuration: 30,
    });
    await expectBlocked(page, VIDEO_A);
    await expect(page.locator('#extend-btn')).toBeVisible();
});

test('YouTube: extend button is NOT visible during a count cooldown', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'youtube.com': {
                startTime: now - 2 * 60 * 1000,
                duration: 30 * 60 * 1000,
                // No originalType — count cooldown
            },
        },
        extensionDuration: 30,
    });
    await expectBlocked(page, VIDEO_A);
    await expect(page.locator('#extend-btn')).toBeHidden();
});

test('YouTube: extend button starts a session and grants access', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'youtube.com': {
                startTime: now - 2 * 60 * 1000,
                duration: 30 * 60 * 1000,
                originalType: 'duration',
            },
        },
        // Use 5 minutes so the session outlives any stale status:complete events
        // that fire after the 1000ms processingTabs lock expires.
        extensionDuration: 300,
        inputDelay: 0,
    });
    await expectBlocked(page, VIDEO_A);
    await expect(page.locator('#extend-btn')).toBeEnabled({ timeout: 3000 });
    await page.click('#extend-btn');
    // Wait for the tab to land on youtube.com and stay there.
    // Using expectAllowed (2s window) confirms no re-block occurs.
    await page.waitForURL(/youtube\.com/, { timeout: 10000 });
    // Give stale events time to fire — if the extension re-blocked, the URL would change.
    await page.waitForTimeout(1500);
    expect(page.url()).not.toContain('prompt.html');
});

test('YouTube: finish button is visible for a video during cooldown', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        cooldowns: {
            'youtube.com': {
                startTime: now - 2 * 60 * 1000,
                duration: 30 * 60 * 1000,
                originalType: 'duration',
            },
        },
        extensionDuration: 0,
    });
    // VIDEO_A is specific content → finish button should appear
    await expectBlocked(page, VIDEO_A);
    await expect(page.locator('#finish-btn')).toBeVisible();
});

// ── 13. Session expiry ────────────────────────────────────────────────────────

test('YouTube: expired duration session shows Cooldown Active', async ({ page, storage }) => {
    const now = Date.now();
    const endTime = now - 5 * 60 * 1000;
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: now - 35 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('h1')).toContainText('Cooldown Active');
});

test('YouTube: session + cooldown both expired shows Session Expired', async ({ page, storage }) => {
    const now = Date.now();
    const endTime = now - 120 * 60 * 1000;
    await storage.set({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: now - 160 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await expectBlocked(page, YT_HOME);
    await expect(page.locator('#error-msg')).toContainText('Session Expired');
    await expect(page.locator('#confirm-btn')).toBeVisible();
});

// ── Reported bug: opening several new videos in background tabs right after starting a
// count session asked to start a new session for each one, as if the just-created session
// didn't exist. This is a REAL browser test (not the jest mock) specifically because
// chrome.storage.local's actual latency is far higher than the mock's near-instant
// resolution — a read/write race on activeSessions[domain] needs real timing to surface.
test('YouTube: opening several new videos in background tabs seconds after starting a count session does not lose the session', async ({ page, context, storage }) => {
    await expectBlocked(page, YT_HOME);
    await submitCount(page, 9);
    await waitForSiteAccess(page, 'youtube.com');

    // A few seconds' gap between finishing the prompt and opening the new tabs, matching
    // the reported timing.
    await page.waitForTimeout(3000);

    // Simulate right-clicking several video links and opening them all in new background
    // tabs in quick succession — fire all three navigations concurrently, not one at a time.
    const p1 = await context.newPage();
    const p2 = await context.newPage();
    const p3 = await context.newPage();
    await Promise.all([
        p1.goto(VIDEO_A, { waitUntil: 'commit' }).catch(() => null),
        p2.goto(VIDEO_B, { waitUntil: 'commit' }).catch(() => null),
        p3.goto(VIDEO_C, { waitUntil: 'commit' }).catch(() => null),
    ]);

    // None of them should ever show the start-a-session prompt — the existing session must
    // still be found and used for all three.
    for (const p of [p1, p2, p3]) {
        await expect(p.locator('[data-testid="page-loaded"]')).toBeVisible({ timeout: 5000 });
    }

    // And no updates should have been lost to a read/write race — all three videos counted.
    const data = await storage.get(['activeSessions']);
    const session = data.activeSessions?.['youtube.com'];
    expect(session).toBeTruthy();
    expect(session.watchedVideoIds).toEqual(expect.arrayContaining(['aaa111', 'bbb222', 'ccc333']));
    expect(session.videosWatched).toBe(3);

    await p1.close();
    await p2.close();
    await p3.close();
});
