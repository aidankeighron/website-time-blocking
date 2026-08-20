// background.js

// State management
// We use chrome.storage.local for persistence.

const DEFAULT_TARGETS = ['instagram.com', 'reddit.com', 'youtube.com'];

// --- Scheduled Limits Helpers ---
//
// A "Scheduled Limit" is { id, days:[0-6], startHour, startMinute, endHour, endMinute, limitMinutes }.
// limitMinutes === 0 means a full/direct block for the whole window (no usage tracking needed).
// limitMinutes > 0 means a shared usage-minutes cap (across all target sites) that resets each
// time a new active occurrence of the window begins.
//
// Usage is tracked via a SPAN, not incremental accumulation: a single global
// scheduledSpanStart marks when the current unbroken stretch of "some session is granting
// access to a target site" began, and scheduledSpanLastLiveness marks the last confirmed
// "still granting" signal within that span. Usage at any moment is computed FRESH from these
// two absolute timestamps (see computeUsedSeconds) — there is no per-session checkpoint that
// needs to be correctly "ticked forward" by every call site, which is what made the previous
// delta-accumulation design fragile.

// Liveness tolerance: if nothing has confirmed "still granting access" within this window, the
// live portion of an open span stops growing at (lastLiveness + this), instead of extending to
// `now` — this is what prevents a closed browser / sleeping machine / evicted service worker
// from silently getting billed as usage. 3x the content-script liveness-ping interval (30s).
const SPAN_TOLERANCE_MS = 90000;

// Returns true if `entry`'s day-of-week + time-of-day window is active at `now`.
// Overnight windows (end <= start) wrap past midnight: the evening portion checks curDay,
// the early-morning portion (before `end`) checks the PREVIOUS calendar day's inclusion.
function isWindowActive(entry, now = Date.now()) {
    if (!entry.days || !entry.days.length) return false;
    const d = new Date(now);
    const curDay = d.getDay();
    const cur = d.getHours() * 60 + d.getMinutes();

    const s = entry.startHour * 60 + entry.startMinute;
    const e = entry.endHour * 60 + entry.endMinute;
    const isOvernight = e <= s;

    if (!isOvernight) {
        return cur >= s && cur < e && entry.days.includes(curDay);
    }
    if (cur >= s) {
        return entry.days.includes(curDay);
    }
    const prevDay = (curDay + 6) % 7;
    return cur < e && entry.days.includes(prevDay);
}

// Calendar-date bucket key for usage accounting. Overnight windows whose early-morning
// portion is currently active are bucketed under the PREVIOUS day's date, so usage keeps
// accumulating against the same occurrence rather than resetting at midnight.
function getWindowDateKey(entry, now = Date.now()) {
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const s = entry.startHour * 60 + entry.startMinute;
    const e = entry.endHour * 60 + entry.endMinute;
    const isOvernight = e <= s;
    const base = (isOvernight && cur < s) ? new Date(now - 86400000) : d;
    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
}

// Ms timestamp of the end of the CURRENTLY ACTIVE window. Precondition: isWindowActive(entry, now).
function getWindowEndTimestamp(entry, now = Date.now()) {
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const s = entry.startHour * 60 + entry.startMinute;
    const e = entry.endHour * 60 + entry.endMinute;
    const isOvernight = e <= s;

    const endDate = new Date(d);
    endDate.setHours(entry.endHour, entry.endMinute, 0, 0);

    if (!isOvernight) return endDate.getTime();
    // Overnight: evening portion (cur >= s) ends tomorrow; early-morning portion ends today.
    if (cur >= s) endDate.setDate(endDate.getDate() + 1);
    return endDate.getTime();
}

// Ms timestamp of the START of the CURRENTLY ACTIVE window's occurrence. Precondition:
// isWindowActive(entry, now). Mirrors getWindowEndTimestamp's overnight branching, and must
// use the SAME overnight/day bucketing as getWindowDateKey so the two never disagree at the
// overnight seam.
function getCurrentWindowStartTimestamp(entry, now = Date.now()) {
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const s = entry.startHour * 60 + entry.startMinute;
    const e = entry.endHour * 60 + entry.endMinute;
    const isOvernight = e <= s;

    const startDate = new Date(d);
    startDate.setHours(entry.startHour, entry.startMinute, 0, 0);

    if (!isOvernight) return startDate.getTime();
    // Overnight: evening portion (cur >= s) started today; early-morning portion (cur < e)
    // started yesterday.
    if (cur >= s) return startDate.getTime();
    startDate.setDate(startDate.getDate() - 1);
    return startDate.getTime();
}

