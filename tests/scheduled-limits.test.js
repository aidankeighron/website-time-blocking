// Tests for the span-based Scheduled Limits engine in background.js: day-of-week + time-
// window matching, full blocks (limitMinutes=0), usage-cap blocking, span open/close
// reconciliation (syncSpanState), the liveness-tolerance phantom-time bound, and alarm-based
// real-time enforcement.
const {
    loadBackground, fireUpdated, fireCommitted, fireAlarm, fireMessage, fireStartup,
    setStorage, expectPromptRedirect, expectNoRedirect, NOW,
} = require('./helpers');

const TAB = 77;
const IG_HOME = 'https://www.instagram.com/';
const YT_HOME = 'https://www.youtube.com/';

// Current day derived from NOW so tests are day-independent.
const _now = new Date(NOW);
const TODAY = _now.getDay();
const NOT_TODAY = (TODAY + 1) % 7;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function nav(tabId, url) {
    return fireUpdated(tabId, { url }, { url, status: 'loading' });
}

function dateKeyFor(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['instagram.com', 'youtube.com'] });
});

// ────────────────────────────────────────────────────────────────────────────
// Day + time window matching, full block vs usage cap (banked usage only, no span)
// ────────────────────────────────────────────────────────────────────────────

test('No scheduled limits — access proceeds normally (no SCHEDULED_LIMIT redirect)', async () => {
    setStorage({ scheduledLimits: [] });
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).not.toContain('SCHEDULED_LIMIT');
});

test('Full-block entry (limitMinutes=0) active today, all hours — blocks immediately', async () => {
    setStorage({ scheduledLimits: [{ id: 'sl_full', days: ALL_DAYS, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 0 }] });
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULED_LIMIT');
    expect(url).toContain('sl_full');
});

test('Entry for a different day than today — not blocked', async () => {
    setStorage({ scheduledLimits: [{ id: 'sl_wrong', days: [NOT_TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 0 }] });
    await nav(TAB, IG_HOME);
    const calls = __mockFns__['tabs.update'].mock.calls;
    if (calls.length > 0) expect(calls[0][1].url).not.toContain('SCHEDULED_LIMIT');
});

test('Entry with banked usage already at/over the limit — blocked, no active session needed', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 1 }],
        scheduledUsage: { sl_cur: { dateKey: dateKeyFor(NOW), bankedSeconds: 120 } },
    });
    await nav(TAB, IG_HOME);
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULED_LIMIT');
});

test('Entry with banked usage below the limit and an active session — not blocked', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        scheduledUsage: { sl_cur: { dateKey: dateKeyFor(NOW), bankedSeconds: 10 } },
        activeSessions: { 'instagram.com': { type: 'duration', startTime: NOW - 60000, endTime: NOW + 300000 } },
    });
    await nav(TAB, IG_HOME);
    expectNoRedirect(TAB);
});

test('Window-boundary non-leakage: a stale dateKey\'s banked total does not apply to today', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: ALL_DAYS, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        scheduledUsage: { sl_cur: { dateKey: 'not-today-at-all', bankedSeconds: 99999 } },
        activeSessions: { 'youtube.com': { type: 'duration', startTime: NOW, endTime: NOW + 60 * 60000 } },
    });
    await nav(TAB, YT_HOME);
    expectNoRedirect(TAB);
});

// ────────────────────────────────────────────────────────────────────────────
// Multiple overlapping entries
// ────────────────────────────────────────────────────────────────────────────

test('Full block and an exhausted usage-limit both active — full block entry is preferred for the message', async () => {
    setStorage({
        scheduledLimits: [
            { id: 'sl_usage', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 1 },
            { id: 'sl_full', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 0 },
        ],
        scheduledUsage: { sl_usage: { dateKey: dateKeyFor(NOW), bankedSeconds: 120 } },
    });
    await nav(TAB, IG_HOME);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('limitId=sl_full');
});

test('Full-block entry overrides an active duration session — still blocked', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_full', days: ALL_DAYS, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 0 }],
        activeSessions: { 'instagram.com': { type: 'duration', startTime: NOW - 60000, endTime: NOW + 300000 } },
    });
    await nav(TAB, IG_HOME);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULED_LIMIT');
});

// ────────────────────────────────────────────────────────────────────────────
// Span open/close reconciliation (syncSpanState)
// ────────────────────────────────────────────────────────────────────────────

