// background.js

// State management
// We use chrome.storage.local for persistence.

const DEFAULT_TARGETS = ['instagram.com', 'reddit.com', 'youtube.com'];
const processingTabs = new Set(); // Tracks tabs currently being processed (short-lived lock)
const pendingPromptTabs = new Set(); // Tracks tabs redirected to prompt.html, waiting for session start

// --- Time Range Helpers ---

function isRangeActive(range, now = Date.now()) {
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const s = range.startHour * 60 + range.startMinute;
    const e = range.endHour * 60 + range.endMinute;
    return e > s ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

function getRangeDateKey(range, now = Date.now()) {
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const s = range.startHour * 60 + range.startMinute;
    const e = range.endHour * 60 + range.endMinute;
    const isOvernight = e <= s;
    const base = (isOvernight && cur < s) ? new Date(now - 86400000) : d;
    return `${base.getFullYear()}-${String(base.getMonth()+1).padStart(2,'0')}-${String(base.getDate()).padStart(2,'0')}`;
}

function getActiveRangeIds(timeRanges, now = Date.now()) {
    return timeRanges.filter(r => isRangeActive(r, now)).map(r => r.id);
}

function accumulateUsage(elapsedSeconds, activeRangeIds, timeRangeUsage, timeRanges, now = Date.now()) {
    const updated = { ...timeRangeUsage };
    for (const id of activeRangeIds) {
        const range = timeRanges.find(r => r.id === id);
        if (!range) continue;
        const dateKey = getRangeDateKey(range, now);
        const prev = updated[id] || { dateKey: null, usedSeconds: 0 };
        updated[id] = {
            dateKey,
            usedSeconds: (prev.dateKey === dateKey ? prev.usedSeconds : 0) + elapsedSeconds
        };
    }
    return updated;
}

function checkTimeRangeLimits(timeRanges, timeRangeUsage, now = Date.now()) {
    return timeRanges.filter(range => {
        if (!isRangeActive(range, now)) return false;
        const dateKey = getRangeDateKey(range, now);
        const usage = timeRangeUsage[range.id];
        const used = (usage && usage.dateKey === dateKey) ? usage.usedSeconds : 0;
        return used >= range.limitMinutes * 60;
    });
}

// Accumulates elapsed time from a session into time range usage and saves to storage.
// Returns updated timeRangeUsage object, or null if nothing was accumulated.
async function saveTimeRangeAccumulation(domain, session, sessions, timeRanges, timeRangeUsage, now) {
    if (!timeRanges.length || !session.timeRangeLastCheck) return null;
    const elapsed = (now - session.timeRangeLastCheck) / 1000;
    if (elapsed <= 0 || elapsed > 300) return null;
    const activeIds = getActiveRangeIds(timeRanges, now);
    if (!activeIds.length) return null;
    const updated = accumulateUsage(elapsed, activeIds, timeRangeUsage, timeRanges, now);
    session.timeRangeLastCheck = now;
    sessions[domain] = session;
    await chrome.storage.local.set({ activeSessions: sessions, timeRangeUsage: updated });
    return updated;
}

// --- End Time Range Helpers ---

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
function redirectToPrompt(tabId, promptUrl) {
    pendingPromptTabs.add(tabId);
    chrome.storage.local.get('__testPromptBase').then(data => {
        let finalUrl = promptUrl;
        if (data.__testPromptBase) {
            try {
                const u = new URL(promptUrl);
                finalUrl = data.__testPromptBase + u.search;
            } catch {}
        }
        chrome.tabs.update(tabId, { url: finalUrl });
    });
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
    if (!changeInfo.url && changeInfo.status !== 'complete' && changeInfo.status !== 'loading') return;

    // Prefer changeInfo.url (the actual new destination) over tab.url, which can be stale
    // when status events fire after a redirect has already been issued.
    const currentUrl = changeInfo.url || tab.url;

    // If the tab is heading to or already at the prompt, leave pendingPromptTabs intact and stop.
    if (currentUrl.startsWith(chrome.runtime.getURL('prompt.html'))) return;

    if (pendingPromptTabs.has(tabId)) {
        if (changeInfo.url) {
            // A fresh URL navigation away from the prompt — clear pending state and process normally.
            pendingPromptTabs.delete(tabId);
        } else {
            // Stale status (loading/complete) event for a tab still waiting at the prompt — skip.
            return;
        }
    }

    if (processingTabs.has(tabId)) return;

    const domain = getDomain(currentUrl);
    if (!domain) return;

    processingTabs.add(tabId);

    try {
        if (await isTargetSite(currentUrl)) {
            await checkAccess(tabId, currentUrl, domain);
        }
    } finally {
        setTimeout(() => {
            processingTabs.delete(tabId);
        }, 1000);
    }
});

