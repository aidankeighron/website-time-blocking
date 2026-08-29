document.addEventListener('DOMContentLoaded', () => {
    restoreOptions();
    initHalfFull();
});
document.getElementById('add-site').addEventListener('click', addSite);
document.getElementById('save-config').addEventListener('click', saveOptions);
document.getElementById('add-scheduled-limit-btn').addEventListener('click', () => openScheduledLimitModal(null));
document.getElementById('sl-save-btn').addEventListener('click', saveScheduledLimit);
document.getElementById('sl-cancel-btn').addEventListener('click', closeScheduledLimitModal);
document.getElementById('hf-login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    halfFullSignIn();
});
document.getElementById('hf-logout-btn').addEventListener('click', halfFullSignOut);
document.getElementById('hf-info-btn').addEventListener('click', () => {
    document.getElementById('hf-info-modal').style.display = 'flex';
});
document.getElementById('hf-info-close-btn').addEventListener('click', () => {
    document.getElementById('hf-info-modal').style.display = 'none';
});

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

// Track which entry is being edited (null = new entry)
let editingLimitId = null;

function getDomain(url) {
    try {
        if (!url.startsWith('http')) url = 'https://' + url;
        const hostname = new URL(url).hostname;
        return hostname.replace(/^www\./, '');
    } catch (e) {
        return null;
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
    removeBtn.onclick = () => { li.remove(); saveOptions(); };
    li.appendChild(removeBtn);
    list.appendChild(li);
}

function addSite() {
    const input = document.getElementById('new-site');
    const domain = getDomain(input.value);
    if (domain) {
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
    chrome.storage.local.set({ targetSites, durationCooldown, countCooldown, inputDelay, extensionDuration }, () => {
        showStatus('Settings saved.');
    });
}

function showStatus(msg, type = 'success') {
    const status = document.getElementById('status');
    status.textContent = msg;
    status.className = type;
    setTimeout(() => { status.textContent = ''; status.className = ''; }, 2000);
}

// --- Scheduled Limit Functions ---

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Half Full pattern color → background chip color. Darkened/adjusted from half-full-desktop's
// raw brand hues so white text on top always clears WCAG AA (4.5:1) — the original hex values
// (e.g. purple #7036E2, darkPurple #3B00B2, blue #0060E5) are too light/saturated to read as
// plain text on this app's dark backgrounds, so pattern colors are rendered as solid chips
// (colored background + white text) instead, verified to clear >=4.5:1 individually.
const HF_PATTERN_COLORS = {
    red: '#a51d1d', yellow: '#7f6c0a', green: '#1b7e1b', purple: '#5a23c7',
    orange: '#9b6508', darkPurple: '#330a7b', blue: '#0b5bcb', default: '#5c5c5c',
};

function hfPatternColor(colorName) {
    return HF_PATTERN_COLORS[colorName] || HF_PATTERN_COLORS.default;
}

function formatTime(hour, minute) {
    const period = hour >= 12 ? 'PM' : 'AM';
    const h = hour % 12 || 12;
    return `${h}:${String(minute).padStart(2, '0')} ${period}`;
}

function formatScheduledLimitDays(days) {
    if (!days || days.length === 0) return 'No days';
    if (days.length === 7) return 'Every day';
    return [...days].sort((a, b) => a - b).map(d => DAY_NAMES[d]).join(', ');
}

function renderScheduledLimitList(entries) {
    const list = document.getElementById('scheduled-limit-list');
    list.innerHTML = '';
    if (!entries || entries.length === 0) return;
    entries.forEach(entry => {
        const li = document.createElement('li');
        li.className = 'time-range-item';

        const labelWrap = document.createElement('div');
        labelWrap.className = 'time-range-label-wrap';

        const label = document.createElement('span');
        const isOvernight = (entry.endHour * 60 + entry.endMinute) <= (entry.startHour * 60 + entry.startMinute);
        const startStr = formatTime(entry.startHour, entry.startMinute);
        const endStr   = formatTime(entry.endHour, entry.endMinute);
        const daysStr  = formatScheduledLimitDays(entry.days);
        const limitStr = entry.limitMinutes === 0 ? 'Full block' : `${entry.limitMinutes} min`;
        label.textContent = `${daysStr} · ${startStr} – ${endStr}${isOvernight ? ' (overnight)' : ''} · ${limitStr}`;
        labelWrap.appendChild(label);

        if (entry.halfFullPattern) {
            const patBadge = document.createElement('span');
            patBadge.className = 'hf-pattern-badge';
            patBadge.style.backgroundColor = hfPatternColor(entry.halfFullPattern.color);
            patBadge.style.color = '#fff';
            patBadge.textContent = `⊕ if "${entry.halfFullPattern.pattern}"`;
            patBadge.title = `Only active when tasks matching "${entry.halfFullPattern.pattern}" are incomplete`;
            labelWrap.appendChild(patBadge);
        }

        li.appendChild(labelWrap);

        const btnWrap = document.createElement('div');
        btnWrap.className = 'time-range-btn-wrap';

        const editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.className = 'btn-secondary';
        editBtn.onclick = () => openScheduledLimitModal(entry);

        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.className = 'remove-btn';
        removeBtn.onclick = () => deleteScheduledLimit(entry.id);

        btnWrap.appendChild(editBtn);
        btnWrap.appendChild(removeBtn);
        li.appendChild(btnWrap);
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

// Populate the Half Full pattern dropdown from stored patterns.
function populatePatternDropdown(selectedPatternId = '') {
    chrome.storage.local.get({ halfFullPatterns: [], halfFullAuth: null }, (data) => {
        const select = document.getElementById('sl-hf-pattern');
        const hint   = document.getElementById('sl-hf-pattern-hint');

        // Clear all options except the "no condition" placeholder
        select.innerHTML = '<option value="">Always active</option>';

        if (!data.halfFullAuth) {
            hint.style.display = 'block';
            hint.textContent = 'Connect your Half Full account below to add pattern-based conditions.';
            return;
        }

        hint.style.display = 'block';
        hint.textContent = 'This limit only applies when you have incomplete tasks matching the selected pattern today.';

        (data.halfFullPatterns || []).forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            // Show the pattern keyword and its match type in the dropdown
            const typeLabel = p.type === 'start' ? 'starts with' : p.type === 'end' ? 'ends with' : 'contains';
            opt.textContent = `${p.pattern}  (${typeLabel})`;
            opt.style.backgroundColor = hfPatternColor(p.color);
            opt.style.color = '#fff';
            if (p.id === selectedPatternId) opt.selected = true;
            select.appendChild(opt);
        });
    });
}

function openScheduledLimitModal(existingEntry) {
    editingLimitId = existingEntry ? existingEntry.id : null;
    document.getElementById('sl-modal-title').textContent = existingEntry ? 'Edit Scheduled Limit' : 'New Scheduled Limit';

    document.querySelectorAll('.day-cb').forEach(cb => {
        const checked = existingEntry ? existingEntry.days.includes(parseInt(cb.value, 10)) : false;
        cb.checked = checked;
        cb.closest('.day-label').classList.toggle('selected', checked);
    });

    document.getElementById('sl-start').value = existingEntry
        ? `${String(existingEntry.startHour).padStart(2,'0')}:${String(existingEntry.startMinute).padStart(2,'0')}`
        : '';
    document.getElementById('sl-end').value = existingEntry
        ? `${String(existingEntry.endHour).padStart(2,'0')}:${String(existingEntry.endMinute).padStart(2,'0')}`
        : '';
    document.getElementById('sl-limit').value = existingEntry ? existingEntry.limitMinutes : '';
    document.getElementById('sl-error').textContent = '';
    document.getElementById('sl-overnight-hint').style.display = 'none';
    document.getElementById('sl-start').oninput = updateSlOvernightHint;
    document.getElementById('sl-end').oninput   = updateSlOvernightHint;

    const selectedPatternId = existingEntry && existingEntry.halfFullPattern ? existingEntry.halfFullPattern.id : '';
    populatePatternDropdown(selectedPatternId);

    document.getElementById('scheduled-limit-modal').style.display = 'flex';
}

function closeScheduledLimitModal() {
    editingLimitId = null;
    document.getElementById('scheduled-limit-modal').style.display = 'none';
}

function saveScheduledLimit() {
    const errorEl  = document.getElementById('sl-error');
    const startVal = document.getElementById('sl-start').value;
    const endVal   = document.getElementById('sl-end').value;
    const days     = Array.from(document.querySelectorAll('.day-cb:checked')).map(cb => parseInt(cb.value, 10));
    const limitVal = parseInt(document.getElementById('sl-limit').value, 10);
    const selectedPatternId = document.getElementById('sl-hf-pattern').value;

    if (days.length === 0) { errorEl.textContent = 'Please select at least one day.'; return; }
    if (!startVal || !endVal) { errorEl.textContent = 'Please set both start and end times.'; return; }
    if (startVal === endVal) { errorEl.textContent = 'Start and end times cannot be the same.'; return; }
    if (!Number.isInteger(limitVal) || limitVal < 0) {
        errorEl.textContent = 'Please enter minutes allowed (0 or more: 0 means a full block).';
        return;
    }

    const [startHour, startMinute] = startVal.split(':').map(Number);
    const [endHour, endMinute]     = endVal.split(':').map(Number);

    chrome.storage.local.get({ scheduledLimits: [], halfFullPatterns: [] }, (data) => {
        // Build the halfFullPattern field from the selected pattern
        let halfFullPattern = null;
        if (selectedPatternId) {
            const pat = data.halfFullPatterns.find(p => p.id === selectedPatternId);
            if (pat) {
                halfFullPattern = { id: pat.id, pattern: pat.pattern, type: pat.type, color: pat.color };
            }
        }

        if (editingLimitId) {
            // Update existing entry (preserve id and createdAt)
            const updated = data.scheduledLimits.map(e => {
                if (e.id !== editingLimitId) return e;
                return { ...e, days, startHour, startMinute, endHour, endMinute, limitMinutes: limitVal, halfFullPattern };
            });
            chrome.storage.local.set({ scheduledLimits: updated }, () => {
                renderScheduledLimitList(updated);
                closeScheduledLimitModal();
                showStatus('Scheduled limit updated.');
                chrome.runtime.sendMessage({ action: 'scheduledLimitsChanged' });
            });
        } else {
            const newEntry = {
                id: `sl_${Date.now()}`,
                days, startHour, startMinute, endHour, endMinute,
                limitMinutes: limitVal,
                createdAt: Date.now(),
                halfFullPattern,
            };
            const updated = [...data.scheduledLimits, newEntry];
            chrome.storage.local.set({ scheduledLimits: updated }, () => {
                renderScheduledLimitList(updated);
                closeScheduledLimitModal();
                showStatus('Scheduled limit saved.');
                chrome.runtime.sendMessage({ action: 'scheduledLimitsChanged' });
            });
        }
    });
}

// --- Half Full Integration ---

const HF_API_KEY = 'AIzaSyAFllak-Mt7RTf0hFInUMR8-25PeaiHE34';
const HF_PROJECT_ID = 'alchemy-a816c';

function initHalfFull() {
    chrome.storage.local.get({ halfFullAuth: null }, (data) => {
        if (data.halfFullAuth && data.halfFullAuth.email) {
            showHalfFullLoggedIn(data.halfFullAuth.email);
            refreshHalfFullPatterns(data.halfFullAuth);
        } else {
            showHalfFullLoggedOut();
        }
    });
}

function showHalfFullLoggedIn(email) {
    document.getElementById('hf-logged-out').style.display = 'none';
    document.getElementById('hf-logged-in').style.display = 'block';
    document.getElementById('hf-user-label').textContent = `Signed in as ${email}`;
}

function showHalfFullLoggedOut() {
    document.getElementById('hf-logged-in').style.display = 'none';
    document.getElementById('hf-logged-out').style.display = 'block';
}

async function halfFullSignIn() {
    const email    = document.getElementById('hf-email').value.trim();
    const password = document.getElementById('hf-password').value;
    const errorEl  = document.getElementById('hf-login-error');
    const btn      = document.getElementById('hf-login-btn');
    errorEl.textContent = '';
    if (!email || !password) { errorEl.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
        const resp = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${HF_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, returnSecureToken: true }),
            }
        );
        const result = await resp.json();
        if (!resp.ok) {
            const msg = result.error && result.error.message;
            errorEl.textContent = msg === 'INVALID_LOGIN_CREDENTIALS'
                ? 'Incorrect email or password.' : (msg || 'Sign-in failed.');
            return;
        }
        const auth = {
            email,
            idToken: result.idToken,
            refreshToken: result.refreshToken,
            uid: result.localId,
            expiresAt: Date.now() + parseInt(result.expiresIn, 10) * 1000,
        };
        await chrome.storage.local.set({ halfFullAuth: auth });
        chrome.runtime.sendMessage({ action: 'halfFullAuthChanged' });
        showHalfFullLoggedIn(email);
        document.getElementById('hf-password').value = '';
        await refreshHalfFullPatterns(auth);
        showStatus('Signed in to Half Full.');
    } catch (err) {
        errorEl.textContent = 'Network error. Check your connection.';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In with Half Full';
    }
}

