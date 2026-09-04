const {
    loadBackground, fireUpdated, fireAlarm, setStorage,
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

// ── 13. Count session: 30-minute inactivity expires session ──────────────────
test('YouTube: count session expires after 30 minutes of inactivity', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 3 * 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: NOW - 30 * 60 * 1000 - 1, // just over 30 minutes ago
                timeRangeLastCheck: NOW - 30 * 60 * 1000,
            },
        },
    });
    await nav(VIDEO_C);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Session%20Expired');
});

// ── 13b. Count session: inactivity alarm expires session with zero navigation ────────────────
// Regression test: reported bug was "gone for a whole day, tab closed, came back to a new tab —
// session still showed 5/9" — the lazy check only ever ran as a side effect of a navigation
// event, so an abandoned session with no navigation event at all (browser closed the whole time)
// never got cleared. count_inactivity_<domain> is the proactive backstop for exactly that case.
test('YouTube: count_inactivity alarm expires an abandoned session even with no navigation at all', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 3 * 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: NOW - 30 * 60 * 1000 - 1, // just over 30 minutes ago
            },
        },
    });
    __mockFns__['tabs.query'].mockResolvedValue([{ id: TAB, url: VIDEO_C }]);

    await fireAlarm({ name: 'count_inactivity_youtube.com' });

    expect(global.__store__.activeSessions['youtube.com']).toBeUndefined();
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Session%20Expired');
});

// ── 13c. count_inactivity alarm is a no-op if activity resumed since it was scheduled ────────
test('YouTube: count_inactivity alarm does nothing if the session is fresh again by the time it fires', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 3 * 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: NOW, // fresh — activity resumed since this alarm was scheduled
            },
        },
    });
    __mockFns__['tabs.query'].mockResolvedValue([{ id: TAB, url: VIDEO_C }]);

    await fireAlarm({ name: 'count_inactivity_youtube.com' });

    expect(global.__store__.activeSessions['youtube.com']).toBeDefined();
    expectNoRedirect(TAB);
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

// ── 21. Concurrency: opening several new videos in background tabs at once ───────
// Regression test: reported bug was "started a count session, right-clicked several videos
// open in new tabs, and each one asked me to start a NEW session" — i.e. an already-active
// session appeared to not exist for tabs opened nearly simultaneously. checkAccess does an
// unlocked read-modify-write on activeSessions[domain]; without per-domain serialization, two
// overlapping calls for the same domain can each read the session before either writes,
// letting the second write silently clobber the first's update. Firing these WITHOUT
// sequentially awaiting between them (Promise.all, not two separate awaited calls) is what
// actually exercises the interleaving — async functions yield at their first `await` even
// when the awaited promise resolves instantly, so this reproduces the real race shape.
test('YouTube: opening multiple new videos in different tabs at nearly the same instant does not lose the active session or its updates', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 9,
                videosWatched: 1,
                watchedVideoIds: ['aaa111'],
                lastActive: NOW,
            },
        },
        countCooldown: 30,
    });

    const TAB_B = 201;
    const TAB_C = 202;
    const TAB_D = 203;

    await Promise.all([
        fireUpdated(TAB_B, { url: VIDEO_B }, { url: VIDEO_B, status: 'loading' }),
        fireUpdated(TAB_C, { url: VIDEO_C }, { url: VIDEO_C, status: 'loading' }),
        fireUpdated(TAB_D, { url: 'https://www.youtube.com/watch?v=ddd444' }, { url: 'https://www.youtube.com/watch?v=ddd444', status: 'loading' }),
    ]);

    // None of the three concurrently-opened tabs should have been asked to start a new
    // session — the existing one must still be found and used for all of them.
    expectNoRedirect(TAB_B);
    expectNoRedirect(TAB_C);
    expectNoRedirect(TAB_D);

    // All three videos must be correctly counted — no lost updates from the race.
    const s = global.__store__;
    const session = s.activeSessions['youtube.com'];
    expect(session).toBeDefined();
    expect(session.watchedVideoIds).toEqual(expect.arrayContaining(['aaa111', 'bbb222', 'ccc333', 'ddd444']));
    expect(session.videosWatched).toBe(4);
});

// ── 22. Sequential variant: switching to each background tab one at a time ───────
// Same reported scenario, but modeling the alternative theory of how Chrome actually delivers
// these events — background tabs opened via right-click may not navigate until the user
// switches to each one, making the checkAccess calls fully sequential rather than concurrent.
// Included alongside test 21 so a real bug in either the concurrent OR the sequential path
// gets caught, since it isn't certain from the report alone which actually happened.
test('YouTube: switching to several new-tab videos one at a time (fully sequential) does not lose the active session', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 9,
                videosWatched: 1,
                watchedVideoIds: ['aaa111'],
                lastActive: NOW,
            },
        },
        countCooldown: 30,
    });

    const TAB_B = 211;
    const TAB_C = 212;
    const TAB_D = 213;

    await fireUpdated(TAB_B, { url: VIDEO_B }, { url: VIDEO_B, status: 'loading' });
    expectNoRedirect(TAB_B);

    await fireUpdated(TAB_C, { url: VIDEO_C }, { url: VIDEO_C, status: 'loading' });
    expectNoRedirect(TAB_C);

    await fireUpdated(TAB_D, { url: 'https://www.youtube.com/watch?v=ddd444' }, { url: 'https://www.youtube.com/watch?v=ddd444', status: 'loading' });
    expectNoRedirect(TAB_D);

    const session = global.__store__.activeSessions['youtube.com'];
    expect(session).toBeDefined();
    expect(session.watchedVideoIds).toEqual(expect.arrayContaining(['aaa111', 'bbb222', 'ccc333', 'ddd444']));
    expect(session.videosWatched).toBe(4);
});
