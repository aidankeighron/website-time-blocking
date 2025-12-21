// content.js
(async function() {
    const api = typeof browser !== 'undefined' ? browser : chrome;

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
    const data = await api.storage.local.get(['targetSites', 'activeSessions']);
    const targetSites = data.targetSites || [];
    
    // Simple check: is domain in target sites?
    if (!targetSites.includes(domain)) return;

    let overlayHost = null;
    let overlay = null;
    let timerInterval = null;
    let lastHeartbeatSent = 0;

    const CSS = `
        #website-time-blocking-overlay {
            position: fixed;
            top: 10px;
            left: 10px;
            background-color: rgba(30, 30, 30, 0.9);
            color: #bb86fc;
            padding: 8px 12px;
            border-radius: 8px;
            font-family: 'Segoe UI', sans-serif;
            font-size: 14px;
            font-weight: 500;
            z-index: 2147483647;
            box-shadow: 0 2px 10px rgba(0,0,0,0.5);
            border: 1px solid #333;
            pointer-events: none;
            user-select: none;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        #website-time-blocking-overlay.warning {
            color: #cf6679;
            border-color: #cf6679;
        }
    `;

    function createOverlay() {
        // Remove existing host if it exists to clean state
        const existingHost = document.getElementById('website-time-blocking-overlay-host');
        if (existingHost) {
            overlayHost = existingHost;
            // Access shadow root? We can't easily access open shadow root if we didn't store reference, 
            // but for simplicity we rely on our 'overlay' variable or recreate.
            // If overlay variable is null but host exists, we might need to query internal shadow if open.
            // Since we use closed mode or just rebuild, let's just create if missing.
            if (!overlayHost.shadowRoot) {
                // Should not happen if we created it. 
                // If it's closed, we can't access it.
                // We'll proceed to creating NEW one if we don't have reference.
            }
        }

        if (!overlayHost || !document.body.contains(overlayHost)) {
            overlayHost = document.createElement('div');
            overlayHost.id = 'website-time-blocking-overlay-host';
            // Reset host styles to ensure it doesn't interfere
            overlayHost.style.position = 'fixed';
            overlayHost.style.top = '0';
            overlayHost.style.left = '0';
            overlayHost.style.width = '0';
            overlayHost.style.height = '0';
            overlayHost.style.zIndex = '2147483647';
            overlayHost.style.pointerEvents = 'none';

            const shadow = overlayHost.attachShadow({ mode: 'closed' });
            
            const style = document.createElement('style');
            style.textContent = CSS;
            shadow.appendChild(style);

            overlay = document.createElement('div');
            overlay.id = 'website-time-blocking-overlay';
            overlay.style.display = 'none'; // Hidden by default
            shadow.appendChild(overlay);

            document.body.appendChild(overlayHost);
        }
    }

    function updateOverlay(session) {
        // Ensure overlay exists
        if (!overlayHost || !document.body.contains(overlayHost)) {
            createOverlay();
        }
        
        if (!overlay) {
            // Re-create overlay reference if we lost it (should be created in createOverlay)
            // But since mode is closed, we can't query it from host unless we stored it in createClosure.
            // Our createOverlay updates the 'overlay' variable in closure scope.
            // If createOverlay failed or didn't run, return.
            return; 
        }

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
             
             if (Date.now() - lastHeartbeatSent > 60000) {
                 lastHeartbeatSent = Date.now();
                 api.runtime.sendMessage({ action: 'keepAlive', url: window.location.href });
             }
        }
    }

    // State to hold current session data
    let currentSession = null;

    // Initial Check
    if (data.activeSessions && data.activeSessions[domain]) {
        currentSession = data.activeSessions[domain];
        updateOverlay(currentSession);
        
        timerInterval = setInterval(() => {
             updateOverlay(currentSession);
        }, 5000); 
    }

    // Listen for changes
    api.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.activeSessions) {
            const newSessions = changes.activeSessions.newValue || {};
            const session = newSessions[domain];
            
            currentSession = session;

            if (!session) {
                // Session ended
                if (overlay) overlay.style.display = 'none';
                if (timerInterval) {
                    clearInterval(timerInterval);
                    timerInterval = null;
                }
            } else {
                 if (!timerInterval) {
                     updateOverlay(session);
                     timerInterval = setInterval(() => updateOverlay(currentSession), 5000);
                 } else {
                     // Since we don't restart timer, update immediately to reflect state change
                     updateOverlay(session);
                 }
            }
        }
    });

})();