// Supplementary navigation listener for environments where tabs.onUpdated fires unreliably
// for certain navigation types (e.g. Playwright's Juggler protocol in Firefox).
chrome.webNavigation.onCommitted.addListener(async ({ tabId, url, frameId }) => {
    if (frameId !== 0) return;
    if (!url) return;
    if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return;
    if (pendingPromptTabs.has(tabId)) return;
    if (processingTabs.has(tabId)) return;

    const domain = getDomain(url);
    if (!domain) return;

    processingTabs.add(tabId);
    try {
        if (await isTargetSite(url)) {
            await checkAccess(tabId, url, domain);
        }
    } finally {
        setTimeout(() => { processingTabs.delete(tabId); }, 1000);
    }
});

async function checkAccess(tabId, url, domain) {
    // Fetch all session state
    const data = await chrome.storage.local.get(['activeSessions', 'cooldowns', 'countCooldown', 'durationCooldown', 'timeRanges', 'timeRangeUsage']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};
    const timeRanges = data.timeRanges || [];

    const now = Date.now();

    // 0. Check time range limits (highest priority — blocks even active sessions)
    if (timeRanges.length > 0) {
        const exhausted = checkTimeRangeLimits(timeRanges, data.timeRangeUsage || {}, now);
        if (exhausted.length > 0) {
            const promptUrl = chrome.runtime.getURL(
                `prompt.html?url=${encodeURIComponent(url)}&msg=TIME_RANGE&rangeId=${encodeURIComponent(exhausted[0].id)}`
            );
            redirectToPrompt(tabId, promptUrl);
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
                 
                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 redirectToPrompt(tabId, promptUrl);
                 return;
            } else if (now > endTime) {
                // Expired -> Start Cooldown (Backdated to actual end time) -> Redirect
                await endSessionAndStartCooldown(domain, 'duration', endTime);
                const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Time%20Up`);
                redirectToPrompt(tabId, promptUrl);
                return;
            }
            await saveTimeRangeAccumulation(domain, session, sessions, timeRanges, data.timeRangeUsage || {}, now);
            return; // Allow access

        } else if (session.type === 'count') {
            // Check Expiry first
            if (session.cooldownEndTime && now > session.cooldownEndTime) {
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 
                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 redirectToPrompt(tabId, promptUrl);
                 return;
            }

            // Check for 2 hours inactivity (similar to unlimited)
            if (now - (session.lastActive || session.startTime) > 2 * 60 * 60 * 1000) {
                 // Session Expired due to inactivity
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });

                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 redirectToPrompt(tabId, promptUrl);
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

                    const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Limit%20Reached`);
                    redirectToPrompt(tabId, promptUrl);
                    return;
                } else {
                     // Add to whitelist
                     session.watchedVideoIds.push(videoId);
                     session.lastActive = now;

                     // Check if we just hit the limit (Nth video)
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
                 if (now - session.lastActive > 5000) { // 5s throttle
                     session.lastActive = now;
                     sessions[domain] = session;
                     await chrome.storage.local.set({ activeSessions: sessions });
                 }
            }

            await saveTimeRangeAccumulation(domain, session, sessions, timeRanges, data.timeRangeUsage || {}, now);
            return; // Allow access
        } else if (session.type === 'single_url') {
            if (checkSingleUrlMatch(url, session.targetUrl)) {
                 await saveTimeRangeAccumulation(domain, session, sessions, timeRanges, data.timeRangeUsage || {}, now);
                 return; // Allow access
            } else {
                 // Navigated away. End this single_url session.
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 
                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Finished`);
                 redirectToPrompt(tabId, promptUrl);
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
            redirectToPrompt(tabId, promptUrl);
            return;
        } else {
            // Expired, clean up
            delete cooldowns[domain];
            await chrome.storage.local.set({ cooldowns });
        }
    }
    
    // 3. No Session & No Cooldown -> Redirect to Prompt to Start
    const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}`);
    redirectToPrompt(tabId, promptUrl);
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

async function endSessionAndStartCooldown(domain, type, overrideStartTime = null) {
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

             // Redirect pages immediately
             tabs.forEach(tab => {
                 try {
                     if (getDomain(tab.url) === domain) {
                          const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(tab.url)}&msg=Time%20Up`);
                          redirectToPrompt(tab.id, promptUrl);
                     }
                 } catch(e) {}
             });
        }
    } else if (alarm.name.startsWith('timerange_')) {
        const rangeId = alarm.name.replace('timerange_', '');
        const data = await chrome.storage.local.get(['timeRanges', 'timeRangeUsage', 'targetSites']);
        const timeRanges = data.timeRanges || [];
        const exhausted = checkTimeRangeLimits(timeRanges, data.timeRangeUsage || {}, Date.now());
        if (!exhausted.find(r => r.id === rangeId)) return;

        const targetSites = data.targetSites || DEFAULT_TARGETS;
        const tabs = await chrome.tabs.query({});
        tabs.forEach(tab => {
            try {
                const domain = getDomain(tab.url);
                if (domain && targetSites.includes(domain)) {
                    const promptUrl = chrome.runtime.getURL(
                        `prompt.html?url=${encodeURIComponent(tab.url)}&msg=TIME_RANGE&rangeId=${encodeURIComponent(rangeId)}`
                    );
                    redirectToPrompt(tab.id, promptUrl);
                }
            } catch(e) {}
        });
    }
});

// Handle Messages from Prompt or Content Script
chrome.tabs.onRemoved.addListener((tabId) => {
    pendingPromptTabs.delete(tabId);
    processingTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startSession') {
        startSession(message.url, message.type, message.value).then((success) => {
            sendResponse({ success: success });
        }).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    } else if (message.action === 'timeRangeHeartbeat') {
        const tabUrl = message.tabUrl || sender.tab?.url;
        handleTimeRangeHeartbeat(message.domain, sender.tab?.id, tabUrl)
            .then(() => sendResponse({}))
            .catch(() => sendResponse({}));
        return true;
    }
});

async function startSession(url, type, value) {
    const domain = getDomain(url);
    if (!domain) return false;
    
    const data = await chrome.storage.local.get(['activeSessions']);
    const sessions = data.activeSessions || {};
    
    const cooldownData = await chrome.storage.local.get(['durationCooldown']);
    const durationCooldown = cooldownData.durationCooldown || 30;

    const session = {
        type: type,
        startTime: Date.now(),
        timeRangeLastCheck: Date.now()
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

async function handleTimeRangeHeartbeat(domain, tabId, tabUrl) {
    const data = await chrome.storage.local.get(['activeSessions', 'timeRanges', 'timeRangeUsage', 'targetSites']);
    const timeRanges = data.timeRanges || [];
    if (!timeRanges.length) return;

    const sessions = data.activeSessions || {};
    const session = sessions[domain];
    if (!session) return;

    const now = Date.now();
    const rawElapsed = (now - (session.timeRangeLastCheck || session.startTime)) / 1000;
    const elapsed = Math.min(rawElapsed, 120); // cap at 2 min to guard against browser sleep

    const activeIds = getActiveRangeIds(timeRanges, now);
    if (!activeIds.length) return;

    const updatedUsage = accumulateUsage(elapsed, activeIds, data.timeRangeUsage || {}, timeRanges, now);
    session.timeRangeLastCheck = now;
    sessions[domain] = session;
    await chrome.storage.local.set({ activeSessions: sessions, timeRangeUsage: updatedUsage });

    // Check if any range is now exhausted and redirect ALL target site tabs
    const exhausted = checkTimeRangeLimits(timeRanges, updatedUsage, now);
    if (exhausted.length > 0) {
        const rangeId = exhausted[0].id;
        const targetSites = data.targetSites || DEFAULT_TARGETS;
        const tabs = await chrome.tabs.query({});
        tabs.forEach(tab => {
            try {
                const tabDomain = getDomain(tab.url);
                if (tabDomain && targetSites.includes(tabDomain)) {
                    const promptUrl = chrome.runtime.getURL(
                        `prompt.html?url=${encodeURIComponent(tab.url)}&msg=TIME_RANGE&rangeId=${encodeURIComponent(rangeId)}`
                    );
                    redirectToPrompt(tab.id, promptUrl);
                }
            } catch(e) {}
        });
        return;
    }

    // Set/refresh alarms for non-exhausted active ranges
    for (const id of activeIds) {
        const range = timeRanges.find(r => r.id === id);
        if (!range) continue;
        const dateKey = getRangeDateKey(range, now);
        const usage = updatedUsage[id];
        const used = (usage && usage.dateKey === dateKey) ? usage.usedSeconds : 0;
        const remaining = range.limitMinutes * 60 - used;
        if (remaining > 0) {
            chrome.alarms.create(`timerange_${id}`, { delayInMinutes: remaining / 60 });
        }
    }
}
