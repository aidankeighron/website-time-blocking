// Regression coverage for a real, live-confirmed bug (BLOCKING_UI_BUG_HANDOFF.md): opening a
// new tab and typing into the omnibox routes through Chrome's OWN new-tab-page + search-warmup
// chain — chrome://newtab/ -> chrome-untrusted://new-tab-page/... -> google.com/search/
// warmup.html -> the real destination — as ordinary onUpdated/onCommitted events on ONE tab,
// no tab replacement involved. None of those intermediate pages are target sites, so nothing
// blocks them, but the processingTabs debounce lock they leave behind (meant only to swallow
// duplicate events for the SAME in-flight navigation) used to also swallow the real
// destination's own event if it arrived within that same 1-second window — which it reliably
// does once caches are warm. A real repro showed this: the very first navigation after an
// extension reload was slow enough to slip past the window and got blocked correctly; every
// navigation after that was fast enough to land inside it and was silently never checked at
// all. Fixed by gating the debounce on the domain actually being processed (lastCheckedDomain,
// later narrowed to lastCheckedNavKey — see below), not just the tab id.
//
// A second, related bug (same lock, opposite direction) is covered further down: domain alone
// is too coarse WITHIN a single target site. YouTube's watch page fires its own pushState/
// replaceState calls for in-page UI state, all still on youtube.com — if one of those raced a
// user's real click to the homepage, the domain-only lock swallowed the homepage's own event,
// letting the stray video-page check "win" and get embedded as the blocked URL. Completing the
// blocking flow then sent the user back to the stale video instead of forward to the homepage
// they'd actually clicked toward. Fixed by keying the debounce on domain+path+query
// (lastCheckedNavKey / getNavKey) instead of domain alone.

const {
    loadBackground, fireUpdated, setStorage,
    expectPromptRedirect, lastRedirectUrl, NOW,
} = require('./helpers');

const TAB = 500;
const YT_SUBS = 'https://www.youtube.com/feed/subscriptions';

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'reddit.com', 'youtube.com'] });
});

test('a different domain arriving inside the debounce window is not swallowed', async () => {
    // Simulates Chrome's own new-tab-page chain: a non-target-site navigation locks
    // processingTabs for TAB, then — well before that lock's 1-second debounce would
    // naturally expire — the REAL destination arrives as a separate, later event.
    await fireUpdated(TAB, { url: 'chrome://newtab/', status: 'loading' }, { url: 'chrome://newtab/', status: 'loading' });
    await fireUpdated(TAB, { url: YT_SUBS, status: 'loading' }, { url: YT_SUBS, status: 'loading' });

    expectPromptRedirect(TAB);
});

test('a genuine duplicate event for the SAME domain is still debounced (checkAccess not re-run)', async () => {
    // Active session so the check resolves to "allowed" — no redirect, no pendingPromptTabs —
    // isolating the domain-debounce behavior itself rather than the separate pendingPromptTabs
    // "ignore intermediate hop" path that would otherwise also swallow a same-domain repeat.
    setStorage({
        activeSessions: {
            'youtube.com': { type: 'duration', startTime: NOW - 60000, endTime: NOW + 300000 },
        },
    });
    const getSpy = jest.spyOn(chrome.storage.local, 'get');

    await fireUpdated(TAB, { url: YT_SUBS, status: 'loading' }, { url: YT_SUBS, status: 'loading' });
    await fireUpdated(TAB, { url: YT_SUBS, status: 'loading' }, { url: YT_SUBS, status: 'loading' });

    // checkAccessSerialized reads 'activeSessions' — should only happen once, not twice, since
    // the second event is a genuine duplicate for the same domain within the debounce window.
    const checkAccessCalls = getSpy.mock.calls.filter(
        ([keys]) => Array.isArray(keys) && keys.includes('activeSessions')
    );
    expect(checkAccessCalls.length).toBe(1);

    getSpy.mockRestore();
});

test('a different URL on the SAME domain racing an in-flight check is not swallowed (video -> homepage)', async () => {
    // Reproduces the reported bug: no active session/cooldown (fully expired), so a stray
    // SPA event on the video page itself (e.g. YouTube's own in-page pushState/replaceState
    // churn) would resolve to "no session/no cooldown -> fresh prompt" for the VIDEO url. If the
    // user's real click to the homepage lands moments later, while that first check is still
    // in flight (i.e. before its 1-second processingTabs lock naturally clears), the domain-only
    // debounce used to swallow the homepage's own event — leaving the stale video URL embedded
    // as the blocked destination instead.
    const VIDEO_URL = 'https://www.youtube.com/watch?v=abc123';
    const HOME_URL = 'https://www.youtube.com/';

    const handlers = global.__listeners__.onCommitted;
    // Fire both events back-to-back WITHOUT awaiting the first — mirrors the real race, where
    // the stray video-page event is still mid-check (its synchronous debounce-lock prefix has
    // run, but its awaited checkAccessSerialized hasn't resolved yet) when the homepage click's
    // event arrives.
    const p1 = Promise.all(handlers.map(fn => fn({ tabId: TAB, url: VIDEO_URL, frameId: 0 })));
    const p2 = Promise.all(handlers.map(fn => fn({ tabId: TAB, url: HOME_URL, frameId: 0 })));
    await Promise.all([p1, p2]);

    // The tab must end up pointed at the REAL destination (the homepage) — not stuck on
    // whatever stale URL the first, in-flight check happened to be for.
    const redirectedUrl = lastRedirectUrl();
    expect(redirectedUrl).toBeTruthy();
    const intendedUrl = new URL(redirectedUrl).searchParams.get('url');
    expect(intendedUrl).toBe(HOME_URL);
});
