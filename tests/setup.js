// Global Chrome Extension API mock — loaded before every test file via jest setupFiles.
// Test files access storage via global.__store__ and listeners via global.__listeners__.

const store = {};
const listeners = { onUpdated: [], onAlarm: [], onMessage: [], onRemoved: [], onCommitted: [], onHistoryStateUpdated: [], onReplaced: [], onInstalled: [], onStartup: [] };
const mockFns = {};

function makeMockFn(key) {
    mockFns[key] = jest.fn();
    return mockFns[key];
}

// All values ever stored via chrome.storage.local are plain JSON-serializable data (numbers,
// strings, arrays, plain objects) — no Dates/Maps/etc — so JSON round-tripping is an adequate
// stand-in for the structured-clone copy the real API performs at its IPC boundary.
function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

global.__store__ = store;
global.__listeners__ = listeners;
global.__mockFns__ = mockFns;

// By default chrome.storage.local resolves essentially instantly (same microtask), which is
// why the multi-tab session-clobbering race never showed up in the fast unit tests — real
// chrome.storage.local has genuine IPC latency (a handful of milliseconds), and it's exactly
// that latency that widens the window for two concurrent calls to interleave. Tests that want
// to exercise timing-dependent behavior can opt in via __setStorageLatency__(minMs, maxMs) —
// every get/set/remove then resolves after a real (jittered, not fixed) delay in that range
// via genuine setTimeout, so real interleaving between concurrent async calls can actually
// occur, the same way it would against the real API. Off by default so the rest of the suite
// stays fast.
let storageLatencyRange = null;
global.__setStorageLatency__ = (minMs, maxMs) => { storageLatencyRange = [minMs, maxMs]; };
global.__clearStorageLatency__ = () => { storageLatencyRange = null; };

function withStorageLatency(computeResult) {
    if (!storageLatencyRange) return Promise.resolve(computeResult());
    const [min, max] = storageLatencyRange;
    const delay = min + Math.random() * (max - min);
    return new Promise(resolve => setTimeout(() => resolve(computeResult()), delay));
}

global.__resetChrome__ = function () {
    // Clear storage
    Object.keys(store).forEach(k => delete store[k]);
    // Clear captured listeners (background.js re-registers on each require)
    Object.keys(listeners).forEach(k => (listeners[k] = []));
    // Reset all mock functions
    Object.values(mockFns).forEach(fn => fn.mockReset());
    // Restore query default
    mockFns['tabs.update'].mockResolvedValue(undefined);
    mockFns['tabs.query'].mockResolvedValue([]);
    // Default: empty URL, matching the real API's momentary state during a tab-ID swap — tests
    // covering the onReplaced retry path override this per-call via mockResolvedValueOnce.
    mockFns['tabs.get'].mockResolvedValue({ url: '' });
    mockFns['alarms.create'].mockResolvedValue(undefined);
    mockFns['alarms.clear'].mockResolvedValue(true);
    mockFns['alarms.getAll'].mockResolvedValue([]);
    storageLatencyRange = null;
};

makeMockFn('tabs.update');
makeMockFn('tabs.query');
makeMockFn('tabs.get');
makeMockFn('alarms.create');
makeMockFn('alarms.clear');
makeMockFn('alarms.getAll');
mockFns['tabs.update'].mockResolvedValue(undefined);
mockFns['tabs.query'].mockResolvedValue([]);
mockFns['tabs.get'].mockResolvedValue({ url: '' });
mockFns['alarms.create'].mockResolvedValue(undefined);
mockFns['alarms.clear'].mockResolvedValue(true);
mockFns['alarms.getAll'].mockResolvedValue([]);

global.chrome = {
    runtime: {
        getURL: (path) => `chrome-extension://fakeid/${path}`,
        onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
        onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
        onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
    },
    storage: {
        local: {
            // Real chrome.storage.local serializes values across an IPC boundary — every get()
            // caller gets its OWN independent deep copy, and every set() copies its argument in
            // rather than retaining the caller's object. This matters: without cloning here,
            // concurrent callers would share live references into `store`, so "concurrent"
            // mutations would land on the same object and nothing could ever actually be lost —
            // masking real read-modify-write races (see background.js's checkAccess) that only
            // show up against the real API's copy-on-every-call semantics.
            get: (keysOrDefaults) => withStorageLatency(() => {
                if (Array.isArray(keysOrDefaults)) {
                    const result = {};
                    for (const k of keysOrDefaults) {
                        if (k in store) result[k] = deepClone(store[k]);
                    }
                    return result;
                }
                if (typeof keysOrDefaults === 'object' && keysOrDefaults !== null) {
                    const result = {};
                    for (const [k, def] of Object.entries(keysOrDefaults)) {
                        result[k] = k in store ? deepClone(store[k]) : deepClone(def);
                    }
                    return result;
                }
                return deepClone(store);
            }),
            set: (data) => withStorageLatency(() => {
                for (const [k, v] of Object.entries(data)) {
                    store[k] = deepClone(v);
                }
            }),
            remove: (keys) => withStorageLatency(() => {
                const list = Array.isArray(keys) ? keys : [keys];
                list.forEach(k => delete store[k]);
            }),
        },
    },
    tabs: {
        onUpdated: {
            addListener: (fn) => listeners.onUpdated.push(fn),
            removeListener: (fn) => {
                const idx = listeners.onUpdated.indexOf(fn);
                if (idx !== -1) listeners.onUpdated.splice(idx, 1);
            },
        },
        onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
        onReplaced: { addListener: (fn) => listeners.onReplaced.push(fn) },
        update: (...args) => mockFns['tabs.update'](...args),
        query: (...args) => mockFns['tabs.query'](...args),
        get: (...args) => mockFns['tabs.get'](...args),
    },
    alarms: {
        onAlarm: { addListener: (fn) => listeners.onAlarm.push(fn) },
        create: (...args) => mockFns['alarms.create'](...args),
        clear: (...args) => mockFns['alarms.clear'](...args),
        getAll: (...args) => mockFns['alarms.getAll'](...args),
    },
    webNavigation: {
        onCommitted: { addListener: (fn) => listeners.onCommitted.push(fn) },
        onHistoryStateUpdated: { addListener: (fn) => listeners.onHistoryStateUpdated.push(fn) },
    },
};
