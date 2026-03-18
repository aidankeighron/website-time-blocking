document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('add-site').addEventListener('click', addSite);
document.getElementById('save-config').addEventListener('click', saveOptions);

function getDomain(url) {
    try {
         // If user enters domain without protocol, add https:// to parse it
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }
        const hostname = new URL(url).hostname;
        return hostname.replace(/^www\./, '');
    } catch (e) {
        return null; // Invalid URL
    }
}

function restoreOptions() {
    chrome.storage.local.get({
        targetSites: ['instagram.com', 'reddit.com', 'youtube.com'],
        durationCooldown: 30,
        countCooldown: 30,
        inputDelay: 0,
        extensionDuration: 30
    }, (items) => {
        document.getElementById('duration-cooldown').value = items.durationCooldown;
        document.getElementById('count-cooldown').value = items.countCooldown;
        document.getElementById('input-delay').value = items.inputDelay;
        document.getElementById('extension-duration').value = items.extensionDuration;
        
        const list = document.getElementById('site-list');
        list.innerHTML = '';
        items.targetSites.forEach(site => createSiteElement(site));
    });
}

function createSiteElement(site) {
    const list = document.getElementById('site-list');
    const li = document.createElement('li');
    li.textContent = site;
    
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'remove-btn';
    removeBtn.onclick = () => {
        li.remove();
        // We auto-save when removing?? user didn't specify. 
        // Let's require explicit save OR auto-save. Prompt says "add and remove websites".
        // I'll make it so you have to click save, OR I'll separate the site list saving.
        // Actually, let's just save the list immediately for better UX on list manipulation
        saveOptions(); 
    };
    
    li.appendChild(removeBtn);
    list.appendChild(li);
}

function addSite() {
    const input = document.getElementById('new-site');
    const domain = getDomain(input.value);
    
    if (domain) {
        // Check if unique
        const currentSites = Array.from(document.querySelectorAll('#site-list li')).map(li => li.childNodes[0].textContent);
        if (!currentSites.includes(domain)) {
             createSiteElement(domain);
             saveOptions();
             input.value = '';
        } else {
             showStatus('Site already in list.', 'error');
        }
    } else {
        showStatus('Invalid domain.', 'error');
    }
}

function saveOptions() {
    const durationCooldown = parseInt(document.getElementById('duration-cooldown').value, 10);
    const countCooldown = parseInt(document.getElementById('count-cooldown').value, 10);
    const inputDelay = parseInt(document.getElementById('input-delay').value, 10);
    const extensionDuration = parseInt(document.getElementById('extension-duration').value, 10);

    const targetSites = Array.from(document.querySelectorAll('#site-list li')).map(li => li.childNodes[0].textContent);

    chrome.storage.local.set({
        targetSites: targetSites,
        durationCooldown: durationCooldown,
        countCooldown: countCooldown,
        inputDelay: inputDelay,
        extensionDuration: extensionDuration
    }, () => {
        showStatus('Settings saved.');
    });
}

function showStatus(msg, type = 'success') {
    const status = document.getElementById('status');
    status.textContent = msg;
    status.className = type;
    setTimeout(() => {
        status.textContent = '';
        status.className = '';
    }, 2000);
}
