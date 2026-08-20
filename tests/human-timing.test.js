// "Realistic human timing" end-to-end tests, run entirely through Jest (no real browser).
//
// Every other test file in this suite fires actions back-to-back in the same tick, and the
// mocked chrome.storage.local resolves essentially instantly — which is exactly why the
// multi-tab session-clobbering bug (see background.js's per-domain checkAccess queue and
// tests/e2e/youtube.spec.js's real-browser regression test) was invisible to the fast unit
// tests and only reproduced against a real browser's real storage latency.
//
// These tests close that gap without needing a real browser: __setStorageLatency__ makes the
// mocked chrome.storage.local resolve after a genuine, jittered, real-wall-clock delay (like
// the real IPC round-trip to the browser process), and humanDelay/humanTypingDelay pace every
// simulated action (reading the prompt, typing a value, clicking, switching/opening tabs) the
// way an actual person would, rather than a script firing everything simultaneously. Because
// these use real setTimeout (never Jest fake timers, which would collapse the very
// interleaving being tested), each test genuinely takes real seconds to run — that's the
// point, not a flaw.

const {
    loadBackground, fireUpdated, fireMessage,
    setStorage, expectNoRedirect,
    humanDelay, humanTypingDelay,
} = require('./helpers');

const YT_HOME = 'https://www.youtube.com/';
const IG_HOME = 'https://www.instagram.com/';
const VIDEO = (id) => `https://www.youtube.com/watch?v=${id}`;

function nav(tabId, url) {
    return fireUpdated(tabId, { url }, { url, status: 'loading' });
}

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'reddit.com', 'youtube.com'] });
    // Realistic chrome.storage.local IPC latency — a few milliseconds per call, jittered,
    // not a fixed delay (real IPC timing isn't perfectly uniform either).
    __setStorageLatency__(15, 60);
});

afterEach(() => {
    __clearStorageLatency__();
});

// Simulates a human completing the prompt's "Count" flow: reads the screen, clicks the Count
// tab, types the target number digit by digit, then clicks Confirm — with a real delay at each
// step — before the startSession message actually fires.
async function humanStartsCountSession(url, targetCount) {
    await humanDelay(300, 700); // reads the prompt
    await humanDelay(120, 260); // clicks the "Count" tab
    await humanTypingDelay(String(targetCount)); // types the number, digit by digit
    await humanDelay(150, 350); // moves to and clicks "Continue to Site"
    const response = await fireMessage({ action: 'startSession', url, type: 'count', value: targetCount });
    expect(response.success).toBe(true);
}

async function humanStartsDurationSession(url, minutes) {
    await humanDelay(300, 700);
    await humanTypingDelay(String(minutes));
    await humanDelay(150, 350);
    const response = await fireMessage({ action: 'startSession', url, type: 'duration', value: minutes });
    expect(response.success).toBe(true);
}

test(
    'Human-paced reproduction: starting a count session, browsing a few seconds, then opening several new videos in quick succession does not lose the session',
    async () => {
        const TAB_ORIGINAL = 501;

        // Blocked on the homepage — this is what got the user to the prompt in the first place.
        await nav(TAB_ORIGINAL, YT_HOME);
        // That expected initial block is not what later expectNoRedirect checks care about —
        // clear it so only redirects from here on (the real assertions) are considered.
        global.__mockFns__['tabs.update'].mockClear();

        // Human fills out and submits the "watch 9 videos" prompt.
        await humanStartsCountSession(YT_HOME, 9);

        // prompt.js's window.location.replace(intendedUrl) — the page navigating itself back.
        await humanDelay(80, 200);
        await nav(TAB_ORIGINAL, YT_HOME);
        expectNoRedirect(TAB_ORIGINAL);

        // The reported gap: a few real seconds of ordinary browsing before opening more tabs.
        await humanDelay(2200, 3200);

        // The original report: right-clicking several video thumbnails and opening each in a
        // new background tab in quick succession. Real clicks land close together but not
        // simultaneously — a small human click-to-click gap before each one, giving the race
        // several independent chances to manifest within one realistic test rather than
        // depending on a single roll hitting the exact right window.
        const allVideos = ['bbb222', 'ccc333', 'ddd444', 'eee555', 'fff666', 'ggg777', 'hhh888', 'iii999', 'jjj000'];
        let nextTabId = 502;
        const navPromises = [];
        for (let i = 0; i < allVideos.length; i++) {
            navPromises.push(nav(nextTabId++, VIDEO(allVideos[i])));
            if (i < allVideos.length - 1) await humanDelay(2, 20); // gap before the next click
        }
        await Promise.all(navPromises);

        // None of the nine should have been sent back to a "start a new session" prompt.
        for (let tabId = 502; tabId < nextTabId; tabId++) {
            expectNoRedirect(tabId);
        }

        // And no video's watch record should have been lost to a read/write race.
        const session = global.__store__.activeSessions['youtube.com'];
        expect(session).toBeDefined();
        expect(session.watchedVideoIds).toEqual(expect.arrayContaining(allVideos));
        expect(session.videosWatched).toBe(9);
    },
    15000,
);

test(
    'Human-paced: an active duration session survives several new videos opened in quick succession',
    async () => {
        const TAB_A = 511;
        const TAB_B = 512;
        const TAB_C = 513;

        await nav(TAB_A, YT_HOME);
        global.__mockFns__['tabs.update'].mockClear();
        await humanStartsDurationSession(YT_HOME, 30);
        await humanDelay(80, 200);
        await nav(TAB_A, YT_HOME);
        expectNoRedirect(TAB_A);

        await humanDelay(1500, 2500);

        const navPromises = [nav(TAB_B, VIDEO('eee555'))];
        await humanDelay(10, 40);
        navPromises.push(nav(TAB_C, VIDEO('fff666')));
        await Promise.all(navPromises);

        expectNoRedirect(TAB_B);
        expectNoRedirect(TAB_C);
        // Duration sessions don't track individual videos, but the session record itself must
        // still exist afterward — not have been silently dropped by a concurrent write.
        expect(global.__store__.activeSessions['youtube.com']).toBeDefined();
        expect(global.__store__.activeSessions['youtube.com'].type).toBe('duration');
    },
    15000,
);

test(
    'Human-paced: opening tabs to two different domains at once processes both correctly (no unnecessary cross-domain blocking)',
    async () => {
        const now = Date.now();
        setStorage({
            activeSessions: {
                'youtube.com': { type: 'duration', startTime: now, endTime: now + 30 * 60000 },
                'instagram.com': { type: 'duration', startTime: now, endTime: now + 30 * 60000 },
            },
        });

        const TAB_YT = 521;
        const TAB_IG = 522;

        // A human alt-tabbing between two already-permitted sites in quick succession —
        // different domains should never need to wait on each other.
        const navPromises = [nav(TAB_YT, VIDEO('ggg777'))];
        await humanDelay(20, 80);
        navPromises.push(nav(TAB_IG, IG_HOME));
        await Promise.all(navPromises);

        expectNoRedirect(TAB_YT);
        expectNoRedirect(TAB_IG);
    },
    15000,
);
