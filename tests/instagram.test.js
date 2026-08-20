const {
    loadBackground, fireUpdated, setStorage, clearStorage,
    expectPromptRedirect, expectNoRedirect, flushPromises, NOW,
} = require('./helpers');

const TAB = 10;
const IG_HOME = 'https://www.instagram.com/';
const IG_POST = 'https://www.instagram.com/p/ABC123/';
const PROMPT_BASE = 'chrome-extension://fakeid/prompt.html';

function nav(url) {
    return fireUpdated(TAB, { url }, { url, status: 'loading' });
}

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    // Default: instagram.com is a target site
    setStorage({ targetSites: ['instagram.com', 'reddit.com', 'youtube.com'] });
});

// ── 1. No session → redirect to prompt ─────────────────────────────────────
test('Instagram homepage: no session redirects to prompt', async () => {
    await nav(IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('prompt.html');
    expect(url).toContain(encodeURIComponent(IG_HOME));
});

// ── 2. Post URL also blocked ────────────────────────────────────────────────
test('Instagram post: no session redirects to prompt', async () => {
    await nav(IG_POST);
    expectPromptRedirect(TAB);
});

// ── 3. Active duration session → access allowed ────────────────────────────
test('Instagram: active duration session allows access', async () => {
    setStorage({
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: NOW - 60000,
                endTime: NOW + 300000, // 5 min remaining
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(IG_HOME);
    expectNoRedirect(TAB);
});

// ── 4. Expired duration session (still in cooldown window) → cooldown UI ───
test('Instagram: expired session in cooldown window shows cooldown', async () => {
    const endTime = NOW - 60000; // ended 1 min ago
    setStorage({
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: NOW - 360000,
                endTime,
                timeRangeLastCheck: NOW - 60000,
            },
        },
        durationCooldown: 30,
    });
    await nav(IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    // Should be a cooldown redirect (msg=Time%20Up) not a fresh prompt
    expect(url).toContain('Time%20Up');
});

// ── 5. Session fully expired (past cooldown) → fresh prompt ─────────────────
test('Instagram: session + cooldown both expired shows fresh prompt', async () => {
    const endTime = NOW - 200 * 60 * 1000; // ended 200 min ago
    setStorage({
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: NOW - 260 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await nav(IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Session%20Expired');
});

// ── 6. Active cooldown (no session) → cooldown redirect ─────────────────────
test('Instagram: active cooldown (no session) redirects to cooldown UI', async () => {
    const cooldownDuration = 30 * 60 * 1000;
    setStorage({
        cooldowns: {
            'instagram.com': { startTime: NOW - 60000, duration: cooldownDuration, originalType: 'duration' },
        },
    });
    await nav(IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('cooldown=');
});

// ── 7. Expired cooldown → fresh prompt ──────────────────────────────────────
test('Instagram: expired cooldown results in fresh prompt', async () => {
    setStorage({
        cooldowns: {
            'instagram.com': { startTime: NOW - 60 * 60 * 1000, duration: 30 * 60 * 1000 },
        },
    });
    await nav(IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    // Fresh prompt — no cooldown param, no Session Expired
    expect(url).not.toContain('cooldown=');
    expect(url).not.toContain('Session%20Expired');
});

// ── 8. Single-URL session for a post allows that post ──────────────────────
test('Instagram: single_url session allows the target post', async () => {
    setStorage({
        activeSessions: {
            'instagram.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: IG_POST,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(IG_POST);
    expectNoRedirect(TAB);
});

// ── 9. Single-URL session navigating to homepage ends session + blocks ──────
test('Instagram: single_url session blocks navigation to different page', async () => {
    setStorage({
        activeSessions: {
            'instagram.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: IG_POST,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Finished');
});

// ── 10. Non-target site is not blocked ──────────────────────────────────────
test('Non-target site (example.com) is not redirected', async () => {
    await nav('https://www.example.com/');
    expectNoRedirect(TAB);
});



// ── 13. Different tabs are processed independently ───────────────────────────
test('Instagram: two different tabs are both redirected independently', async () => {
    await nav(IG_HOME); // TAB = 10
    await fireUpdated(20, { url: IG_HOME }, { url: IG_HOME, status: 'loading' });
    // Both tabs should get their own redirect
    const tabIds = __mockFns__['tabs.update'].mock.calls.map(([id]) => id);
    expect(tabIds).toContain(TAB);
    expect(tabIds).toContain(20);
});
