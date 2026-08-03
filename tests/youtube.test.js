const {
    loadBackground, fireUpdated, setStorage,
    expectPromptRedirect, expectNoRedirect, flushPromises, NOW,
} = require('./helpers');

const TAB = 12;
const YT_HOME = 'https://www.youtube.com/';
const YT_SUBS = 'https://www.youtube.com/feed/subscriptions';
const VIDEO_A = 'https://www.youtube.com/watch?v=aaa111';
const VIDEO_B = 'https://www.youtube.com/watch?v=bbb222';
const VIDEO_C = 'https://www.youtube.com/watch?v=ccc333';
const SHORTS_A = 'https://www.youtube.com/shorts/sss999/';
const VIDEO_A_EXTRA = 'https://www.youtube.com/watch?v=aaa111&t=30s'; // same ID, extra param

function nav(url) {
    return fireUpdated(TAB, { url }, { url, status: 'loading' });
}

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'reddit.com', 'youtube.com'] });
});

// ── 1. Homepage blocked with no session ─────────────────────────────────────
test('YouTube homepage: no session redirects to prompt', async () => {
    await nav(YT_HOME);
    expectPromptRedirect(TAB);
});

// ── 2. Subscriptions feed also blocked ──────────────────────────────────────
test('YouTube subscriptions feed: no session redirects to prompt', async () => {
    await nav(YT_SUBS);
    expectPromptRedirect(TAB);
});

// ── 3. Video URL blocked with no session ─────────────────────────────────────
test('YouTube video page: no session redirects to prompt', async () => {
    await nav(VIDEO_A);
    expectPromptRedirect(TAB);
});

// ── 4. Active duration session allows all pages ──────────────────────────────
test('YouTube: active duration session allows homepage', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: NOW - 60000,
                endTime: NOW + 300000,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(YT_HOME);
    expectNoRedirect(TAB);
});

test('YouTube: active duration session allows video page', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: NOW - 60000,
                endTime: NOW + 300000,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(VIDEO_A);
    expectNoRedirect(TAB);
});

// ── 5. Count session: homepage (no video ID) is allowed ──────────────────────
test('YouTube: count session allows homepage (not a video)', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 3,
                videosWatched: 0,
                watchedVideoIds: [],
                lastActive: NOW,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(YT_HOME);
    expectNoRedirect(TAB);
});

// ── 6. Count session: first new video is counted and allowed ─────────────────
test('YouTube: count session allows first new video and counts it', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 3,
                videosWatched: 0,
                watchedVideoIds: [],
                lastActive: NOW,
                timeRangeLastCheck: NOW,
            },
        },
        countCooldown: 30,
    });
    await nav(VIDEO_A);
    expectNoRedirect(TAB);
    // videosWatched should now be 1
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].videosWatched).toBe(1);
    expect(s.activeSessions['youtube.com'].watchedVideoIds).toContain('aaa111');
});

// ── 7. Count session: re-watching same video ID does not count again ──────────
test('YouTube: count session does not recount same video ID', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 3,
                videosWatched: 1,
                watchedVideoIds: ['aaa111'],
                lastActive: NOW,
                timeRangeLastCheck: NOW,
            },
        },
        countCooldown: 30,
    });
    await nav(VIDEO_A);
    expectNoRedirect(TAB);
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].videosWatched).toBe(1); // unchanged
});

// ── 8. Count session: video with extra query params matches same ID ───────────
test('YouTube: count session: same video ID with extra params is not recounted', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 3,
                videosWatched: 1,
                watchedVideoIds: ['aaa111'],
                lastActive: NOW,
                timeRangeLastCheck: NOW,
            },
        },
        countCooldown: 30,
    });
    await nav(VIDEO_A_EXTRA); // same video, extra &t=30s param
    expectNoRedirect(TAB);
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].videosWatched).toBe(1);
});

// ── 9. Count session: Nth video (exactly at limit) is allowed and starts cooldown ─
test('YouTube: Nth video is allowed but starts cooldown', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 2,
                videosWatched: 1,
                watchedVideoIds: ['aaa111'],
                lastActive: NOW,
                timeRangeLastCheck: NOW,
            },
        },
        countCooldown: 30,
    });
    await nav(VIDEO_B); // 2nd video = Nth
    expectNoRedirect(TAB); // allowed
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].videosWatched).toBe(2);
    expect(s.activeSessions['youtube.com'].cooldownEndTime).toBeGreaterThan(NOW);
    expect(s.cooldowns && s.cooldowns['youtube.com']).toBeTruthy();
});

// ── 10. Count session: (N+1)th video is blocked ──────────────────────────────
test('YouTube: video beyond count limit is blocked', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 2,
                videosWatched: 2, // already at limit
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: NOW,
                timeRangeLastCheck: NOW,
            },
        },
        countCooldown: 30,
    });
    await nav(VIDEO_C); // new video, over limit
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Limit%20Reached');
});

