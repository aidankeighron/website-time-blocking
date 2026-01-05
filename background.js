// background.js

// State management
// We use chrome.storage.local for persistence, but we can keep a local cache for speed.
// However, since service workers can terminate, we must rely on storage.

const DEFAULT_TARGETS = ['instagram.com', 'reddit.com', 'youtube.com'];

// Helper to get domain
function getDomain(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace(/^(www\.|m\.|mobile\.)/, '');
    } catch (e) {
        return null;
    }
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
    // We only care if URL changed or status is loading (initial load) or complete
    if (!changeInfo.url && changeInfo.status !== 'complete' && changeInfo.status !== 'loading') return;
    
    // If the tab is just loading the prompt, ignore logic to prevent loops
    if (tab.url.startsWith(chrome.runtime.getURL('prompt.html'))) return;
    
    const domain = getDomain(tab.url);
    if (!domain) return;
    
    if (await isTargetSite(tab.url)) {
        checkAccess(tabId, tab.url, domain);
    }
});

async function checkAccess(tabId, url, domain) {
    // Fetch all session state
    const data = await chrome.storage.local.get(['activeSessions', 'cooldowns', 'countCooldown', 'durationCooldown']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};
    
    const now = Date.now();
    
    // 1. Check Active Session (Priority over Cooldown for Unlimited)
    if (sessions[domain]) {
        const session = sessions[domain];

        // Validation Logic per type
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
                 chrome.tabs.update(tabId, { url: promptUrl });
                 return;
            } else if (now > endTime) {
                // Expired -> Start Cooldown (Backdated to actual end time) -> Redirect
                await endSessionAndStartCooldown(domain, 'duration', endTime);
                const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Time%20Up`);
                chrome.tabs.update(tabId, { url: promptUrl });
                return;
            }
            return; // Allow access

        } else if (session.type === 'count') {
            // Check Expiry first
            if (session.cooldownEndTime && now > session.cooldownEndTime) {
                 // **Count session specific cooldown logic might need review if we want to unify everything**
                 // For now, let's respect the existing Count logic but ensure it uses the new structure if it triggers a full cooldown.
                 // Actually, the user asked to remove the "entire cooldown system as it currently stands".
                 // But session.cooldownEndTime in 'count' mode is a bit hybrid (it's a session that eventually expires).
                 // Let's keep the internal logic for 'count' expiry, but when it officially ends, we use the new system.
                 
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 
                 // If there's a lingering global cooldown, we trust the new checkAccess logic to catch it next time, 
                 // but here we just expire the session.
                 
                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 chrome.tabs.update(tabId, { url: promptUrl });
                 return;
            }

            // Check for 2 hours inactivity (similar to unlimited)
            if (now - (session.lastActive || session.startTime) > 2 * 60 * 60 * 1000) {
                 // Session Expired due to inactivity
                 delete sessions[domain];
                 await chrome.storage.local.set({ activeSessions: sessions });
                 
                 const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 chrome.tabs.update(tabId, { url: promptUrl });
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
                    // BUT do not delete the session, so we can keep watching the old ones.
                    // Just redirect THIS tab.
                    
                    // We need to set the session's internal endpoint for Count expiration if not set
                    if (!session.cooldownEndTime) {
                         const cooldownDuration = data.countCooldown || 30;
                         const cooldownEnd = now + (cooldownDuration * 60 * 1000);
                         session.cooldownEndTime = cooldownEnd;
                         
                         // Note: We are strictly NOT setting the global domain block cooldown here yet?
                         // The original code set `cooldowns[domain]`.
                         // The user wants "cooldown info will still be tracked even if the browser is closed".
                         // So we SHOULD set the global cooldown here too using new structure.
                         
                         cooldowns[domain] = {
                             startTime: now,
                             duration: cooldownDuration * 60 * 1000
                         };
                         
                         sessions[domain] = session;
                         await chrome.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
                    }

                    const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Limit%20Reached`);
                    chrome.tabs.update(tabId, { url: promptUrl });
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
                    // Save both provided we updated cooldowns
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

            return; // Allow access
        }
    }

    // 2. Check Cooldown (If no active session)
    if (cooldowns[domain]) {
        const { startTime, duration } = cooldowns[domain];
        const endTime = startTime + duration; // Calculate end time dynamically
        
        if (endTime > now) {
            const minutesLeft = Math.ceil((endTime - now) / 60000);
            const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&cooldown=${minutesLeft}`);
            chrome.tabs.update(tabId, { url: promptUrl });
            return;
        } else {
            // Expired, clean up
            delete cooldowns[domain];
            await chrome.storage.local.set({ cooldowns });
        }
    }
    
    // 3. No Session & No Cooldown -> Redirect to Prompt to Start
    const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}`);
    chrome.tabs.update(tabId, { url: promptUrl });
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
             // Use the planned end time for precision, or Date.now() if needed. 
             // Since alarm fired, Date.now() is approx endTime. 
             // But simpler to just pass session.endTime if available.
             const session = data.activeSessions[domain];
             await endSessionAndStartCooldown(domain, 'duration', session.endTime);
             
             // Redirect pages immediately
             tabs.forEach(tab => {
                 try {
                     const url = new URL(tab.url);
                     if (getDomain(tab.url) === domain) {
                          const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(tab.url)}&msg=Time%20Up`);
                          chrome.tabs.update(tab.id, { url: promptUrl });
                     }
                 } catch(e) {}
             });
        }
    }
});

// Handle Messages from Prompt or Content Script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startSession') {
        startSession(message.url, message.type, message.value).then((success) => {
            sendResponse({ success: success });
        }).catch(err => sendResponse({ success: false, error: err.message }));
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
        startTime: Date.now()
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
    }
    
    sessions[domain] = session;
    await chrome.storage.local.set({ activeSessions: sessions });
    return true;
}

// ... existing utility functions ...


