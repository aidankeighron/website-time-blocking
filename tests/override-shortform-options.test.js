/**
 * @jest-environment jsdom
 */
// Settings page: the Emergency Override section (switch, Emergency/Extend choice, numbers) and
// the Block Short-Form Content switches.
const fs = require('fs');
const path = require('path');

let store;
function setup(initial = {}) {
    store = { ...initial };
    const pick = (keys) => {
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]]));
        return Object.assign({}, keys, store);
    };
    global.chrome = {
        storage: { local: {
            get: (keys, cb) => { const r = pick(keys); if (cb) { cb(r); return; } return Promise.resolve(r); },
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
function flip(el, checked) { el.checked = checked; el.dispatchEvent(new Event('change')); }

describe('Emergency Override', () => {
    test('new user: off, Emergency passes preselected with 2 x 5 min', () => {
        setup({ overrideEnabled: false, overrideType: 'emergency' });
        expect($('override-enabled').checked).toBe(false);
        expect($('override-editor').hidden).toBe(true);
        expect($('override-type-emergency').checked).toBe(true);
        expect($('emergency-per-week').value).toBe('2');
        expect($('emergency-minutes').value).toBe('5');
        expect($('override-extend-fields').hidden).toBe(true);
    });

    test('migrated Extend user sees Extend with their seconds', () => {
        setup({ overrideEnabled: true, overrideType: 'extend', extensionDuration: 45 });
        expect($('override-enabled').checked).toBe(true);
        expect($('override-type-extend').checked).toBe(true);
        expect($('extension-duration').value).toBe('45');
        expect($('override-emergency-fields').hidden).toBe(true);
        expect($('override-extend-fields').hidden).toBe(false);
    });

    test('not migrated yet: the old Extension Duration decides', () => {
        setup({ extensionDuration: 20 });
        expect($('override-enabled').checked).toBe(true);
        expect($('override-type-extend').checked).toBe(true);
        setup({ extensionDuration: 0 });
        expect($('override-enabled').checked).toBe(false);
    });

    test('the switch and the kind save immediately', () => {
        setup({ overrideEnabled: false, overrideType: 'emergency' });
        flip($('override-enabled'), true);
        expect(store).toMatchObject({ overrideEnabled: true, overrideType: 'emergency' });
        expect($('override-editor').hidden).toBe(false);
        flip($('override-type-extend'), true);
        expect(store.overrideType).toBe('extend');
        expect($('override-extend-fields').hidden).toBe(false);
        flip($('override-enabled'), false);
        expect(store.overrideEnabled).toBe(false);
    });

    test('Save stores the numbers, clamped', () => {
        setup({ overrideEnabled: true, overrideType: 'emergency' });
        $('emergency-per-week').value = '3';
        $('emergency-minutes').value = '10';
        $('extension-duration').value = '0';
        $('save-override').click();
        expect(store).toMatchObject({ emergencyOverridesPerWeek: 3, emergencyOverrideMinutes: 10, extensionDuration: 1 });
        $('emergency-per-week').value = '999';
        $('emergency-minutes').value = '';
        $('save-override').click();
        expect(store).toMatchObject({ emergencyOverridesPerWeek: 100, emergencyOverrideMinutes: 5 });
    });

    test('the old Extension Duration field is gone from Configuration', () => {
        setup();
        const config = [...document.querySelectorAll('.section')].find(s => s.textContent.includes('Configuration'));
        expect(config.querySelector('#extension-duration')).toBeNull();
    });
});

describe('Block Short-Form Content', () => {
    test('all off by default', () => {
        setup();
        const toggles = [...document.querySelectorAll('.sf-toggle')];
        expect(toggles.map(t => t.dataset.kind)).toEqual(['youtubeShorts', 'instagramReels', 'facebookReels', 'tiktok']);
        expect(toggles.every(t => !t.checked)).toBe(true);
    });

    test('restores saved switches', () => {
        setup({ shortFormBlock: { tiktok: true, youtubeShorts: true } });
        expect(document.querySelector('[data-kind="tiktok"]').checked).toBe(true);
        expect(document.querySelector('[data-kind="youtubeShorts"]').checked).toBe(true);
        expect(document.querySelector('[data-kind="instagramReels"]').checked).toBe(false);
    });

    test('each switch saves immediately and tells the background', () => {
        setup({ shortFormBlock: { tiktok: true } });
        flip(document.querySelector('[data-kind="youtubeShorts"]'), true);
        expect(store.shortFormBlock).toEqual({ tiktok: true, youtubeShorts: true });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'shortFormChanged' });
        flip(document.querySelector('[data-kind="tiktok"]'), false);
        expect(store.shortFormBlock).toEqual({ tiktok: false, youtubeShorts: true });
    });
});
