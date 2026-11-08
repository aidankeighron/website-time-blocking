/**
 * @jest-environment jsdom
 */
// Settings page: the Reminders section (switch, prefilled examples, tag chips, Save button).
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
    $('reminders-enabled').checked = on;
    $('reminders-enabled').dispatchEvent(new Event('change'));
}

test('off by default, editor hidden', () => {
    setup();
    expect($('reminders-enabled').checked).toBe(false);
    expect($('reminders-editor').hidden).toBe(true);
});

test('first switch-on prefills the examples and saves them', () => {
    setup();
    toggle(true);
    expect($('reminders-editor').hidden).toBe(false);
    expect($('reminders-text').value).toBe(globalThis.WTBReminders.DEFAULT_REMINDERS.join('\n'));
    expect(store.remindersEnabled).toBe(true);
    expect(store.reminders).toEqual(globalThis.WTBReminders.DEFAULT_REMINDERS);
});

test('switching on again keeps the user\'s own list', () => {
    setup({ remindersEnabled: false, reminders: ['mine'] });
    toggle(true);
    expect($('reminders-text').value).toBe('mine');
    expect(store.reminders).toEqual(['mine']);
});

test('switching off saves immediately and hides the editor', () => {
    setup({ remindersEnabled: true, reminders: ['mine'] });
    toggle(false);
    expect(store.remindersEnabled).toBe(false);
    expect($('reminders-editor').hidden).toBe(true);
});

test('edits are only stored on Save, blank lines dropped, deck reset', () => {
    setup({ remindersEnabled: true, reminders: ['old'], reminderDeck: ['old'] });
    $('reminders-text').value = 'one\n\n  two  \n';
    $('reminders-text').dispatchEvent(new Event('input'));
    expect($('reminders-dirty').hidden).toBe(false);
    expect(store.reminders).toEqual(['old']);
    $('save-reminders').click();
    expect(store.reminders).toEqual(['one', 'two']);
    expect(store.reminderDeck).toEqual([]);
    expect($('reminders-dirty').hidden).toBe(true);
});

test('tag chip inserts its tag at the caret', () => {
    setup({ remindersEnabled: true, reminders: [] });
    const ta = $('reminders-text');
    ta.value = 'Hi  there';
    ta.setSelectionRange(3, 3);
    document.querySelector('.tag-chip[data-tag="{site}"]').click();
    expect(ta.value).toBe('Hi {site} there');
});