// Next ms timestamp (>= now) at which this entry's window will START. Scans 8 day-offsets
// (0..7 inclusive) so a same-day start time that has already passed today correctly wraps
// to the same weekday next week rather than being skipped.
function getNextWindowStartTimestamp(entry, now = Date.now()) {
    if (!entry.days || !entry.days.length) return null;
    const base = new Date(now);
    for (let offset = 0; offset <= 7; offset++) {
        const candidate = new Date(base);
        candidate.setDate(base.getDate() + offset);
        if (!entry.days.includes(candidate.getDay())) continue;
        candidate.setHours(entry.startHour, entry.startMinute, 0, 0);
        if (candidate.getTime() >= now) return candidate.getTime();
    }
    return null; // unreachable given entry.days.length > 0
}

// The earliest moment `entry` can start accruing live usage: the later of the span's own
// start, the window's current occurrence start (pre-window time never counts), and the
// entry's own creation time (a newly-created entry never retroactively bills browsing that
// happened before it existed — without this, creating a limit mid-session could make it
// appear instantly exhausted based on time nobody could have known to cap).
function effectiveSpanStartFor(entry, spanStart, occurrenceStart) {
    return Math.max(spanStart, occurrenceStart, entry.createdAt || 0);
}

// Pure: usage seconds for `entry` at `now`, given its banked-usage record and the GLOBAL span
// state. Only meaningful while the entry's window is active. The live portion of an open span
// is clipped both to the window's current occurrence (a span that began before the window
// opened doesn't count pre-window time) and to the liveness tolerance horizon (a span that's
// gone quiet doesn't keep accruing phantom time for however long it's been silent).
function computeUsedSeconds(entry, usage, spanStart, lastLiveness, now = Date.now()) {
    const dateKey = getWindowDateKey(entry, now);
    const rec = usage[entry.id];
    const banked = (rec && rec.dateKey === dateKey) ? rec.bankedSeconds : 0;

    if (!isWindowActive(entry, now)) return banked;
    if (spanStart == null) return banked;

    const occurrenceStart = getCurrentWindowStartTimestamp(entry, now);
    const effectiveStart = effectiveSpanStartFor(entry, spanStart, occurrenceStart);
    const liveUntil = Math.min(now, (lastLiveness ?? spanStart) + SPAN_TOLERANCE_MS);
    const liveSeconds = Math.max(0, (liveUntil - effectiveStart) / 1000);
    return banked + liveSeconds;
}

// Returns ALL currently-blocking entries (active window AND (full block OR usage exhausted)).
// Full-block entries are sorted first so callers picking "the" entry for a message get the
// most informative one when a full block and a usage-limit happen to overlap.
function checkScheduledLimits(entries, usage, spanStart, lastLiveness, now = Date.now()) {
    const blocking = entries.filter(entry => {
        if (!isWindowActive(entry, now)) return false;
        if (entry.limitMinutes === 0) return true;
        const used = computeUsedSeconds(entry, usage, spanStart, lastLiveness, now);
        return used >= entry.limitMinutes * 60;
    });
    blocking.sort((a, b) => (a.limitMinutes === 0 ? 0 : 1) - (b.limitMinutes === 0 ? 0 : 1));
    return blocking;
}

// The next ms timestamp at which this entry's blocking status could change: its next window
// start if currently inactive; window-end if it's a full block or already exhausted (exhausted
// never resolves to "now" — nothing changes again until the window ends and usage resets);
// otherwise the projected exhaustion moment assuming activity continues uninterrupted, clipped
// to window-end. If activity actually stops before that projection, syncSpanState's close
// transition reschedules correctly at that point — this projection doesn't need its own
// staleness handling.
function computeNextEventTime(entry, usage, spanStart, lastLiveness, now = Date.now()) {
    if (!isWindowActive(entry, now)) return getNextWindowStartTimestamp(entry, now);
    const windowEnd = getWindowEndTimestamp(entry, now);
    if (entry.limitMinutes === 0) return windowEnd;

    const budget = entry.limitMinutes * 60;
    const usedNow = computeUsedSeconds(entry, usage, spanStart, lastLiveness, now);
    if (usedNow >= budget) return windowEnd;
    if (spanStart == null) return windowEnd; // nobody browsing; nothing pending

    const dateKey = getWindowDateKey(entry, now);
    const rec = usage[entry.id];
    const banked = (rec && rec.dateKey === dateKey) ? rec.bankedSeconds : 0;
    const occurrenceStart = getCurrentWindowStartTimestamp(entry, now);
    const effectiveStart = effectiveSpanStartFor(entry, spanStart, occurrenceStart);

    const projectedExhaustion = effectiveStart + (budget - banked) * 1000;
    return Math.min(projectedExhaustion, windowEnd);
}

