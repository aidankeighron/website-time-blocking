// Tests for day-of-week + time-frame schedule blocking.
// Schedule blocks completely block access with no session bypass.
const {
    loadBackground, fireUpdated, fireCommitted, setStorage,
    expectPromptRedirect, expectNoRedirect, NOW,
} = require('./helpers');

const TAB = 55;
const IG_HOME = 'https://www.instagram.com/';
const YT_HOME  = 'https://www.youtube.com/';

// Current day/time derived from NOW so tests are day-independent.
const _now = new Date(NOW);
const TODAY     = _now.getDay();          // 0–6
const NOT_TODAY = (TODAY + 1) % 7;
const CUR_HOUR  = _now.getHours();
const CUR_MIN   = _now.getMinutes();

// A block covering all days and all hours — always active.
function allDaysAllHoursBlock(id = 'sb_all') {
    return { id, days: [0,1,2,3,4,5,6], startHour:0, startMinute:0, endHour:23, endMinute:59 };
}

// A block covering only a day that is NOT today — never active today.
function wrongDayBlock() {
    return { id: 'sb_wrong', days: [NOT_TODAY], startHour:0, startMinute:0, endHour:23, endMinute:59 };
}

// A block covering today but only the tiny 00:00–00:01 window.
// Active only when CUR_HOUR === 0 and CUR_MIN === 0, which is astronomically unlikely in CI.
function tinyMidnightBlock() {
    return { id: 'sb_midnight', days: [TODAY], startHour:0, startMinute:0, endHour:0, endMinute:1 };
}

// A block covering today and all hours — tests the day filter specifically.
function currentTimeBlock(id = 'sb_cur') {
    return { id, days: [TODAY], startHour:0, startMinute:0, endHour:23, endMinute:59 };
}

function nav(tabId, url) {
    return fireUpdated(tabId, { url }, { url, status: 'loading' });
}

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'youtube.com'] });
});

// ────────────────────────────────────────────────────────────────────────────
// Basic blocking / not-blocking
// ────────────────────────────────────────────────────────────────────────────

test('No schedule blocks — access proceeds normally to prompt (no schedule block message)', async () => {
    setStorage({ scheduleBlocks: [] });
    await nav(TAB, IG_HOME);
    // Should redirect to prompt but NOT with SCHEDULE_BLOCK (normal flow)
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).not.toContain('SCHEDULE_BLOCK');
});

test('All-days all-hours block — navigation redirects with SCHEDULE_BLOCK message', async () => {
    setStorage({ scheduleBlocks: [allDaysAllHoursBlock()] });
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULE_BLOCK');
});

test('Schedule block redirect URL includes blockId', async () => {
    setStorage({ scheduleBlocks: [allDaysAllHoursBlock('sb_myid')] });
    await nav(TAB, IG_HOME);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('blockId=sb_myid');
});

// ────────────────────────────────────────────────────────────────────────────
// Day-of-week filter
// ────────────────────────────────────────────────────────────────────────────

test('Block for wrong day — navigation NOT blocked by schedule', async () => {
    setStorage({ scheduleBlocks: [wrongDayBlock()] });
    await nav(TAB, IG_HOME);
    // Falls through to normal prompt (no session) — not a SCHEDULE_BLOCK redirect
    const calls = __mockFns__['tabs.update'].mock.calls;
    // Either no redirect or a non-schedule-block redirect
    if (calls.length > 0) {
        const url = calls[0][1].url;
        expect(url).not.toContain('SCHEDULE_BLOCK');
    }
});

test('Block for today + current time — navigation blocked by schedule', async () => {
    setStorage({ scheduleBlocks: [currentTimeBlock()] });
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULE_BLOCK');
});

// ────────────────────────────────────────────────────────────────────────────
// Time window filter
// ────────────────────────────────────────────────────────────────────────────

test('Block for today but tiny midnight window (00:00–00:01) — not active at test run time', async () => {
    // This test will fail if run exactly at midnight:00, which is acceptable.
    if (CUR_HOUR === 0 && CUR_MIN === 0) return; // skip at midnight exactly
    setStorage({ scheduleBlocks: [tinyMidnightBlock()] });
    await nav(TAB, IG_HOME);
    const calls = __mockFns__['tabs.update'].mock.calls;
    if (calls.length > 0) {
        expect(calls[0][1].url).not.toContain('SCHEDULE_BLOCK');
    }
});

// ────────────────────────────────────────────────────────────────────────────
// Priority: schedule blocks override active sessions
// ────────────────────────────────────────────────────────────────────────────

test('Schedule block overrides an active duration session — still blocked', async () => {
    setStorage({
        scheduleBlocks: [allDaysAllHoursBlock()],
        activeSessions: {
            'instagram.com': {
                type: 'duration',
                startTime: NOW - 60000,
                endTime: NOW + 300000,
                timeRangeLastCheck: NOW,
            },
        },
    });
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULE_BLOCK');
});

test('Schedule block overrides an active count session — still blocked', async () => {
    setStorage({
        scheduleBlocks: [allDaysAllHoursBlock()],
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: NOW,
                targetCount: 5,
                videosWatched: 2,
                watchedVideoIds: [],
                lastActive: NOW,
            },
        },
    });
    await nav(TAB, YT_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULE_BLOCK');
});

// ────────────────────────────────────────────────────────────────────────────
// Multiple blocks: first match wins
// ────────────────────────────────────────────────────────────────────────────

test('Multiple blocks: one inactive, one active — navigation still blocked', async () => {
    setStorage({
        scheduleBlocks: [
            wrongDayBlock(),                 // inactive
            allDaysAllHoursBlock('sb_b2'),   // active
        ],
    });
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULE_BLOCK');
});

test('Multiple blocks: both inactive — navigation not schedule-blocked', async () => {
    setStorage({
        scheduleBlocks: [wrongDayBlock(), tinyMidnightBlock()],
    });
    if (CUR_HOUR === 0 && CUR_MIN === 0) return;
    await nav(TAB, IG_HOME);
    const calls = __mockFns__['tabs.update'].mock.calls;
    if (calls.length > 0) {
        expect(calls[0][1].url).not.toContain('SCHEDULE_BLOCK');
    }
});

// ────────────────────────────────────────────────────────────────────────────
// webNavigation.onCommitted listener also respects schedule blocks
// ────────────────────────────────────────────────────────────────────────────

test('webNavigation.onCommitted: schedule block also fires', async () => {
    setStorage({ scheduleBlocks: [allDaysAllHoursBlock()] });
    await fireCommitted({ tabId: TAB, url: IG_HOME });
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULE_BLOCK');
});

// ────────────────────────────────────────────────────────────────────────────
// Non-target sites not affected
// ────────────────────────────────────────────────────────────────────────────

test('Schedule block does not affect non-target sites', async () => {
    setStorage({ scheduleBlocks: [allDaysAllHoursBlock()] });
    await nav(TAB, 'https://www.google.com/');
    expectNoRedirect(TAB);
});
