document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('add-site').addEventListener('click', addSite);
document.getElementById('save-config').addEventListener('click', saveOptions);
document.getElementById('add-scheduled-limit-btn').addEventListener('click', openScheduledLimitModal);
document.getElementById('sl-save-btn').addEventListener('click', saveScheduledLimit);
document.getElementById('sl-cancel-btn').addEventListener('click', closeScheduledLimitModal);

// Day-of-week toggle buttons: mirror checked state onto the label for styling.
document.querySelectorAll('.day-cb').forEach(cb => {
    cb.addEventListener('change', () => {
        cb.closest('.day-label').classList.toggle('selected', cb.checked);
    });
});

// Time pickers: try to open native picker on click; do NOT block keyboard so
// PC users can type the time directly (Firefox desktop needs this fallback).
['sl-start', 'sl-end'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('click', () => { try { el.showPicker(); } catch (_) {} });
});

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
        extensionDuration: 30,
        scheduledLimits: [],
    }, (items) => {
        document.getElementById('duration-cooldown').value = items.durationCooldown;
        document.getElementById('count-cooldown').value = items.countCooldown;
        document.getElementById('input-delay').value = items.inputDelay;
        document.getElementById('extension-duration').value = items.extensionDuration;

        const list = document.getElementById('site-list');
        list.innerHTML = '';
        items.targetSites.forEach(site => createSiteElement(site));

        renderScheduledLimitList(items.scheduledLimits);
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

// --- Scheduled Limit Functions ---

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTime(hour, minute) {
    const period = hour >= 12 ? 'PM' : 'AM';
    const h = hour % 12 || 12;
    return `${h}:${String(minute).padStart(2, '0')} ${period}`;
}

function formatScheduledLimitDays(days) {
    if (!days || days.length === 0) return 'No days';
    if (days.length === 7) return 'Every day';
    const sorted = [...days].sort((a, b) => a - b);
    return sorted.map(d => DAY_NAMES[d]).join(', ');
}

function renderScheduledLimitList(entries) {
    const list = document.getElementById('scheduled-limit-list');
    list.innerHTML = '';
    if (!entries || entries.length === 0) return;
    entries.forEach(entry => {
        const li = document.createElement('li');
        li.className = 'time-range-item';

        const label = document.createElement('span');
        const isOvernight = (entry.endHour * 60 + entry.endMinute) <= (entry.startHour * 60 + entry.startMinute);
        const startStr = formatTime(entry.startHour, entry.startMinute);
        const endStr   = formatTime(entry.endHour, entry.endMinute);
        const daysStr  = formatScheduledLimitDays(entry.days);
        const limitStr = entry.limitMinutes === 0 ? 'Full block' : `${entry.limitMinutes} min`;
        label.textContent = `${daysStr} · ${startStr} – ${endStr}${isOvernight ? ' (overnight)' : ''} · ${limitStr}`;

        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.className = 'remove-btn';
        removeBtn.onclick = () => deleteScheduledLimit(entry.id);

        li.appendChild(label);
        li.appendChild(removeBtn);
        list.appendChild(li);
    });
}

function deleteScheduledLimit(id) {
    chrome.storage.local.get({ scheduledLimits: [] }, (data) => {
        const updated = data.scheduledLimits.filter(e => e.id !== id);
        chrome.storage.local.set({ scheduledLimits: updated }, () => {
            renderScheduledLimitList(updated);
            showStatus('Scheduled limit removed.');
            chrome.runtime.sendMessage({ action: 'scheduledLimitsChanged' });
        });
    });
}

function updateSlOvernightHint() {
    const start = document.getElementById('sl-start').value;
    const end   = document.getElementById('sl-end').value;
    const show = start && end && end <= start;
    document.getElementById('sl-overnight-hint').style.display = show ? 'block' : 'none';
}

function openScheduledLimitModal() {
    document.querySelectorAll('.day-cb').forEach(cb => {
        cb.checked = false;
        cb.closest('.day-label').classList.remove('selected');
    });
    document.getElementById('sl-start').value = '';
    document.getElementById('sl-end').value   = '';
    document.getElementById('sl-limit').value = '';
    document.getElementById('sl-error').textContent = '';
    document.getElementById('sl-overnight-hint').style.display = 'none';
    document.getElementById('sl-start').oninput = updateSlOvernightHint;
    document.getElementById('sl-end').oninput   = updateSlOvernightHint;
    document.getElementById('scheduled-limit-modal').style.display = 'flex';
}

function closeScheduledLimitModal() {
    document.getElementById('scheduled-limit-modal').style.display = 'none';
}

function saveScheduledLimit() {
    const errorEl  = document.getElementById('sl-error');
    const startVal = document.getElementById('sl-start').value;
    const endVal   = document.getElementById('sl-end').value;
    const days     = Array.from(document.querySelectorAll('.day-cb:checked')).map(cb => parseInt(cb.value, 10));
    const limitVal = parseInt(document.getElementById('sl-limit').value, 10);

    if (days.length === 0) {
        errorEl.textContent = 'Please select at least one day.';
        return;
    }
    if (!startVal || !endVal) {
        errorEl.textContent = 'Please set both start and end times.';
        return;
    }
    if (startVal === endVal) {
        errorEl.textContent = 'Start and end times cannot be the same.';
        return;
    }
    if (!Number.isInteger(limitVal) || limitVal < 0) {
        errorEl.textContent = 'Please enter minutes allowed (0 or more — 0 means a full block).';
        return;
    }

    const [startHour, startMinute] = startVal.split(':').map(Number);
    const [endHour, endMinute]     = endVal.split(':').map(Number);

    const newEntry = {
        id: `sl_${Date.now()}`,
        days,
        startHour, startMinute,
        endHour, endMinute,
        limitMinutes: limitVal,
        // Usage tracking never counts time before an entry existed (see background.js's
        // computeUsedSeconds) — without this, creating a limit mid-session could retroactively
        // bill already-elapsed browsing and appear instantly exhausted.
        createdAt: Date.now(),
    };

    chrome.storage.local.get({ scheduledLimits: [] }, (data) => {
        const updated = [...data.scheduledLimits, newEntry];
        chrome.storage.local.set({ scheduledLimits: updated }, () => {
            renderScheduledLimitList(updated);
            closeScheduledLimitModal();
            showStatus('Scheduled limit saved.');
            chrome.runtime.sendMessage({ action: 'scheduledLimitsChanged' });
        });
    });
}
