// reminders.js — Intervention Reminders: the user's own lines of text, shown one at a time on
// the block screen. Shared by options.html (default examples, tag list) and prompt.html
// (drawing + rendering). Pure functions only, so they're unit-testable under jest.
(function (root) {
    // Prefilled the first time the feature is switched on. Each one shows off at least one tag.
    const DEFAULT_REMINDERS = [
        'Visit #{visits} to {site} today. Still worth it?',
        "It's {time}. What did you open this tab to do?",
        'Is {site} how you want to spend your {day}?',
        'Close the tab, take three breaths, then decide.',
    ];

    const TAGS = [
        { tag: '{site}',   desc: 'site name' },
        { tag: '{visits}', desc: 'visits today' },
        { tag: '{time}',   desc: 'current time' },
        { tag: '{day}',    desc: 'weekday' },
    ];

    // How the reminder appears on screen. Picked at random per visit so the box never looks the
    // same twice in a row and the eye can't learn to skip it.
    const STYLES = ['type', 'words', 'fade'];

    function parseReminders(text) {
        return String(text || '')
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);
    }

    function fillTags(template, ctx) {
        const now = ctx.now ? new Date(ctx.now) : new Date();
        const values = {
            site: ctx.site || 'this site',
            visits: String(ctx.visits || 1),
            time: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
            day: now.toLocaleDateString([], { weekday: 'long' }),
        };
        return template.replace(/\{(site|visits|time|day)\}/gi, (_, k) => values[k.toLowerCase()]);
    }

    function shuffle(arr, rand) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // Shuffle-bag draw: every reminder is shown once before any repeats, and the same one is
    // never shown twice in a row (including across a reshuffle). `deck` is the remaining bag
    // from storage; lines that were edited away since are dropped from it.
    // Returns { text, deck } where `deck` is what to persist for next time.
    function drawReminder(reminders, deck, last, rand = Math.random) {
        if (!reminders || reminders.length === 0) return { text: null, deck: [] };
        let bag = (deck || []).filter(r => reminders.includes(r));
        if (bag.length === 0) {
            bag = shuffle(reminders, rand);
            // bag.pop() is drawn first; don't let it repeat the one just shown.
            if (bag.length > 1 && bag[bag.length - 1] === last) {
                [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
            }
        }
        const text = bag.pop();
        return { text, deck: bag };
    }

    function localDateKey(ts) {
        const d = ts ? new Date(ts) : new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // Per-site count of block-screen views today. Resets at local midnight.
    function bumpVisits(stored, domain, ts) {
        const today = localDateKey(ts);
        const counts = stored && stored.date === today ? { ...stored.counts } : {};
        counts[domain] = (counts[domain] || 0) + 1;
        return { date: today, counts };
    }

    const api = { DEFAULT_REMINDERS, TAGS, STYLES, parseReminders, fillTags, drawReminder, bumpVisits, localDateKey };
    root.WTBReminders = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
