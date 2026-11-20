// Emergency Override (replaced the standalone Extend setting): migration of the old
// extensionDuration, the weekly emergency allowance, and that an emergency pass resumes the
// original cooldown when it ends, like Extend.
const { loadBackground, fireMessage, fireAlarm, setStorage } = require('./helpers');

const YT = 'https://www.youtube.com/';

// Wednesday 2026-11-18, 14:00 local; that week starts Monday 2026-11-16.
function at(day, hour = 14) { return new Date(2026, 10, day, hour, 0, 0, 0).getTime(); }
let clock;

beforeEach(() => {
    __resetChrome__();
    clock = at(18);
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    loadBackground();
    setStorage({ targetSites: ['youtube.com'] });
});
afterEach(() => jest.restoreAllMocks());

const installed = (reason) => Promise.all(__listeners__.onInstalled.map(fn => fn({ reason })));
const status = () => fireMessage({ action: 'getOverrideStatus' });
const emergency = () => fireMessage({ action: 'startSession', url: YT, type: 'duration', value: 999, origin: 'emergency' }, { tab: { id: 3 } });

describe('migration from the old Extension Duration setting', () => {
    test('a new install starts with no override at all', async () => {
        await installed('install');
        expect(__store__).toMatchObject({ overrideEnabled: false, overrideType: 'emergency' });
        expect((await status()).mode).toBe('off');
    });

    test('an existing user keeps their Extend seconds', async () => {
        setStorage({ extensionDuration: 45 });
        await installed('update');
        expect(__store__).toMatchObject({ overrideEnabled: true, overrideType: 'extend', extensionDuration: 45 });
        expect(await status()).toMatchObject({ mode: 'extend', extensionSeconds: 45 });
    });

    test('an existing user who never saved settings keeps the old 30s default', async () => {
        await installed('update');
        expect(__store__).toMatchObject({ overrideEnabled: true, overrideType: 'extend', extensionDuration: 30 });
    });

    test('an existing user with Extension Duration 0 stays off', async () => {
        setStorage({ extensionDuration: 0 });
        await installed('update');
        expect(__store__).toMatchObject({ overrideEnabled: false, overrideType: 'extend', extensionDuration: 30 });
        expect((await status()).mode).toBe('off');
    });

    test('runs once: settings already in the new format are left alone', async () => {
        setStorage({ overrideEnabled: true, overrideType: 'emergency', extensionDuration: 10 });
        await installed('update');
        expect(__store__).toMatchObject({ overrideEnabled: true, overrideType: 'emergency', extensionDuration: 10 });
    });

    test('before migration runs, a saved legacy value still decides', async () => {
        setStorage({ extensionDuration: 20 });
        expect(await status()).toMatchObject({ mode: 'extend', extensionSeconds: 20 });
    });
});

describe('emergency passes', () => {
    beforeEach(() => setStorage({ overrideEnabled: true, overrideType: 'emergency' }));

    test('defaults: 2 passes a week of 5 minutes', async () => {
        expect(await status()).toMatchObject({ mode: 'emergency', emergencyMinutes: 5, perWeek: 2, used: 0, remaining: 2 });
    });

    test('a pass grants the configured minutes (not what the page asked for) and spends one use', async () => {
        const res = await emergency();
        expect(res.success).toBe(true);
        const s = __store__.activeSessions['youtube.com'];
        expect(s).toMatchObject({ type: 'duration', origin: 'emergency' });
        expect(s.endTime - s.startTime).toBe(5 * 60000);
        expect(__store__.emergencyOverrideUsage).toEqual({ weekKey: '2026-11-16', used: 1 });
        expect((await status()).remaining).toBe(1);
    });

    test('no passes left: refused, nothing granted', async () => {
        await emergency();
        await emergency();
        delete __store__.activeSessions;
        const res = await emergency();
        expect(res.success).toBe(false);
        expect(__store__.activeSessions).toBeUndefined();
        expect(__store__.emergencyOverrideUsage.used).toBe(2);
    });

    test('uses reset on Monday', async () => {
        setStorage({ emergencyOverrideUsage: { weekKey: '2026-11-16', used: 2 } });
        expect((await status()).remaining).toBe(0);
        clock = at(22, 23); // Sunday night, same week
        expect((await status()).remaining).toBe(0);
        clock = at(23, 0); // Monday 00:00
        expect((await status()).remaining).toBe(2);
    });

    test('custom count and length', async () => {
        setStorage({ emergencyOverridesPerWeek: 4, emergencyOverrideMinutes: 15 });
        expect(await status()).toMatchObject({ perWeek: 4, emergencyMinutes: 15, remaining: 4 });
        await emergency();
        const s = __store__.activeSessions['youtube.com'];
        expect(s.endTime - s.startTime).toBe(15 * 60000);
    });

    test('refused when the override is off or set to Extend', async () => {
        setStorage({ overrideEnabled: false });
        expect((await emergency()).success).toBe(false);
        setStorage({ overrideEnabled: true, overrideType: 'extend' });
        expect((await emergency()).success).toBe(false);
        expect(__store__.emergencyOverrideUsage).toBeUndefined();
    });

    test('when the pass ends, the original cooldown resumes instead of a new one starting', async () => {
        const cooldown = { startTime: clock - 60000, duration: 30 * 60000, originalType: 'count' };
        setStorage({ cooldowns: { 'youtube.com': cooldown } });
        await emergency();
        clock += 5 * 60000;
        await fireAlarm({ name: 'session_youtube.com' });
        expect(__store__.cooldowns['youtube.com']).toEqual(cooldown);
        expect(__store__.activeSessions['youtube.com']).toBeUndefined();
    });
});
