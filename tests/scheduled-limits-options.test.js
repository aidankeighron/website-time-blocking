/**
 * @jest-environment jsdom
 */
// Tests for options.js — the merged "Scheduled Limits" modal: day-of-week toggle buttons,
// start/end time inputs (including the PC-Firefox keyboard-input regression, retargeted
// from the old #tr-start/#tr-end), the minutes-allowed field (0 = full block, still valid),
// save/delete, list rendering, and the scheduledLimitsChanged message flow.

const fs = require('fs');
const path = require('path');

function setupChrome(store = {}) {
    global.chrome = {
        storage: {
            local: {
                get: (defaults, cb) => {
                    const result = Object.assign({}, defaults, store);
                    if (cb) { cb(result); return; }
                    return Promise.resolve(result);
                },
                set: (data, cb) => {
                    Object.assign(store, data);
                    if (cb) cb();
                },
            },
        },
        alarms: { clear: jest.fn() },
        runtime: {
            sendMessage: jest.fn((msg, cb) => { if (cb) cb({}); }),
        },
    };
    return store;
}

function loadOptionsPage() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
    document.documentElement.innerHTML = html;

    ['sl-start', 'sl-end'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.showPicker = jest.fn();
    });

    const src = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(src)();
}

// Click a day toggle button by its checkbox value (0=Sun ... 6=Sat).
function clickDay(value) {
    document.querySelector(`.day-cb[value="${value}"]`)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function isDaySelected(value) {
    const cb = document.querySelector(`.day-cb[value="${value}"]`);
    return cb.checked && cb.closest('.day-label').classList.contains('selected');
}

beforeEach(() => {
    setupChrome();
    loadOptionsPage();
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Keyboard input must NOT be blocked on PC (regression coverage)
// ---------------------------------------------------------------------------

test('keydown on sl-start does not prevent default (keyboard input allowed)', () => {
    const el = document.getElementById('sl-start');
    const event = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
});

test('keydown on sl-end does not prevent default (keyboard input allowed)', () => {
    const el = document.getElementById('sl-end');
    const event = new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
});

test('clicking sl-start calls showPicker', () => {
    const el = document.getElementById('sl-start');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.showPicker).toHaveBeenCalled();
});

test('showPicker throwing does not crash the page', () => {
    const el = document.getElementById('sl-start');
    el.showPicker.mockImplementation(() => { throw new DOMException('No user gesture'); });
    expect(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
});

// ---------------------------------------------------------------------------
// Day toggle button interaction
// ---------------------------------------------------------------------------

test('clicking a day button checks it and marks the label selected', () => {
    document.getElementById('add-scheduled-limit-btn').click();
    expect(isDaySelected(1)).toBe(false);

    clickDay(1); // Mon

    expect(isDaySelected(1)).toBe(true);
});

test('clicking a selected day button again unchecks it and removes selected', () => {
    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(1);
    expect(isDaySelected(1)).toBe(true);

    clickDay(1);

    expect(isDaySelected(1)).toBe(false);
});

test('opening the modal resets all day buttons to unchecked/unselected', () => {
    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(1);
    clickDay(3);
    expect(isDaySelected(1)).toBe(true);
    expect(isDaySelected(3)).toBe(true);

    document.getElementById('sl-cancel-btn').click();
    document.getElementById('add-scheduled-limit-btn').click();

    for (let d = 0; d <= 6; d++) {
        expect(isDaySelected(d)).toBe(false);
    }
});

// ---------------------------------------------------------------------------
// saveScheduledLimit validation
// ---------------------------------------------------------------------------

test('rejects when no day is selected', () => {
    document.getElementById('add-scheduled-limit-btn').click();
    document.getElementById('sl-start').value = '09:00';
    document.getElementById('sl-end').value = '17:00';
    document.getElementById('sl-limit').value = '30';

    document.getElementById('sl-save-btn').click();

    expect(document.getElementById('sl-error').textContent).toMatch(/at least one day/i);
});

test('rejects missing start/end times', () => {
    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(1);
    document.getElementById('sl-start').value = '';
    document.getElementById('sl-end').value = '17:00';
    document.getElementById('sl-limit').value = '30';

    document.getElementById('sl-save-btn').click();

    expect(document.getElementById('sl-error').textContent).toMatch(/start and end/i);
});

test('rejects identical start and end times', () => {
    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(1);
    document.getElementById('sl-start').value = '09:00';
    document.getElementById('sl-end').value = '09:00';
    document.getElementById('sl-limit').value = '30';

    document.getElementById('sl-save-btn').click();

    expect(document.getElementById('sl-error').textContent).toMatch(/same/i);
});

test('rejects a negative minutes value', () => {
    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(1);
    document.getElementById('sl-start').value = '09:00';
    document.getElementById('sl-end').value = '17:00';
    document.getElementById('sl-limit').value = '-5';

    document.getElementById('sl-save-btn').click();

    expect(document.getElementById('sl-error').textContent).toMatch(/0 or more/i);
});

test('rejects an empty (non-numeric) minutes value', () => {
    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(1);
    document.getElementById('sl-start').value = '09:00';
    document.getElementById('sl-end').value = '17:00';
    document.getElementById('sl-limit').value = '';

    document.getElementById('sl-save-btn').click();

    expect(document.getElementById('sl-error').textContent).toMatch(/0 or more/i);
});

test('0 minutes is a VALID value (full block) — no validation error', done => {
    const store = {};
    setupChrome(store);
    loadOptionsPage();

    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(1);
    document.getElementById('sl-start').value = '09:00';
    document.getElementById('sl-end').value = '17:00';
    document.getElementById('sl-limit').value = '0';

    document.getElementById('sl-save-btn').click();

    setTimeout(() => {
        expect(document.getElementById('sl-error').textContent).toBe('');
        expect(store.scheduledLimits[0].limitMinutes).toBe(0);
        done();
    }, 0);
});

// ---------------------------------------------------------------------------
// saveScheduledLimit happy path — via real button clicks
// ---------------------------------------------------------------------------

test('saves the days clicked via the toggle buttons + minutes to storage, and notifies background', done => {
    const store = {};
    setupChrome(store);
    loadOptionsPage();

    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(1); // Mon
    clickDay(3); // Wed
    clickDay(5); // Fri
    document.getElementById('sl-start').value = '09:00';
    document.getElementById('sl-end').value = '17:00';
    document.getElementById('sl-limit').value = '45';

    document.getElementById('sl-save-btn').click();

    setTimeout(() => {
        expect(store.scheduledLimits).toBeDefined();
        expect(store.scheduledLimits.length).toBe(1);
        const entry = store.scheduledLimits[0];
        expect(entry.days.slice().sort((a, b) => a - b)).toEqual([1, 3, 5]);
        expect(entry.startHour).toBe(9);
        expect(entry.startMinute).toBe(0);
        expect(entry.endHour).toBe(17);
        expect(entry.endMinute).toBe(0);
        expect(entry.limitMinutes).toBe(45);

        expect(document.getElementById('scheduled-limit-modal').style.display).toBe('none');
        expect(document.getElementById('scheduled-limit-list').textContent).toMatch(/Mon, Wed, Fri/);
        expect(document.getElementById('scheduled-limit-list').textContent).toMatch(/45 min/);

        expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'scheduledLimitsChanged' });
        done();
    }, 0);
});

test('a full-block (0 minute) entry renders as "Full block" in the list', done => {
    const store = {};
    setupChrome(store);
    loadOptionsPage();

    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(0);
    document.getElementById('sl-start').value = '22:00';
    document.getElementById('sl-end').value = '06:00';
    document.getElementById('sl-limit').value = '0';
    document.getElementById('sl-save-btn').click();

    setTimeout(() => {
        expect(document.getElementById('scheduled-limit-list').textContent).toMatch(/Full block/);
        done();
    }, 0);
});

test('saved entry can be removed via the list Remove button and notifies background', done => {
    const store = {};
    setupChrome(store);
    loadOptionsPage();

    document.getElementById('add-scheduled-limit-btn').click();
    clickDay(2); // Tue
    document.getElementById('sl-start').value = '08:00';
    document.getElementById('sl-end').value = '10:00';
    document.getElementById('sl-limit').value = '15';
    document.getElementById('sl-save-btn').click();

    setTimeout(() => {
        expect(store.scheduledLimits.length).toBe(1);
        global.chrome.runtime.sendMessage.mockClear();

        document.querySelector('#scheduled-limit-list .remove-btn').click();

        setTimeout(() => {
            expect(store.scheduledLimits.length).toBe(0);
            expect(document.getElementById('scheduled-limit-list').textContent.trim()).toBe('');
            expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'scheduledLimitsChanged' });
            done();
        }, 0);
    }, 0);
});