// Schedules (or reschedules) the single self-managing alarm for `entry` at its next event
// time. One-shot `when`-based alarms are self-healing: if an entry is later deleted without
// its alarm being explicitly cleared, the alarm fires once, finds nothing, and never
// reschedules — no leak is possible even in that case.
function scheduleSingleEntryAlarm(entry, usage, spanStart, lastLiveness, now = Date.now()) {
    const when = computeNextEventTime(entry, usage, spanStart, lastLiveness, now);
    if (when == null) return;
    chrome.alarms.create('schedlimit_' + entry.id, { when });
}

// Reconciles chrome.alarms against the current scheduledLimits: clears orphaned schedlimit_
// alarms for deleted entries, and (re)schedules every current entry against whatever span
// state is currently in storage. Does NOT reconcile span state itself (see syncSpanState) —
// callers that need fresh span state should call syncSpanState first.
async function syncScheduledLimitAlarms() {
    const data = await chrome.storage.local.get({
        scheduledLimits: [], scheduledUsage: {}, scheduledSpanStart: null, scheduledSpanLastLiveness: null,
    });
    const entries = data.scheduledLimits;
    const now = Date.now();

    const validIds = new Set(entries.map(e => e.id));
    const existing = await chrome.alarms.getAll();
    for (const alarm of existing) {
        if (!alarm.name.startsWith('schedlimit_')) continue;
        const id = alarm.name.slice('schedlimit_'.length);
        if (!validIds.has(id)) await chrome.alarms.clear(alarm.name);
    }

    for (const entry of entries) {
        scheduleSingleEntryAlarm(entry, data.scheduledUsage, data.scheduledSpanStart, data.scheduledSpanLastLiveness, now);
    }
}

// Per-type "is this session currently granting the user access to the site" check, used only
// for span open/close decisions — mirrors, but does not modify, checkAccess's own allow-vs-
// redirect conditions for each session type.
function isSessionGrantingAccess(session, now = Date.now()) {
    if (session.type === 'duration') return now < session.endTime;

    if (session.type === 'count') {
        // A count session mid-cooldown can still legitimately access the homepage or rewatch
        // an already-whitelisted video (checkAccess only blocks NEW videos once capped) — so
        // "cooldownEndTime is set" alone does not mean not-granting. Mirror checkAccess's own
        // two expiry conditions instead (cooldown fully expired, or 2 hours of inactivity).
        // This also makes an abandoned under-target session (never hit its cap, tab just
        // closed) self-correcting after 2 hours instead of reporting "granting" forever with
        // nothing external to time it out.
        if (session.cooldownEndTime && now > session.cooldownEndTime) return false;
        const lastActive = session.lastActive || session.startTime;
        return (now - lastActive) <= 2 * 60 * 60 * 1000;
    }

    if (session.type === 'single_url') {
        // No fixed duration by design — checkAccess itself never times these out; they end
        // only when the user navigates away from the matching URL. For SPAN-tracking purposes
        // only, bound how long an abandoned one (tab closed without navigating away) can keep
        // phantom-crediting usage to unrelated scheduled-limit windows, mirroring count's same
        // 2-hour ceiling. This does not change the single_url feature itself — a real revisit
        // within the window still resumes normally via checkSingleUrlMatch regardless.
        const lastActive = session.lastActive || session.startTime;
        return (now - lastActive) <= 2 * 60 * 60 * 1000;
    }

    return false;
}

function isAnySessionGrantingAccess(sessions, now = Date.now()) {
    return Object.values(sessions).some(s => isSessionGrantingAccess(s, now));
}

