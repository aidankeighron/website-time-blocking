// Morning Blocking: the day's first browsing starts a full block of all target sites for
// morningBlockMinutes, cut short at the end time (default 11:00 AM). First browsing at/after the
// end time skips it for the day. Like a full-block scheduled limit, no session can bypass it.
const {
    loadBackground, fireUpdated, fireCommitted, fireMessage, fireStartup, setStorage, lastRedirectUrl,
} = require('./helpers');

const YT = 'https://www.youtube.com/';
const IG = 'https://www.instagram.com/';

// A fixed local morning, so the suite doesn't depend on when it runs.
function at(hour, minute = 0, dayOffset = 0) {
    return new Date(2026, 10, 20 + dayOffset, hour, minute, 0, 0).getTime();
}
function dateKeyFor(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let clock;
function setClock(ms) { clock = ms; }

const settle = () => new Promise(r => setTimeout(r, 20));

let nextTab = 100;
async function visit(url) {
    const tabId = nextTab++;
    __mockFns__['tabs.update'].mockClear();
    await fireUpdated(tabId, { url, status: 'loading' }, { id: tabId, url });
    return lastRedirectUrl();
}

const isMorningBlock = (u) => !!u && u.includes('prompt.html') && u.includes('msg=MORNING_BLOCK');
const isNormalPrompt = (u) => !!u && u.includes('prompt.html') && !u.includes('msg=MORNING_BLOCK');

beforeEach(() => {
    __resetChrome__();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    setClock(at(8, 0));
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'youtube.com'] });
});

afterEach(() => jest.restoreAllMocks());

function enable(extra = {}) {
    setStorage({ morningBlockEnabled: true, morningBlockMinutes: 30, morningBlockEndHour: 11, morningBlockEndMinute: 0, ...extra });
}

test('off by default: the first visit of the day gets the normal picker and records nothing', async () => {
    expect(isNormalPrompt(await visit(YT))).toBe(true);
    expect(__store__.morningBlock).toBeUndefined();
});

test('first visit of the morning starts the block; it lifts after the wait', async () => {
    enable();
    expect(isMorningBlock(await visit(YT))).toBe(true);
    expect(__store__.morningBlock).toEqual({ dateKey: dateKeyFor(at(8, 0)), startTime: at(8, 0) });

    setClock(at(8, 29));
    expect(isMorningBlock(await visit(IG))).toBe(true);

    setClock(at(8, 30));
    expect(isNormalPrompt(await visit(YT))).toBe(true);
});

test('a non-target page load starts the clock and sweeps target tabs already open', async () => {
    enable();
    __mockFns__['tabs.query'].mockResolvedValue([
        { id: 7, url: 'https://www.youtube.com/watch?v=abc' },
        { id: 8, url: 'https://mail.example.com/' },
    ]);
    await fireCommitted({ tabId: 1, url: 'https://mail.example.com/' });
    await settle();

    expect(__store__.morningBlock.startTime).toBe(at(8, 0));
    const swept = __mockFns__['tabs.update'].mock.calls.map(([id, o]) => [id, o.url]);
    expect(swept.some(([id, u]) => id === 7 && isMorningBlock(u))).toBe(true);
    expect(swept.some(([id]) => id === 8 || id === 1)).toBe(false);

    // Counted from 8:00 (the email check), not from the later YouTube visit.
    setClock(at(8, 20));
    expect(isMorningBlock(await visit(YT))).toBe(true);
    setClock(at(8, 31));
    expect(isNormalPrompt(await visit(YT))).toBe(true);
});

test('browser startup counts as the first browsing', async () => {
    enable();
    await fireStartup();
    expect(__store__.morningBlock.startTime).toBe(at(8, 0));
    setClock(at(8, 10));
    expect(isMorningBlock(await visit(YT))).toBe(true);
});

test('the end time cuts the block short', async () => {
    enable();
    setClock(at(10, 50));
    expect(isMorningBlock(await visit(YT))).toBe(true);
    setClock(at(10, 59));
    expect(isMorningBlock(await visit(YT))).toBe(true);
    setClock(at(11, 0));
    expect(isNormalPrompt(await visit(YT))).toBe(true);
});

test('first browsing after the end time skips the block for the day', async () => {
    enable();
    setClock(at(11, 30));
    expect(isNormalPrompt(await visit(YT))).toBe(true);
    setClock(at(11, 35));
    expect(isNormalPrompt(await visit(IG))).toBe(true);
});

test('it starts again on the next day', async () => {
    enable({ morningBlock: { dateKey: dateKeyFor(at(8, 0, -1)), startTime: at(7, 0, -1) } });
    expect(isMorningBlock(await visit(YT))).toBe(true);
    expect(__store__.morningBlock.dateKey).toBe(dateKeyFor(at(8, 0)));
});

test('an active session does not bypass it', async () => {
    enable({
        morningBlock: { dateKey: dateKeyFor(at(8, 0)), startTime: at(7, 55) },
        activeSessions: { 'youtube.com': { type: 'duration', origin: 'fresh', startTime: at(7, 50), endTime: at(9, 0), durationMinutes: 70 } },
    });
    expect(isMorningBlock(await visit(YT))).toBe(true);
});

test('no session can be started during the block', async () => {
    enable({ morningBlock: { dateKey: dateKeyFor(at(8, 0)), startTime: at(7, 55) } });
    const res = await fireMessage({ action: 'startSession', url: YT, type: 'duration', value: 10, origin: 'fresh' }, { tab: { id: 5 } });
    expect(res.success).toBe(false);
    expect((__store__.activeSessions || {})['youtube.com']).toBeUndefined();
    expect(isMorningBlock(lastRedirectUrl())).toBe(true);
});

test('switched on today (startTime null) means nothing is blocked until tomorrow', async () => {
    enable({ morningBlock: { dateKey: dateKeyFor(at(8, 0)), startTime: null } });
    expect(isNormalPrompt(await visit(YT))).toBe(true);
    expect(__store__.morningBlock.startTime).toBeNull();
});

test('switching it off lifts a running block', async () => {
    enable();
    expect(isMorningBlock(await visit(YT))).toBe(true);
    setStorage({ morningBlockEnabled: false });
    setClock(at(8, 5));
    expect(isNormalPrompt(await visit(YT))).toBe(true);
});

test('fewer minutes in settings shortens a running block', async () => {
    enable();
    await visit(YT);
    setStorage({ morningBlockMinutes: 10 });
    setClock(at(8, 11));
    expect(isNormalPrompt(await visit(YT))).toBe(true);
});

test('getMorningBlock reports the end time, or null once it is over', async () => {
    enable({ morningBlock: { dateKey: dateKeyFor(at(8, 0)), startTime: at(8, 0) } });
    expect(await fireMessage({ action: 'getMorningBlock' })).toEqual({ startTime: at(8, 0), endTime: at(8, 30) });
    setClock(at(8, 30));
    expect(await fireMessage({ action: 'getMorningBlock' })).toBeNull();
});

test('closeTab closes the sender tab', async () => {
    const res = await fireMessage({ action: 'closeTab' }, { tab: { id: 42 } });
    expect(res).toEqual({ success: true });
    expect(__mockFns__['tabs.remove']).toHaveBeenCalledWith(42);
});

test('closeTab without a sender tab reports failure', async () => {
    const res = await fireMessage({ action: 'closeTab' }, {});
    expect(res).toEqual({ success: false });
    expect(__mockFns__['tabs.remove']).not.toHaveBeenCalled();
});