async function halfFullSignOut() {
    await chrome.storage.local.remove(['halfFullAuth', 'halfFullPatterns', 'halfFullTaskCache']);
    chrome.runtime.sendMessage({ action: 'halfFullAuthChanged' });
    showHalfFullLoggedOut();
    showStatus('Signed out of Half Full.');
}

// Fetch patterns from Firestore and store them locally for dropdown use.
async function refreshHalfFullPatterns(auth) {
    if (!auth || !auth.uid || !auth.idToken) return;
    // Refresh token if close to expiry
    let token = auth.idToken;
    if (auth.expiresAt && Date.now() > auth.expiresAt - 60000) {
        try {
            const resp = await fetch(
                `https://securetoken.googleapis.com/v1/token?key=${HF_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
                }
            );
            if (resp.ok) {
                const r = await resp.json();
                const updated = { ...auth, idToken: r.id_token, refreshToken: r.refresh_token,
                    uid: r.user_id, expiresAt: Date.now() + parseInt(r.expires_in, 10) * 1000 };
                await chrome.storage.local.set({ halfFullAuth: updated });
                token = updated.idToken;
            }
        } catch { /* use existing token */ }
    }

    try {
        const url = `https://firestore.googleapis.com/v1/projects/${HF_PROJECT_ID}/databases/(default)/documents/users/${auth.uid}/pattern`;
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!resp.ok) return;
        const data = await resp.json();
        const docs = data.documents || [];
        const patterns = docs.map(doc => {
            const f = doc.fields || {};
            const id = doc.name.split('/').pop();
            return {
                id,
                pattern: f.pattern && f.pattern.stringValue || '',
                type: f.type && f.type.stringValue || 'any',
                color: f.color && f.color.stringValue || 'default',
                uuid: f.uuid && f.uuid.stringValue || id,
                visible: f.visible ? f.visible.booleanValue : true,
            };
        }).filter(p => p.pattern);
        await chrome.storage.local.set({ halfFullPatterns: patterns });
    } catch { /* silently fail */ }
}