test('Starting a session while a window is active opens a span and immediately schedules an alarm', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_short', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 1 }],
        activeSessions: { 'instagram.com': { type: 'duration', startTime: NOW, endTime: NOW + 5 * 60000 } },
    });
    await nav(TAB, IG_HOME);

    expect(global.__store__.scheduledSpanStart).not.toBeNull();
    const alarmCall = __mockFns__['alarms.create'].mock.calls.find(([name]) => name === 'schedlimit_sl_short');
    expect(alarmCall).toBeDefined();
    const when = alarmCall[1].when;
    expect(when).toBeGreaterThan(NOW);
    expect(when).toBeLessThanOrEqual(NOW + 70000); // ~60s budget, generous slack for test drift
});

test('Span stays open while ANY of multiple domains is granting access; closes only once all end', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: {
            'instagram.com': { type: 'duration', startTime: NOW, endTime: NOW + 10 * 60000 },
            'youtube.com': { type: 'duration', startTime: NOW, endTime: NOW + 10 * 60000 },
        },
    });
    // Each check below uses a distinct tab id — checkAccess's 1s per-tab debounce lock
    // wouldn't clear between these calls in this test's timeframe otherwise, silently
    // swallowing the later navigations.
    await nav(TAB, IG_HOME); // opens the span
    expect(global.__store__.scheduledSpanStart).not.toBeNull();

    // End the instagram session only — youtube's is still active.
    global.__store__.activeSessions['instagram.com'].endTime = NOW - 1000;
    await nav(TAB + 1, IG_HOME);
    expect(global.__store__.scheduledSpanStart).not.toBeNull(); // still open — youtube granting

    // Now end youtube's too.
    global.__store__.activeSessions['youtube.com'].endTime = NOW - 1000;
    await nav(TAB + 2, YT_HOME);
    expect(global.__store__.scheduledSpanStart).toBeNull();
});

test('Count session hitting its cap keeps the span open — cooldown still allows homepage/rewatch access', async () => {
    // Regression test: isSessionGrantingAccess must NOT treat "cooldownEndTime is set" alone as
    // "not granting" — checkAccess still allows the homepage and already-whitelisted videos
    // during cooldown, so real usage continues and must keep accruing against scheduled limits.
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: {
            'youtube.com': {
                type: 'count', startTime: NOW, targetCount: 1, videosWatched: 1,
                watchedVideoIds: ['aaa111'], lastActive: NOW,
            },
        },
    });
    await nav(TAB, YT_HOME); // homepage, no video ID — opens the span
    expect(global.__store__.scheduledSpanStart).not.toBeNull();

    // Navigate to a NEW video, pushing videosWatched past targetCount -> cooldown starts.
    // Uses a different tab id so checkAccess's 1s per-tab debounce lock (from the first nav,
    // which won't clear for a real second in this test's timeframe) doesn't silently swallow
    // this second navigation.
    await nav(TAB + 1, 'https://www.youtube.com/watch?v=bbb222');
    expect(global.__store__.activeSessions['youtube.com'].cooldownEndTime).toBeDefined();

    // Still granting (mid-cooldown, but session hasn't actually expired) — span stays open.
    expect(global.__store__.scheduledSpanStart).not.toBeNull();
});

test('Count session\'s span closes once the cooldown has fully expired and the session is cleaned up', async () => {
    const cooldownEnd = NOW - 1000; // already expired
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: {
            'youtube.com': {
                type: 'count', startTime: NOW - 60000, targetCount: 1, videosWatched: 2,
                watchedVideoIds: ['aaa111', 'bbb222'], lastActive: NOW - 60000, cooldownEndTime: cooldownEnd,
            },
        },
        scheduledSpanStart: NOW - 60000,
        scheduledSpanLastLiveness: NOW,
    });
    await nav(TAB, YT_HOME); // triggers the "cooldown expired -> delete session" cleanup path
    expect(global.__store__.activeSessions['youtube.com']).toBeUndefined();
    expect(global.__store__.scheduledSpanStart).toBeNull();
});

