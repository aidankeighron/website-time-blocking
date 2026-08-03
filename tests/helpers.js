// Shared helpers for E2E tests.
// Each test file calls loadBackground() in beforeEach to get a fresh module instance.

const path = require('path');
const BG_PATH = path.resolve(__dirname, '../background.js');

// Re-require background.js so its module-level state (processingTabs, pendingPromptTabs)
// is fresh, and its addListener calls re-populate __listeners__.
function loadBackground() {
    jest.resetModules();
    require(BG_PATH);
}

// Fire a tabs.onUpdated event and wait for async processing to complete.
async function fireUpdated(tabId, changeInfo, tab) {
    const handlers = global.__listeners__.onUpdated;
    await Promise.all(handlers.map(fn => fn(tabId, changeInfo, tab)));
}

// Fire a tabs.onRemoved event.
function fireRemoved(tabId) {
    global.__listeners__.onRemoved.forEach(fn => fn(tabId));
}

// Fire a runtime.onMessage event and return the response.
function fireMessage(message, sender = {}) {
    return new Promise((resolve) => {
        const handlers = global.__listeners__.onMessage;
        let responded = false;
        const sendResponse = (resp) => { responded = true; resolve(resp); };
        handlers.forEach(fn => fn(message, sender, sendResponse));
        // If no handler called sendResponse synchronously, resolve with undefined
        if (!responded) setTimeout(() => resolve(undefined), 10);
    });
}

// Fire an alarm event.
async function fireAlarm(alarm) {
    const handlers = global.__listeners__.onAlarm;
    await Promise.all(handlers.map(fn => fn(alarm)));
}

// Convenience: set storage keys directly.
function setStorage(data) {
    Object.assign(global.__store__, data);
}

// Clear all storage.
function clearStorage() {
    const s = global.__store__;
    Object.keys(s).forEach(k => delete s[k]);
}

// Return the URL passed to the most recent chrome.tabs.update call.
function lastRedirectUrl() {
    const calls = global.__mockFns__['tabs.update'].mock.calls;
    if (!calls.length) return null;
    const last = calls[calls.length - 1];
    return last[1] && last[1].url;
}

// Assert that the last redirect is a prompt URL (not directly to the site).
function expectPromptRedirect(tabId) {
    const calls = global.__mockFns__['tabs.update'].mock.calls;
    const match = calls.find(([id, opts]) => id === tabId && opts.url && opts.url.includes('prompt.html'));
    if (!match) throw new Error(`Expected tab ${tabId} to be redirected to prompt.html but got: ${JSON.stringify(calls)}`);
}

// Assert that no redirect happened for a given tabId.
function expectNoRedirect(tabId) {
    const calls = global.__mockFns__['tabs.update'].mock.calls;
    const match = calls.find(([id, opts]) => id === tabId && opts.url);
    if (match) throw new Error(`Expected no redirect for tab ${tabId} but got: ${match[1].url}`);
}

// Promise that resolves after microtask queue is drained (for chained .then() resolution).
function flushPromises() {
    return new Promise(resolve => setImmediate(resolve));
}

// Current time offset helper — lets tests shift "now" via setStorage lastActive etc.
const NOW = Date.now();

module.exports = {
    loadBackground,
    fireUpdated,
    fireRemoved,
    fireMessage,
    fireAlarm,
    setStorage,
    clearStorage,
    lastRedirectUrl,
    expectPromptRedirect,
    expectNoRedirect,
    flushPromises,
    NOW,
};
