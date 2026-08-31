// Regression coverage for Defect B (BLOCKING_UI_BUG_HANDOFF.md): redirectToPrompt used to
// verify its own redirect landed via a bare setTimeout, which isn't guaranteed to survive
// MV3 service-worker eviction. If dropped, pendingPromptTabs stayed stuck true forever, and
// every subsequent real navigation event for that tab was silently ignored (no re-block, no
// logging). It's now replaced by backstopPendingTab, invoked directly from the navigation
// listeners themselves whenever a pending tab's next event reports settling somewhere that
// isn't the prompt page — which can't be dropped by worker eviction, since it only runs when
// the worker is alive to receive the event in the first place.
//
// This test fires the exact problematic sequence directly (redirect issued, then a competing
// navigation "wins" and lands the tab somewhere else before it ever committed to prompt.html)
// — the real browser race this defends against (a redirect-chain hop, or a prerendered tab
// swap) can't be forced deterministically through Playwright, but the resulting internal state
// (pendingPromptTabs true, tabsCurrentlyAtPrompt false, a real navigation event arrives) is
// exactly what this simulates.

const {
    loadBackground, fireUpdated, setStorage,
    expectPromptRedirect, expectNoRedirect, NOW,
} = require('./helpers');

const TAB = 700;
const VIDEO_A = 'https://www.youtube.com/watch?v=aaa111';
const VIDEO_B = 'https://www.youtube.com/watch?v=bbb222';

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'reddit.com', 'youtube.com'] });
});

test('a redirect that never lands is corrected by the tab\'s own next settled navigation', async () => {
    setStorage({
        cooldowns: { 'youtube.com': { startTime: NOW, duration: 30 * 60 * 1000, originalType: 'duration' } },
    });

    // Navigate to a blocked page — checkAccess runs, redirectToPrompt fires tabs.update() to
    // prompt.html and marks the tab pending. We deliberately do NOT fire the follow-up
    // onUpdated event reporting arrival at prompt.html, simulating the tab's own competing
    // navigation winning that race instead.
    await fireUpdated(TAB, { url: VIDEO_A, status: 'loading' }, { url: VIDEO_A, status: 'loading' });
    expectPromptRedirect(TAB);
    __mockFns__['tabs.update'].mockClear();

    // The tab settles somewhere else entirely (still the blocked domain, but not prompt.html) —
    // exactly the shape of a real redirect-chain hop winning against our tabs.update() call.
    await fireUpdated(TAB, { url: VIDEO_B, status: 'complete' }, { url: VIDEO_B, status: 'complete' });

    // Must still end up blocked — not silently stranded on VIDEO_B forever.
    expectPromptRedirect(TAB);
});

test('the backstop does not re-block a tab that legitimately gained access in the meantime', async () => {
    // No cooldown/session yet — first navigation gets blocked and marked pending.
    await fireUpdated(TAB, { url: VIDEO_A, status: 'loading' }, { url: VIDEO_A, status: 'loading' });
    expectPromptRedirect(TAB);
    __mockFns__['tabs.update'].mockClear();

    // A session starts for this domain in the meantime (e.g. via another tab's picker, or a
    // sync from startSession) — access is now legitimately allowed.
    setStorage({
        activeSessions: {
            'youtube.com': { type: 'duration', startTime: NOW, endTime: NOW + 300000 },
        },
    });

    // The tab settles on a real URL without ever having visibly landed on prompt.html.
    await fireUpdated(TAB, { url: VIDEO_B, status: 'complete' }, { url: VIDEO_B, status: 'complete' });

    // Must NOT be redirected back to the block screen — this is the exact regression the
    // "real decision logic, never a stale URL comparison" constraint (see backstopPendingTab
    // and BLOCKING_UI_BUG_HANDOFF.md) exists to prevent.
    expectNoRedirect(TAB);
});

test('intermediate loading hops while pending are ignored, not treated as a settled destination', async () => {
    setStorage({
        cooldowns: { 'youtube.com': { startTime: NOW, duration: 30 * 60 * 1000, originalType: 'duration' } },
    });

    await fireUpdated(TAB, { url: VIDEO_A, status: 'loading' }, { url: VIDEO_A, status: 'loading' });
    expectPromptRedirect(TAB);
    __mockFns__['tabs.update'].mockClear();

    // A mid-chain 'loading' event for a different URL — must be ignored, not treated as the
    // navigation having settled (which would otherwise re-issue a redirect prematurely and
    // race a second, still in-flight hop).
    await fireUpdated(TAB, { url: VIDEO_B, status: 'loading' }, { url: VIDEO_B, status: 'loading' });
    expectNoRedirect(TAB);
});
