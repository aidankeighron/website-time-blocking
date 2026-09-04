// background.js

// State management
// We use chrome.storage.local for persistence.

const DEFAULT_TARGETS = ['instagram.com', 'reddit.com', 'youtube.com'];
const processingTabs = new Set(); // Tracks tabs currently being processed (short-lived lock)
const pendingPromptTabs = new Set(); // Tracks tabs redirected to prompt.html, waiting to commit
const tabsCurrentlyAtPrompt = new Set(); // Tracks tabs that have committed to prompt.html
// Which domain each processingTabs entry's debounce is actually FOR. The 1-second debounce
// below exists to swallow duplicate events for the SAME in-flight navigation (a site can fire
// many onUpdated ticks per navigation); it must not also swallow a genuinely different,
// subsequent navigation on the same tab that happens to land inside that window. Concretely:
// opening a new tab and typing into the omnibox routes through Chrome's own
// chrome://newtab/ -> chrome-untrusted://new-tab-page/... -> google.com/search/warmup.html
// chain before ever reaching the real destination — all as ordinary onUpdated events on ONE
// tab, not a tab replacement. None of those are target sites, so nothing blocks them, but the
// debounce they leave behind used to also blindly swallow the real destination's own event if
// it arrived (as it usually does once caches are warm) within that same second — a live-
// confirmed miss with zero blocking UI. Comparing against the domain actually being debounced
// lets a different domain through immediately instead of waiting out someone else's window.
const lastCheckedDomain = new Map();
// Tabs whose real destination chrome.tabs.onReplaced is still waiting to discover (tab.url was
// empty or a transient browser placeholder at swap time — see isTransientBrowserUrl below).
// Deliberately separate from processingTabs/lastCheckedDomain: while a tab is in here, the
// top-level onUpdated/handleWebNavigationEvent listeners must defer to the retry's own scoped
// listener UNCONDITIONALLY, regardless of domain — domain-based debouncing doesn't apply
// because there IS no domain yet; that's the whole thing being resolved.
const pendingReplacementResolution = new Set();

// Verbose console logging for navigation/session-flow debugging. Leave off in normal use.
const WTB_DEBUG = false;

// --- Half Full Integration ---
//
// Scheduled limits can have an optional `halfFullPattern` field:
//   { id, pattern, type, color }
// When set, the limit is only applied if today has incomplete tasks matching that pattern
// in the user's Half Full account. This lets users set "conditional" limits — e.g. block
// YouTube until all homework tasks are done.

const HF_API_KEY = 'AIzaSyAFllak-Mt7RTf0hFInUMR8-25PeaiHE34';
const HF_PROJECT_ID = 'alchemy-a816c';
const HF_TASK_CACHE_TTL_MS = 2 * 60 * 1000; // 2 min cache for today's tasks
const HF_DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Mirrors half-full-desktop's dateToWeekNumber (week IDs map to Firestore week docs).
function hfDateToWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const firstOfJanuary = new Date(d.getFullYear(), 0, 1, 0, 0, 0);
    firstOfJanuary.setHours(0, 0, 0, 0);
    const dayNumber = Math.round(
        (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
         Date.UTC(firstOfJanuary.getFullYear(), firstOfJanuary.getMonth(), firstOfJanuary.getDate())) / 86400000
    ) + 1;
    let weekNumber = Math.ceil((dayNumber + firstOfJanuary.getDay()) / 7);
    if (weekNumber === 1) {
        weekNumber = hfDateToWeekNumber(new Date(d.getFullYear() - 1, 11, 31, 0, 0, 0));
    }
    return weekNumber;
}

// Parse a Firestore REST API typed value into a plain JS value.
function hfParseFirestoreValue(val) {
    if (!val) return null;
    if ('stringValue' in val) return val.stringValue;
    if ('booleanValue' in val) return val.booleanValue;
    if ('integerValue' in val) return parseInt(val.integerValue, 10);
    if ('doubleValue' in val) return val.doubleValue;
    if ('nullValue' in val) return null;
    if ('mapValue' in val) {
        const result = {};
        for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
            result[k] = hfParseFirestoreValue(v);
        }
        return result;
    }
    if ('arrayValue' in val) {
        return (val.arrayValue.values || []).map(hfParseFirestoreValue);
    }
    return null;
}

function hfParseFirestoreDoc(doc) {
    if (!doc || !doc.fields) return null;
    const result = {};
    for (const [key, val] of Object.entries(doc.fields)) {
        result[key] = hfParseFirestoreValue(val);
    }
    return result;
}

// Dedupes concurrent refresh attempts — buildHalfFullPatternMap can call hfGetValidToken for
// several patterns at once with an expired token; without this each call independently hits
// the refresh endpoint and independently writes the result, racing each other.
let hfTokenRefreshInFlight = null;

// Returns a valid Firebase ID token, refreshing it if expired. Returns null if not logged in.
async function hfGetValidToken() {
    const data = await chrome.storage.local.get({ halfFullAuth: null });
    const auth = data.halfFullAuth;
    if (!auth || !auth.refreshToken) return null;
    if (auth.expiresAt && Date.now() < auth.expiresAt - 60000) return auth.idToken;
    if (hfTokenRefreshInFlight) return hfTokenRefreshInFlight;
    hfTokenRefreshInFlight = hfRefreshTokenNow(auth).finally(() => { hfTokenRefreshInFlight = null; });
    return hfTokenRefreshInFlight;
}

async function hfRefreshTokenNow(auth) {
    try {
        const resp = await fetch(
            `https://securetoken.googleapis.com/v1/token?key=${HF_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`
            }
        );
        if (!resp.ok) {
            // The server responded (this isn't a network failure) but rejected the refresh —
            // the token is genuinely invalid/revoked, not just temporarily unreachable. Sign
            // out so the UI reflects reality (prompts re-login) instead of silently claiming to
            // be signed in indefinitely while every pattern check quietly no-ops.
            await chrome.storage.local.remove(['halfFullAuth', 'halfFullPatterns', 'halfFullTaskCache']);
            return null;
        }
        const result = await resp.json();
        const updated = {
            ...auth,
            idToken: result.id_token,
            refreshToken: result.refresh_token,
            uid: result.user_id,
            expiresAt: Date.now() + parseInt(result.expires_in, 10) * 1000,
        };
        await chrome.storage.local.set({ halfFullAuth: updated });
        return updated.idToken;
    } catch {
        // Network-level failure (offline, timeout, DNS) — likely transient. Leave auth intact
        // and just report "no valid token right now" for this one check; hfIsPatternActive's
        // own conservative fallback (limit stays active) handles the rest.
        return null;
    }
}

