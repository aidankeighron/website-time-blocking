// Parse query parameters
const params = new URLSearchParams(window.location.search);
const intendedUrl = params.get('url');
const cooldownVal = params.get('cooldown');
const msgVal = params.get('msg');
// Use getDomain helper for consistency with background.js
const hostname = intendedUrl ? new URL(intendedUrl).hostname : 'Unknown';

// Replace state to avoid adding to history if possible, or at least mark this entry
if (window.history.replaceState) {
    window.history.replaceState(null, '', window.location.href);
}

function getDomain(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace(/^(www\.|m\.|mobile\.)/, '');
    } catch (e) {
        return null;
    }
}

document.getElementById('target-site-display').textContent = `Accessing: ${hostname}`;

// Main Logic: Check status immediately
init();

async function init() {
    const data = await chrome.storage.local.get(['cooldowns', 'inputDelay', 'extensionDuration']);
    // Normalize domain to match storage key
    const domain = intendedUrl ? getDomain(intendedUrl) : (hostname !== 'Unknown' ? getDomain('http://' + hostname) : null);
    
    if (!domain) {
        setupNormalUI();
        return;
    }
    const now = Date.now();
    // Check Cooldown in Storage (Priority UI check)
    if (data.cooldowns && data.cooldowns[domain]) {
        // New structure: { startTime, duration }
        // Fallback for migration if old number exists
        let endTime;
        if (typeof data.cooldowns[domain] === 'number') {
             endTime = data.cooldowns[domain];
        } else {
             const { startTime, duration } = data.cooldowns[domain];
             endTime = startTime + duration;
        }

        if (endTime > now) {
            const delay = data.inputDelay || 0;
            const extDuration = data.extensionDuration !== undefined ? data.extensionDuration : 30;
            showCooldownUI(endTime, data.cooldowns[domain], delay, extDuration);
            return;
        }
    }
    
    // If URL param says cooldown but storage doesn't (weird sync issue), trust params or storage? storage is source of truth.
    // If param says cooldown=5 but storage says expired, we should probably check storage.
    // But for responsiveness, let's trust storage.
    // If NO cooldown in storage, proceed to normal UI.

    if (msgVal) {
        document.getElementById('error-msg').textContent = decodeURIComponent(msgVal);
    }

    const delay = data.inputDelay || 0;

    // Check if we already have an active session for this domain
    // If we do, and it's still valid, redirect immediately (handles 'back' button into prompt)
    if (data.activeSessions && data.activeSessions[domain]) {
        const session = data.activeSessions[domain];
        const now = Date.now();
        if (session.type === 'duration' && session.endTime > now) {
            window.location.replace(intendedUrl);
            return;
        } 
        else if (session.type === 'count' && (!session.cooldownEndTime || session.cooldownEndTime < now)) {
            // For count, if not in cooldown, it's technically 'active'
            // However, the background script manages the limit. 
            // If the user backed into here, we should probably let them through if they haven't hit the limit.
            if ((session.videosWatched || 0) < session.targetCount) {
                window.location.replace(intendedUrl);
                return;
            }
        }
    }

    setupNormalUI(delay);
}

function isSpecificContent(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
            if (u.pathname.startsWith('/shorts/')) return true;
            if (u.searchParams.get('v')) return true;
        }
        if (u.hostname.includes('reddit.com')) {
            if (u.pathname.match(/\/r\/[\w-]+\/comments\/[\w]+\/?/)) return true;
        }
    } catch(e) {}
    return false;
}

