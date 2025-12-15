// Parse query parameters to get the intended URL
const params = new URLSearchParams(window.location.search);
const intendedUrl = params.get('url');
const cooldownVal = params.get('cooldown');
const msgVal = params.get('msg');
const hostname = intendedUrl ? new URL(intendedUrl).hostname : 'Unknown';

document.getElementById('target-site-display').textContent = `Accessing: ${hostname}`;

// Handle Cooldown or Custom Message
if (cooldownVal) {
    document.body.innerHTML = `
        <div class="container">
            <h1>Cooldown Active</h1>
            <p>You cannot access ${hostname} for another ${cooldownVal} minutes.</p>
            <p class="small-text">Go do something else!</p>
        </div>
    ` + '<link rel="stylesheet" href="prompt.css">'; // Keep style
    throw new Error('Cooldown active'); // Stop script
}

if (msgVal) {
    document.getElementById('error-msg').textContent = decodeURIComponent(msgVal);
}

// show 'Count' only if it is youtube
if (hostname.includes('youtube.com')) {
    document.getElementById('count-btn').style.display = 'inline-block';
}

let selectedType = 'unlimited';
let config = {};

// Load config to display current limits/status
chrome.storage.local.get(['unlimitedUses', 'countLimit'], (items) => { // 'countLimit' wasn't in options, assuming fixed logic or derived. 
    // Wait, the user said "Count session type... will let you watch count number of videos."
    // But they also said: "For the settings page... The number of unlimited session usages... and the cooldown durations"
    // They didn't explicitly say "The number of videos for count session" is configurable in settings. 
    // They said "The prompt will have the user select the blocking type and config they want... The count session type is only available for youtube. It will let you watch count number of videos."
    // Re-reading: "The prompt will have the user select the blocking type and config they want to use... The count session type... will let you watch count number of videos."
    // This implies the USER sets the number of videos IN THE PROMPT, similar to Duration (numerical text box).
    // Let's re-read carefully: "The duration session type will contain a numerial text box... The count session type... will let you watch count number of videos."
    // It doesn't explicitly say "numerical text box for count", but contextually it matches "Duration".
    // "You switch through the different types... when switching blocking types the content of the prompt will switch to reflect the configuration needed"
    // "The count session type... will let you watch count number of videos."
    // "The extension will keep track of every new video you open... and if you try to open a video past the count limit..."
    
    // I will assume for Count type, I also need an input field for "Number of Videos", similar to "Number of Minutes".
    // I'll update prompt.html structure dynamically or just fix it now.
    // I'll fix prompt.html structure in the DOM via JS or just rewrite it if I can.
    // Let's modify the DOM in JS for now or just treat 'view-count' as having an input.
    // I'll update the 'view-count' innerHTML below.
});

// Update view-count to have an input
document.getElementById('view-count').innerHTML = `
    <label for="count-input">Enter number of videos:</label>
    <input type="number" id="count-input" min="1" placeholder="e.g. 3">
`;

// Setup type switching
document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
        const type = btn.getAttribute('data-type');
        document.getElementById(`view-${type}`).classList.add('active-view');
        selectedType = type;
        
        validate();
    });
});

// Check daily unlimited status
const today = new Date().toLocaleDateString();
chrome.storage.local.get(['unlimitedUses', 'dailyUnlimitedUsage'], (data) => {
    const dailyLimit = data.unlimitedUses || 5;
    const usageData = data.dailyUnlimitedUsage || { date: today, count: 0 };
    
    // Reset if new day
    if (usageData.date !== today) {
        usageData.date = today;
        usageData.count = 0;
        chrome.storage.local.set({ dailyUnlimitedUsage: usageData });
    }
    
    const remaining = dailyLimit - usageData.count;
    document.getElementById('unlimited-remaining').textContent = Math.max(0, remaining);
    
    if (remaining <= 0) {
        document.getElementById('unlimited-warning').textContent = "No unlimited sessions remaining for today.";
        // Disable confirm if unlimited is selected and no uses left?
        // "You can still start an unlimited session as long as you have some left."
    }
});

document.getElementById('confirm-btn').addEventListener('click', () => {
    const errorDiv = document.getElementById('error-msg');
    errorDiv.textContent = '';

    if (selectedType === 'unlimited') {
        chrome.storage.local.get(['unlimitedUses', 'dailyUnlimitedUsage'], (data) => {
            const dailyLimit = data.unlimitedUses || 5;
            const usageData = data.dailyUnlimitedUsage || { date: today, count: 0 };
            
            // Check date again to be safe
            if (usageData.date !== today) { usageData.count = 0; }
            
            if (usageData.count >= dailyLimit) {
                errorDiv.textContent = "No unlimited uses left today.";
                return;
            }
            
            // Increment usage
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
});

function startSession(type, value) {
    // Send message to background to authorize the session
    chrome.runtime.sendMessage({
        action: 'startSession',
        url: intendedUrl,
        type: type,
        value: value
    }, (response) => {
        if (response && response.success) {
           // Redirect to original URL
           window.location.href = intendedUrl;
        } else {
             document.getElementById('error-msg').textContent = response.error || "Failed to start session.";
        }
    });
}

function validate() {
   // Optional: real-time validation visual cues
}