// Returns true if today's Half Full tasks contain at least one INCOMPLETE task matching pattern.
// Uses a short cache to avoid hitting Firestore on every navigation.
// Conservative fallback: if auth fails or fetch fails, returns true (limit stays active).
async function hfIsPatternActive(pattern) {
    if (!pattern || !pattern.pattern) return true;
    const token = await hfGetValidToken();
    if (!token) return true;
    const stored = await chrome.storage.local.get({ halfFullAuth: null, halfFullTaskCache: null });
    const auth = stored.halfFullAuth;
    if (!auth || !auth.uid) return true;
    const now = Date.now();
    const cache = stored.halfFullTaskCache;
    let tasks = null;
    if (cache && cache.fetchedAt && (now - cache.fetchedAt) < HF_TASK_CACHE_TTL_MS) {
        tasks = cache.tasks;
    } else {
        try {
            const today = new Date();
            const weekId = `week${hfDateToWeekNumber(today)}`;
            const url = `https://firestore.googleapis.com/v1/projects/${HF_PROJECT_ID}/databases/(default)/documents/users/${auth.uid}/weeks/${weekId}`;
            const resp = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` },
                signal: AbortSignal.timeout(5000),
            });
            if (resp.ok) {
                const doc = await resp.json();
                const weekData = hfParseFirestoreDoc(doc);
                const todayName = HF_DAY_NAMES[today.getDay()];
                const dayTasks = weekData && weekData.tasks && weekData.tasks[todayName];
                tasks = dayTasks ? Object.values(dayTasks) : [];
                await chrome.storage.local.set({ halfFullTaskCache: { tasks, fetchedAt: now } });
            } else if (resp.status === 404) {
                tasks = [];
                await chrome.storage.local.set({ halfFullTaskCache: { tasks, fetchedAt: now } });
            } else {
                // Deliberately NOT falling back to cache.tasks here: this branch is only ever
                // reached when the cache already failed its own freshness check above, so
                // "the cache" could be hours or days old — reusing it isn't a soft fallback,
                // it's silently trusting arbitrarily stale data. Treat as indeterminate instead,
                // which the tasks === null check below turns into the documented conservative
                // behavior (limit stays active).
                tasks = null;
            }
        } catch {
            tasks = null;
        }
    }
    if (tasks === null) return true; // can't determine — conservative
    const pat = pattern.pattern.toLowerCase();
    const type = pattern.type || 'any';
    return tasks.some(task => {
        if (!task || !task.name || task.checked) return false;
        const name = task.name.toLowerCase();
        if (type === 'start') return name.startsWith(pat);
        if (type === 'end') return name.endsWith(pat);
        return name.includes(pat);
    });
}

// Build a map { [limitId]: boolean } for all entries with halfFullPattern that are currently
// in their time window. Entries without halfFullPattern are omitted (treated as always active).
async function buildHalfFullPatternMap(entries, now = Date.now()) {
    const needsCheck = entries.filter(e => e.halfFullPattern && isWindowActive(e, now));
    if (needsCheck.length === 0) return {};
    const results = await Promise.all(needsCheck.map(e => hfIsPatternActive(e.halfFullPattern)));
    const map = {};
    needsCheck.forEach((e, i) => { map[e.id] = results[i]; });
    return map;
}

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

// How long a count/single_url session can go untouched before it's treated as abandoned and
// cleared. Mirrored across isSessionGrantingAccess and checkAccessSerialized — see comments
// at each usage site for why they must stay in sync.
const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

// (Re)schedules the count_inactivity_<domain> proactive backstop alarm for `session` at the
// EARLIER of its two lazy expiry conditions (mirrors checkAccessSerialized's own
// cooldownEndTime-vs-inactivity check, see the count_inactivity_ alarm handler). Using the plain
// lastActive+timeout instant here — without ever consulting cooldownEndTime — would leave a
// short countCooldown (e.g. 5 minutes, shorter than SESSION_INACTIVITY_TIMEOUT_MS) sitting
// unenforced by any alarm until the later inactivity instant, the exact same class of "sits
// there stale until something else happens to revisit it" bug this alarm exists to close.
function scheduleCountInactivityAlarm(domain, session, now = Date.now()) {
    const lastActive = session.lastActive || session.startTime;
    let when = lastActive + SESSION_INACTIVITY_TIMEOUT_MS;
    if (session.cooldownEndTime) when = Math.min(when, session.cooldownEndTime);
    chrome.alarms.create(`count_inactivity_${domain}`, { when });
}

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
// patternActiveMap: optional { [limitId]: boolean } — false means pattern has no active tasks,
// so the limit is skipped. Omitted entries default to active (limit applies).
function checkScheduledLimits(entries, usage, spanStart, lastLiveness, now = Date.now(), patternActiveMap = {}) {
    const blocking = entries.filter(entry => {
        if (!isWindowActive(entry, now)) return false;
        // Half Full conditional: skip this limit if pattern has no incomplete tasks today.
        if (entry.halfFullPattern && patternActiveMap[entry.id] === false) return false;
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

    // Half-Full-conditional entries can flip blocking state at any moment as the user's tasks
    // are completed/added in an entirely separate app — that's not a schedulable clock event,
    // so instead of trying to predict it, force a periodic recheck at the cache TTL. Without
    // this, an entry whose usage/window-end next-event is hours away would never get proactively
    // re-evaluated if a task un-completes mid-window with no navigation to trigger a lazy check.
    const hfCeiling = entry.halfFullPattern ? now + HF_TASK_CACHE_TTL_MS : Infinity;

    if (entry.limitMinutes === 0) return Math.min(windowEnd, hfCeiling);

    const budget = entry.limitMinutes * 60;
    const usedNow = computeUsedSeconds(entry, usage, spanStart, lastLiveness, now);
    if (usedNow >= budget) return Math.min(windowEnd, hfCeiling);
    if (spanStart == null) return Math.min(windowEnd, hfCeiling); // nobody browsing; nothing pending

    const dateKey = getWindowDateKey(entry, now);
    const rec = usage[entry.id];
    const banked = (rec && rec.dateKey === dateKey) ? rec.bankedSeconds : 0;
    const occurrenceStart = getCurrentWindowStartTimestamp(entry, now);
    const effectiveStart = effectiveSpanStartFor(entry, spanStart, occurrenceStart);

    const projectedExhaustion = effectiveStart + (budget - banked) * 1000;
    return Math.min(projectedExhaustion, windowEnd, hfCeiling);
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
        // two expiry conditions instead (cooldown fully expired, or SESSION_INACTIVITY_TIMEOUT_MS
        // of inactivity). This also makes an abandoned under-target session (never hit its cap,
        // tab just closed) self-correcting after the timeout instead of reporting "granting"
        // forever with nothing external to time it out.
        if (session.cooldownEndTime && now > session.cooldownEndTime) return false;
        const lastActive = session.lastActive || session.startTime;
        return (now - lastActive) <= SESSION_INACTIVITY_TIMEOUT_MS;
    }

    if (session.type === 'single_url') {
        // No fixed duration by design — checkAccess itself never times these out; they end
        // only when the user navigates away from the matching URL. For SPAN-tracking purposes
        // only, bound how long an abandoned one (tab closed without navigating away) can keep
        // phantom-crediting usage to unrelated scheduled-limit windows, mirroring count's same
        // SESSION_INACTIVITY_TIMEOUT_MS ceiling. This does not change the single_url feature
        // itself — a real revisit within the window still resumes normally via
        // checkSingleUrlMatch regardless.
        const lastActive = session.lastActive || session.startTime;
        return (now - lastActive) <= SESSION_INACTIVITY_TIMEOUT_MS;
    }

    return false;
}

function isAnySessionGrantingAccess(sessions, now = Date.now()) {
    return Object.values(sessions).some(s => isSessionGrantingAccess(s, now));
}

// Stricter than isSessionGrantingAccess: true only if this session has been touched within the
// last SPAN_TOLERANCE_MS. Used specifically to gate re-opening a span that just closed due to
// staleness. isSessionGrantingAccess's generous "up to SESSION_INACTIVITY_TIMEOUT_MS since last
// touch" leniency for count/single_url sessions is intentional for NOT prematurely ending an
// open span over a brief gap — but using that same leniency to justify OPENING a brand new span
// (i.e. starting to bill again) let an abandoned, idle session (e.g. a count session sitting
// untouched in cooldown) collect a free SPAN_TOLERANCE_MS top-up every time anything else in the
// extension happened to run reconciliation, with zero real usage behind it. Re-opening needs
// genuinely fresh evidence of activity, not just "this session record hasn't technically expired
// yet".
function isSessionFreshlyActive(session, now = Date.now()) {
    if (session.type === 'duration') return now < session.endTime;
    const lastActive = session.lastActive || session.startTime;
    return (now - lastActive) <= SPAN_TOLERANCE_MS;
}

function isAnySessionFreshlyActive(sessions, now = Date.now()) {
    return Object.values(sessions).some(s => isSessionFreshlyActive(s, now));
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
    // Distinguishes "the span is ending because access genuinely ended" from "the span is
    // ending because we just haven't heard anything in a while, but the session record itself
    // hasn't technically expired" — only the latter needs the stricter re-open check below.
    const closingDueToStalenessAlone = spanStart != null && stale && granting;

    let transitioned = false;

    if (spanStart != null && (!granting || stale)) {
        // Close (or close-then-reopen below, if still eligible): bank each currently-active
        // entry's live portion up to the liveness horizon — never beyond it, so a stale gap
        // never gets retroactively counted just because we're finally closing it.
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

    // Re-opening right after a stale-close must not lean on the same lenient "granting" signal
    // that just failed to prevent the close in the first place — an abandoned count/single_url
    // session (idle, sitting in cooldown) would otherwise collect a free SPAN_TOLERANCE_MS
    // credit every time ANYTHING else triggers reconciliation, with zero real usage behind it.
    // Require genuinely fresh activity (isAnySessionFreshlyActive) in that specific case; a
    // close driven by real expiry (!granting), or a span that was never open to begin with,
    // still uses the normal "granting" check — a session that just started is by definition
    // freshly active anyway, so this changes nothing for the ordinary open-a-new-span case.
    const canOpen = closingDueToStalenessAlone ? isAnySessionFreshlyActive(sessions, now) : granting;

    if (canOpen && spanStart == null) {
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
        const hostname = new URL(url).hostname.replace(/^(www\.|m\.|mobile\.)/, '');
        // youtu.be is YouTube's own short-link domain for the exact same site/videos — without
        // this alias it's treated as an entirely different, non-target domain: isTargetSite
        // never matches it (targetSites only ever contains "youtube.com"), so a youtu.be link
        // silently bypasses blocking, video counting, and any active youtube.com session
        // entirely, regardless of what getYouTubeVideoId can extract from it.
        if (hostname === 'youtu.be') return 'youtube.com';
        return hostname;
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
    pendingPromptTabs.add(tabId);
    const data = await chrome.storage.local.get('__testPromptBase');
    let finalUrl = promptUrl;
    if (data.__testPromptBase) {
        try {
            const u = new URL(promptUrl);
            finalUrl = data.__testPromptBase + u.search;
        } catch {}
    }
    chrome.tabs.update(tabId, { url: finalUrl });

    // Typing a bare domain (e.g. "youtube.com") triggers the site's own multi-hop redirect
    // chain (http->https, apex->www) that's still in flight at the network layer when we issue
    // the update above, and Chrome sometimes lets that in-progress navigation win instead of
    // our tabs.update() call, silently dropping the block. Verifying this used to rely on a
    // bare setTimeout, but background.js runs as a non-persistent MV3 service worker — a plain
    // timer isn't guaranteed to survive worker eviction, and if dropped, pendingPromptTabs was
    // left stuck forever for that tab (see backstopPendingTab for the replacement approach:
    // verification now piggybacks on the tab's own next real navigation event instead of a
    // detached timer, so it can't be silently lost this way).
}

// Prompt-page URL bases this extension may have redirected a tab to — the real extension URL,
// plus (in Firefox E2E tests) __testPromptBase, since Playwright's Juggler protocol can't
// observe moz-extension:// navigations directly (see redirectToPrompt).
async function getPromptBases() {
    const data = await chrome.storage.local.get('__testPromptBase');
    const bases = [chrome.runtime.getURL('prompt.html')];
    if (data.__testPromptBase) bases.push(data.__testPromptBase);
    return bases;
}

// Dedicated in-flight guard for backstopPendingTab, deliberately separate from
// processingTabs: that Set stays held for a full extra second after an ordinary check
// completes (an artificial debounce against unrelated flicker events, see the onUpdated
// listener below), which would otherwise cause it to still be "locked" — and silently swallow
// a genuine, differently-URLed backstop event — for up to a second after the very redirect
// that armed pendingPromptTabs in the first place. Cleared immediately when the check
// completes, since there's no equivalent flicker concern here: this only runs on settled
// navigations (onUpdated's status:'complete', or onCommitted/onHistoryStateUpdated, both of
// which fire once per resolved navigation, not per intermediate loading tick).
const backstopInFlight = new Set();

// Called whenever a tab we redirected to prompt.html (pendingPromptTabs) generates a further
// real navigation event whose URL is NOT the prompt page — i.e. our redirect may have lost a
// race against the site's own in-flight navigation. Re-runs the REAL access decision for
// whatever the tab is now showing, through the normal queued path. Deliberately not a URL/
// domain string comparison: that can't tell "genuinely still stuck on the site we tried to
// block" apart from "legitimately granted access to that SAME site in the meantime" (e.g.
// Extend/Finish succeeding) — only the real decision logic knows the difference. Driven by the
// browser's own "this navigation settled" signal (onUpdated's status:'complete', or
// onCommitted/onHistoryStateUpdated), so — unlike a detached timer — it can't be silently lost
// to service-worker eviction: if the worker is alive to receive the event, it's alive to
// process it; if it was evicted, pendingPromptTabs was already reset to empty and this function
// is never even reached, since the event just flows through the normal fresh-navigation path.
async function backstopPendingTab(tabId, url) {
    if (backstopInFlight.has(tabId)) return;
    const promptBases = await getPromptBases();
    if (promptBases.some(base => url.startsWith(base))) return; // arrived at prompt; nothing to backstop

    backstopInFlight.add(tabId);
    try {
        const domain = getDomain(url);
        if (domain && await isTargetSite(url)) {
            if (WTB_DEBUG) console.log('[WTB DEBUG] backstopPendingTab: re-checking', { tabId, url, domain });
            const blocked = await checkAccess(tabId, url, domain);
            if (WTB_DEBUG) console.log('[WTB DEBUG] backstopPendingTab: decision', { tabId, blocked });
            if (!blocked) pendingPromptTabs.delete(tabId);
        } else {
            if (WTB_DEBUG) console.log('[WTB DEBUG] backstopPendingTab: no longer a target site, clearing', { tabId, url });
            pendingPromptTabs.delete(tabId);
        }
    } finally {
        backstopInFlight.delete(tabId);
    }
}

// Check if url matches target
async function isTargetSite(url) {
    const domain = getDomain(url);
    if (!domain) return false;

    const data = await chrome.storage.local.get({ targetSites: DEFAULT_TARGETS });
    const result = data.targetSites.includes(domain);
    if (WTB_DEBUG) console.log('[WTB DEBUG] isTargetSite', { url, domain, targetSites: data.targetSites, result });
    return result;
}

// Core navigation listener
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (WTB_DEBUG) console.log('[WTB DEBUG] onUpdated fired', { tabId, changeInfo, tabUrl: tab.url });

    // We only care if URL changed or status is loading (initial load)
    if (!changeInfo.url && changeInfo.status !== 'loading') return;

    // Prefer changeInfo.url (the actual new destination) over tab.url, which can be stale
    // when status events fire after a redirect has already been issued.
    const currentUrl = changeInfo.url || tab.url;

    // If the tab has committed to the prompt page, mark it and clear the debounce lock —
    // the redirect is complete, so a later event for this tab should be treated fresh.
    if (currentUrl.startsWith(chrome.runtime.getURL('prompt.html'))) {
        tabsCurrentlyAtPrompt.add(tabId);
        processingTabs.delete(tabId);
        if (WTB_DEBUG) console.log('[WTB DEBUG] onUpdated: landed at prompt.html', { tabId });
        return;
    }

    // If the tab was genuinely at prompt.html and is now navigating away (e.g. after
    // starting a session), clear the pending markers and fall through to process it.
    if (tabsCurrentlyAtPrompt.has(tabId)) {
        if (WTB_DEBUG) console.log('[WTB DEBUG] onUpdated: navigating away from prompt.html, clearing pending flags', { tabId, currentUrl });
        tabsCurrentlyAtPrompt.delete(tabId);
        pendingPromptTabs.delete(tabId);
    } else if (pendingPromptTabs.has(tabId)) {
        // Tab was redirected to prompt but hasn't landed there yet. Intermediate `loading`
        // hops (e.g. site.com -> www.site.com mid-chain) are ignored so they don't race a
        // second, competing redirect. Once the navigation actually settles (status:
        // 'complete') somewhere that isn't the prompt page, our redirect lost that race —
        // hand off to the real access-check backstop instead of silently giving up.
        if (changeInfo.status !== 'complete') {
            if (WTB_DEBUG) console.log('[WTB DEBUG] onUpdated: ignoring intermediate loading hop while pending', { tabId, currentUrl, status: changeInfo.status });
            return;
        }
        if (WTB_DEBUG) console.log('[WTB DEBUG] onUpdated: pending tab settled off prompt page', { tabId, currentUrl });
        await backstopPendingTab(tabId, currentUrl);
        return;
    }

    if (pendingReplacementResolution.has(tabId)) {
        // onReplaced's retry (below) is actively waiting for this specific tab's real
        // destination via its own scoped listener — defer to it entirely rather than also
        // acting on this event ourselves, which would double-process it.
        if (WTB_DEBUG) console.log('[WTB DEBUG] onUpdated: deferring to onReplaced retry in flight', { tabId, currentUrl });
        return;
    }

    const domain = getDomain(currentUrl);
    if (!domain) {
        if (WTB_DEBUG) console.log('[WTB DEBUG] onUpdated: no resolvable domain, ignoring', { tabId, currentUrl });
        return;
    }

    // A rapid duplicate of an in-flight check for this SAME domain. Sites fire many onUpdated
    // events per navigation (loading/complete, title, favicon, SPA route changes — this is
    // especially aggressive on Firefox and on the exact sites this extension targets), and
    // without this lock each one independently re-issues its own tabs.update() redirect,
    // which itself triggers more onUpdated events — a flicker loop that can take minutes to
    // settle before the block finally sticks. Gated on domain (not just tabId) so a genuinely
    // different, subsequent navigation on the same tab — e.g. Chrome's own
    // chrome://newtab/ -> search-warmup -> destination chain — isn't swallowed just because it
    // lands inside this domain's debounce window (see lastCheckedDomain above).
    if (processingTabs.has(tabId) && lastCheckedDomain.get(tabId) === domain) {
        if (WTB_DEBUG) console.log('[WTB DEBUG] onUpdated: skipped, processingTabs locked for same domain', { tabId, currentUrl, domain });
        return;
    }

    processingTabs.add(tabId);
    lastCheckedDomain.set(tabId, domain);
    try {
        if (await isTargetSite(currentUrl)) {
            await checkAccess(tabId, currentUrl, domain);
        }
    } finally {
        // Release the lock after a short delay so the redirect has time to take effect
        // before we listen again — this debounces the event stream.
        setTimeout(() => {
            processingTabs.delete(tabId);
        }, 1000);
    }
});

// Supplementary navigation listener for cases where tabs.onUpdated fires unreliably or not at
// all: Playwright's Juggler protocol in Firefox, and — via onHistoryStateUpdated below — SPA
// route changes (pushState/replaceState) on target sites like YouTube search, video-to-video
// navigation, and Reddit/Instagram in-app routing, none of which are full page navigations.
async function handleWebNavigationEvent({ tabId, url, frameId }) {
    if (WTB_DEBUG) console.log('[WTB DEBUG] handleWebNavigationEvent fired', { tabId, url, frameId });
    if (frameId !== 0) return;
    if (!url) return;
    if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return;
    if (pendingPromptTabs.has(tabId)) {
        // onCommitted/onHistoryStateUpdated only fire once a navigation has resolved to its
        // final URL (no intermediate 'loading' hops to filter, unlike onUpdated above), so any
        // event here for a pending tab means our redirect lost the race — hand off to the real
        // access-check backstop instead of silently giving up.
        if (WTB_DEBUG) console.log('[WTB DEBUG] handleWebNavigationEvent: pending tab settled off prompt page', { tabId, url });
        await backstopPendingTab(tabId, url);
        return;
    }
    if (pendingReplacementResolution.has(tabId)) {
        if (WTB_DEBUG) console.log('[WTB DEBUG] handleWebNavigationEvent: deferring to onReplaced retry in flight', { tabId, url });
        return;
    }
    const domain = getDomain(url);
    if (!domain) {
        if (WTB_DEBUG) console.log('[WTB DEBUG] handleWebNavigationEvent: no resolvable domain, ignoring', { tabId, url });
        return;
    }

    // See the matching comment in onUpdated above: only swallow a duplicate for the SAME
    // domain, not a genuinely different navigation landing inside the debounce window.
    if (processingTabs.has(tabId) && lastCheckedDomain.get(tabId) === domain) {
        if (WTB_DEBUG) console.log('[WTB DEBUG] handleWebNavigationEvent: skipped, processingTabs locked for same domain', { tabId, url, domain });
        return;
    }

    processingTabs.add(tabId);
    lastCheckedDomain.set(tabId, domain);
    try {
        if (await isTargetSite(url)) {
            await checkAccess(tabId, url, domain);
        }
    } finally {
        setTimeout(() => { processingTabs.delete(tabId); }, 1000);
    }
}

chrome.webNavigation.onCommitted.addListener(handleWebNavigationEvent);
// onCommitted never fires for History API (pushState/replaceState) navigations — this is the
// dedicated event for those, needed because YouTube/Reddit/Instagram are SPAs that change the
// URL client-side (e.g. YouTube search, clicking between videos) without a full navigation.
chrome.webNavigation.onHistoryStateUpdated.addListener(handleWebNavigationEvent);

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

// Returns true if this call blocked/redirected the tab, false if access was allowed (the tab's
// own navigation proceeds normally). Callers that re-run this against a tab already sitting on
// prompt.html (see syncOtherPromptTabs) use the return value to know whether they still need to
// actively navigate it forward — "allowed" alone doesn't move a tab that isn't mid-navigation.
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

    if (WTB_DEBUG) console.log('[WTB DEBUG] checkAccessSerialized', { tabId, url, domain, activeSessions: sessions, cooldowns });

    const now = Date.now();

    // 0. Check scheduled limits (highest priority — a full block or an exhausted usage cap
    // overrides even an active session; no session can bypass it).
    if (scheduledLimits.length > 0) {
        const patternActiveMap = await buildHalfFullPatternMap(scheduledLimits, now);
        const blocking = checkScheduledLimits(scheduledLimits, scheduledUsage, spanStart, lastLiveness, now, patternActiveMap);
        if (blocking.length > 0) {
            const entry = blocking[0];
            const promptUrl = chrome.runtime.getURL(
                `prompt.html?url=${encodeURIComponent(url)}&msg=SCHEDULED_LIMIT&limitId=${encodeURIComponent(entry.id)}`
            );
            await redirectToPrompt(tabId, promptUrl);
            return true;
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
                 return true;
            } else if (now > endTime) {
                // Expired -> Start Cooldown (Backdated to actual end time) -> Redirect
                await endSessionAndStartCooldownInternal(domain, 'duration', endTime, session.origin === 'extend');
                await syncSpanStateSerialized(now);
                const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Time%20Up`);
                await redirectToPrompt(tabId, promptUrl);
                return true;
            }
            return false; // Allow access

        } else if (session.type === 'count') {
            // Check Expiry first
            if (session.cooldownEndTime && now > session.cooldownEndTime) {
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 await syncSpanStateSerialized(now);

                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 await redirectToPrompt(tabId, promptUrl);
                 return true;
            }

            // Check for inactivity (similar to unlimited)
            if (now - (session.lastActive || session.startTime) > SESSION_INACTIVITY_TIMEOUT_MS) {
                 // Session Expired due to inactivity
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 await syncSpanStateSerialized(now);

                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 await redirectToPrompt(tabId, promptUrl);
                 return true;
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
                         // This can be the very first place cooldownEndTime is ever set for this
                         // session (e.g. targetCount 0, or opening straight into an over-cap
                         // video) — pull the alarm in to match it, in case it's sooner than
                         // whatever inactivity-only timing was previously scheduled.
                         scheduleCountInactivityAlarm(domain, session, now);
                    }

                    await syncSpanStateSerialized(now);
                    const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Limit%20Reached`);
                    await redirectToPrompt(tabId, promptUrl);
                    return true;
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

                    // After any cooldownEndTime this navigation may have just set above, so a
                    // short countCooldown gets scheduled against, not just the longer
                    // inactivity-only fallback.
                    scheduleCountInactivityAlarm(domain, session, now);
                    sessions[domain] = session;
                    await chrome.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
                }
            } else {
                 // Watching a known/whitelisted video OR not a video page
                 if (!session.lastActive || now - session.lastActive > 5000) { // 5s throttle
                     session.lastActive = now;
                     scheduleCountInactivityAlarm(domain, session, now);
                     sessions[domain] = session;
                     await chrome.storage.local.set({ activeSessions: sessions });
                 }
            }

            // This navigation itself may have just started a cooldown (the Nth-video case
            // above) — resync so the span correctly closes even though this call still
            // allows access.
            await syncSpanStateSerialized(now);
            return false; // Allow access
        } else if (session.type === 'single_url') {
            if (checkSingleUrlMatch(url, session.targetUrl)) {
                 // Keep lastActive fresh so isSessionGrantingAccess's span-tracking-only
                 // liveness bound (see above) doesn't time out an actively-revisited session.
                 session.lastActive = now;
                 sessions[domain] = session;
                 await chrome.storage.local.set({ activeSessions: sessions });
                 return false; // Allow access
            } else {
                 // Navigated away. End this single_url session.
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 await syncSpanStateSerialized(now);

                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Finished`);
                 await redirectToPrompt(tabId, promptUrl);
                 return true;
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
            return true;
        } else {
            // Expired, clean up
            delete cooldowns[domain];
            await chrome.storage.local.set({ cooldowns });
        }
    }

    // 3. No Session & No Cooldown -> Redirect to Prompt to Start
    const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}`);
    await redirectToPrompt(tabId, promptUrl);
    return true;
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
        if (curr.hostname.includes('instagram.com') && tgt.hostname.includes('instagram.com')) {
            // Real Instagram post URLs commonly vary by query param (carousel index, tracking
            // params) between loads of the SAME post — comparing the post ID out of the path
            // (like the YouTube/Reddit branches above) instead of the full URL avoids treating
            // that as "navigated away" and prematurely ending the session.
            const igPostRegex = /\/(p|reel|tv)\/([\w-]+)/;
            const currMatch = curr.pathname.match(igPostRegex);
            const tgtMatch = tgt.pathname.match(igPostRegex);
            if (currMatch && tgtMatch && currMatch[2] === tgtMatch[2]) return true;
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
        // youtu.be short links carry the video ID in the path (youtu.be/VIDEO_ID), not a `v`
        // query param — without this branch every youtu.be link resolves to no ID at all.
        if (u.hostname.includes('youtu.be')) {
            return u.pathname.slice(1).split('/')[0] || null;
        }
        if (u.hostname.includes('youtube.com')) {
            if (u.pathname.startsWith('/shorts/')) {
                return u.pathname.split('/shorts/')[1].split('/')[0];
            }
            return u.searchParams.get('v');
        }
    } catch(e) {}
    return null;
}

async function endSessionAndStartCooldownInternal(domain, type, overrideStartTime = null, isExtend = false) {
    const data = await chrome.storage.local.get(['activeSessions', 'cooldowns', 'durationCooldown', 'countCooldown']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};

    delete sessions[domain];

    // An Extend grant ending should resume the ORIGINAL cooldown it was carved out of, not
    // start a brand-new full-length one — starting an Extend session never touches
    // cooldowns[domain] (see startSessionInternal), so the original record is still sitting
    // here untouched. Overwriting it here was the bug: every Extend click was silently pushing
    // the real cooldown further into the future by a full cooldown length, directly
    // contradicting the UI's own "grants a brief extra window without resetting your cooldown."
    if (!isExtend) {
        const durationMinutes = (type === 'duration' ? data.durationCooldown : data.countCooldown) || 30;

        // New Structure: Store start time and duration
        cooldowns[domain] = {
            startTime: overrideStartTime || Date.now(),
            duration: durationMinutes * 60 * 1000,
            originalType: type
        };
    }

    await chrome.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
}

function endSessionAndStartCooldown(domain, type, overrideStartTime = null, isExtend = false) {
    return enqueueSessionOp(() => endSessionAndStartCooldownInternal(domain, type, overrideStartTime, isExtend));
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
             await endSessionAndStartCooldown(domain, 'duration', session.endTime, session.origin === 'extend');

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
    } else if (alarm.name.startsWith('count_inactivity_')) {
        const domain = alarm.name.slice('count_inactivity_'.length);

        // Proactive backstop for the lazy inactivity check in checkAccessSerialized: fires even
        // if the domain never gets another navigation event (e.g. browser closed for the day),
        // which the lazy-only check can't handle since nothing else ever revisits it.
        await enqueueSessionOp(async () => {
            const now = Date.now();
            const data = await chrome.storage.local.get(['activeSessions']);
            const sessions = data.activeSessions || {};
            const session = sessions[domain];

            // Don't trust whatever was true when this alarm was scheduled — re-verify against
            // current state, since activity (which reschedules this same alarm name forward)
            // could have resumed between scheduling and firing.
            const stillStale = session && session.type === 'count' && (
                (session.cooldownEndTime && now > session.cooldownEndTime) ||
                (now - (session.lastActive || session.startTime) > SESSION_INACTIVITY_TIMEOUT_MS)
            );
            if (!stillStale) return;

            delete sessions[domain];
            await chrome.storage.local.set({ activeSessions: sessions });
            await syncSpanStateSerialized(now);

            const tabs = await chrome.tabs.query({});
            await Promise.all(tabs.map(async tab => {
                try {
                    if (getDomain(tab.url) === domain) {
                        const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(tab.url)}&msg=Session%20Expired`);
                        await redirectToPrompt(tab.id, promptUrl);
                    }
                } catch (e) {}
            }));
        });
    } else if (alarm.name.startsWith('schedlimit_')) {
        const limitId = alarm.name.slice('schedlimit_'.length);
        const now = Date.now();

        // Reconcile span state from current reality first — don't trust whatever was true
        // when this alarm was originally scheduled.
        const { usage, spanStart, lastLiveness } = await syncSpanState(now);

        const data = await chrome.storage.local.get({ scheduledLimits: [], targetSites: DEFAULT_TARGETS });
        const entries = data.scheduledLimits;

        const patternActiveMap = await buildHalfFullPatternMap(entries, now);
        const blocking = checkScheduledLimits(entries, usage, spanStart, lastLiveness, now, patternActiveMap);
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
    pendingPromptTabs.delete(tabId);
    tabsCurrentlyAtPrompt.delete(tabId);
    processingTabs.delete(tabId);
    lastCheckedDomain.delete(tabId);
    pendingReplacementResolution.delete(tabId);
});

