// Parse query parameters
const params = new URLSearchParams(window.location.search);
const intendedUrl = params.get('url');
const cooldownVal = params.get('cooldown');
const msgVal = params.get('msg');
const hostname = intendedUrl ? new URL(intendedUrl).hostname : 'Unknown';

document.getElementById('target-site-display').textContent = `Accessing: ${hostname}`;

// Main Logic: Check status immediately
init();

async function init() {
    const data = await chrome.storage.local.get('cooldowns');
    const domain = hostname;
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
            showCooldownUI(endTime, data.cooldowns[domain]);
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
    
    setupNormalUI();
}

function showCooldownUI(endTime, cooldownInfo) {
    const minutesLeft = Math.ceil((endTime - Date.now()) / 60000);
    
    const canExtend = cooldownInfo.originalType === 'duration';

    let bypassHtml = '';
    
    if (canExtend) {
        bypassHtml += `
            <div class="extension-section" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #333;">
                <button id="extend-btn" style="background-color: #03dac6; color: #000; padding: 10px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-bottom: 15px; width: 100%;">
                    Use for 30s
                </button>
            </div>
        `;
    }

    document.body.innerHTML = `
        <div class="container" style="max-width: 400px;">
            <h1 style="color: #cf6679;">Cooldown Active</h1>
            <p>You cannot access ${hostname} for another <span id="cd-timer">${minutesLeft}</span> minutes.</p>
            <p class="small-text">Go do something else!</p>
            ${bypassHtml}
        </div>
    ` + '<link rel="stylesheet" href="prompt.css">'; 
    
    if (canExtend) {
        document.getElementById('extend-btn').addEventListener('click', () => {
             startSession('duration', 0.5); // 0.5 minutes = 30 seconds
        });
    }
}

function setupNormalUI() {
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
    
    document.getElementById('confirm-btn').addEventListener('click', handleConfirm);
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
           window.location.href = intendedUrl;
        } else {
             document.getElementById('error-msg').textContent = response.error || "Failed to start session.";
        }
    });
}


