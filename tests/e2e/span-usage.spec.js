/**
 * Regression coverage for the scheduled-limit "span" usage-tracking fix: re-opening a span that
 * just closed due to staleness (a >90s gap with no liveness signal) must require genuinely
 * fresh activity, not just "some session record hasn't technically expired yet" — otherwise an
 * abandoned count/single_url session (e.g. sitting untouched in cooldown) collects a free
 * ~90-second usage credit against the scheduled limit's budget every time ANYTHING else in the
 * extension happens to trigger reconciliation, with zero real browsing behind it.
 */
const { test, expect } = require('./fixture');
const { REDDIT_HOME, VIDEO_A, expectBlocked } = require('./helpers');

function todayDateKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ALL_DAY_LIMIT = {
    id: 'limit1',
    days: [0, 1, 2, 3, 4, 5, 6],
    startHour: 0, startMinute: 0,
    endHour: 23, endMinute: 59,
    limitMinutes: 60,
};

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

test('An abandoned session does not get a free usage top-up when unrelated activity triggers reconciliation', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        scheduledLimits: [ALL_DAY_LIMIT],
        scheduledUsage: {},
        // A span that opened 15 minutes ago but hasn't had a liveness signal in 10 minutes —
        // well past the 90-second staleness tolerance.
        scheduledSpanStart: now - 15 * 60 * 1000,
        scheduledSpanLastLiveness: now - 10 * 60 * 1000,
        // The count session responsible for that span: abandoned in cooldown, untouched for the
        // same 10 minutes. isSessionGrantingAccess still calls this "granting" (well under its
        // lenient 30-minute tolerance) even though nothing is actually happening.
        activeSessions: {
            'youtube.com': {
                type: 'count',
                startTime: now - 20 * 60 * 1000,
                targetCount: 5,
                videosWatched: 5,
                watchedVideoIds: ['a', 'b', 'c', 'd', 'e'],
                cooldownEndTime: now + 20 * 60 * 1000,
                lastActive: now - 10 * 60 * 1000,
            },
        },
    });

    // Unrelated activity: navigate to a DIFFERENT target site with no session of its own. This
    // still triggers syncSpanStateSerialized (it runs at the top of every access check),
    // exactly the kind of incidental trigger that used to hand out a free credit.
    await expectBlocked(page, REDDIT_HOME);

    const data = await storage.get({ scheduledSpanStart: null, scheduledUsage: {} });
    // The stale span must have been closed and NOT immediately reopened — Reddit has no
    // session of its own, and the abandoned YouTube session isn't fresh (10 min since touch).
    expect(data.scheduledSpanStart).toBeNull();

    // The real ~6.5 minutes (15 - 10 + the 90s tolerance = ~6.5 min) gets banked correctly —
    // that part of the accounting is unchanged by this fix — but nothing beyond it.
    const banked = data.scheduledUsage['limit1'];
    expect(banked).toBeTruthy();
    expect(banked.bankedSeconds).toBeGreaterThan(300); // ~5 min real gap
    expect(banked.bankedSeconds).toBeLessThan(420); // + at most the 90s tolerance, not more
});

test('Genuine fresh activity elsewhere still correctly re-opens the span', async ({ page, storage }) => {
    const now = Date.now();
    await storage.set({
        scheduledLimits: [ALL_DAY_LIMIT],
        scheduledUsage: {},
        scheduledSpanStart: now - 15 * 60 * 1000,
        scheduledSpanLastLiveness: now - 10 * 60 * 1000,
        activeSessions: {
            // The same abandoned YouTube session as above...
            'youtube.com': {
                type: 'count',
                startTime: now - 20 * 60 * 1000,
                targetCount: 5,
                videosWatched: 5,
                watchedVideoIds: ['a', 'b', 'c', 'd', 'e'],
                cooldownEndTime: now + 20 * 60 * 1000,
                lastActive: now - 10 * 60 * 1000,
            },
            // ...but this time there's a genuinely active duration session on Reddit right now.
            'reddit.com': {
                type: 'duration',
                startTime: now - 60 * 1000,
                endTime: now + 10 * 60 * 1000,
            },
        },
    });

    await expectBlocked(page, VIDEO_A); // a NEW video still blocked — count session is capped

    const data = await storage.get({ scheduledSpanStart: null, scheduledUsage: {} });
    // Reddit's session is genuinely active right now, so the span correctly re-opens — real
    // ongoing usage must still be tracked; the fix only withholds credit when NOTHING is fresh.
    expect(data.scheduledSpanStart).not.toBeNull();
});
