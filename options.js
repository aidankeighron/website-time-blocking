document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('add-site').addEventListener('click', addSite);
document.getElementById('save-config').addEventListener('click', saveOptions);
document.getElementById('add-time-range-btn').addEventListener('click', openTimeRangeModal);
document.getElementById('tr-save-btn').addEventListener('click', saveTimeRange);
document.getElementById('tr-cancel-btn').addEventListener('click', closeTimeRangeModal);
document.getElementById('add-schedule-block-btn').addEventListener('click', openScheduleBlockModal);
document.getElementById('sb-save-btn').addEventListener('click', saveScheduleBlock);
document.getElementById('sb-cancel-btn').addEventListener('click', closeScheduleBlockModal);

// Time pickers: try to open native picker on click; do NOT block keyboard so
// PC users can type the time directly (Firefox desktop needs this fallback).
['tr-start', 'tr-end'].forEach(id => {
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
        timeRanges: [],
        scheduleBlocks: [],
    }, (items) => {
        document.getElementById('duration-cooldown').value = items.durationCooldown;
        document.getElementById('count-cooldown').value = items.countCooldown;
        document.getElementById('input-delay').value = items.inputDelay;
        document.getElementById('extension-duration').value = items.extensionDuration;

        const list = document.getElementById('site-list');
        list.innerHTML = '';
        items.targetSites.forEach(site => createSiteElement(site));

        renderTimeRangeList(items.timeRanges);
        renderScheduleBlockList(items.scheduleBlocks);
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

// --- Time Range Functions ---

function formatTime(hour, minute) {
    const period = hour >= 12 ? 'PM' : 'AM';
    const h = hour % 12 || 12;
    return `${h}:${String(minute).padStart(2, '0')} ${period}`;
}

function renderTimeRangeList(ranges) {
    const list = document.getElementById('time-range-list');
    list.innerHTML = '';
    if (!ranges || ranges.length === 0) return;
    ranges.forEach(range => {
        const li = document.createElement('li');
        li.className = 'time-range-item';

        const label = document.createElement('span');
        const isOvernight = (range.endHour * 60 + range.endMinute) <= (range.startHour * 60 + range.startMinute);
        label.textContent = `${formatTime(range.startHour, range.startMinute)} – ${formatTime(range.endHour, range.endMinute)}${isOvernight ? ' (overnight)' : ''} · ${range.limitMinutes} min`;

        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.className = 'remove-btn';
        removeBtn.onclick = () => deleteTimeRange(range.id);

        li.appendChild(label);
        li.appendChild(removeBtn);
        list.appendChild(li);
    });
}

function deleteTimeRange(id) {
    chrome.alarms.clear(`timerange_${id}`);
    chrome.storage.local.get({ timeRanges: [], timeRangeUsage: {} }, (data) => {
        const updated = data.timeRanges.filter(r => r.id !== id);
        const updatedUsage = { ...data.timeRangeUsage };
        delete updatedUsage[id];
        chrome.storage.local.set({ timeRanges: updated, timeRangeUsage: updatedUsage }, () => {
            renderTimeRangeList(updated);
            showStatus('Time range removed.');
        });
    });
}

function updateOvernightHint() {
    const start = document.getElementById('tr-start').value;
    const end = document.getElementById('tr-end').value;
    const show = start && end && end <= start;
    document.getElementById('tr-overnight-hint').style.display = show ? 'block' : 'none';
}

function openTimeRangeModal() {
    document.getElementById('tr-start').value = '';
    document.getElementById('tr-end').value = '';
    document.getElementById('tr-limit').value = '';
    document.getElementById('tr-error').textContent = '';
    document.getElementById('tr-overnight-hint').style.display = 'none';
    document.getElementById('tr-start').oninput = updateOvernightHint;
    document.getElementById('tr-end').oninput = updateOvernightHint;
    document.getElementById('time-range-modal').style.display = 'flex';
}

function closeTimeRangeModal() {
    document.getElementById('time-range-modal').style.display = 'none';
}

function saveTimeRange() {
    const startVal = document.getElementById('tr-start').value;
    const endVal = document.getElementById('tr-end').value;
    const limitVal = parseInt(document.getElementById('tr-limit').value, 10);
    const errorEl = document.getElementById('tr-error');

    if (!startVal || !endVal) {
        errorEl.textContent = 'Please set both start and end times.';
        return;
    }
    if (!limitVal || limitVal <= 0) {
        errorEl.textContent = 'Please enter a positive number of minutes.';
        return;
    }
    if (startVal === endVal) {
        errorEl.textContent = 'Start and end times cannot be the same.';
        return;
    }

    const [startHour, startMinute] = startVal.split(':').map(Number);
    const [endHour, endMinute] = endVal.split(':').map(Number);

    const newRange = {
        id: `tr_${Date.now()}`,
        startHour, startMinute,
        endHour, endMinute,
        limitMinutes: limitVal
    };

    chrome.storage.local.get({ timeRanges: [] }, (data) => {
        const updated = [...data.timeRanges, newRange];
        chrome.storage.local.set({ timeRanges: updated }, () => {
            renderTimeRangeList(updated);
            closeTimeRangeModal();
            showStatus('Time range saved.');
        });
    });
}

// --- Schedule Block Functions ---

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatScheduleBlockDays(days) {
    if (!days || days.length === 0) return 'No days';
    if (days.length === 7) return 'Every day';
    const sorted = [...days].sort((a, b) => a - b);
    return sorted.map(d => DAY_NAMES[d]).join(', ');
}

function renderScheduleBlockList(blocks) {
    const list = document.getElementById('schedule-block-list');
    list.innerHTML = '';
    if (!blocks || blocks.length === 0) return;
    blocks.forEach(block => {
        const li = document.createElement('li');
        li.className = 'time-range-item';

        const label = document.createElement('span');
        const isOvernight = (block.endHour * 60 + block.endMinute) <= (block.startHour * 60 + block.startMinute);
        const startStr = formatTime(block.startHour, block.startMinute);
        const endStr   = formatTime(block.endHour, block.endMinute);
        const daysStr  = formatScheduleBlockDays(block.days);
        label.textContent = `${daysStr} · ${startStr} – ${endStr}${isOvernight ? ' (overnight)' : ''}`;

        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.className = 'remove-btn';
        removeBtn.onclick = () => deleteScheduleBlock(block.id);

        li.appendChild(label);
        li.appendChild(removeBtn);
        list.appendChild(li);
    });
}

function deleteScheduleBlock(id) {
    chrome.storage.local.get({ scheduleBlocks: [] }, (data) => {
        const updated = data.scheduleBlocks.filter(b => b.id !== id);
        chrome.storage.local.set({ scheduleBlocks: updated }, () => {
            renderScheduleBlockList(updated);
            showStatus('Schedule block removed.');
        });
    });
}

function updateSbOvernightHint() {
    const start = document.getElementById('sb-start').value;
    const end   = document.getElementById('sb-end').value;
    const show = start && end && end <= start;
    document.getElementById('sb-overnight-hint').style.display = show ? 'block' : 'none';
}

function openScheduleBlockModal() {
    document.querySelectorAll('.day-cb').forEach(cb => { cb.checked = false; });
    document.getElementById('sb-start').value = '';
    document.getElementById('sb-end').value   = '';
    document.getElementById('sb-error').textContent = '';
    document.getElementById('sb-overnight-hint').style.display = 'none';
    document.getElementById('sb-start').oninput = updateSbOvernightHint;
    document.getElementById('sb-end').oninput   = updateSbOvernightHint;
    document.getElementById('schedule-block-modal').style.display = 'flex';
}

function closeScheduleBlockModal() {
    document.getElementById('schedule-block-modal').style.display = 'none';
}

function saveScheduleBlock() {
    const errorEl  = document.getElementById('sb-error');
    const startVal = document.getElementById('sb-start').value;
    const endVal   = document.getElementById('sb-end').value;
    const days     = Array.from(document.querySelectorAll('.day-cb:checked')).map(cb => parseInt(cb.value, 10));

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

    const [startHour, startMinute] = startVal.split(':').map(Number);
    const [endHour, endMinute]     = endVal.split(':').map(Number);

    const newBlock = {
        id: `sb_${Date.now()}`,
        days,
        startHour, startMinute,
        endHour, endMinute,
    };

    chrome.storage.local.get({ scheduleBlocks: [] }, (data) => {
        const updated = [...data.scheduleBlocks, newBlock];
        chrome.storage.local.set({ scheduleBlocks: updated }, () => {
            renderScheduleBlockList(updated);
            closeScheduleBlockModal();
            showStatus('Schedule block saved.');
        });
    });
}