// ── 11. Count session: Shorts URL video ID extracted correctly ────────────────
test('YouTube Shorts: video ID extracted and counted', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 3,
                videosWatched: 0,
                watchedVideoIds: [],
                lastActive: NOW,
                timeRangeLastCheck: NOW,
            },
        },
        countCooldown: 30,
    });
    await nav(SHORTS_A);
    expectNoRedirect(TAB);
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].videosWatched).toBe(1);
    expect(s.activeSessions['youtube.com'].watchedVideoIds).toContain('sss999');
});

// ── 12. Count session: count session starts with first video from prompt URL ──
test('YouTube: startSession with video URL counts that video immediately', async () => {
    // Simulate what happens after user fills prompt on VIDEO_A:
    // The background's startSession is called with url=VIDEO_A, type=count, value=3
    await new Promise((resolve) => {
        const handlers = global.__listeners__.onMessage;
        const sendResponse = (resp) => { expect(resp.success).toBe(true); resolve(); };
        handlers.forEach(fn => fn(
            { action: 'startSession', url: VIDEO_A, type: 'count', value: 3 },
            { tab: { id: TAB } },
            sendResponse
        ));
    });
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].videosWatched).toBe(1);
    expect(s.activeSessions['youtube.com'].watchedVideoIds).toContain('aaa111');
    expect(s.activeSessions['youtube.com'].targetCount).toBe(3);
});

// ── 13. Count session: 2-hour inactivity expires session ─────────────────────
test('YouTube: count session expires after 2 hours of inactivity', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 3 * 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: NOW - 2 * 60 * 60 * 1000 - 1, // just over 2 hours ago
                timeRangeLastCheck: NOW - 2 * 60 * 60 * 1000,
            },
        },
    });
    await nav(VIDEO_C);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Session%20Expired');
});

// ── 14. Count session with active cooldownEndTime → blocked ──────────────────
test('YouTube: count session with past-limit cooldown blocks access', async () => {
    const cooldownEnd = NOW + 30 * 60 * 1000;
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 60 * 60 * 1000,
                targetCount: 2,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: NOW - 5000,
                cooldownEndTime: cooldownEnd,
                timeRangeLastCheck: NOW,
            },
        },
        cooldowns: {
            'youtube.com': { startTime: NOW - 5000, duration: 30 * 60 * 1000, originalType: 'count' },
        },
    });
    await nav(VIDEO_C);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Limit%20Reached');
});

// ── 15. Count session with expired cooldownEndTime → fresh prompt ─────────────
test('YouTube: count session with expired cooldownEndTime triggers Session Expired', async () => {
    const cooldownEnd = NOW - 5 * 60 * 1000; // expired 5 min ago
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 3 * 60 * 60 * 1000,
                targetCount: 2,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: NOW - 5000,
                cooldownEndTime: cooldownEnd,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(VIDEO_C);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Session%20Expired');
});

// ── 16. Single-URL session for video: same video ID allowed ──────────────────
test('YouTube: single_url session allows same video (different query params)', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: VIDEO_A,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(VIDEO_A_EXTRA); // same video ID, extra params
    expectNoRedirect(TAB);
});

// ── 17. Single-URL session for video: different video blocked ─────────────────
test('YouTube: single_url session blocks different video', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: VIDEO_A,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(VIDEO_B);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Finished');
});

// ── 18. Single-URL session: going to homepage triggers Finished ───────────────
test('YouTube: single_url session blocks navigation to homepage', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: VIDEO_A,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(YT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Finished');
});

// ── 19. Duration session expired alarm fires → redirects active tab ───────────
test('YouTube: session_youtube.com alarm redirects tabs on that domain', async () => {
    const endTime = NOW - 1000;
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: NOW - 30 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    // Mock that tab 99 is on youtube.com
    __mockFns__['tabs.query'].mockResolvedValue([
        { id: 99, url: 'https://www.youtube.com/watch?v=aaa111' },
    ]);

    const handlers = global.__listeners__.onAlarm;
    await Promise.all(handlers.map(fn => fn({ name: 'session_youtube.com' })));

    // Tab 99 should be redirected
    const calls = __mockFns__['tabs.update'].mock.calls;
    const match = calls.find(([id, opts]) => id === 99 && opts.url && opts.url.includes('prompt.html'));
    expect(match).toBeTruthy();
    const url = match[1].url;
    expect(url).toContain('Time%20Up');
});

// ── 20. Duration session expired alarm with no matching active session is a no-op ─
test('YouTube: alarm for non-existent session is ignored', async () => {
    setStorage({ activeSessions: {} });
    __mockFns__['tabs.query'].mockResolvedValue([{ id: 99, url: YT_HOME }]);

    const handlers = global.__listeners__.onAlarm;
    await Promise.all(handlers.map(fn => fn({ name: 'session_youtube.com' })));

    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(0);
});
