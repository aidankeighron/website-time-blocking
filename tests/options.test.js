/**
 * @jest-environment jsdom
 */
// Tests for options.js — time range modal behaviour.
// Covers the PC Firefox regression where keydown preventDefault blocked keyboard
// input on the tr-start / tr-end time inputs.

const fs = require('fs');
const path = require('path');

// Minimal chrome stub for the options page
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
    };
    return store;
}

function loadOptionsPage() {
    // Load the HTML structure
    const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
    document.documentElement.innerHTML = html;

    // Mock showPicker — jsdom does not implement it
    ['tr-start', 'tr-end'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.showPicker = jest.fn();
    });

    // Load options.js — re-evaluate in this document context
    const src = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(src)();
}

beforeEach(() => {
    setupChrome();
    loadOptionsPage();
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Keyboard input must NOT be blocked on PC
// ---------------------------------------------------------------------------

test('keydown on tr-start does not prevent default (keyboard input allowed)', () => {
    const el = document.getElementById('tr-start');
    const event = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
});

test('keydown on tr-end does not prevent default (keyboard input allowed)', () => {
    const el = document.getElementById('tr-end');
    const event = new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
});

// ---------------------------------------------------------------------------
// showPicker still attempted on click
// ---------------------------------------------------------------------------

test('clicking tr-start calls showPicker', () => {
    const el = document.getElementById('tr-start');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.showPicker).toHaveBeenCalled();
});

test('showPicker throwing does not crash the page', () => {
    const el = document.getElementById('tr-start');
    el.showPicker.mockImplementation(() => { throw new DOMException('No user gesture'); });
    expect(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
});

// ---------------------------------------------------------------------------
// Time range save / validation
// ---------------------------------------------------------------------------

test('saveTimeRange rejects empty start time', () => {
    // Open modal so the elements are in a known state
    document.getElementById('add-time-range-btn').click();
    document.getElementById('tr-start').value = '';
    document.getElementById('tr-end').value = '10:00';
    document.getElementById('tr-limit').value = '30';

    document.getElementById('tr-save-btn').click();

    expect(document.getElementById('tr-error').textContent).toMatch(/start and end/i);
});

test('saveTimeRange rejects empty end time', () => {
    document.getElementById('add-time-range-btn').click();
    document.getElementById('tr-start').value = '09:00';
    document.getElementById('tr-end').value = '';
    document.getElementById('tr-limit').value = '30';

    document.getElementById('tr-save-btn').click();

    expect(document.getElementById('tr-error').textContent).toMatch(/start and end/i);
});

test('saveTimeRange rejects identical start and end', () => {
    document.getElementById('add-time-range-btn').click();
    document.getElementById('tr-start').value = '09:00';
    document.getElementById('tr-end').value = '09:00';
    document.getElementById('tr-limit').value = '30';

    document.getElementById('tr-save-btn').click();

    expect(document.getElementById('tr-error').textContent).toMatch(/same/i);
});

test('saveTimeRange rejects zero limit', () => {
    document.getElementById('add-time-range-btn').click();
    document.getElementById('tr-start').value = '09:00';
    document.getElementById('tr-end').value = '11:00';
    document.getElementById('tr-limit').value = '0';

    document.getElementById('tr-save-btn').click();

    expect(document.getElementById('tr-error').textContent).toMatch(/positive/i);
});

test('saveTimeRange saves valid range to chrome storage', done => {
    const store = {};
    setupChrome(store);
    loadOptionsPage();

    document.getElementById('add-time-range-btn').click();
    document.getElementById('tr-start').value = '09:00';
    document.getElementById('tr-end').value = '17:00';
    document.getElementById('tr-limit').value = '45';

    document.getElementById('tr-save-btn').click();

    // chrome.storage.local.set is synchronous in the mock, but options.js
    // reads first and then sets; give microtasks a tick to flush.
    setTimeout(() => {
        expect(store.timeRanges).toBeDefined();
        expect(store.timeRanges.length).toBe(1);
        const r = store.timeRanges[0];
        expect(r.startHour).toBe(9);
        expect(r.startMinute).toBe(0);
        expect(r.endHour).toBe(17);
        expect(r.endMinute).toBe(0);
        expect(r.limitMinutes).toBe(45);
        done();
    }, 0);
});
