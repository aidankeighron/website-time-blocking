// content.js
(async function() {
    function getDomain(url) {
        try {
            const hostname = new URL(url).hostname;
            return hostname.replace(/^(www\.|m\.|mobile\.)/, '');
        } catch (e) {
            return null;
        }
    }

    const domain = getDomain(window.location.href);
    if (!domain) return;

    // Check if we are a target site
    const data = await chrome.storage.local.get(['targetSites', 'activeSessions']);
    const targetSites = data.targetSites || [];
    
    // Simple check: is domain in target sites?
    if (!targetSites.includes(domain)) return;

    let overlay = null;
    let timerInterval = null;

    let lastHeartbeatSent = 0;

    function createOverlay() {
        if (document.getElementById('website-time-blocking-overlay')) return;
        
        overlay = document.createElement('div');
        overlay.id = 'website-time-blocking-overlay';
        document.body.appendChild(overlay);
    }

    function updateOverlay(session) {
        if (!overlay) createOverlay();
        if (!overlay) return; // Should exist

        if (!session) {
            overlay.style.display = 'none';
            return;
        }

        overlay.style.display = 'flex';
        
        if (session.type === 'duration') {
            const timeLeft = session.endTime - Date.now();
            if (timeLeft <= 0) {
                 overlay.textContent = "Time's Up!";
                 overlay.classList.add('warning');
                 // Force reload to trigger background check immediately
                 // Debounce this to avoid spamming reloads if background is slow
                 if (!session.expiredActionTaken) {
                     session.expiredActionTaken = true;
                     setTimeout(() => window.location.reload(), 500);
                 }
            } else {
                const minutes = Math.floor(timeLeft / 60000);
                const seconds = Math.floor((timeLeft % 60000) / 1000);
                overlay.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                overlay.classList.remove('warning');
            }
        } else if (session.type === 'count') {
            overlay.textContent = `${session.videosWatched || 0} / ${session.targetCount} Videos`;
             if ((session.videosWatched || 0) >= session.targetCount) {
                  overlay.classList.add('warning');
             } else {
                  overlay.classList.remove('warning');
             }
        } else if (session.type === 'unlimited') {
             overlay.textContent = "Unlimited Session";
             
             // Send heartbeat
             // Use local variable to throttle
             if (Date.now() - lastHeartbeatSent > 60000) {
                 lastHeartbeatSent = Date.now();
                 chrome.runtime.sendMessage({ action: 'keepAlive', url: window.location.href });
             }
        }
    }

    // State to hold current session data
    let currentSession = null;

    // Initial Check
    if (data.activeSessions && data.activeSessions[domain]) {
        currentSession = data.activeSessions[domain];
        updateOverlay(currentSession);
        
        // Start lighter timer for duration updates AND heartbeats
        timerInterval = setInterval(() => {
             updateOverlay(currentSession);
        }, 5000); // 5 sec interval as requested
    }

    // Listen for changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.activeSessions) {
            const newSessions = changes.activeSessions.newValue || {};
            const session = newSessions[domain];
            
            // Just update reference, don't churn timers
            currentSession = session;

            if (!session) {
                // Session ended
                if (overlay) overlay.style.display = 'none';
                if (timerInterval) {
                    clearInterval(timerInterval);
                    timerInterval = null;
                }
            } else {
                 // If timer wasn't running (e.g. startup), start it
                 if (!timerInterval) {
                     updateOverlay(session);
                     timerInterval = setInterval(() => updateOverlay(currentSession), 5000);
                 } 
                 // REMOVED: Immediate updateOverlay(session) here, because if that triggered a write (heartbeat)
                 // it would cause an infinite loop with storage.onChanged.
                 // We rely on the interval to update the display.
            }
        }
    });

})();
