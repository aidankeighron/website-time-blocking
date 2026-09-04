// Cross-site and shared flows: pendingPromptTabs, alarms, startSession message.
// Scheduled-limit blocking behavior lives in tests/scheduled-limits.test.js.
const {
    loadBackground, fireUpdated, fireRemoved, fireCommitted, setStorage,
    expectPromptRedirect, expectNoRedirect, flushPromises, NOW,
} = require('./helpers');

const TAB = 13;
const IG_HOME = 'https://www.instagram.com/';
const YT_HOME = 'https://www.youtube.com/';
const YT_VIDEO = 'https://www.youtube.com/watch?v=aaa111';

function nav(tabId, url) {
    return fireUpdated(tabId, { url }, { url, status: 'loading' });
}

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'reddit.com', 'youtube.com'] });
});

// ────────────────────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────────────────────
// startSession message handler
// ────────────────────────────────────────────────────────────────────────────

test('startSession message creates duration session and sets alarm', async () => {
    const response = await new Promise((resolve) => {
        global.__listeners__.onMessage.forEach(fn =>
            fn(
                { action: 'startSession', url: YT_HOME, type: 'duration', value: 10 },
                { tab: { id: TAB } },
                resolve
            )
        );
    });
    expect(response.success).toBe(true);
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].type).toBe('duration');
    expect(s.activeSessions['youtube.com'].durationMinutes).toBe(10);
    expect(s.activeSessions['youtube.com'].endTime).toBeGreaterThan(NOW);
    // Alarm should have been created
    expect(__mockFns__['alarms.create'].mock.calls.length).toBeGreaterThan(0);
    const alarmArgs = __mockFns__['alarms.create'].mock.calls[0];
    expect(alarmArgs[0]).toBe('session_youtube.com');
});

test('startSession message creates count session and sets an inactivity backstop alarm', async () => {
    const response = await new Promise((resolve) => {
        global.__listeners__.onMessage.forEach(fn =>
            fn(
                { action: 'startSession', url: YT_VIDEO, type: 'count', value: 5 },
                { tab: { id: TAB } },
                resolve
            )
        );
    });
    expect(response.success).toBe(true);
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].type).toBe('count');
    expect(s.activeSessions['youtube.com'].targetCount).toBe(5);
    // count_inactivity_<domain> alarm should have been created as the proactive backstop for
    // the lazy navigation-triggered inactivity check.
    const alarmArgs = __mockFns__['alarms.create'].mock.calls[0];
    expect(alarmArgs[0]).toBe('count_inactivity_youtube.com');
});

test('startSession message creates single_url session', async () => {
    const response = await new Promise((resolve) => {
        global.__listeners__.onMessage.forEach(fn =>
            fn(
                { action: 'startSession', url: YT_VIDEO, type: 'single_url', value: YT_VIDEO },
                { tab: { id: TAB } },
                resolve
            )
        );
    });
    expect(response.success).toBe(true);
    const s = global.__store__;
    expect(s.activeSessions['youtube.com'].type).toBe('single_url');
    expect(s.activeSessions['youtube.com'].targetUrl).toBe(YT_VIDEO);
});

// ────────────────────────────────────────────────────────────────────────────
// Multi-tab domain session sharing
// ────────────────────────────────────────────────────────────────────────────

test('Single domain session shared across multiple tabs', async () => {
    setStorage({
        activeSessions: {
            'youtube.com': {
                type: 'duration',
                startTime: NOW,
                endTime: NOW + 300000,
                timeRangeLastCheck: NOW,
            },
        },
    });
    // Both tabs should be allowed through without redirect
    await nav(TAB, YT_HOME);
    await nav(TAB + 1, YT_VIDEO);
    expectNoRedirect(TAB);
    expectNoRedirect(TAB + 1);
});

// ────────────────────────────────────────────────────────────────────────────
// Non-target site ignored
// ────────────────────────────────────────────────────────────────────────────

test('Non-target sites are not blocked even with no sessions', async () => {
    await nav(TAB, 'https://www.google.com/');
    await nav(TAB, 'https://news.ycombinator.com/');
    await nav(TAB, 'https://www.github.com/');
    expectNoRedirect(TAB);
});

// ────────────────────────────────────────────────────────────────────────────
// Custom targetSites configuration
// ────────────────────────────────────────────────────────────────────────────

test('Custom targetSites: only configured domains are blocked', async () => {
    setStorage({ targetSites: ['instagram.com'] }); // only Instagram
    // Instagram blocked
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    __mockFns__['tabs.update'].mockClear();

    // YouTube NOT blocked (not in targetSites)
    await nav(TAB, YT_HOME);
    expectNoRedirect(TAB);
});

// ────────────────────────────────────────────────────────────────────────────
// Prompt URL itself is never processed
// ────────────────────────────────────────────────────────────────────────────

test('Navigation to prompt.html itself does not trigger another redirect', async () => {
    const promptUrl = `chrome-extension://fakeid/prompt.html?url=${encodeURIComponent(YT_HOME)}`;
    await fireUpdated(TAB, { url: promptUrl }, { url: promptUrl });
    expectNoRedirect(TAB);
});

// ────────────────────────────────────────────────────────────────────────────
// Rapid duplicate navigation events are debounced.
// Regression coverage for the "infinite reloading" bug: sites (and Firefox itself) can fire
// many onUpdated/onCommitted events per navigation, and without a per-tab debounce lock each
// one independently re-issues its own redirect to prompt.html — which itself triggers more
// onUpdated events — a flicker loop that can take minutes to settle before the block sticks.
// ────────────────────────────────────────────────────────────────────────────

test('Rapid duplicate onUpdated events for the same tab only trigger one redirect', async () => {
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const callsAfterFirst = __mockFns__['tabs.update'].mock.calls.length;

    // Simulate the same navigation firing more onUpdated events before the debounce lock has
    // cleared (e.g. status changes, favicon updates, or an SPA route change).
    await nav(TAB, IG_HOME);
    await nav(TAB, IG_HOME);

    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(callsAfterFirst);
});

test('A redirect-chain event (site.com -> www.site.com) arriving before the prompt commits does not trigger a second redirect', async () => {
    await nav(TAB, 'https://instagram.com/');
    expectPromptRedirect(TAB);
    const callsAfterFirst = __mockFns__['tabs.update'].mock.calls.length;

    // Browser's own www-redirect for the ORIGINAL site fires before the tab has actually
    // committed to prompt.html.
    await nav(TAB, IG_HOME);

    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(callsAfterFirst);
});

test('After committing to prompt.html and starting a session, navigating back to the site is re-checked and allowed', async () => {
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);

    // Browser actually commits the navigation to prompt.html.
    const promptUrl = `chrome-extension://fakeid/prompt.html?url=${encodeURIComponent(IG_HOME)}`;
    await fireUpdated(TAB, { url: promptUrl }, { url: promptUrl });

    // User starts a session; the prompt page then navigates back to the real site.
    setStorage({
        activeSessions: {
            'instagram.com': { type: 'duration', startTime: NOW, endTime: NOW + 300000 },
        },
    });
    __mockFns__['tabs.update'].mockClear();
    await nav(TAB, IG_HOME);

    // Session is active, so checkAccess allows it through — no further redirect to prompt.
    expectNoRedirect(TAB);
});
