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
    const data = await chrome.storage.local.get(['cooldowns', 'unlimitedUses', 'dailyUnlimitedUsage']);
    const now = Date.now();
    const domain = hostname.replace(/^www\./, '');
    
    // Check Cooldown in Storage (Priority UI check)
    if (data.cooldowns && data.cooldowns[domain] && data.cooldowns[domain] > now) {
        showCooldownUI(data.cooldowns[domain], data);
        return;
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

function showCooldownUI(endTime, data) {
    const minutesLeft = Math.ceil((endTime - Date.now()) / 60000);
    
    // Check Unlimited availability
    const dailyLimit = data.unlimitedUses || 5;
    const today = new Date().toLocaleDateString();
    const usageData = data.dailyUnlimitedUsage || { date: today, count: 0 };
    if (usageData.date !== today) { usageData.count = 0; } // reset if needed
    
    const remainingUnlimited = dailyLimit - usageData.count;
    const canBypass = remainingUnlimited > 0;

    let bypassHtml = '';
    if (canBypass) {
        bypassHtml = `
            <div class="bypass-section" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #333;">
                <p>You have ${remainingUnlimited} unlimited sessions left.</p>
                <button id="bypass-btn" style="background-color: #bb86fc; color: #000; padding: 10px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Use Unlimited & Bypass
                </button>
            </div>
        `;
    } else {
         bypassHtml = `<p class="small-text" style="color: #777; margin-top: 20px;">No unlimited sessions available to bypass.</p>`;
    }

    document.body.innerHTML = `
        <div class="container" style="max-width: 400px;">
            <h1 style="color: #cf6679;">Cooldown Active</h1>
            <p>You cannot access ${hostname} for another <span id="cd-timer">${minutesLeft}</span> minutes.</p>
            <p class="small-text">Go do something else!</p>
            ${bypassHtml}
        </div>
    ` + '<link rel="stylesheet" href="prompt.css">'; 
    
    if (canBypass) {
        document.getElementById('bypass-btn').addEventListener('click', () => {
             // Increment usage
             usageData.count = usageData.count + 1;
             usageData.date = today;
             chrome.storage.local.set({ dailyUnlimitedUsage: usageData }, () => {
                  startSession('unlimited', null);
             });
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
    updateUnlimitedStatus();
    
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
            
            // Set global selectedType (implicitly via closure variable check in handleConfirm, or just use DOM)
            // Better to update a var
            window.selectedType = type; 
        });
    });
    window.selectedType = 'unlimited'; // default
}

function updateUnlimitedStatus() {
    const today = new Date().toLocaleDateString();
    chrome.storage.local.get(['unlimitedUses', 'dailyUnlimitedUsage'], (data) => {
        const dailyLimit = data.unlimitedUses || 5;
        const usageData = data.dailyUnlimitedUsage || { date: today, count: 0 };
        
        if (usageData.date !== today) {
            usageData.date = today;
            usageData.count = 0;
            chrome.storage.local.set({ dailyUnlimitedUsage: usageData });
        }
        
        const remaining = dailyLimit - usageData.count;
        document.getElementById('unlimited-remaining').textContent = Math.max(0, remaining);
        
        if (remaining <= 0) {
            document.getElementById('unlimited-warning').textContent = "No unlimited sessions remaining for today.";
        }
    });
}

function handleConfirm() {
    const errorDiv = document.getElementById('error-msg');
    errorDiv.textContent = '';
    const selectedType = window.selectedType || 'unlimited';

    if (selectedType === 'unlimited') {
        const today = new Date().toLocaleDateString();
         chrome.storage.local.get(['unlimitedUses', 'dailyUnlimitedUsage'], (data) => {
            const dailyLimit = data.unlimitedUses || 5;
            const usageData = data.dailyUnlimitedUsage || { date: today, count: 0 };
            
            if (usageData.date !== today) { usageData.count = 0; }
            
            if (usageData.count >= dailyLimit) {
                errorDiv.textContent = "No unlimited uses left today.";
                return;
            }
            
            usageData.count = usageData.count + 1;
            usageData.date = today;
            
            chrome.storage.local.set({ dailyUnlimitedUsage: usageData }, () => {
                 startSession('unlimited', null);
            });
        });

    } else if (selectedType === 'duration') {
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
