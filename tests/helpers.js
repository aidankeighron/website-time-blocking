// Shared helpers for E2E tests.
// Each test file calls loadBackground() in beforeEach to get a fresh module instance.

const path = require('path');
const BG_PATH = path.resolve(__dirname, '../background.js');

// Re-require background.js so its module-level state
// starts fresh for every test block, and its addListener calls re-populate __listeners__.
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
        // Fallback for a message with no matching handler at all (sendResponse never called).
        // Generous on purpose: real handlers respond asynchronously after their own
        // chrome.storage.local calls, which can take real time when __setStorageLatency__ is
        // enabled — this must not race ahead of a genuine, still-pending response.
        if (!responded) setTimeout(() => resolve(undefined), 5000);
    });
}

// Fire a webNavigation.onCommitted event.
async function fireCommitted({ tabId, url, frameId = 0 }) {
    const handlers = global.__listeners__.onCommitted;
    await Promise.all(handlers.map(fn => fn({ tabId, url, frameId })));
}

// Fire an alarm event.
async function fireAlarm(alarm) {
    const handlers = global.__listeners__.onAlarm;
    await Promise.all(handlers.map(fn => fn(alarm)));
}

// Fire chrome.runtime.onInstalled.
async function fireInstalled() {
    const handlers = global.__listeners__.onInstalled;
    await Promise.all(handlers.map(fn => fn()));
}

// Fire chrome.runtime.onStartup.
async function fireStartup() {
    const handlers = global.__listeners__.onStartup;
    await Promise.all(handlers.map(fn => fn()));
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

// Real (not fake-timer) delay, jittered within [minMs, maxMs], for simulating the pace of a
// human doing something — reading a screen, moving a mouse, reacting — rather than a script
// firing every action back-to-back in the same tick. Genuinely waits real wall-clock time:
// using jest fake timers instead would defeat the purpose, since what these tests need is
// real event-loop interleaving between concurrent async operations, which fake timers collapse
// away entirely.
function humanDelay(minMs, maxMs = minMs) {
    const ms = minMs + Math.random() * (maxMs - minMs);
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Approximate wall-clock time a human takes to type `text`, at a per-character pace of
// [minMsPerChar, maxMsPerChar] (defaults roughly match average typing speed, ~500ms/char for
// deliberate, careful entry — slower than touch-typing since these are usually short numeric
// fields glanced at between keystrokes). Await this before "submitting" a typed value, rather
// than firing the equivalent action instantly.
function humanTypingDelay(text, minMsPerChar = 90, maxMsPerChar = 220) {
    const perChar = minMsPerChar + Math.random() * (maxMsPerChar - minMsPerChar);
    return new Promise(resolve => setTimeout(resolve, String(text).length * perChar));
}

// Current time offset helper — lets tests shift "now" via setStorage lastActive etc.
const NOW = Date.now();

module.exports = {
    loadBackground,
    fireUpdated,
    fireRemoved,
    fireCommitted,
    fireMessage,
    fireAlarm,
    fireInstalled,
    fireStartup,
    setStorage,
    clearStorage,
    lastRedirectUrl,
    expectPromptRedirect,
    expectNoRedirect,
    flushPromises,
    humanDelay,
    humanTypingDelay,
    NOW,
};