function showCooldownUI(endTime, cooldownInfo, delay = 0, extensionDuration = 30) {
    const minutesLeft = Math.ceil((endTime - Date.now()) / 60000);

    const canExtend = cooldownInfo.originalType === 'duration' && extensionDuration > 0;
    const canFinish = isSpecificContent(intendedUrl);

    const extendLabel = `Use for ${extensionDuration}s`;
    const finishLabel = 'Finish Video/Post';

    let bypassHtml = '';

    if (canExtend || canFinish) {
        bypassHtml += `
            <div class="extension-section" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #333;">
        `;
        if (canExtend) {
            bypassHtml += `
                <button id="extend-btn" disabled style="background-color: #03dac6; color: #000; padding: 10px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-bottom: 15px; width: 100%;">
                    ${delay > 0 ? `Wait ${delay}...` : extendLabel}
                </button>
            `;
        }
        if (canFinish) {
            bypassHtml += `
                <button id="finish-btn" disabled style="background-color: #bb86fc; color: #000; padding: 10px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-bottom: 15px; width: 100%;">
                    ${delay > 0 ? `Wait ${delay}...` : finishLabel}
                </button>
            `;
        }
        bypassHtml += `</div>`;
    }

    document.body.innerHTML = `
        <div class="container" style="max-width: 400px;">
            <h1 style="color: #cf6679;">Cooldown Active</h1>
            <p>You cannot access ${hostname} for another <span id="cd-timer">${minutesLeft}</span> minutes.</p>
            <p class="small-text">Go do something else!</p>
            ${bypassHtml}
        </div>
    ` + '<link rel="stylesheet" href="prompt.css">';

    const extendBtn = canExtend ? document.getElementById('extend-btn') : null;
    const finishBtn = canFinish ? document.getElementById('finish-btn') : null;

    if (delay > 0) {
        let timeLeft = delay;
        const timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(timer);
                if (extendBtn) {
                    extendBtn.disabled = false;
                    extendBtn.textContent = extendLabel;
                }
                if (finishBtn) {
                    finishBtn.disabled = false;
                    finishBtn.textContent = finishLabel;
                }
            } else {
                if (extendBtn) extendBtn.textContent = `Wait ${timeLeft}...`;
                if (finishBtn) finishBtn.textContent = `Wait ${timeLeft}...`;
            }
        }, 1000);
    } else {
        if (extendBtn) extendBtn.disabled = false;
        if (finishBtn) finishBtn.disabled = false;
    }

    if (extendBtn) {
        extendBtn.addEventListener('click', () => {
            startSession('duration', extensionDuration / 60); // convert seconds to minutes
        });
    }
    if (finishBtn) {
        finishBtn.addEventListener('click', () => {
            startSession('single_url', intendedUrl);
        });
    }
}

function setupNormalUI(delay = 0) {
    // show 'Count' only if it is youtube
    if (hostname.includes('youtube.com')) {
        document.getElementById('count-btn').style.display = 'inline-block';
    }

    // Default existing setup
    document.getElementById('view-count').innerHTML = `
        <label for="count-input">Enter number of videos:</label>
        <input type="number" id="count-input" min="1" placeholder="e.g. 3">
    `;
    
    setupTypeSwitching();
    // updateUnlimitedStatus(); // Removed
    
    const confirmBtn = document.getElementById('confirm-btn');
    confirmBtn.addEventListener('click', handleConfirm);
    
    if (delay > 0) {
        const inputs = document.querySelectorAll('input, button.type-btn');
        inputs.forEach(el => el.disabled = true);
        confirmBtn.disabled = true;
        
        // Also disable any inputs created above (specifically count-input)
        document.getElementById('count-input').disabled = true;
        
        let timeLeft = delay;
        confirmBtn.textContent = `Wait ${timeLeft}...`;
        
        const timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(timer);
                inputs.forEach(el => el.disabled = false);
                document.getElementById('count-input').disabled = false;
                confirmBtn.disabled = false;
                confirmBtn.textContent = "Continue to Site";
            } else {
                confirmBtn.textContent = `Wait ${timeLeft}...`;
            }
        }, 1000);
    }
}

function setupTypeSwitching() {
    document.querySelectorAll('.type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
            const type = btn.getAttribute('data-type');
            document.getElementById(`view-${type}`).classList.add('active-view');
            
            window.selectedType = type; 
        });
    });
    window.selectedType = 'duration'; // default
    document.getElementById('view-duration').classList.add('active-view');
}


function handleConfirm() {
    const errorDiv = document.getElementById('error-msg');
    errorDiv.textContent = '';
    const selectedType = window.selectedType || 'duration';

    if (selectedType === 'duration') {
        const minutes = parseInt(document.getElementById('duration-input').value, 10);
        if (!minutes || minutes <= 0) {
            errorDiv.textContent = "Please enter a valid positive duration.";
            return;
        }
        startSession('duration', minutes);

    } else if (selectedType === 'count') {
        const count = parseInt(document.getElementById('count-input').value, 10);
        if (!count || count <= 0) {
            errorDiv.textContent = "Please enter a valid positive number of videos.";
            return;
        }
        startSession('count', count);
    }
}

function startSession(type, value) {
    chrome.runtime.sendMessage({
        action: 'startSession',
        url: intendedUrl,
        type: type,
        value: value
    }, (response) => {
        if (response && response.success) {
           window.location.replace(intendedUrl);
        } else {
             document.getElementById('error-msg').textContent = response.error || "Failed to start session.";
        }
    });
}


