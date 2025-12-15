// background.js

// State management
// We use chrome.storage.local for persistence, but we can keep a local cache for speed.
// However, since service workers can terminate, we must rely on storage.

const DEFAULT_TARGETS = ['instagram.com', 'reddit.com', 'youtube.com'];

// Helper to get domain
function getDomain(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace(/^www\./, '');
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
    // We only care if URL changed or status is loading (initial load)
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    
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
    const data = await chrome.storage.local.get(['activeSessions', 'cooldowns']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};
    
    const now = Date.now();
    
    // 1. Check Cooldown
    if (cooldowns[domain] && cooldowns[domain] > now) {
        // Cooldown active. Redirect to prompt with cooldown message.
        // Or just a simple "Cooldown Active" page. 
        // We'll use prompt.html?cooldown=true
        const minutesLeft = Math.ceil((cooldowns[domain] - now) / 60000);
        const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&cooldown=${minutesLeft}`);
        // updating to the same URL repeatedly causes flickering or loops if we are not careful
        // The check at the top "if (tab.url.startsWith...)" prevents loop.
        chrome.tabs.update(tabId, { url: promptUrl });
        return;
    }
    
    // Clean up expired cooldowns
    if (cooldowns[domain] && cooldowns[domain] <= now) {
        delete cooldowns[domain];
        chrome.storage.local.set({ cooldowns });
    }

    // 2. Check Active Session
    if (!sessions[domain]) {
        // No session -> Redirect to prompt
        const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}`);
        chrome.tabs.update(tabId, { url: promptUrl });
        return;
    }
    
    const session = sessions[domain];
    
    // 3. Validation Logic per type
    if (session.type === 'duration') {
        const endTime = session.endTime;
        if (now > endTime) {
            // Expired -> Start Cooldown -> Redirect
            endSessionAndStartCooldown(domain, 'duration');
            // We need to reload or update to prompt
             const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Time%20Up`);
             chrome.tabs.update(tabId, { url: promptUrl });
        }
    } else if (session.type === 'count') {
        // YouTube specific: Check video ID
        const videoId = getYouTubeVideoId(url);
        if (videoId && videoId !== session.lastVideoId) {
            // New video detected
            session.videosWatched = (session.videosWatched || 0) + 1;
            session.lastVideoId = videoId;
            
            if (session.videosWatched > session.targetCount) {
                // Limit exceeded -> Start Cooldown -> Redirect
                // Note: The user said "if you try to open a video past the count limit". 
                // So if limit is 3, watching 3 is OK. Opening 4th triggers blocking.
                endSessionAndStartCooldown(domain, 'count');
                const promptUrl = chrome.runtime.getURL(`prompt.html?url=${encodeURIComponent(url)}&msg=Limit%20Reached`);
                chrome.tabs.update(tabId, { url: promptUrl });
            } else {
                // Update session state
                sessions[domain] = session;
                chrome.storage.local.set({ activeSessions: sessions });
            }
        }
    }
    // 'unlimited' needs no check, just let it pass.
}

function getYouTubeVideoId(url) {
    try {
        const u = new URL(url);
        if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
            return u.searchParams.get('v');
        }
    } catch(e) {}
    return null;
}

async function endSessionAndStartCooldown(domain, type) {
    const data = await chrome.storage.local.get(['activeSessions', 'cooldowns', 'durationCooldown', 'countCooldown']);
    const sessions = data.activeSessions || {};
    const cooldowns = data.cooldowns || {};
    
    // Remove session
    delete sessions[domain];
    
    // Set Cooldown
    const cooldownDuration = (type === 'duration' ? data.durationCooldown : data.countCooldown) || 30; // default 30 min
    cooldowns[domain] = Date.now() + (cooldownDuration * 60 * 1000);
    
    await chrome.storage.local.set({ activeSessions: sessions, cooldowns: cooldowns });
}


// Handle Messages from Prompt
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startSession') {
        startSession(message.url, message.type, message.value).then((success) => {
            sendResponse({ success: success });
        }).catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async response
    }
});

async function startSession(url, type, value) {
    const domain = getDomain(url);
    if (!domain) return false;
    
    const data = await chrome.storage.local.get(['activeSessions']);
    const sessions = data.activeSessions || {};
    
    const session = {
        type: type,
        startTime: Date.now()
    };
    
    if (type === 'duration') {
        session.durationMinutes = value;
        session.endTime = Date.now() + (value * 60 * 1000);
    } else if (type === 'count') {
        session.targetCount = value;
        session.videosWatched = 0; // Starts at 0, first video counts as 1
        // If we are already on a video URL, count it?
        // "The extension will keep track of every new video you open"
        // If we start the session on a video page, that counts as the first video.
        const vid = getYouTubeVideoId(url);
        if (vid) {
             session.videosWatched = 1;
             session.lastVideoId = vid;
        }
    }
    
    sessions[domain] = session;
    await chrome.storage.local.set({ activeSessions: sessions });
    return true;
}
