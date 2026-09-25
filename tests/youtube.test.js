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

// ── 11b. Count session: youtu.be short link is recognized as youtube.com and counted ──────────
// Regression test: getDomain() used to return "youtu.be" verbatim (no alias to "youtube.com"),
// so isTargetSite (which only ever matches against "youtube.com") never matched a youtu.be link
// at all — it bypassed blocking, counting, and any active youtube.com session entirely, silently
// passing straight through. getYouTubeVideoId's own youtu.be handling only matters once this
// domain alias exists to route the navigation through checkAccess in the first place.
test('YouTube: youtu.be short link is treated as youtube.com and its video ID is counted', async () => {
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
    await nav('https://youtu.be/xyz789?t=15');
    expectNoRedirect(TAB);
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].videosWatched).toBe(1);
    expect(s.activeSessions['youtube.com'].watchedVideoIds).toContain('xyz789');
});

// ── 11c. youtu.be link is blocked (as youtube.com) with no session ────────────────────────────
test('YouTube: youtu.be short link with no session redirects to prompt', async () => {
    await nav('https://youtu.be/xyz789');
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain(encodeURIComponent('https://youtu.be/xyz789'));
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

// ── 13b. Count session: cooldown ending does not retroactively block already-watched videos ──
// Regression test: reported bug was "started a 5-video count session, watched all 5, the
// countCooldown ran out — and every one of those 5 already-watched videos then got the block
// screen too, not just genuinely new ones." That happened because both the lazy expiry check in
// checkAccessSerialized AND the count_inactivity_ alarm unconditionally deleted the whole
// session (watchedVideoIds included) the moment the cooldown/inactivity clock ran out, so there
// was nothing left to tell "already-granted video" apart from "brand new video" by the time the
// next navigation event fired. A video already on the whitelist must stay reachable once the
// cooldown is over; only a genuinely new video (or a non-video page like the homepage — see the
// next test) should force a fresh session.
test('YouTube: revisiting an already-watched video after cooldown ends is still allowed', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 5,
                watchedVideoIds: ['v1', 'v2', 'v3', 'v4', 'v5'],
                lastActive: NOW - 31 * 60 * 1000,
                cooldownEndTime: NOW - 60 * 1000, // cooldown ended a minute ago
            },
        },
        countCooldown: 30,
    });

    await nav('https://www.youtube.com/watch?v=v3'); // one of the 5 already-watched videos
    expectNoRedirect(TAB);
    // The session survives — its whitelist is still there for the next revisit too.
    expect(global.__store__.activeSessions['youtube.com'].watchedVideoIds).toContain('v3');
});

// Regression test: after a count session's cooldown ended, opening the YouTube homepage showed
// no blocking UI at all — the old `!videoId` clause in isKnownContent treated every non-video
// page as "already granted," so the stale session was silently left active. Only clicking into
// an actual new video (no videoId match) triggered the block screen, so the block only ever
// appeared once the user had already started watching, not the moment they landed on the site.
// The homepage must re-trigger the same expiry/prompt flow a genuinely new video does.
test('YouTube: the homepage re-triggers the block screen and ends the session once cooldown expires', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 5,
                watchedVideoIds: ['v1', 'v2', 'v3', 'v4', 'v5'],
                lastActive: NOW - 31 * 60 * 1000,
                cooldownEndTime: NOW - 60 * 1000,
            },
        },
        countCooldown: 30,
    });

    await nav(YT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Session%20Expired');
    expect(global.__store__.activeSessions['youtube.com']).toBeUndefined();
});

test('YouTube: a genuinely NEW video after cooldown ends still requires a fresh session', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 5,
                watchedVideoIds: ['v1', 'v2', 'v3', 'v4', 'v5'],
                lastActive: NOW - 31 * 60 * 1000,
                cooldownEndTime: NOW - 60 * 1000,
            },
        },
        countCooldown: 30,
    });

    await nav(VIDEO_C); // not on the whitelist
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Session%20Expired');
    expect(global.__store__.activeSessions['youtube.com']).toBeUndefined();
});