test('BUG FIX: an abandoned under-target count session (never hit its cap) self-corrects after 2 hours of inactivity instead of keeping the span open forever', async () => {
    // Reproduces the exact gap found in review: nothing external ever revisits a session that
    // never hit its cap and was simply abandoned (tab closed). Without a self-correcting
    // isSessionGrantingAccess, this would keep the global span open — and every unrelated
    // scheduled limit's budget silently draining — indefinitely.
    const staleLastActive = NOW - (3 * 60 * 60 * 1000); // 3 hours ago — past the 2h ceiling
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: {
            'youtube.com': {
                type: 'count', startTime: staleLastActive, targetCount: 5, videosWatched: 1,
                watchedVideoIds: ['aaa111'], lastActive: staleLastActive, // no cooldownEndTime — never capped
            },
        },
        scheduledSpanStart: staleLastActive,
        scheduledSpanLastLiveness: staleLastActive,
    });

    // A completely unrelated navigation (different domain) triggers syncSpanState — the
    // abandoned youtube.com session must not keep the span artificially open.
    await nav(TAB, IG_HOME);
    expect(global.__store__.scheduledSpanStart).toBeNull();
});

test('The session_<domain> duration-expiry alarm closes the span with zero navigation', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: { 'youtube.com': { type: 'duration', startTime: NOW, endTime: NOW + 1000 } },
        scheduledSpanStart: NOW,
        scheduledSpanLastLiveness: NOW,
    });
    await fireAlarm({ name: 'session_youtube.com' });
    expect(global.__store__.scheduledSpanStart).toBeNull();
});

test('BUG FIX: an abandoned single_url session (tab closed, never navigated away) self-corrects after 2 hours instead of keeping the span open forever', async () => {
    // single_url sessions have no natural expiry in checkAccess (by design — "finish this one
    // post/video" has no fixed duration) and are only cleaned up by navigating away from the
    // matching URL. If the tab is just closed instead, nothing ever revisits it. Without a
    // bounded isSessionGrantingAccess, this would phantom-credit usage to unrelated scheduled
    // limits indefinitely, the same shape as the abandoned-count-session bug above.
    const staleLastActive = NOW - (3 * 60 * 60 * 1000);
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: {
            'reddit.com': { type: 'single_url', startTime: staleLastActive, lastActive: staleLastActive, targetUrl: 'https://www.reddit.com/r/x/comments/abc/' },
        },
        scheduledSpanStart: staleLastActive,
        scheduledSpanLastLiveness: staleLastActive,
    });
    await nav(TAB, IG_HOME); // unrelated domain
    expect(global.__store__.scheduledSpanStart).toBeNull();
});

test('A live single_url session keeps the span open (lastActive refreshes on each matching revisit)', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: {
            'reddit.com': { type: 'single_url', startTime: NOW, lastActive: NOW, targetUrl: 'https://www.reddit.com/r/x/comments/abc/' },
        },
    });
    await nav(TAB, 'https://www.reddit.com/r/x/comments/abc/');
    expect(global.__store__.activeSessions['reddit.com'].lastActive).toBeGreaterThanOrEqual(NOW);
    expect(global.__store__.scheduledSpanStart).not.toBeNull();
});

test('BUG FIX: a newly-created scheduled limit does not retroactively bill browsing that happened before it existed', async () => {
    // The span has been open for 20 real minutes from an unrelated, already-running session —
    // e.g. the user started a long duration session, then later created a brand-new 1-minute
    // scheduled limit to try it out. The new entry must start counting from its own creation
    // time forward, not from whenever the pre-existing span happened to begin.
    const spanStart = NOW - 20 * 60000;
    const createdAt = NOW; // entry created "just now"
    setStorage({
        scheduledLimits: [{ id: 'sl_new', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 1, createdAt }],
        scheduledUsage: {},
        activeSessions: { 'youtube.com': { type: 'duration', startTime: spanStart, endTime: NOW + 60 * 60000 } },
        scheduledSpanStart: spanStart,
        scheduledSpanLastLiveness: NOW,
    });

    await nav(TAB, YT_HOME);

    // Must NOT be blocked — despite the span having been open for 20 minutes, the entry itself
    // is brand new and hasn't had any of ITS OWN time elapse yet.
    expectNoRedirect(TAB);
});

// ────────────────────────────────────────────────────────────────────────────
// The direct bug-fix proof: real span-based usage exceeding the limit blocks, with zero
// navigations — the exact scenario reported ("used the app well past the limit I set").
// ────────────────────────────────────────────────────────────────────────────