// Shared by chrome.tabs.onReplaced's immediate-success and retry paths below.
async function processTabForAccessById(tabId, url) {
    const domain = getDomain(url);
    if (!domain) return;
    if (await isTargetSite(url)) {
        await checkAccess(tabId, url, domain);
    }
}

// A swapped-in tab's URL passes through several of the browser's OWN internal placeholder
// pages before reaching the site the user actually typed/selected — e.g. opening a new tab
// and typing a search legitimately transitions chrome://newtab/ -> chrome-untrusted://
// new-tab-page/... -> https://www.google.com/search/warmup.html -> the real destination, all
// as real onUpdated events with a genuinely non-empty tab.url at each step. Treating the FIRST
// non-empty URL as "resolved" (as an earlier version of the onReplaced retry below did) means
// resolving on chrome://newtab/ itself — which isn't a target site, so the access check runs,
// finds nothing to block, and the whole retry considers itself done, while the REAL destination
// arrives moments later as an ordinary event that's now ignored (processingTabs still briefly
// held) with nothing left waiting to catch it. Confirmed via a live repro: exactly this
// sequence preceded a real "no blocking UI at all" miss on a fresh YouTube navigation.
function isTransientBrowserUrl(url) {
    if (!url) return true;
    return /^(chrome|chrome-untrusted|edge|chrome-search|about):/i.test(url);
}

