// Pure logic for Intervention Reminders (reminders.js): parsing, tag filling, the shuffle-bag
// draw (no repeats within a cycle, never the same one twice in a row), and the daily visit count.
const R = require('../reminders.js');

test('parseReminders trims and drops blank lines', () => {
    expect(R.parseReminders('  a \n\n b\n   \n')).toEqual(['a', 'b']);
    expect(R.parseReminders('')).toEqual([]);
});

test('default examples use every tag', () => {
    const all = R.DEFAULT_REMINDERS.join(' ');
    R.TAGS.forEach(({ tag }) => expect(all).toContain(tag));
});

test('fillTags replaces every tag, case-insensitively, and leaves unknown braces alone', () => {
    const now = new Date(2026, 10, 7, 14, 5).getTime(); // a Saturday
    const out = R.fillTags('{site} #{visits} {TIME} {day} {nope}', { site: 'reddit.com', visits: 3, now });
    expect(out).toContain('reddit.com #3');
    expect(out).toMatch(/2:05|14:05/);
    expect(out).toContain('Saturday');
    expect(out).toContain('{nope}');
});

test('drawReminder shows every reminder once before any repeats', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    let deck = [], last = null;
    const seen = [];
    for (let i = 0; i < list.length; i++) {
        const r = R.drawReminder(list, deck, last);
        seen.push(r.text); deck = r.deck; last = r.text;
    }
    expect(seen.sort()).toEqual(list);
    expect(deck).toEqual([]);
});

test('drawReminder never repeats back-to-back across a reshuffle', () => {
    const list = ['a', 'b', 'c'];
    let deck = [], last = null;
    for (let i = 0; i < 300; i++) {
        const r = R.drawReminder(list, deck, last);
        expect(r.text).not.toBe(last);
        deck = r.deck; last = r.text;
    }
});

test('drawReminder drops lines that were edited away', () => {
    const r = R.drawReminder(['x'], ['gone', 'also gone'], null);
    expect(r.text).toBe('x');
});

test('drawReminder with no reminders returns null', () => {
    expect(R.drawReminder([], ['a'], null).text).toBeNull();
});

test('bumpVisits counts per site and resets on a new day', () => {
    const day1 = new Date(2026, 10, 7, 9).getTime();
    const day2 = new Date(2026, 10, 8, 9).getTime();
    let v = R.bumpVisits(null, 'reddit.com', day1);
    v = R.bumpVisits(v, 'reddit.com', day1);
    v = R.bumpVisits(v, 'youtube.com', day1);
    expect(v.counts).toEqual({ 'reddit.com': 2, 'youtube.com': 1 });
    v = R.bumpVisits(v, 'reddit.com', day2);
    expect(v.counts).toEqual({ 'reddit.com': 1 });
});
