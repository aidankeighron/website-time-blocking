// Cross-site and shared flows: time ranges, pendingPromptTabs, alarms, startSession message.
const {
    loadBackground, fireUpdated, fireRemoved, fireAlarm, setStorage,
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
// Time range blocking
// ────────────────────────────────────────────────────────────────────────────

function activeRangeStorage(overrideUsed) {
    // A range from 00:00 to 23:59 (covers all times) with 1-minute limit
    const now = new Date(NOW);
    const dateKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    return {
        timeRanges: [{
            id: 'range1',
            startHour: 0, startMinute: 0,
            endHour: 23, endMinute: 59,
            limitMinutes: 1,
        }],
        timeRangeUsage: {
            range1: { dateKey, usedSeconds: overrideUsed },
        },
    };
}

test('Time range limit exhausted blocks site even with active session', async () => {
    setStorage({
        ...activeRangeStorage(120), // 120s used > 60s limit
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: NOW - 60000,
                endTime: NOW + 300000,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('TIME_RANGE');
    expect(url).toContain('range1');
});

test('Time range limit exhausted blocks YouTube with no session', async () => {
    setStorage(activeRangeStorage(120));
    await nav(TAB, YT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('TIME_RANGE');
});

test('Time range not yet exhausted allows access for site with active session', async () => {
    setStorage({
        ...activeRangeStorage(10), // only 10s of 60s limit used
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: NOW - 60000,
                endTime: NOW + 300000,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(TAB, IG_HOME);
    expectNoRedirect(TAB);
});

test('Time range alarm fires and redirects all target tabs', async () => {
    setStorage({
        ...activeRangeStorage(120),
        targetSites: ['instagram.com', 'reddit.com', 'youtube.com'],
    });
    __mockFns__['tabs.query'].mockResolvedValue([
        { id: 20, url: YT_HOME },
        { id: 21, url: IG_HOME },
        { id: 22, url: 'https://www.google.com/' }, // not a target
    ]);

    await fireAlarm({ name: 'timerange_range1' });

    const calls = __mockFns__['tabs.update'].mock.calls;
    const tabIds = calls.map(([id]) => id);
    expect(tabIds).toContain(20);
    expect(tabIds).toContain(21);
    expect(tabIds).not.toContain(22);

    const ytCall = calls.find(([id]) => id === 20);
    expect(ytCall[1].url).toContain('TIME_RANGE');
});

// ────────────────────────────────────────────────────────────────────────────
// pendingPromptTabs race condition prevention
// ────────────────────────────────────────────────────────────────────────────

test('pendingPromptTabs: stale status:complete after redirect does not double-prompt', async () => {
    // First event — no session → redirect
    await nav(TAB, YT_HOME);
    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(1);

    // Stale status event (no changeInfo.url) arrives while tab is at prompt.html
    await fireUpdated(TAB, { status: 'complete' }, { url: YT_HOME });
    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(1); // still only 1

    // And a loading event
    await fireUpdated(TAB, { status: 'loading' }, { url: YT_HOME });
    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(1);
});

test('pendingPromptTabs: fresh URL navigation away from prompt clears pending state', async () => {
    // Redirect to prompt
    await nav(TAB, YT_HOME);
    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(1);

    // User starts a session — simulate what prompt.js does: sends startSession message,
    // then calls window.location.replace(intendedUrl) which fires a changeInfo.url event
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

    // The replace fires a new URL navigation event — should clear pendingPromptTabs
    // and then isTargetSite check should find an active session → no redirect
    await fireUpdated(TAB, { url: YT_HOME }, { url: YT_HOME });
    // Active session exists → should be allowed (no new redirect)
    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(1);
});

test('pendingPromptTabs: tab removed cleans up state', async () => {
    await nav(TAB, YT_HOME);
    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(1);

    // Tab is closed
    fireRemoved(TAB);

    // Open a new tab with the same ID (unlikely but tests cleanup)
    await nav(TAB, YT_HOME);
    // Should redirect again since pendingPromptTabs was cleared on removal
    expect(__mockFns__['tabs.update'].mock.calls.length).toBe(2);
});

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

test('startSession message creates count session without alarm', async () => {
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
    expect(__mockFns__['alarms.create'].mock.calls.length).toBe(0);
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
