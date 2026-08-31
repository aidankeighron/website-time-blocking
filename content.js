// content.js
(async function() {
    const DEFAULT_TARGETS = ['instagram.com', 'reddit.com', 'youtube.com'];

    function getDomain(url) {
        try {
            const hostname = new URL(url).hostname;
            return hostname.replace(/^(www\.|m\.|mobile\.)/, '');
        } catch (e) {
            return null;
        }
    }

    function getStorage(keys) {
        return new Promise((resolve) => {
            // Prioritize standard 'browser' namespace (Firefox)
            if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
                browser.storage.local.get(keys)
                    .then(resolve)
                    .catch((err) => {
                        console.error("Website Time Blocking: Storage read error", err);
                        resolve({});
                    });
            } 
            // Fallback to 'chrome' namespace
            else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    chrome.storage.local.get(keys, (result) => {
                        if (chrome.runtime.lastError) {
                            console.error("Website Time Blocking: Runtime error", chrome.runtime.lastError);
                            resolve({});
                        } else {
                            resolve(result || {});
                        }
                    });
                } catch (e) {
                     console.error("Website Time Blocking: Exception accessing storage", e);
                     resolve({});
                }
            } else {
                resolve({});
            }
        });
    }

    const domain = getDomain(window.location.href);
    if (!domain) return;
    
    console.log("Website Time Blocking: Content script running for", domain);

    // Check if we are a target site
    const data = await getStorage(['targetSites', 'activeSessions']);
    const targetSites = data.targetSites || DEFAULT_TARGETS;
    
    // Simple check: is domain in target sites?
    if (!targetSites.includes(domain)) return;


    let overlay = null;
    let timerInterval = null;

    function createOverlay() {
        if (document.getElementById('website-time-blocking-overlay')) return;
        
        overlay = document.createElement('div');
        overlay.id = 'website-time-blocking-overlay';
        
        // Try to append to body, fallback to documentElement (html)
        if (document.body) {
            document.body.appendChild(overlay);
        } else {
            document.documentElement.appendChild(overlay);
        }
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
                 overlay.classList.add('wtb-warning');
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
                overlay.classList.remove('wtb-warning');
            }
        } else if (session.type === 'count') {
            if (session.cooldownEndTime) {
                const timeLeft = session.cooldownEndTime - Date.now();
                if (timeLeft <= 0) {
                     // Cooldown over, but technically session is still active until page refresh/check
                     // or until we hit the limit in background
                     overlay.textContent = "Cooldown Complete";
                     overlay.classList.remove('wtb-warning');
                } else {
                    const minutes = Math.floor(timeLeft / 60000);
                    const seconds = Math.floor((timeLeft % 60000) / 1000);
                    overlay.textContent = `Cooldown: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                    overlay.classList.add('wtb-warning');
                }
            } else {
                overlay.textContent = `${session.videosWatched || 0} / ${session.targetCount} Videos`;
                 if ((session.videosWatched || 0) >= session.targetCount) {
                      overlay.classList.add('wtb-warning');
                 } else {
                      overlay.classList.remove('wtb-warning');
                 }
            }
        } else if (session.type === 'single_url') {
             overlay.textContent = "Finish this post/video";
             overlay.classList.remove('wtb-warning');
        }
    }

    // State to hold current session data
    let currentSession = null;

    let heartbeatInterval = null;

    // Purely a liveness nudge — no accumulation math happens here or on the receiving end.
    // It exists so a single long-lived page with zero navigation (e.g. one long video, no
    // clicks) still keeps the scheduled-limit engine's liveness timestamp fresh.
    function startHeartbeat() {
        if (heartbeatInterval) return;
        heartbeatInterval = setInterval(() => {
            if (!currentSession) return;
            chrome.runtime.sendMessage({ action: 'scheduledLimitLivenessPing', domain }).catch(() => {});
        }, 30000);
    }

    function stopHeartbeat() {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    }

    // Initial Check
    if (data.activeSessions && data.activeSessions[domain]) {
        currentSession = data.activeSessions[domain];
        updateOverlay(currentSession);

        // Start lighter timer for duration updates AND heartbeats
        timerInterval = setInterval(() => {
             updateOverlay(currentSession);
        }, 1000); // 1 sec interval as requested

        startHeartbeat();
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
                stopHeartbeat();
            } else {
                 // If timer wasn't running (e.g. startup), start it
                 if (!timerInterval) {
                     updateOverlay(session);
                     timerInterval = setInterval(() => updateOverlay(currentSession), 1000);
                 }
                 startHeartbeat();
                 // REMOVED: Immediate updateOverlay(session) here, because if that triggered a write (heartbeat)
                 // it would cause an infinite loop with storage.onChanged.
                 // We rely on the interval to update the display.
            }
        }
    });

})();

// Test-only storage bridge for Firefox E2E tests.
// Firefox content scripts run in an XRay-wrapped isolated world. exportFunction() exposes
// a privileged function to the page's JS scope, but returning a privileged Promise from
// it triggers a "Permission denied to access .then" Xray error. Workaround: use a
// callback parameter — the page passes its own (page-context) resolve function and the
// content script calls it with a plain JSON string, which auto-clones across worlds.
// No-op in Chrome (exportFunction is undefined there).
//
// SECURITY: exportFunction is a standard API present in every real Firefox content script —
// NOT a signal that this is a test environment. Without the hostname check below, this bridge
// would expose chrome.storage.local (including Half Full's idToken/refreshToken) and
// chrome.runtime.sendMessage (including the ability to call startSession) to every website the
// user visits, in the actual shipped Firefox build. It must only ever activate on the exact
// synthetic domains the Playwright fixture serves (see tests/e2e/fixture.js's HELPER_URL and
// TEST_PROMPT_BASE) — domains that cannot exist on the real internet.
const TEST_BRIDGE_HOSTS = new Set(['playwright-ext-helper.invalid', 'playwright-ext-prompt.invalid']);
if (typeof exportFunction !== 'undefined' && TEST_BRIDGE_HOSTS.has(location.hostname)) {
    const store = (typeof browser !== 'undefined' && browser.storage) ? browser.storage.local : chrome.storage.local;
    exportFunction((op, dataStr, callback) => {
        const data = dataStr === null ? null : JSON.parse(dataStr);
        let p;
        if (op === 'set') p = store.set(data).then(() => '{}');
        else if (op === 'get') p = store.get(data).then(r => JSON.stringify(r));
        // chrome.alarms is not available in content scripts — alarm clearing is done
        // by the fixture via a background-script message after storage is cleared.
        else if (op === 'clear') p = store.clear().then(() => '{}');
        else if (op === 'sendMessage') {
            const rt = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime : chrome.runtime;
            p = rt.sendMessage(data).then(r => JSON.stringify(r));
        }
        else p = Promise.resolve('{"error":"unknown op"}');
        p.then(r => callback(r)).catch(() => callback('{"error":"store failed"}'));
    }, window, { defineAs: '__extBridge' });
}
