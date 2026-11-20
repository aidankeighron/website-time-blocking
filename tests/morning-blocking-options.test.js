/**
 * @jest-environment jsdom
 */
// Settings page: the Morning Blocking section (switch, wait minutes, end time, Save button).
const fs = require('fs');
const path = require('path');

let store;
function setup(initial = {}) {
    store = { ...initial };
    global.chrome = {
        storage: { local: {
            get: (defaults, cb) => { const r = Object.assign({}, defaults, store); if (cb) { cb(r); return; } return Promise.resolve(r); },
            set: (data, cb) => { Object.assign(store, data); if (cb) cb(); },
        } },
        runtime: { sendMessage: jest.fn((m, cb) => { if (cb) cb({}); }) },
    };
    document.documentElement.innerHTML = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(path.join(__dirname, '..', 'reminders.js'), 'utf8'))();
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8'))();
    document.dispatchEvent(new Event('DOMContentLoaded'));
}

const $ = id => document.getElementById(id);
function toggle(on) {
    $('morning-enabled').checked = on;
    $('morning-enabled').dispatchEvent(new Event('change'));
}
function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('off by default with 30 min / 11:00 defaults, editor hidden', () => {
    setup();
    expect($('morning-enabled').checked).toBe(false);
    expect($('morning-editor').hidden).toBe(true);
    expect($('morning-minutes').value).toBe('30');
    expect($('morning-end').value).toBe('11:00');
});

test('restores saved settings', () => {
    setup({ morningBlockEnabled: true, morningBlockMinutes: 45, morningBlockEndHour: 9, morningBlockEndMinute: 5 });
    expect($('morning-enabled').checked).toBe(true);
    expect($('morning-editor').hidden).toBe(false);
    expect($('morning-minutes').value).toBe('45');
    expect($('morning-end').value).toBe('09:05');
});

test('switching on saves right away and counts today as already started', () => {
    setup();
    toggle(true);
    expect($('morning-editor').hidden).toBe(false);
    expect(store.morningBlockEnabled).toBe(true);
    expect(store.morningBlock).toEqual({ dateKey: todayKey(), startTime: null });
});

test('switching on keeps a block already running today', () => {
    const running = { dateKey: todayKey(), startTime: Date.now() - 60000 };
    setup({ morningBlock: running });
    toggle(true);
    expect(store.morningBlock).toEqual(running);
});

test('switching off saves immediately and hides the editor', () => {
    setup({ morningBlockEnabled: true });
    toggle(false);
    expect(store.morningBlockEnabled).toBe(false);
    expect($('morning-editor').hidden).toBe(true);
});

test('save stores minutes and end time; bad values fall back or are clamped', () => {
    setup({ morningBlockEnabled: true });
    $('morning-minutes').value = '20';
    $('morning-end').value = '10:15';
    $('save-morning').click();
    expect(store).toMatchObject({ morningBlockMinutes: 20, morningBlockEndHour: 10, morningBlockEndMinute: 15 });

    $('morning-minutes').value = '99999';
    $('morning-end').value = '';
    $('save-morning').click();
    expect(store).toMatchObject({ morningBlockMinutes: 1440, morningBlockEndHour: 11, morningBlockEndMinute: 0 });
    expect($('morning-end').value).toBe('11:00');

    $('morning-minutes').value = '0';
    $('save-morning').click();
    expect(store.morningBlockMinutes).toBe(1);
});

test('input delay defaults to 5 seconds', () => {
    setup();
    expect($('input-delay').value).toBe('5');
});
