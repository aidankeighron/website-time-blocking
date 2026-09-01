// Regression coverage for Defect A (BLOCKING_UI_BUG_HANDOFF.md): chrome.tabs.onReplaced fires
// when Chrome swaps in a prerendered omnibox/autocomplete suggestion under a new tab ID. The
// handler used to bail permanently if tab.url was momentarily empty at that instant (a real
// race during the swap) with no retry — silently skipping the access check forever for that
// navigation. It now retries via a scoped onUpdated listener (with a bounded fallback poll).
//
// This cannot prove real Chrome ever actually produces an empty tab.url during a real prerender
// swap — only that once it does, the extension no longer gives up silently.

const {
    loadBackground, fireUpdated, fireReplaced, setStorage,
    expectPromptRedirect, expectNoRedirect, flushPromises,
} = require('./helpers');

const OLD_TAB = 900;
const NEW_TAB = 901;
const YT_HOME = 'https://www.youtube.com/';

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'reddit.com', 'youtube.com'] });
});

test('onReplaced blocks immediately when tab.url is already populated', async () => {
    __mockFns__['tabs.get'].mockResolvedValueOnce({ url: YT_HOME });
    await fireReplaced(NEW_TAB, OLD_TAB);
    expectPromptRedirect(NEW_TAB);
});

test('onReplaced treats an already-populated transient URL (e.g. chrome://newtab/) the same as empty — waits for the real destination', async () => {
    // Live-confirmed bug: a swapped-in tab's URL legitimately passes through the browser's OWN
    // internal placeholder pages (chrome://newtab/, search warmup, etc.) before reaching the
    // site the user actually typed. Treating the first non-empty URL as "resolved" meant
    // resolving on the placeholder and never checking the real destination at all.
    __mockFns__['tabs.get'].mockResolvedValueOnce({ url: 'chrome://newtab/' });
    const replacedPromise = fireReplaced(NEW_TAB, OLD_TAB);
    await flushPromises();

    await fireUpdated(NEW_TAB, { url: YT_HOME, status: 'complete' }, { url: YT_HOME, status: 'complete' });
    await replacedPromise;

    expectPromptRedirect(NEW_TAB);
});

test('onReplaced does not resolve early on a transient chrome://newtab/ placeholder delivered via onUpdated — keeps waiting for the real destination', async () => {
    __mockFns__['tabs.get'].mockResolvedValueOnce({ url: '' });
    const replacedPromise = fireReplaced(NEW_TAB, OLD_TAB);
    await flushPromises();

    // The transient placeholder arrives first as a genuine onUpdated event — must NOT be
    // treated as the resolved destination.
    await fireUpdated(NEW_TAB, { url: 'chrome://newtab/', status: 'complete' }, { url: 'chrome://newtab/', status: 'complete' });
    expectNoRedirect(NEW_TAB);

    // The real destination arrives moments later — this is what should resolve the retry.
    await fireUpdated(NEW_TAB, { url: YT_HOME, status: 'complete' }, { url: YT_HOME, status: 'complete' });
    await replacedPromise;

    expectPromptRedirect(NEW_TAB);
});

test('onReplaced retries via the tab\'s own next onUpdated event when tab.url is momentarily empty', async () => {
    // Default mock (see tests/setup.js) already resolves tabs.get to { url: '' }, simulating
    // the race. Kick off onReplaced without awaiting yet — it will register a scoped listener
    // for NEW_TAB and then block on it internally.
    const replacedPromise = fireReplaced(NEW_TAB, OLD_TAB);
    await flushPromises(); // let onReplaced's tabs.get resolve and the scoped listener register

    // The tab's URL populates shortly after, delivered as a normal onUpdated event — exactly
    // what would happen once Chrome finishes settling the swapped-in tab.
    await fireUpdated(NEW_TAB, { url: YT_HOME, status: 'complete' }, { url: YT_HOME, status: 'complete' });
    await replacedPromise;

    expectPromptRedirect(NEW_TAB);
});

test('onReplaced retry does not double-process: the top-level onUpdated listener stays silent while retry is pending', async () => {
    const replacedPromise = fireReplaced(NEW_TAB, OLD_TAB);
    await flushPromises();

    await fireUpdated(NEW_TAB, { url: YT_HOME, status: 'complete' }, { url: YT_HOME, status: 'complete' });
    await replacedPromise;

    // Exactly one prompt redirect for NEW_TAB, not two (one from the scoped retry listener and
    // a duplicate from the top-level onUpdated listener racing it).
    const redirects = __mockFns__['tabs.update'].mock.calls.filter(
        ([id, opts]) => id === NEW_TAB && opts.url && opts.url.includes('prompt.html')
    );
    expect(redirects.length).toBe(1);
});

test('onReplaced falls back to a bounded poll if the scoped onUpdated listener never fires', async () => {
    // tabs.get keeps resolving empty on the initial check; the fallback poll's own tabs.get
    // call (~2500ms later) is the one that finally reports a real URL.
    __mockFns__['tabs.get']
        .mockResolvedValueOnce({ url: '' })   // onReplaced's initial check
        .mockResolvedValueOnce({ url: YT_HOME }); // the fallback poll

    await fireReplaced(NEW_TAB, OLD_TAB);
    expectPromptRedirect(NEW_TAB);
}, 6000);

test('onReplaced fallback poll also treats a still-transient URL as "not resolved" and gives up', async () => {
    __mockFns__['tabs.get']
        .mockResolvedValueOnce({ url: '' })
        .mockResolvedValueOnce({ url: 'chrome://newtab/' }); // still just the placeholder at poll time

    await fireReplaced(NEW_TAB, OLD_TAB);
    expectNoRedirect(NEW_TAB);
}, 6000);

test('onReplaced gives up quietly (no crash, no stuck lock) if the tab is gone by the fallback poll', async () => {
    __mockFns__['tabs.get']
        .mockResolvedValueOnce({ url: '' })
        .mockRejectedValueOnce(new Error('No tab with id'));

    await fireReplaced(NEW_TAB, OLD_TAB); // ~2.5s: waits out the fallback poll internally
    expectNoRedirect(NEW_TAB);

    // The lock must not be left stuck — a subsequent normal navigation on a reused tab id
    // should still be checked. processingTabs is held for the retry window plus a further 1s
    // debounce release (see the `finally` in the onReplaced handler), so wait that out too.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fireUpdated(NEW_TAB, { url: YT_HOME, status: 'complete' }, { url: YT_HOME, status: 'complete' });
    expectPromptRedirect(NEW_TAB);
}, 9000);
