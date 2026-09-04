// Parse query parameters
const params = new URLSearchParams(window.location.search);

// When the extension redirects to a test-helper URL (https://playwright-ext-prompt.invalid/)
// instead of the real moz-extension:// page, chrome.storage.local and chrome.runtime are
// unavailable in the page context. Use the __extBridge exported by the content script instead.
// On real extension pages (_isExtPage), the normal extension APIs are used directly.
const _isExtPage = location.protocol === 'chrome-extension:' || location.protocol === 'moz-extension:';

function _storageGet(keys) {
    if (_isExtPage) return chrome.storage.local.get(keys);
    return new Promise(resolve => {
        (function poll() {
            if (window.__extBridge) return window.__extBridge('get', JSON.stringify(keys), r => resolve(JSON.parse(r)));
            setTimeout(poll, 50);
        })();
    });
}

function _sendMessage(msg) {
    if (_isExtPage) return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
    return new Promise(resolve => {
        (function poll() {
            if (window.__extBridge) return window.__extBridge('sendMessage', JSON.stringify(msg), r => resolve(JSON.parse(r)));
            setTimeout(poll, 50);
        })();
    });
}
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
        const hostname = new URL(url).hostname.replace(/^(www\.|m\.|mobile\.)/, '');
        // Must match background.js's getDomain exactly, including the youtu.be alias — this is
        // what's used to look up the right activeSessions/cooldowns entry for a youtu.be intent.
        if (hostname === 'youtu.be') return 'youtube.com';
        return hostname;
    } catch (e) {
        return null;
    }
}

document.getElementById('target-site-display').textContent = `Accessing: ${hostname}`;

// Rotating tips shown at the bottom of every blocking screen
const TIPS = [
    { text: 'Tip: Use Duration mode to set a timer, the site blocks when time runs out.' },
    { text: 'Tip: Count mode on YouTube lets you limit yourself to a set number of videos.' },
    { text: 'Tip: Scheduled Limits block sites during specific hours, like a daily focus window.' },
    { text: 'Tip: The Extend button grants a brief extra window without resetting your cooldown.' },
    { text: 'Tip: "Finish Video/Post" lets you wrap up what you were watching before locking out.' },
    { text: 'Tip: Input Delay adds a pause before you can confirm, a moment to reconsider.' },
    { text: 'Tip: Add multiple sites to the block list and manage them all from Settings.' },
    { text: 'Tip: Open Settings to adjust cooldown length, input delay, and extension duration.' },
    { text: 'Connect Half Full to make limits conditional on your task list.', hf: true },
    { text: 'Half Full is a task manager, when tasks are done, your limits can lift automatically.', hf: true },
    { text: 'Earn your screen time: link Half Full so limits lift once your tasks are checked off.', hf: true },
];

function appendTipBar() {
    if (document.getElementById('tip-bar')) return;
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    const bar = document.createElement('div');
    bar.id = 'tip-bar';
    if (tip.hf) {
        const logo = document.createElement('img');
        logo.src = 'icons/half-full-logo.png';
        logo.alt = 'Half Full';
        logo.className = 'tip-logo';
        bar.appendChild(logo);
    }
    const text = document.createElement('span');
    text.textContent = tip.text;
    bar.appendChild(text);
    if (tip.hf) {
        const link = document.createElement('a');
        link.href = 'https://halffull.pro';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Learn more →';
        link.className = 'tip-link';
        bar.appendChild(link);
    }
    document.body.appendChild(bar);
}

// Main Logic: Check status immediately
init();

function formatTimeLocal(hour, minute) {
    const period = hour >= 12 ? 'PM' : 'AM';
    const h = hour % 12 || 12;
    return `${h}:${String(minute).padStart(2, '0')} ${period}`;
}

// Escapes text interpolated into an innerHTML template. Needed specifically for Half Full
// pattern names — those come from the user's own Firestore data (effectively externally
// controlled from this extension's point of view) and get built into a template string. MV3's
// CSP blocks inline script execution either way, but this stops arbitrary markup/links from
// rendering on the block screen.
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