// ---------------------------------------------------------------------------
// restoreOptions reads storage directly (no migration system anymore)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// addSite domain normalization
// ---------------------------------------------------------------------------
// Regression test: options.js's own getDomain used to only strip "www." while background.js/
// prompt.js strip "www./m./mobile." when matching a real navigation's hostname — a site added
// here as "m.youtube.com" was saved verbatim and could then never match anything, since real
// traffic always normalizes down to "youtube.com" before comparison.

test('Adding "m.youtube.com" normalizes to "youtube.com", matching what background.js matches against', () => {
    document.getElementById('new-site').value = 'm.youtube.com';
    document.getElementById('add-site').click();

    const sites = Array.from(document.querySelectorAll('#site-list li')).map(li => li.childNodes[0].textContent);
    expect(sites).toContain('youtube.com');
    expect(sites).not.toContain('m.youtube.com');
});

test('Adding "mobile.twitter.com" normalizes to "twitter.com"', () => {
    document.getElementById('new-site').value = 'mobile.twitter.com';
    document.getElementById('add-site').click();

    const sites = Array.from(document.querySelectorAll('#site-list li')).map(li => li.childNodes[0].textContent);
    expect(sites).toContain('twitter.com');
});

// ---------------------------------------------------------------------------
// saveOptions numeric field validation
// ---------------------------------------------------------------------------
// Regression test: clearing a numeric settings field before saving used to persist NaN
// (parseInt('') is NaN with no fallback), silently breaking every downstream
// `value * 60 * 1000` computation for that setting.