// syncSpanState reads-then-writes global span state with no locking of its own. It's called
// from many places (checkAccess, alarms, messages) that can legitimately fire concurrently
// across different domains/tabs — without serializing the calls themselves, two overlapping
// invocations could race (one's write clobbering the other's). We queue it onto the 
// globalSessionQueue so it doesn't race against startSessionInternal or other writes.
function syncSpanState(now = Date.now()) {
    return enqueueSessionOp(() => syncSpanStateSerialized(now));
}

// Idempotent reconciler: derives span open/close state from the CURRENT activeSessions,
// converging storage to match observed reality regardless of what happened since the last
// call. Safe to call from anywhere, any number of times, with no risk of double-counting or
// getting permanently stuck — this is what makes the design immune to the "forgot to update a
// checkpoint somewhere" bug class that broke the two previous implementations.
async function syncSpanStateSerialized(now = Date.now()) {
    const data = await chrome.storage.local.get({
        activeSessions: {}, scheduledLimits: [], scheduledUsage: {},
        scheduledSpanStart: null, scheduledSpanLastLiveness: null,
    });
    const sessions = data.activeSessions;
    const entries = data.scheduledLimits;
    let usage = data.scheduledUsage;
    let spanStart = data.scheduledSpanStart;
    let lastLiveness = data.scheduledSpanLastLiveness;

    // Clean up orphaned usage records for deleted entries safely under the queue lock
    const validIds = new Set(entries.map(e => e.id));
    for (const key of Object.keys(usage)) {
        if (!validIds.has(key)) {
            delete usage[key];
        }
    }

    const granting = isAnySessionGrantingAccess(sessions, now);
    const stale = spanStart != null && lastLiveness != null && (now - lastLiveness) > SPAN_TOLERANCE_MS;

    let transitioned = false;

    if (spanStart != null && (!granting || stale)) {
        // Close (or close-then-reopen below, if stale but still granting): bank each
        // currently-active entry's live portion up to the liveness horizon — never beyond it,
        // so a stale gap never gets retroactively counted just because we're finally closing it.
        const bankUntil = Math.min(now, (lastLiveness ?? spanStart) + SPAN_TOLERANCE_MS);
        const updated = { ...usage };
        for (const entry of entries) {
            if (entry.limitMinutes === 0 || !isWindowActive(entry, now)) continue;
            const occurrenceStart = getCurrentWindowStartTimestamp(entry, now);
            const effectiveStart = effectiveSpanStartFor(entry, spanStart, occurrenceStart);
            const liveSeconds = Math.max(0, (bankUntil - effectiveStart) / 1000);
            if (liveSeconds <= 0) continue;
            const dateKey = getWindowDateKey(entry, now);
            const prev = updated[entry.id] || { dateKey: null, bankedSeconds: 0 };
            updated[entry.id] = {
                dateKey,
                bankedSeconds: (prev.dateKey === dateKey ? prev.bankedSeconds : 0) + liveSeconds,
            };
        }
        usage = updated;
        spanStart = null;
        lastLiveness = null;
        transitioned = true;
    }

    if (granting && spanStart == null) {
        spanStart = now;
        lastLiveness = now;
        transitioned = true;
    }
    // A plain refresh (granting, span already open, not stale) updates lastLiveness but is
    // NOT a "transition" — computeNextEventTime's projection doesn't depend on lastLiveness
    // for entries that aren't already at their exhaustion horizon, so nothing needs
    // rescheduling on every single ping. The existing alarm (scheduled when the span opened
    // or last transitioned) already targets the correct projected exhaustion time.
    else if (granting && spanStart != null) {
        lastLiveness = now;
    }

    await chrome.storage.local.set({
        scheduledUsage: usage,
        scheduledSpanStart: spanStart,
        scheduledSpanLastLiveness: lastLiveness,
    });

    if (transitioned) {
        for (const entry of entries) {
            if (isWindowActive(entry, now)) {
                scheduleSingleEntryAlarm(entry, usage, spanStart, lastLiveness, now);
            }
        }
    }

    return { usage, spanStart, lastLiveness, transitioned };
}

// --- End Scheduled Limits Helpers ---

// Helper to get domain
function getDomain(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace(/^(www\.|m\.|mobile\.)/, '');
    } catch (e) {
        return null;
    }
}