const SCHEDULED_LIMIT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatScheduledLimitDaysLocal(days) {
    if (!days || days.length === 0) return 'selected days';
    if (days.length === 7) return 'every day';
    return [...days].sort((a, b) => a - b).map(d => SCHEDULED_LIMIT_DAY_NAMES[d]).join(', ');
}

async function showScheduledLimitBlockUI(limitId) {
    const data = await _storageGet({ scheduledLimits: [] });
    const entry = data.scheduledLimits.find(e => e.id === limitId);
    const hfPattern = entry && entry.halfFullPattern;

    let detailHtml;
    if (entry) {
        const startStr = formatTimeLocal(entry.startHour, entry.startMinute);
        const endStr   = formatTimeLocal(entry.endHour, entry.endMinute);
        const isOvernight = (entry.endHour * 60 + entry.endMinute) <= (entry.startHour * 60 + entry.startMinute);
        const reasonLine = entry.limitMinutes === 0
            ? 'This window is fully blocked, no browsing time is allowed.'
            : `${entry.limitMinutes}-minute limit used up.`;
        const waitLine = hfPattern
            ? `This lifts as soon as you finish the "${escapeHtml(hfPattern.pattern)}" task(s) in Half Full — or waits until ${endStr}, whichever comes first.`
            : `This is not a countdown you can wait out early, access resumes at ${endStr}.`;
        detailHtml = `
            <div class="time-range-block-info">
                <p><strong>${formatScheduledLimitDaysLocal(entry.days)} · ${startStr} – ${endStr}${isOvernight ? ' (overnight)' : ''}</strong></p>
                <p>${reasonLine}</p>
                <p class="small-text">${waitLine}</p>
                <p class="small-text">All target sites are blocked until then. No session can bypass it.</p>
            </div>
            ${hfPattern ? `
            <div class="extension-section">
                <button id="hf-recheck-btn">Finished? Check again</button>
            </div>` : ''}`;
    } else {
        detailHtml = `
            <div class="time-range-block-info">
                <p>A scheduled limit is active.</p>
                <p class="small-text">This is not a countdown you can wait out early, access resumes when this window ends.</p>
                <p class="small-text">All target sites are blocked until then. No session can bypass it.</p>
            </div>`;
    }

    document.body.innerHTML = `
        <div class="container">
            <h1 class="scheduled-limit-block-title">Access Blocked (Scheduled Limit)</h1>
            <p id="target-site-display">You are trying to access ${escapeHtml(hostname)}</p>
            ${detailHtml}
        </div>
    ` + '<link rel="stylesheet" href="prompt.css">';

    if (hfPattern) {
        const recheckBtn = document.getElementById('hf-recheck-btn');
        recheckBtn.addEventListener('click', async () => {
            recheckBtn.disabled = true;
            recheckBtn.textContent = 'Checking…';
            await _sendMessage({ action: 'refreshHalfFullCache' });
            window.location.replace(intendedUrl);
        });
    }
}

async function init() {
    // Handle scheduled limits before any other UI (highest priority — a full block or an
    // exhausted usage cap overrides even an active session).
    if (msgVal === 'SCHEDULED_LIMIT') {
        const limitId = params.get('limitId');
        await showScheduledLimitBlockUI(limitId);
        appendTipBar();
        return;
    }

    const data = await _storageGet(['cooldowns', 'inputDelay', 'extensionDuration', 'activeSessions']);
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
            appendTipBar();
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

    // Check if we already have an active session for this domain.
    // If we do, redirect immediately (handles 'back' button and any spurious re-redirects).
    if (data.activeSessions && data.activeSessions[domain]) {
        const session = data.activeSessions[domain];
        const now = Date.now();
        if (session.type === 'duration' && session.endTime > now) {
            window.location.replace(intendedUrl);
            return;
        } else if (session.type === 'count' && (!session.cooldownEndTime || session.cooldownEndTime < now)) {
            if ((session.videosWatched || 0) < session.targetCount) {
                window.location.replace(intendedUrl);
                return;
            }
        } else if (session.type === 'single_url') {
            window.location.replace(intendedUrl);
            return;
        }
    }

    setupNormalUI(delay);
    appendTipBar();
}

