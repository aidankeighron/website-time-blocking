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
// all. Fixed by gating the debounce on the domain actually being processed (lastCheckedDomain),
// not just the tab id.

const {
    loadBackground, fireUpdated, setStorage,
    expectPromptRedirect, NOW,
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