// Redirect a tab to the prompt page and mark it as pending so duplicate events are ignored.
// In Firefox E2E tests, background.js can't redirect to moz-extension:// because Playwright's
// Juggler protocol drops the page when it encounters that scheme. If the storage key
// __testPromptBase is set (by the test fixture), redirect there instead so Playwright can
// observe the navigation normally.
async function redirectToPrompt(tabId, promptUrl) {
    const data = await chrome.storage.local.get('__testPromptBase');
    let finalUrl = promptUrl;
    if (data.__testPromptBase) {
        try {
            const u = new URL(promptUrl);
            finalUrl = data.__testPromptBase + u.search;
        } catch {}
    }
    chrome.tabs.update(tabId, { url: finalUrl });
}

// Check if url matches target
async function isTargetSite(url) {
    const domain = getDomain(url);
    if (!domain) return false;

    const data = await chrome.storage.local.get({ targetSites: DEFAULT_TARGETS });
    return data.targetSites.includes(domain);
}

// Core navigation listener
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // We only care if URL changed or status is loading (initial load)
    if (!changeInfo.url && changeInfo.status !== 'loading') return;
    
    // If the tab is just loading the prompt, ignore logic to prevent loops
    if (tab.url.startsWith(chrome.runtime.getURL('prompt.html'))) return;

    // Prefer changeInfo.url (the actual new destination) over tab.url, which can be stale
    // when status events fire after a redirect has already been issued.
    const currentUrl = changeInfo.url || tab.url;

    const domain = getDomain(currentUrl);
    if (!domain) return;

    if (await isTargetSite(currentUrl)) {
        await checkAccess(tabId, currentUrl, domain);
    }
});

// Supplementary navigation listener for environments where tabs.onUpdated fires unreliably
// for certain navigation types (e.g. Playwright's Juggler protocol in Firefox).
chrome.webNavigation.onCommitted.addListener(async ({ tabId, url, frameId }) => {
    if (frameId !== 0) return;
    if (!url) return;
    if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return;

    const domain = getDomain(url);
    if (!domain) return;

    if (await isTargetSite(url)) {
        await checkAccess(tabId, url, domain);
    }
});

// activeSessions and cooldowns are global objects in storage. Since we read, modify, and 
// write them back entirely, concurrent operations across DIFFERENT domains can still clobber 
// each other. A global queue ensures all session-mutating operations run strictly sequentially.
let globalSessionQueue = Promise.resolve();

function enqueueSessionOp(opFn) {
    const thisCall = globalSessionQueue.catch(() => {}).then(opFn);
    globalSessionQueue = thisCall.catch(() => {});
    return thisCall;
}

function checkAccess(tabId, url, domain) {
    return enqueueSessionOp(() => checkAccessSerialized(tabId, url, domain));
}