test('Clearing a numeric settings field before saving falls back to its default instead of persisting NaN', done => {
    const store = {};
    setupChrome(store);
    loadOptionsPage();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    document.getElementById('duration-cooldown').value = '';
    document.getElementById('count-cooldown').value = '';
    document.getElementById('input-delay').value = '';
    document.getElementById('extension-duration').value = '';
    document.getElementById('save-config').click();

    setTimeout(() => {
        expect(store.durationCooldown).toBe(30);
        expect(store.countCooldown).toBe(30);
        expect(store.inputDelay).toBe(0);
        expect(store.extensionDuration).toBe(30);
        expect(Number.isNaN(store.durationCooldown)).toBe(false);
        done();
    }, 0);
});

// ---------------------------------------------------------------------------
// Editing a scheduled limit whose Half-Full pattern is no longer locally known
// ---------------------------------------------------------------------------
// Regression test: openScheduledLimitModal populates the pattern dropdown from the LOCAL
// halfFullPatterns cache. If the entry's own halfFullPattern.id isn't in that cache (deleted in
// Half Full since this limit was created, or simply not fetched yet), the dropdown silently
// fell back to "Always active" — and saving (even to change something unrelated, like the time)
// persisted that as if the user had deliberately removed the condition.

test('Editing an entry whose halfFullPattern is not in the local pattern cache preserves it on save', done => {
    const store = {
        halfFullAuth: { email: 'a@b.com', uid: 'u1' },
        // Note: halfFullPatterns does NOT contain 'p1' (deleted, or not-yet-fetched race).
        halfFullPatterns: [{ id: 'p2', pattern: 'chores', type: 'any', color: 'blue' }],
        scheduledLimits: [{
            id: 'sl_1', days: [1], startHour: 9, startMinute: 0, endHour: 17, endMinute: 0,
            limitMinutes: 30, createdAt: 12345,
            halfFullPattern: { id: 'p1', pattern: 'homework', type: 'contains', color: 'purple' },
        }],
    };
    setupChrome(store);
    loadOptionsPage();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    document.querySelector('#scheduled-limit-list .btn-secondary').click(); // "Edit" button

    setTimeout(() => {
        // The stale pattern must still be selected in the dropdown, not silently reset.
        const select = document.getElementById('sl-hf-pattern');
        expect(select.value).toBe('p1');

        // User saves without touching the pattern dropdown (e.g. only wanted to tweak the time).
        document.getElementById('sl-save-btn').click();

        setTimeout(() => {
            const saved = store.scheduledLimits[0];
            expect(saved.halfFullPattern).toEqual({ id: 'p1', pattern: 'homework', type: 'contains', color: 'purple' });
            done();
        }, 0);
    }, 0);
});

test('restoreOptions reads scheduledLimits directly from storage with no sendMessage call', () => {
    const store = { scheduledLimits: [{ id: 'sl_1', days: [1], startHour: 9, startMinute: 0, endHour: 10, endMinute: 0, limitMinutes: 20 }] };
    setupChrome(store);
    loadOptionsPage();

    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById('scheduled-limit-list').textContent).toMatch(/20 min/);
});
