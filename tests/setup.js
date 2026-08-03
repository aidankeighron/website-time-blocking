// Global Chrome Extension API mock — loaded before every test file via jest setupFiles.
// Test files access storage via global.__store__ and listeners via global.__listeners__.

const store = {};
const listeners = { onUpdated: [], onAlarm: [], onMessage: [], onRemoved: [] };
const mockFns = {};

function makeMockFn(key) {
    mockFns[key] = jest.fn();
    return mockFns[key];
}

global.__store__ = store;
global.__listeners__ = listeners;
global.__mockFns__ = mockFns;

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
    mockFns['alarms.create'].mockResolvedValue(undefined);
};

makeMockFn('tabs.update');
makeMockFn('tabs.query');
makeMockFn('alarms.create');
mockFns['tabs.update'].mockResolvedValue(undefined);
mockFns['tabs.query'].mockResolvedValue([]);
mockFns['alarms.create'].mockResolvedValue(undefined);

global.chrome = {
    runtime: {
        getURL: (path) => `chrome-extension://fakeid/${path}`,
        onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
    },
    storage: {
        local: {
            get: (keysOrDefaults) => {
                if (Array.isArray(keysOrDefaults)) {
                    const result = {};
                    for (const k of keysOrDefaults) {
                        if (k in store) result[k] = store[k];
                    }
                    return Promise.resolve(result);
                }
                if (typeof keysOrDefaults === 'object' && keysOrDefaults !== null) {
                    const result = {};
                    for (const [k, def] of Object.entries(keysOrDefaults)) {
                        result[k] = k in store ? store[k] : def;
                    }
                    return Promise.resolve(result);
                }
                return Promise.resolve({ ...store });
            },
            set: (data) => {
                Object.assign(store, data);
                return Promise.resolve();
            },
        },
    },
    tabs: {
        onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
        onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
        update: (...args) => mockFns['tabs.update'](...args),
        query: (...args) => mockFns['tabs.query'](...args),
    },
    alarms: {
        onAlarm: { addListener: (fn) => listeners.onAlarm.push(fn) },
        create: (...args) => mockFns['alarms.create'](...args),
    },
};