function isSpecificContent(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        // youtu.be short links carry the video ID in the path, not a `v` query param — without
        // this branch "Finish Video" never appears for a youtu.be link (mirrors the same fix in
        // background.js's getYouTubeVideoId).
        if (u.hostname.includes('youtu.be')) {
            if (u.pathname.length > 1) return true;
        } else if (u.hostname.includes('youtube.com')) {
            if (u.pathname.startsWith('/shorts/')) return true;
            if (u.searchParams.get('v')) return true;
        }
        if (u.hostname.includes('reddit.com')) {
            if (u.pathname.match(/\/r\/[\w-]+\/comments\/[\w]+\/?/)) return true;
        }
        if (u.hostname.includes('instagram.com')) {
            if (u.pathname.match(/\/(p|reel|tv)\/[\w-]+\/?/)) return true;
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
            <div class="extension-section">
        `;
        if (canExtend) {
            bypassHtml += `
                <button id="extend-btn" disabled>
                    ${delay > 0 ? `Wait ${delay}...` : extendLabel}
                </button>
            `;
        }
        if (canFinish) {
            bypassHtml += `
                <button id="finish-btn" disabled>
                    ${delay > 0 ? `Wait ${delay}...` : finishLabel}
                </button>
            `;
        }
        bypassHtml += `</div>`;
    }

    document.body.innerHTML = `
        <div class="container">
            <h1 class="cooldown-title">Cooldown Active</h1>
            <p>You cannot access ${escapeHtml(hostname)} for another <span id="cd-timer">${minutesLeft}</span> minutes.</p>
            <p class="small-text">Go do something else!</p>
            ${bypassHtml}
        </div>
    ` + '<link rel="stylesheet" href="prompt.css">';

    const extendBtn = canExtend ? document.getElementById('extend-btn') : null;
    const finishBtn = canFinish ? document.getElementById('finish-btn') : null;

    // The countdown text was computed once at render time and never updated, so a cooldown tab
    // left open showed a number that got progressively wrong and never reached 0. Tick it down
    // for real, and once time's actually up, re-navigate so the real access check (which is the
    // sole source of truth for whether the cooldown has ended) runs instead of the UI just
    // guessing it's over.
    const cdTimerEl = document.getElementById('cd-timer');
    const cdInterval = setInterval(() => {
        const remainingMs = endTime - Date.now();
        if (remainingMs <= 0) {
            clearInterval(cdInterval);
            window.location.replace(intendedUrl);
            return;
        }
        cdTimerEl.textContent = Math.ceil(remainingMs / 60000);
    }, 1000);

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
            startSession('duration', extensionDuration / 60, 'extend'); // convert seconds to minutes
        });
    }
    if (finishBtn) {
        finishBtn.addEventListener('click', () => {
            startSession('single_url', intendedUrl, 'finish');
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
        startSession('duration', minutes, 'fresh');

    } else if (selectedType === 'count') {
        const count = parseInt(document.getElementById('count-input').value, 10);
        if (!count || count <= 0) {
            errorDiv.textContent = "Please enter a valid positive number of videos.";
            return;
        }
        startSession('count', count, 'fresh');
    }
}

function startSession(type, value, origin) {
    _sendMessage({
        action: 'startSession',
        url: intendedUrl,
        type: type,
        value: value,
        origin: origin
    }).then(response => {
        if (response && response.success) {
            window.location.replace(intendedUrl);
        } else {
             document.getElementById('error-msg').textContent = (response && response.error) || "Failed to start session.";
        }
    });
}


