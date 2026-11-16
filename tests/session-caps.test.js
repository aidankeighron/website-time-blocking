// Session caps: hard ceilings (1440 min / 100 videos), the user's own Max Session Length /
// Max Videos settings, and trimming a fresh duration session to an active scheduled limit's
// remaining budget. All trimming is silent (the session simply starts at the capped size).
const { loadBackground, fireMessage, setStorage, NOW } = require('./helpers');

const YT = 'https://www.youtube.com/';
const IG = 'https://www.instagram.com/';

function dateKeyFor(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A 24h overnight window that opened a minute ago on every day, so the window end is ~24h away
// no matter what time of day the suite runs.
function allDayLimit(limitMinutes, extra = {}) {
    const d = new Date(NOW - 60000);
    return {
        id: 'sl_cap', days: [0, 1, 2, 3, 4, 5, 6],
        startHour: d.getHours(), startMinute: d.getMinutes(),
        endHour: d.getHours(), endMinute: d.getMinutes(),
        limitMinutes, createdAt: NOW - 120000, ...extra,
    };
}

function start(url, type, value, origin = 'fresh') {
    return fireMessage({ action: 'startSession', url, type, value, origin }, { tab: { id: 5 } });
}

function sessionFor(domain) {
    return (__store__.activeSessions || {})[domain];
}

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'youtube.com'] });
});

test('duration over 24 hours is trimmed to 1440 minutes', async () => {
    const res = await start(IG, 'duration', 99999);
    expect(res.success).toBe(true);
    const s = sessionFor('instagram.com');
    expect(s.durationMinutes).toBe(1440);
    expect(s.endTime - s.startTime).toBe(1440 * 60000);
});

test('count over 100 videos is trimmed to 100', async () => {
    await start(YT, 'count', 5000);
    expect(sessionFor('youtube.com').targetCount).toBe(100);
});

test('values under the caps are left alone', async () => {
    await start(IG, 'duration', 15);
    expect(sessionFor('instagram.com').durationMinutes).toBe(15);
    await start(YT, 'count', 7);
    expect(sessionFor('youtube.com').targetCount).toBe(7);
});

test('user Max Session Length / Max Videos settings trim sessions', async () => {
    setStorage({ maxSessionMinutes: 20, maxSessionVideos: 5 });
    await start(IG, 'duration', 60);
    expect(sessionFor('instagram.com').durationMinutes).toBe(20);
    await start(YT, 'count', 12);
    expect(sessionFor('youtube.com').targetCount).toBe(5);
});

test('user settings above the hard ceilings cannot raise them', async () => {
    setStorage({ maxSessionMinutes: 5000, maxSessionVideos: 900 });
    await start(IG, 'duration', 3000);
    expect(sessionFor('instagram.com').durationMinutes).toBe(1440);
    await start(YT, 'count', 900);
    expect(sessionFor('youtube.com').targetCount).toBe(100);
});

test('active scheduled limit: a 15 min duration request becomes 10 min when 10 min are left', async () => {
    setStorage({ scheduledLimits: [allDayLimit(10)] });
    await start(IG, 'duration', 15);
    expect(sessionFor('instagram.com').durationMinutes).toBe(10);
});

test('active scheduled limit uses the REMAINING budget, not the total', async () => {
    const limit = allDayLimit(30);
    setStorage({
        scheduledLimits: [limit],
        scheduledUsage: { sl_cap: { dateKey: dateKeyFor(NOW - 60000), bankedSeconds: 20 * 60 } },
    });
    await start(IG, 'duration', 45);
    expect(sessionFor('instagram.com').durationMinutes).toBe(10);
});

test('active scheduled limit does not trim a shorter request, or count sessions', async () => {
    setStorage({ scheduledLimits: [allDayLimit(10)] });
    await start(IG, 'duration', 5);
    expect(sessionFor('instagram.com').durationMinutes).toBe(5);
    await start(YT, 'count', 8);
    expect(sessionFor('youtube.com').targetCount).toBe(8);
});

test('the extend grant is not trimmed by the scheduled limit', async () => {
    setStorage({ scheduledLimits: [allDayLimit(10)] });
    await start(IG, 'duration', 0.5, 'extend');
    expect(sessionFor('instagram.com').durationMinutes).toBe(0.5);
});

test('getSessionCaps reports the active limit and the duration cap', async () => {
    setStorage({ scheduledLimits: [allDayLimit(10)], maxSessionVideos: 30 });
    const caps = await fireMessage({ action: 'getSessionCaps' });
    expect(caps.maxMinutes).toBe(1440);
    expect(caps.maxVideos).toBe(30);
    expect(caps.durationCapMinutes).toBe(10);
    expect(caps.limits).toHaveLength(1);
    expect(caps.limits[0]).toMatchObject({ id: 'sl_cap', limitMinutes: 10, remainingMinutes: 10, capsDuration: true });
});

test('getSessionCaps ignores full blocks and inactive windows', async () => {
    setStorage({ scheduledLimits: [allDayLimit(0), allDayLimit(10, { id: 'sl_off', days: [] })] });
    const caps = await fireMessage({ action: 'getSessionCaps' });
    expect(caps.limits).toHaveLength(0);
    expect(caps.durationCapMinutes).toBe(1440);
});