// ── 13b-2. count_inactivity alarm no longer deletes the session, only closes the tracking span ──
// The alarm has no URL to check against, so it can no longer tell "already-granted video" apart
// from "new video" the way checkAccessSerialized's lazy check can — deleting the session here
// would blow away watchedVideoIds and reintroduce the retroactive-block bug above via a route
// that doesn't even require a navigation. Finalizing an expired count session is left entirely to
// the lazy, per-navigation check; this alarm now only keeps the scheduled-limits span accounting
// accurate and never touches any open tab.
test('YouTube: count_inactivity alarm does not delete the session or touch any open tab', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 3 * 60 * 60 * 1000,
                targetCount: 5,
                videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'],
                lastActive: NOW - 2 * 60 * 60 * 1000 - 1, // just over 2 hours ago
            },
        },
    });
    __mockFns__['tabs.query'].mockResolvedValue([{ id: TAB, url: VIDEO_C }]);

    await fireAlarm({ name: 'count_inactivity_youtube.com' });

    // The session (and its whitelist) is left in storage...
    expect(global.__store__.activeSessions['youtube.com']).toBeDefined();
    expect(global.__store__.activeSessions['youtube.com'].watchedVideoIds).toEqual(['aaa111', 'bbb222']);
    // ...and the open tab itself was never touched.
    expectNoRedirect(TAB);
});

// ── 13b-3. A long, still-pending cooldown stays authoritative even past 2 hours of inactivity ──
// Regression test companion: a session with a cooldown far longer than the usual 2-hour
// inactivity window (e.g. a deliberately long countCooldown) must not have that inactivity check
// short-circuit it into an early "Session Expired" reset — that would let a genuinely new video
// jump the remainder of a cooldown the user hasn't actually served yet. A known video stays
// allowed either way.
test('YouTube: a still-pending cooldown is not bypassed by 2+ hours of inactivity', async () => {
    const cooldownEnd = NOW + 10 * 60 * 1000; // 10 minutes still left on the cooldown
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 3 * 60 * 60 * 1000,
                targetCount: 1,
                videosWatched: 1,
                watchedVideoIds: ['aaa111'],
                lastActive: NOW - 2 * 60 * 60 * 1000 - 1, // stale by the inactivity window too
                cooldownEndTime: cooldownEnd,
            },
        },
        countCooldown: 30,
    });

    // A known video is still fine.
    await nav('https://www.youtube.com/watch?v=aaa111');
    expectNoRedirect(TAB);

    // A genuinely new video is blocked — the remaining ~10 minutes of cooldown still apply,
    // instead of being wiped by the unrelated 2-hour inactivity timeout.
    await nav(VIDEO_C);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Limit%20Reached');
    expect(global.__store__.activeSessions['youtube.com'].cooldownEndTime).toBe(cooldownEnd);
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

// ── 13d. Short countCooldown pulls the inactivity alarm in to match it ───────────────────────
// Regression test: the count_inactivity alarm used to always be scheduled 30 minutes out from
// lastActive, ignoring cooldownEndTime entirely — so a countCooldown shorter than 30 minutes
// (here, 5) had no proactive alarm covering it at all, the same "sits there stale until
// something else happens to revisit it" bug class this alarm exists to close.
test('YouTube: reaching the cap with a short countCooldown schedules the alarm at cooldownEndTime, not 30 minutes out', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW - 60000,
                targetCount: 1,
                videosWatched: 0,
                watchedVideoIds: [],
                lastActive: NOW - 60000,
            },
        },
        countCooldown: 5, // minutes — much shorter than SESSION_INACTIVITY_TIMEOUT_MS (2h)
    });
    await nav(VIDEO_A); // the 1st (== target) video — hits cap, starts a 5-minute cooldown
    expectNoRedirect(TAB); // this navigation itself is still allowed through

    const session = global.__store__.activeSessions['youtube.com'];
    expect(session.cooldownEndTime).toBeLessThan(NOW + 30 * 60 * 1000);

    const calls = __mockFns__['alarms.create'].mock.calls.filter(([name]) => name === 'count_inactivity_youtube.com');
    expect(calls.length).toBeGreaterThan(0);
    const { when } = calls[calls.length - 1][1];
    expect(when).toBe(session.cooldownEndTime);
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
