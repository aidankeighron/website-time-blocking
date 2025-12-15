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
        unlimitedUses: 5,
        durationCooldown: 30,
        countCooldown: 30
    }, (items) => {
        document.getElementById('unlimited-daily').value = items.unlimitedUses;
        document.getElementById('duration-cooldown').value = items.durationCooldown;
        document.getElementById('count-cooldown').value = items.countCooldown;
        
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
    const unlimitedUses = parseInt(document.getElementById('unlimited-daily').value, 10);
    const durationCooldown = parseInt(document.getElementById('duration-cooldown').value, 10);
    const countCooldown = parseInt(document.getElementById('count-cooldown').value, 10);
    
    const targetSites = Array.from(document.querySelectorAll('#site-list li')).map(li => li.childNodes[0].textContent);

    chrome.storage.local.set({
        targetSites: targetSites,
        unlimitedUses: unlimitedUses,
        durationCooldown: durationCooldown,
        countCooldown: countCooldown
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
