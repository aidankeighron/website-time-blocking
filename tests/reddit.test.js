const {
    loadBackground, fireUpdated, setStorage,
    expectPromptRedirect, expectNoRedirect, NOW,
} = require('./helpers');

const TAB = 11;
const REDDIT_HOME = 'https://www.reddit.com/';
const REDDIT_POPULAR = 'https://www.reddit.com/r/popular/';
const POST_A = 'https://www.reddit.com/r/programming/comments/abc123/some_title/';
const POST_A_ALT = 'https://www.reddit.com/r/programming/comments/abc123/'; // no trailing slug
const POST_B = 'https://www.reddit.com/r/gaming/comments/xyz789/other_post/';

function nav(url) {
    return fireUpdated(TAB, { url }, { url, status: 'loading' });
}

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'reddit.com', 'youtube.com'] });
});

// ── 1. Homepage blocked ──────────────────────────────────────────────────────
test('Reddit homepage: no session redirects to prompt', async () => {
    await nav(REDDIT_HOME);
    expectPromptRedirect(TAB);
});

// ── 2. Subreddit page also blocked ──────────────────────────────────────────
test('Reddit subreddit page: no session redirects to prompt', async () => {
    await nav(REDDIT_POPULAR);
    expectPromptRedirect(TAB);
});

// ── 3. Post page blocked ─────────────────────────────────────────────────────
test('Reddit post: no session redirects to prompt', async () => {
    await nav(POST_A);
    expectPromptRedirect(TAB);
});

// ── 4. Active duration session allows all Reddit pages ──────────────────────
test('Reddit: active duration session allows homepage', async () => {
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'duration',
                startTime: NOW - 60000,
                endTime: NOW + 300000,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(REDDIT_HOME);
    expectNoRedirect(TAB);
});

test('Reddit: active duration session allows post page', async () => {
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'duration',
                startTime: NOW - 60000,
                endTime: NOW + 300000,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(POST_A);
    expectNoRedirect(TAB);
});

// ── 5. Single-URL session on a post allows same post (same post ID) ──────────
test('Reddit: single_url session allows matching post URL', async () => {
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: POST_A,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(POST_A);
    expectNoRedirect(TAB);
});

// ── 6. Single-URL session: different URL format but same post ID is allowed ──
test('Reddit: single_url session matches same post ID with different slug', async () => {
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: POST_A,
                timeRangeLastCheck: NOW,
            },
        },
    });
    // POST_A_ALT has the same post ID (abc123) but no trailing title slug
    await nav(POST_A_ALT);
    expectNoRedirect(TAB);
});

// ── 7. Single-URL session: different post ID is blocked ──────────────────────
test('Reddit: single_url session blocks navigation to a different post', async () => {
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: POST_A,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(POST_B);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Finished');
});

// ── 8. Single-URL session: navigating to homepage ends session + blocks ──────
test('Reddit: single_url session blocks navigation to homepage', async () => {
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: POST_A,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(REDDIT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Finished');
});

// ── 9. Cooldown active → cooldown redirect ───────────────────────────────────
test('Reddit: active cooldown redirects to cooldown UI', async () => {
    setStorage({
        cooldowns: {
            'reddit.com': { startTime: NOW - 5 * 60 * 1000, duration: 30 * 60 * 1000, originalType: 'duration' },
        },
    });
    await nav(REDDIT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('cooldown=');
});

// ── 10. Expired cooldown → fresh prompt ─────────────────────────────────────
test('Reddit: expired cooldown leads to fresh prompt', async () => {
    setStorage({
        cooldowns: {
            'reddit.com': { startTime: NOW - 60 * 60 * 1000, duration: 30 * 60 * 1000 },
        },
    });
    await nav(REDDIT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).not.toContain('cooldown=');
});

// ── 11. Duration session expired → Time Up + cooldown ───────────────────────
test('Reddit: expired duration session shows Time Up and starts cooldown', async () => {
    const endTime = NOW - 5 * 60 * 1000;
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'duration',
                startTime: NOW - 35 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await nav(REDDIT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Time%20Up');
    // Cooldown should have been written to storage
    const s = global.__store__;
    expect(s.cooldowns && s.cooldowns['reddit.com']).toBeTruthy();
});

// ── 12. Session fully expired (past cooldown) → Session Expired ──────────────
test('Reddit: session + cooldown both expired shows Session Expired', async () => {
    const endTime = NOW - 120 * 60 * 1000;
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'duration',
                startTime: NOW - 160 * 60 * 1000,
                endTime,
                timeRangeLastCheck: endTime,
            },
        },
        durationCooldown: 30,
    });
    await nav(REDDIT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('Session%20Expired');
});

// ── 13. After single_url ends, accessing another post requires new prompt ────
test('Reddit: after single_url ends, next post visit requires new session', async () => {
    setStorage({
        activeSessions: {
            'reddit.com': {
                type: 'single_url',
                startTime: NOW,
                targetUrl: POST_A,
                timeRangeLastCheck: NOW,
            },
        },
    });
    // Navigate away — session ends and tab gets redirected to prompt
    await nav(POST_B);
    // Verify session was deleted from storage
    const s = global.__store__;
    expect(s.activeSessions?.['reddit.com']).toBeFalsy();

    // Visiting POST_B now requires a new session.
    await fireUpdated(TAB, { url: POST_B }, { url: POST_B, status: 'loading' });
    expectPromptRedirect(TAB);
});