test('BUG FIX: real elapsed span time exceeding the limit blocks via the schedlimit_ alarm with zero navigations', async () => {
    // A 1-minute cap, active all day today. The span has been open for 90 real seconds with
    // FRESH liveness (well within tolerance) — genuine, confirmed usage exceeding the 60s
    // budget, not a stale/phantom gap.
    setStorage({
        scheduledLimits: [{ id: 'sl_short', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 1 }],
        scheduledUsage: {},
        activeSessions: { 'youtube.com': { type: 'duration', startTime: NOW - 90000, endTime: NOW + 300000 } },
        scheduledSpanStart: NOW - 90000,
        scheduledSpanLastLiveness: NOW,
    });
    __mockFns__['tabs.query'].mockResolvedValue([{ id: TAB, url: YT_HOME }]);

    await fireAlarm({ name: 'schedlimit_sl_short' });

    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULED_LIMIT');
    expect(url).toContain('sl_short');
});

test('schedlimit_ alarm firing when NOT actually exhausted does not block, and reschedules', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_long', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        scheduledUsage: {},
        activeSessions: { 'youtube.com': { type: 'duration', startTime: NOW - 5000, endTime: NOW + 300000 } },
        scheduledSpanStart: NOW - 5000,
        scheduledSpanLastLiveness: NOW,
    });
    __mockFns__['tabs.query'].mockResolvedValue([{ id: TAB, url: YT_HOME }]);

    await fireAlarm({ name: 'schedlimit_sl_long' });

    expectNoRedirect(TAB);
    const alarmCall = __mockFns__['alarms.create'].mock.calls.find(([name]) => name === 'schedlimit_sl_long');
    expect(alarmCall).toBeDefined();
});

test('Exhausted entry reschedules for window-end, not "now" (no rapid-refire loop)', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_exhausted', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 1 }],
        scheduledUsage: { sl_exhausted: { dateKey: dateKeyFor(NOW), bankedSeconds: 999 } },
    });
    __mockFns__['tabs.query'].mockResolvedValue([{ id: TAB, url: YT_HOME }]);

    await fireAlarm({ name: 'schedlimit_sl_exhausted' });

    expectPromptRedirect(TAB);
    const rescheduleCall = __mockFns__['alarms.create'].mock.calls
        .filter(([name]) => name === 'schedlimit_sl_exhausted')
        .pop();
    expect(rescheduleCall).toBeDefined();
    expect(rescheduleCall[1].when).toBeGreaterThan(NOW + 5 * 60000);
});

test('schedlimit_ alarm firing for a deleted entry is a silent no-op (self-healing, never reschedules)', async () => {
    setStorage({ scheduledLimits: [] });
    __mockFns__['tabs.query'].mockResolvedValue([{ id: TAB, url: YT_HOME }]);
    await expect(fireAlarm({ name: 'schedlimit_sl_gone' })).resolves.not.toThrow();
    expectNoRedirect(TAB);
    expect(__mockFns__['alarms.create'].mock.calls.find(([name]) => name === 'schedlimit_sl_gone')).toBeUndefined();
});

// ────────────────────────────────────────────────────────────────────────────
// Phantom-time bound — the design-review-caught gap: a span that's been silently stale
// (browser closed / machine asleep / service worker evicted) must NOT get the full gap
// counted as usage, only the confirmed-live portion plus a small tolerance grace period.
// ────────────────────────────────────────────────────────────────────────────

test('Phantom-time bound: a long silent gap after real usage does not get banked as usage', async () => {
    // 2 real minutes of confirmed usage (spanStart to lastLiveness), then a 15-minute silent
    // gap with no liveness pings at all — simulating a closed browser or evicted service
    // worker while a duration session was still technically valid.
    const spanStart = NOW - 17 * 60000; // span "started" 17 minutes ago
    const lastLiveness = NOW - 15 * 60000; // nothing confirmed it was live for the last 15 of those
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        scheduledUsage: {},
        activeSessions: { 'youtube.com': { type: 'duration', startTime: spanStart, endTime: NOW + 60 * 60000 } },
        scheduledSpanStart: spanStart,
        scheduledSpanLastLiveness: lastLiveness,
    });

    await nav(TAB, YT_HOME); // triggers syncSpanState, reconciling the stale span

    const usage = global.__store__.scheduledUsage.sl_cur;
    expect(usage).toBeDefined();
    // Confirmed-live portion (2 min = 120s) + tolerance grace (90s) ≈ 210s — nowhere near the
    // full 17-minute (1020s) gap that would have been banked with no bounding at all.
    expect(usage.bankedSeconds).toBeGreaterThan(180);
    expect(usage.bankedSeconds).toBeLessThan(600); // well under half the unbounded gap either way

    // The session is still genuinely granting access right now, so the span reopens fresh.
    expect(global.__store__.scheduledSpanStart).not.toBeNull();
    expect(global.__store__.scheduledSpanStart).toBeGreaterThan(lastLiveness);
});