async function checkAccessSerialized(tabId, url, domain) {
    // Reconcile span state from current reality before making the blocking decision.
    await syncSpanStateSerialized(Date.now());

    // Fetch all session state
    const data = await chrome.storage.local.get([
        'activeSessions', 'cooldowns', 'countCooldown', 'durationCooldown',
        'scheduledLimits', 'scheduledUsage', 'scheduledSpanStart', 'scheduledSpanLastLiveness',
    ]);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};
    const scheduledLimits = data.scheduledLimits || [];
    const scheduledUsage = data.scheduledUsage || {};
    const spanStart = data.scheduledSpanStart ?? null;
    const lastLiveness = data.scheduledSpanLastLiveness ?? null;

    const now = Date.now();

    // 0. Check scheduled limits (highest priority — a full block or an exhausted usage cap
    // overrides even an active session; no session can bypass it).
    if (scheduledLimits.length > 0) {
        const blocking = checkScheduledLimits(scheduledLimits, scheduledUsage, spanStart, lastLiveness, now);
        if (blocking.length > 0) {
            const entry = blocking[0];
            const promptUrl = chrome.runtime.getURL(
                `prompt.html?url=${encodeURIComponent(url)}&msg=SCHEDULED_LIMIT&limitId=${encodeURIComponent(entry.id)}`
            );
            await redirectToPrompt(tabId, promptUrl);
            return;
        }
    }

    // 1. Check Active Session (Priority over Cooldown for Unlimited)
    if (sessions[domain]) {
        const session = sessions[domain];

        // Validation Logic per type
        if (session.type === 'duration') {
            const endTime = session.endTime;
            const cooldownDuration = data.durationCooldown || 30;
            const cooldownEndTime = endTime + (cooldownDuration * 60 * 1000);

            if (now > cooldownEndTime) {
                 // Session exited AND Cooldown exited while browser was closed
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 await syncSpanStateSerialized(now);

                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 await redirectToPrompt(tabId, promptUrl);
                 return;
            } else if (now > endTime) {
                // Expired -> Start Cooldown (Backdated to actual end time) -> Redirect
                await endSessionAndStartCooldownInternal(domain, 'duration', endTime);
                await syncSpanStateSerialized(now);
                const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Time%20Up`);
                await redirectToPrompt(tabId, promptUrl);
                return;
            }
            return; // Allow access

        } else if (session.type === 'count') {
            // Check Expiry first
            if (session.cooldownEndTime && now > session.cooldownEndTime) {
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 await syncSpanStateSerialized(now);

                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 await redirectToPrompt(tabId, promptUrl);
                 return;
            }

            // Check for 2 hours inactivity (similar to unlimited)
            if (now - (session.lastActive || session.startTime) > 2 * 60 * 60 * 1000) {
                 // Session Expired due to inactivity
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 await syncSpanStateSerialized(now);

                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 await redirectToPrompt(tabId, promptUrl);
                 return;
            }

            // YouTube specific: Check video ID
            const videoId = getYouTubeVideoId(url);

            // Initialize array if missing (migration)
            if (!session.watchedVideoIds) session.watchedVideoIds = [];
            if (session.lastVideoId && !session.watchedVideoIds.includes(session.lastVideoId)) {
                 session.watchedVideoIds.push(session.lastVideoId); // migrates old single ID
            }

            if (videoId && !session.watchedVideoIds.includes(videoId)) {
                // New unique video detected
                session.videosWatched = (session.videosWatched || 0) + 1;

                if (session.videosWatched > session.targetCount) {
                    // Start Cooldown / Limit Reached
                    if (!session.cooldownEndTime) {
                         const cooldownDuration = data.countCooldown || 30;
                         const cooldownEnd = now + (cooldownDuration * 60 * 1000);
                         session.cooldownEndTime = cooldownEnd;

                         cooldowns[domain] = {
                             startTime: now,
                             duration: cooldownDuration * 60 * 1000
                         };

                         sessions[domain] = session;
                         await chrome.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
                    }

                    await syncSpanStateSerialized(now);
                    const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Limit%20Reached`);
                    await redirectToPrompt(tabId, promptUrl);
                    return;
                } else {
                     // Add to whitelist
                     session.watchedVideoIds.push(videoId);
                     session.lastActive = now;

                     // Check if we just hit the limit (Nth video) — cooldown starts NOW even
                     // though this navigation (the Nth video itself) is still allowed through.
                     if (session.videosWatched === session.targetCount) {
                         const cooldownDuration = data.countCooldown || 30; // default 30 min
                         // Start cooldown NOW
                         const cooldownEnd = now + (cooldownDuration * 60 * 1000);
                         session.cooldownEndTime = cooldownEnd;

                         cooldowns[domain] = {
                             startTime: now,
                             duration: cooldownDuration * 60 * 1000
                         };
                     }

                    sessions[domain] = session;
                    await chrome.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
                }
            } else {
                 // Watching a known/whitelisted video OR not a video page
                 if (!session.lastActive || now - session.lastActive > 5000) { // 5s throttle
                     session.lastActive = now;
                     sessions[domain] = session;
                     await chrome.storage.local.set({ activeSessions: sessions });
                 }
            }

            // This navigation itself may have just started a cooldown (the Nth-video case
            // above) — resync so the span correctly closes even though this call still
            // allows access.
            await syncSpanStateSerialized(now);
            return; // Allow access
        } else if (session.type === 'single_url') {
            if (checkSingleUrlMatch(url, session.targetUrl)) {
                 // Keep lastActive fresh so isSessionGrantingAccess's span-tracking-only
                 // liveness bound (see above) doesn't time out an actively-revisited session.
                 session.lastActive = now;
                 sessions[domain] = session;
                 await chrome.storage.local.set({ activeSessions: sessions });
                 return; // Allow access
            } else {
                 // Navigated away. End this single_url session.
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 await syncSpanStateSerialized(now);

                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Finished`);
                 await redirectToPrompt(tabId, promptUrl);
                 return;
            }
        }
    }

    // 2. Check Cooldown (If no active session)
    if (cooldowns[domain]) {
        const { startTime, duration } = cooldowns[domain];
        const endTime = startTime + duration; // Calculate end time dynamically

        if (endTime > now) {
            const minutesLeft = Math.ceil((endTime - now) / 60000);
            const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&cooldown=${minutesLeft}`);
            await redirectToPrompt(tabId, promptUrl);
            return;
        } else {
            // Expired, clean up
            delete cooldowns[domain];
            await chrome.storage.local.set({ cooldowns });
        }
    }

    // 3. No Session & No Cooldown -> Redirect to Prompt to Start
    const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}`);
    await redirectToPrompt(tabId, promptUrl);
}

function checkSingleUrlMatch(currentUrl, targetUrl) {
    if (!currentUrl || !targetUrl) return false;
    if (currentUrl === targetUrl) return true;
    try {
        const curr = new URL(currentUrl);
        const tgt = new URL(targetUrl);
        if ((curr.hostname.includes('youtube.com') || curr.hostname.includes('youtu.be')) &&
            (tgt.hostname.includes('youtube.com') || tgt.hostname.includes('youtu.be'))) {
            const currVid = getYouTubeVideoId(currentUrl);
            const tgtVid = getYouTubeVideoId(targetUrl);
            if (currVid && tgtVid && currVid === tgtVid) return true;
            return false;
        }
        if (curr.hostname.includes('reddit.com') && tgt.hostname.includes('reddit.com')) {
            const currPath = curr.pathname.replace(/\/$/, "");
            const tgtPath = tgt.pathname.replace(/\/$/, "");
            const redditPostRegex = /\/r\/[\w-]+\/comments\/([\w]+)/;
            const currMatch = currPath.match(redditPostRegex);
            const tgtMatch = tgtPath.match(redditPostRegex);
            if (currMatch && tgtMatch && currMatch[1] === tgtMatch[1]) return true;
            return false;
        }
        return false;
    } catch(e) {
        return false;
    }
}

function getYouTubeVideoId(url) {
    try {
        const u = new URL(url);
        if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
            if (u.pathname.startsWith('/shorts/')) {
                return u.pathname.split('/shorts/')[1].split('/')[0];
            }
            return u.searchParams.get('v');
        }
    } catch(e) {}
    return null;
}

async function endSessionAndStartCooldownInternal(domain, type, overrideStartTime = null) {
    const data = await chrome.storage.local.get(['activeSessions', 'cooldowns', 'durationCooldown', 'countCooldown']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};

    delete sessions[domain];

    const durationMinutes = (type === 'duration' ? data.durationCooldown : data.countCooldown) || 30;

    // New Structure: Store start time and duration
    cooldowns[domain] = {
        startTime: overrideStartTime || Date.now(),
        duration: durationMinutes * 60 * 1000,
        originalType: type
    };

    await chrome.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
}

function endSessionAndStartCooldown(domain, type, overrideStartTime = null) {
    return enqueueSessionOp(() => endSessionAndStartCooldownInternal(domain, type, overrideStartTime));
}

// Handle Alarms for Duration Expiry
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name.startsWith('session_')) {
        const domain = alarm.name.split('session_')[1];
        // Session expired.
        // Get active tabs for this domain and redirect them.
        const tabs = await chrome.tabs.query({});
        const data = await chrome.storage.local.get(['activeSessions']);

        // Verify session is still active and duration type
        if (data.activeSessions && data.activeSessions[domain] && data.activeSessions[domain].type === 'duration') {
             const session = data.activeSessions[domain];
             await endSessionAndStartCooldown(domain, 'duration', session.endTime);

             // This alarm ends a session with zero navigation involved — if it was the sole
             // granting session, the span must close here, or it would stay open indefinitely
             // until some unrelated event happens to touch it.
             await syncSpanState(Date.now());

             // Redirect pages immediately
             await Promise.all(tabs.map(async tab => {
                 try {
                     if (getDomain(tab.url) === domain) {
                          const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(tab.url)}&msg=Time%20Up`);
                          await redirectToPrompt(tab.id, promptUrl);
                     }
                 } catch(e) {}
             }));
        }
    } else if (alarm.name.startsWith('schedlimit_')) {
        const limitId = alarm.name.slice('schedlimit_'.length);
        const now = Date.now();

        // Reconcile span state from current reality first — don't trust whatever was true
        // when this alarm was originally scheduled.
        const { usage, spanStart, lastLiveness } = await syncSpanState(now);

        const data = await chrome.storage.local.get({ scheduledLimits: [], targetSites: DEFAULT_TARGETS });
        const entries = data.scheduledLimits;

        const blocking = checkScheduledLimits(entries, usage, spanStart, lastLiveness, now);
        if (blocking.length > 0) {
            const entry = blocking[0];
            const targetSites = data.targetSites;
            const tabs = await chrome.tabs.query({});
            await Promise.all(tabs.map(async tab => {
                try {
                    const tabDomain = getDomain(tab.url);
                    if (tabDomain && targetSites.includes(tabDomain)) {
                        const promptUrl = chrome.runtime.getURL(
                            `prompt.html?url=${encodeURIComponent(tab.url)}&msg=SCHEDULED_LIMIT&limitId=${encodeURIComponent(entry.id)}`
                        );
                        await redirectToPrompt(tab.id, promptUrl);
                    }
                } catch (e) {}
            }));
        }

        // Reschedule this entry's next event (window-start if now inactive, exhaustion/
        // window-end if still active), if it still exists.
        const stillExists = entries.find(e => e.id === limitId);
        if (stillExists) scheduleSingleEntryAlarm(stillExists, usage, spanStart, lastLiveness, now);
    }
});