// Chrome's "Preload pages for faster browsing" (Settings > Performance) can prerender a
// high-confidence omnibox/autocomplete destination in the background, then swap it into the
// visible tab the instant you press Enter — as a tab REPLACEMENT (new internal tab ID), not a
// normal navigation. None of the navigation listeners above fire for that: there's no loading
// phase to intercept, since the page is already fully rendered before it appears. This is why
// blocking silently never happens for autocomplete-selected navigations specifically, while a
// typed-out URL or a reload (both normal navigations) work fine.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    if (WTB_DEBUG) console.log('[WTB DEBUG] onReplaced fired', { addedTabId, removedTabId });
    pendingPromptTabs.delete(removedTabId);
    tabsCurrentlyAtPrompt.delete(removedTabId);
    processingTabs.delete(removedTabId);
    lastCheckedDomain.delete(removedTabId);
    pendingReplacementResolution.delete(removedTabId);

    if (pendingReplacementResolution.has(addedTabId)) {
        if (WTB_DEBUG) console.log('[WTB DEBUG] onReplaced: skipped, already resolving', { addedTabId });
        return;
    }
    // Held for the entire retry window below, not just the immediate-success path — this is
    // what guarantees the scoped onUpdated listener in the retry branch is the only thing that
    // acts on the URL-populating event it's waiting for (the top-level onUpdated/
    // handleWebNavigationEvent listeners both defer unconditionally to
    // pendingReplacementResolution.has(tabId), regardless of domain).
    pendingReplacementResolution.add(addedTabId);
    try {
        let tab;
        try {
            tab = await chrome.tabs.get(addedTabId);
        } catch {
            return; // tab already gone
        }
        if (!isTransientBrowserUrl(tab.url)) {
            if (WTB_DEBUG) console.log('[WTB DEBUG] onReplaced: real destination populated immediately', { addedTabId, removedTabId, url: tab.url });
            await processTabForAccessById(addedTabId, tab.url);
            return;
        }

        // tab.url is empty or still a transient browser-internal placeholder — the swapped-in
        // tab hasn't reached its real destination yet. There is no other listener expected to
        // catch this navigation type (see comment above), so wait instead of silently giving
        // up: keep watching this specific tab's onUpdated events until a real destination
        // shows up, with a bounded fallback poll in case no further event ever arrives.
        if (WTB_DEBUG) console.log('[WTB DEBUG] onReplaced: no real destination yet, arming retry', { addedTabId, removedTabId, sawUrl: tab.url });
        await new Promise((resolve) => {
            let done = false;
            const finish = async (url) => {
                if (done) return;
                done = true;
                clearTimeout(fallbackTimer);
                chrome.tabs.onUpdated.removeListener(scopedListener);
                if (url) {
                    if (WTB_DEBUG) console.log('[WTB DEBUG] onReplaced retry: resolved', { addedTabId, url });
                    await processTabForAccessById(addedTabId, url);
                } else if (WTB_DEBUG) {
                    console.log('[WTB DEBUG] onReplaced retry: gave up, no real destination ever seen', { addedTabId });
                }
                resolve();
            };
            const scopedListener = (tabId, changeInfo, updatedTab) => {
                if (tabId !== addedTabId) return;
                const url = changeInfo.url || updatedTab.url;
                if (!isTransientBrowserUrl(url)) finish(url);
            };
            chrome.tabs.onUpdated.addListener(scopedListener);
            const fallbackTimer = setTimeout(async () => {
                try {
                    const polledTab = await chrome.tabs.get(addedTabId);
                    finish(isTransientBrowserUrl(polledTab.url) ? null : polledTab.url);
                } catch {
                    finish(null); // tab gone
                }
            }, 2500);
        });
    } finally {
        setTimeout(() => pendingReplacementResolution.delete(addedTabId), 1000);
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startSession') {
        const originTabId = sender.tab ? sender.tab.id : null;
        startSession(message.url, message.type, message.value, message.origin, originTabId).then((success) => {
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
    } else if (message.action === 'halfFullAuthChanged') {
        // Clear the task cache so the next check fetches fresh data.
        chrome.storage.local.remove('halfFullTaskCache').finally(() => sendResponse({}));
        return true;
    } else if (message.action === 'refreshHalfFullCache') {
        // "Check again" button on a Half-Full-conditional block screen — clear the cache so the
        // navigation that follows re-fetches today's tasks instead of reusing the up-to-2-minute-
        // old cached result.
        chrome.storage.local.remove('halfFullTaskCache').finally(() => sendResponse({}));
        return true;
    } else if (message.action === 'ensureHalfFullToken') {
        // options.js defers to this instead of doing its own independent token refresh, so
        // there's a single source of truth for halfFullAuth writes — see hfGetValidToken.
        hfGetValidToken().then(token => sendResponse({ token })).catch(() => sendResponse({ token: null }));
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

// Finds every OTHER tab currently sitting on prompt.html for `domain` (skipping `excludeTabId`,
// which handles its own redirect via startSession's response) and re-runs the exact same access
// check against each one's original intended URL — as if that tab had just been reloaded. This
// is what makes a fresh session "sync": a count session correctly consumes a slot per already-
// open blocked tab (and sends any tab beyond the target to the cooldown/limit screen, same as it
// would on a real reload), while a duration session simply lets everyone through. Tabs that
// already have real access are never touched, since we only look at tabs whose current URL IS
// prompt.html. Must be awaited directly (not via checkAccess/enqueueSessionOp) — this runs
// inside a call that's already occupying the single session-op queue slot; enqueuing more work
// onto that same queue from within it would deadlock (the outer call can't finish until the
// queue advances, but the queue can't advance until the outer call finishes).
async function syncOtherPromptTabs(domain, excludeTabId) {
    const promptBases = await getPromptBases();

    let tabs;
    try {
        tabs = await chrome.tabs.query({});
    } catch { return; }

    for (const tab of tabs) {
        if (tab.id === excludeTabId) continue;
        if (!tab.url || !promptBases.some(base => tab.url.startsWith(base))) continue;

        let intendedUrl;
        try {
            intendedUrl = new URL(tab.url).searchParams.get('url');
        } catch { continue; }
        if (!intendedUrl) continue;

        const tabDomain = getDomain(intendedUrl);
        if (tabDomain !== domain) continue;

        const blocked = await checkAccessSerialized(tab.id, intendedUrl, tabDomain);
        if (!blocked) {
            // Allowed, but this tab isn't mid-navigation (it's sitting still on prompt.html) —
            // checkAccessSerialized has no reason to move it on its own, so send it through.
            chrome.tabs.update(tab.id, { url: intendedUrl });
        }
    }
}

async function startSessionInternal(url, type, value, origin, originTabId) {
    const domain = getDomain(url);
    if (!domain) return false;

    const data = await chrome.storage.local.get(['activeSessions', 'cooldowns']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};

    // A fresh session pick (the initial duration/count picker) should only ever be possible
    // when nothing is currently active for this domain. If a cooldown has since started
    // elsewhere, this tab is a stale copy of the block screen rendered before that cooldown
    // began — letting it silently create a session here would overwrite/bypass that cooldown
    // for the ENTIRE domain, not just this tab. Extend/Finish are exempt: those are only ever
    // reachable from the cooldown screen itself, so they're meant to act during a cooldown.
    if (origin === 'fresh' && cooldowns[domain] && (cooldowns[domain].startTime + cooldowns[domain].duration) > Date.now()) {
        if (originTabId != null) {
            // Push this tab to reflect reality (the actual cooldown screen) instead of leaving
            // it stuck showing an outdated picker with just a generic error.
            await checkAccessSerialized(originTabId, url, domain).catch(() => {});
        }
        return false;
    }

    const cooldownData = await chrome.storage.local.get(['durationCooldown']);
    const durationCooldown = cooldownData.durationCooldown || 30;

    const session = {
        type: type,
        origin: origin,
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

        // Proactive backstop for the lazy inactivity check in checkAccessSerialized: without
        // this, an abandoned session (e.g. browser closed for the day, no navigation event ever
        // fires again) just sits in storage forever showing stale progress, since nothing else
        // ever revisits it. Rescheduled (via the same alarm name) every time lastActive moves.
        scheduleCountInactivityAlarm(domain, session);
    } else if (type === 'single_url') {
        session.targetUrl = value;
    }

    sessions[domain] = session;
    await chrome.storage.local.set({ activeSessions: sessions });

    // Only a genuinely fresh session pick (the initial duration/count picker on the block
    // screen) syncs to other blocked tabs. Extend and Finish Video/Post — both of which can
    // also produce 'duration'/'single_url' session objects — stay exclusive to the tab that
    // clicked them, per explicit design: those are deliberate, minimal, one-off grants, not a
    // "keep browsing" decision meant to cascade to every other blocked tab.
    if (origin === 'fresh' && (type === 'duration' || type === 'count')) {
        await syncOtherPromptTabs(domain, originTabId);
    }

    return true;
}

function startSession(url, type, value, origin, originTabId) {
    return enqueueSessionOp(() => startSessionInternal(url, type, value, origin, originTabId));
}
