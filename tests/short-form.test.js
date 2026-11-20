// Block Short-Form Content: outright URL blocks for YouTube Shorts, Instagram/Facebook Reels and
// TikTok, independent of the target-site list.
const { loadBackground, fireUpdated, fireCommitted, fireMessage, setStorage, lastRedirectUrl } = require('./helpers');

let nextTab = 200;
async function visit(url, via = 'updated') {
    const tabId = nextTab++;
    __mockFns__['tabs.update'].mockClear();
    if (via === 'committed') await fireCommitted({ tabId, url });
    else await fireUpdated(tabId, { url, status: 'loading' }, { id: tabId, url });
    return lastRedirectUrl();
}
const shortFormKind = (u) => (u && u.includes('msg=SHORT_FORM')) ? new URL(u).searchParams.get('kind') : null;

beforeEach(() => {
    __resetChrome__();
    loadBackground();
    setStorage({ targetSites: ['reddit.com'] }); // none of the short-form sites are targets
});

const ALL_ON = { youtubeShorts: true, instagramReels: true, facebookReels: true, tiktok: true };

test.each([
    ['https://www.youtube.com/shorts/abc123', 'youtubeShorts'],
    ['https://m.youtube.com/shorts/abc123', 'youtubeShorts'],
    ['https://www.instagram.com/reel/Cxyz/', 'instagramReels'],
    ['https://www.instagram.com/reels/', 'instagramReels'],
    ['https://www.instagram.com/reels/Cxyz/', 'instagramReels'],
    ['https://www.instagram.com/someone/reels/', 'instagramReels'],
    ['https://www.facebook.com/reel/123456', 'facebookReels'],
    ['https://www.facebook.com/reels/', 'facebookReels'],
    ['https://www.tiktok.com/@someone/video/1', 'tiktok'],
    ['https://www.tiktok.com/', 'tiktok'],
])('%s is blocked as %s, even though the site is not a target', async (url, kind) => {
    setStorage({ shortFormBlock: ALL_ON });
    expect(shortFormKind(await visit(url))).toBe(kind);
});

test.each([
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/',
    'https://www.instagram.com/p/Cxyz/',
    'https://www.instagram.com/someone/',
    'https://www.facebook.com/someone',
    'https://www.notyoutube.com/shorts/abc',
])('%s is not short-form and passes through', async (url) => {
    setStorage({ shortFormBlock: ALL_ON });
    expect(await visit(url)).toBeNull();
});

test('each platform is switched separately; all off by default', async () => {
    expect(await visit('https://www.youtube.com/shorts/a')).toBeNull();
    setStorage({ shortFormBlock: { instagramReels: true } });
    expect(await visit('https://www.youtube.com/shorts/b')).toBeNull();
    expect(shortFormKind(await visit('https://www.instagram.com/reel/x/'))).toBe('instagramReels');
});

test('in-app navigation into a Short is caught too', async () => {
    setStorage({ shortFormBlock: { youtubeShorts: true } });
    expect(shortFormKind(await visit('https://www.youtube.com/shorts/spa', 'committed'))).toBe('youtubeShorts');
});

test('wins over an active session on a target site', async () => {
    setStorage({
        targetSites: ['youtube.com'],
        shortFormBlock: { youtubeShorts: true },
        activeSessions: { 'youtube.com': { type: 'duration', origin: 'fresh', startTime: Date.now(), endTime: Date.now() + 600000 } },
    });
    expect(shortFormKind(await visit('https://www.youtube.com/shorts/x'))).toBe('youtubeShorts');
    expect(await visit('https://www.youtube.com/watch?v=x')).toBeNull();
});

test('turning a block on sweeps tabs already showing that content', async () => {
    setStorage({ shortFormBlock: { tiktok: true } });
    __mockFns__['tabs.query'].mockResolvedValue([
        { id: 1, url: 'https://www.tiktok.com/foryou' },
        { id: 2, url: 'https://www.youtube.com/shorts/a' },
    ]);
    await fireMessage({ action: 'shortFormChanged' });
    const calls = __mockFns__['tabs.update'].mock.calls;
    expect(calls.map(c => c[0])).toEqual([1]);
    expect(shortFormKind(calls[0][1].url)).toBe('tiktok');
});