test('scheduledLimitLivenessPing message refreshes an open span\'s liveness', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: { 'youtube.com': { type: 'duration', startTime: NOW, endTime: NOW + 60 * 60000 } },
        scheduledSpanStart: NOW,
        scheduledSpanLastLiveness: NOW,
    });
    await fireMessage({ action: 'scheduledLimitLivenessPing', domain: 'youtube.com' });
    expect(global.__store__.scheduledSpanLastLiveness).toBeGreaterThanOrEqual(NOW);
    expect(global.__store__.scheduledSpanStart).not.toBeNull(); // still open, not closed
});

// ────────────────────────────────────────────────────────────────────────────
// Alarm reconciliation / cleanup
// ────────────────────────────────────────────────────────────────────────────

test('scheduledLimitsChanged message clears orphaned alarms for deleted entries', async () => {
    setStorage({ scheduledLimits: [] });
    __mockFns__['alarms.getAll'].mockResolvedValue([
        { name: 'schedlimit_gone_id' },
        { name: 'session_youtube.com' }, // unrelated alarm kind, must not be touched
    ]);
    await fireMessage({ action: 'scheduledLimitsChanged' });
    expect(__mockFns__['alarms.clear']).toHaveBeenCalledWith('schedlimit_gone_id');
    expect(__mockFns__['alarms.clear']).not.toHaveBeenCalledWith('session_youtube.com');
});

test('scheduledLimitsChanged resyncs span state first, so a new entry\'s alarm reflects current reality, not a stale span', async () => {
    // A session ended a while ago (its own alarm/navigation never got a chance to run yet in
    // this test), leaving a stale open span in storage. Saving a new scheduled limit must not
    // schedule its alarm against that stale span — it should reconcile first.
    const staleLastActive = NOW - (3 * 60 * 60 * 1000);
    setStorage({
        scheduledLimits: [{ id: 'sl_new', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30, createdAt: NOW }],
        activeSessions: {
            'youtube.com': { type: 'count', startTime: staleLastActive, targetCount: 5, videosWatched: 1, watchedVideoIds: ['aaa111'], lastActive: staleLastActive },
        },
        scheduledSpanStart: staleLastActive,
        scheduledSpanLastLiveness: staleLastActive,
    });

    await fireMessage({ action: 'scheduledLimitsChanged' });

    expect(global.__store__.scheduledSpanStart).toBeNull(); // stale span correctly closed
    const alarmCall = __mockFns__['alarms.create'].mock.calls.find(([name]) => name === 'schedlimit_sl_new');
    expect(alarmCall).toBeDefined();
    // Nobody is currently browsing (span just closed), so the next event is window-end, far
    // in the future — not an immediate/near-term re-check based on the stale span.
    expect(alarmCall[1].when).toBeGreaterThan(NOW + 5 * 60000);
});

test('onStartup reconciles span state and reschedules alarms for existing entries', async () => {
    setStorage({
        scheduledLimits: [{ id: 'sl_cur', days: [TODAY], startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 30 }],
        activeSessions: { 'youtube.com': { type: 'duration', startTime: NOW, endTime: NOW + 60 * 60000 } },
    });
    await fireStartup();
    const alarmCall = __mockFns__['alarms.create'].mock.calls.find(([name]) => name === 'schedlimit_sl_cur');
    expect(alarmCall).toBeDefined();
});

// ────────────────────────────────────────────────────────────────────────────
// Non-target sites / alternate navigation listener
// ────────────────────────────────────────────────────────────────────────────

test('Scheduled limit does not affect non-target sites', async () => {
    setStorage({ scheduledLimits: [{ id: 'sl_full', days: ALL_DAYS, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 0 }] });
    await nav(TAB, 'https://www.google.com/');
    expectNoRedirect(TAB);
});

test('webNavigation.onCommitted also respects scheduled limits', async () => {
    setStorage({ scheduledLimits: [{ id: 'sl_full', days: ALL_DAYS, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, limitMinutes: 0 }] });
    await fireCommitted({ tabId: TAB, url: IG_HOME });
    expectPromptRedirect(TAB);
    const url = __mockFns__['tabs.update'].mock.calls[0][1].url;
    expect(url).toContain('SCHEDULED_LIMIT');
});