// Handle Messages from Prompt or Content Script
chrome.tabs.onRemoved.addListener((tabId) => {
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startSession') {
        startSession(message.url, message.type, message.value).then((success) => {
            sendResponse({ success: success });
        }).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    } else if (message.action === 'scheduledLimitLivenessPing') {
        syncSpanState(Date.now())
            .then(() => sendResponse({}))
            .catch(() => sendResponse({}));
        return true;
    } else if (message.action === 'scheduledLimitsChanged') {
        // Reconcile span state first — otherwise a newly-saved/deleted entry's alarm could get
        // scheduled against a stale span left over from before this edit.
        syncSpanState(Date.now())
            .then(() => syncScheduledLimitAlarms())
            .then(() => sendResponse({}))
            .catch(() => sendResponse({}));
        return true;
    }
});

// Survive browser restarts / extension (re)installs: reconcile span state (this is what
// bounds any downtime while the browser was fully closed — the liveness-tolerance formula in
// computeUsedSeconds handles it automatically, no special-casing needed here) and alarms.
chrome.runtime.onInstalled.addListener(async () => {
    await syncSpanState(Date.now());
    await syncScheduledLimitAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
    await syncSpanState(Date.now());
    await syncScheduledLimitAlarms();
});

async function startSessionInternal(url, type, value) {
    const domain = getDomain(url);
    if (!domain) return false;

    const data = await chrome.storage.local.get(['activeSessions']);
    const sessions = data.activeSessions || {};

    const cooldownData = await chrome.storage.local.get(['durationCooldown']);
    const durationCooldown = cooldownData.durationCooldown || 30;

    const session = {
        type: type,
        startTime: Date.now(),
    };

    if (type === 'duration') {
        session.durationMinutes = value;
        session.endTime = Date.now() + (value * 60 * 1000);
        // Calculate and save cooldown end time based on scheduled end time
        session.cooldownEndTime = session.endTime + (durationCooldown * 60 * 1000);

        // Create Alarm
        chrome.alarms.create(`session_${domain}`, { when: session.endTime });

    } else if (type === 'count') {
        session.targetCount = value;
        session.videosWatched = 0;
        session.watchedVideoIds = [];
        const vid = getYouTubeVideoId(url);
        if (vid) {
             session.videosWatched = 1;
             session.watchedVideoIds.push(vid);
        }
    } else if (type === 'single_url') {
        session.targetUrl = value;
    }

    sessions[domain] = session;
    await chrome.storage.local.set({ activeSessions: sessions });
    return true;
}

function startSession(url, type, value) {
    return enqueueSessionOp(() => startSessionInternal(url, type, value));
}
