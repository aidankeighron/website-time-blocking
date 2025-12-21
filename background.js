
// Wrapper for browser compatibility
const api = typeof browser !== 'undefined' ? browser : chrome;

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
    
    const data = await api.storage.local.get({ targetSites: DEFAULT_TARGETS });
    return data.targetSites.includes(domain);
}

// Core navigation listener
api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // We only care if URL changed or status is loading (initial load)
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    
    // If the tab is just loading the prompt, ignore logic to prevent loops
    if (tab.url.startsWith(api.runtime.getURL('prompt.html'))) return;
    
    const domain = getDomain(tab.url);
    if (!domain) return;
    
    if (await isTargetSite(tab.url)) {
        checkAccess(tabId, tab.url, domain);
    }
});

async function checkAccess(tabId, url, domain) {
    // Fetch all session state
    const data = await api.storage.local.get(['activeSessions', 'cooldowns']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};
    
    const now = Date.now();
    
    // 1. Check Active Session (Priority over Cooldown for Unlimited)
    if (sessions[domain]) {
        const session = sessions[domain];

        // Validation Logic per type
        if (session.type === 'unlimited') {
            // Check for 20 minute inactivity
            if (now - (session.lastActive || session.startTime) > 20 * 60 * 1000) {
                 // Session Expired
                 delete sessions[domain];
                 await api.storage.local.set({ activeSessions: sessions });
                 
                 const promptUrl = api.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Session%20Expired`);
                 api.tabs.update(tabId, { url: promptUrl });
                 return;
            }
            
            // Update Activity (Throttled)
            if (now - session.lastActive > 5000) { // 5s throttle
                session.lastActive = now;
                sessions[domain] = session;
                api.storage.local.set({ activeSessions: sessions });
            }
            return; // Allow access

        } else if (session.type === 'duration') {
            const endTime = session.endTime;
            if (now > endTime) {
                // Expired -> Start Cooldown -> Redirect
                endSessionAndStartCooldown(domain, 'duration');
                const promptUrl = api.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Time%20Up`);
                api.tabs.update(tabId, { url: promptUrl });
                return;
            }
            return; // Allow access

        } else if (session.type === 'count') {
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
                session.watchedVideoIds.push(videoId);
                session.lastActive = now;
                
                if (session.videosWatched > session.targetCount) {
                    endSessionAndStartCooldown(domain, 'count');
                    const promptUrl = api.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Limit%20Reached`);
                    api.tabs.update(tabId, { url: promptUrl });
                    return;
                } else {
                    sessions[domain] = session;
                    api.storage.local.set({ activeSessions: sessions });
                }
            } else {
                 if (now - session.lastActive > 5000) { // 5s throttle
                     session.lastActive = now;
                     sessions[domain] = session;
                     api.storage.local.set({ activeSessions: sessions });
                 }
            }

            return; // Allow access
        }
    }

    // 2. Check Cooldown (If no active session)
    if (cooldowns[domain] && cooldowns[domain] > now) {
        const minutesLeft = Math.ceil((cooldowns[domain] - now) / 60000);
        const promptUrl = api.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&cooldown=${minutesLeft}`);
        api.tabs.update(tabId, { url: promptUrl });
        return;
    }
    
    // Clean up expired cooldowns
    if (cooldowns[domain] && cooldowns[domain] <= now) {
        delete cooldowns[domain];
        api.storage.local.set({ cooldowns });
    }

    // 3. No Session & No Cooldown -> Redirect to Prompt to Start
    const promptUrl = api.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}`);
    api.tabs.update(tabId, { url: promptUrl });
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

async function endSessionAndStartCooldown(domain, type) {
    const data = await api.storage.local.get(['activeSessions', 'cooldowns', 'durationCooldown', 'countCooldown']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};
    
    // Remove session
    delete sessions[domain];
    
    // Set Cooldown
    const cooldownDuration = (type === 'duration' ? data.durationCooldown : data.countCooldown) || 30; // default 30 min
    cooldowns[domain] = Date.now() + (cooldownDuration * 60 * 1000);
    
    await api.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
}


// Handle Alarms for Duration Expiry
api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name.startsWith('session_')) {
        const domain = alarm.name.split('session_')[1];
        // Session expired.
        // Get active tabs for this domain and redirect them.
        const tabs = await api.tabs.query({});
        const data = await api.storage.local.get(['activeSessions']);
        
        // Verify session is still active and duration type
        if (data.activeSessions && data.activeSessions[domain] && data.activeSessions[domain].type === 'duration') {
             endSessionAndStartCooldown(domain, 'duration');
             
             // Redirect pages immediately
             tabs.forEach(tab => {
                 try {
                     const url = new URL(tab.url);
                     if (getDomain(tab.url) === domain) {
                          const promptUrl = api.runtime.getURL(`prompt.html?url=${encodeURIComponent(tab.url)}&msg=Time%20Up`);
                          api.tabs.update(tab.id, { url: promptUrl });
                     }
                 } catch(e) {}
             });
        }
    }
});

// Handle Messages from Prompt or Content Script
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startSession') {
        startSession(message.url, message.type, message.value).then((success) => {
            sendResponse({ success: success });
        }).catch(err => sendResponse({ success: false, error: err.message }));
        return true; 
    } else if (message.action === 'keepAlive') {
        keepAlive(message.url);
    }
});

async function keepAlive(url) {
    const domain = getDomain(url);
    if (!domain) return;
    
    const data = await api.storage.local.get(['activeSessions']);
    const sessions = data.activeSessions || {};
    
    if (sessions[domain] && sessions[domain].type === 'unlimited') {
        sessions[domain].lastActive = Date.now();
        await api.storage.local.set({ activeSessions: sessions });
    }
}

async function startSession(url, type, value) {
    const domain = getDomain(url);
    if (!domain) return false;
    
    const data = await api.storage.local.get(['activeSessions']);
    const sessions = data.activeSessions || {};
    
    const session = {
        type: type,
        startTime: Date.now(),
        lastActive: Date.now() // For unlimited timeout
    };
    
    if (type === 'duration') {
        session.durationMinutes = value;
        session.endTime = Date.now() + (value * 60 * 1000);
        
        // Create Alarm
        api.alarms.create(`session_${domain}`, { when: session.endTime });
        
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
    await api.storage.local.set({ activeSessions: sessions });
    return true;
}

// ... existing utility functions ...

async function endSessionAndStartCooldown(domain, type) {
    const data = await api.storage.local.get(['activeSessions', 'cooldowns', 'durationCooldown', 'countCooldown']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};
    
    // Remove session
    delete sessions[domain];
    
    // Clear alarm if exists
    api.alarms.clear(`session_${domain}`);
    
    // Set Cooldown
    const cooldownDuration = (type === 'duration' ? data.durationCooldown : data.countCooldown) || 30; // default 30 min
    cooldowns[domain] = Date.now() + (cooldownDuration * 60 * 1000);
    
    await api.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
}
