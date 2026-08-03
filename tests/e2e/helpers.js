/**
 * Shared URL constants and navigation helpers for E2E tests.
 *
 * All target-site URLs resolve to local HTML (see fixture.js routeTargetSites).
 * The extension sees the real hostname and blocks / allows accordingly.
 */

const { expect } = require('@playwright/test');

// ── URLs ─────────────────────────────────────────────────────────────────────

const YT_HOME      = 'https://www.youtube.com/';
const YT_SUBS      = 'https://www.youtube.com/feed/subscriptions';
const VIDEO_A      = 'https://www.youtube.com/watch?v=aaa111';
const VIDEO_B      = 'https://www.youtube.com/watch?v=bbb222';
const VIDEO_C      = 'https://www.youtube.com/watch?v=ccc333';
const VIDEO_D      = 'https://www.youtube.com/watch?v=ddd444';
const SHORTS_A     = 'https://www.youtube.com/shorts/sss999/';
const VIDEO_A_EXTRA = 'https://www.youtube.com/watch?v=aaa111&t=30s'; // same ID, extra param

const IG_HOME = 'https://www.instagram.com/';
const IG_POST = 'https://www.instagram.com/p/ABC123/';

const REDDIT_HOME = 'https://www.reddit.com/';
const REDDIT_POPULAR = 'https://www.reddit.com/r/popular/';
const POST_A      = 'https://www.reddit.com/r/programming/comments/abc123/some_title/';
const POST_A_ALT  = 'https://www.reddit.com/r/programming/comments/abc123/'; // same ID, no slug
const POST_B      = 'https://www.reddit.com/r/gaming/comments/xyz789/other_post/';

// ── Navigation helpers ────────────────────────────────────────────────────────

/**
 * Navigate to a URL that the extension should block.
 * Resolves once the tab lands on prompt.html (Chrome) or the test-redirect prompt
 * page (Firefox, where moz-extension:// can't be tracked by Playwright's Juggler).
 */
async function expectBlocked(page, url) {
    const isBlockedUrl = (u) => {
        const href = typeof u === 'string' ? u : u.href;
        return href.includes('prompt.html') || href.includes('playwright-ext-prompt.invalid');
    };
    await Promise.all([
        page.waitForURL(isBlockedUrl, { timeout: 10000 }),
        page.goto(url, { waitUntil: 'commit' }).catch(() => null),
    ]);
    expect(isBlockedUrl(page.url())).toBe(true);
}

/**
 * Navigate to a URL that the extension should allow (active session exists).
 * Fails if the extension unexpectedly redirects to prompt.html within 2s.
 */
async function expectAllowed(page, url) {
    await page.goto(url, { waitUntil: 'commit' }).catch(() => null);
    const isBlockedUrl = (u) => {
        const href = typeof u === 'string' ? u : u.href;
        return href.includes('prompt.html') || href.includes('playwright-ext-prompt.invalid');
    };
    const blocked = await page.waitForURL(isBlockedUrl, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
    if (blocked) {
        throw new Error(`expectAllowed: extension unexpectedly blocked ${url} — landed on ${page.url()}`);
    }
    // Confirm we're at the right domain.
    expect(new URL(page.url()).hostname).toContain(
        new URL(url).hostname.replace(/^(www\.|m\.)/, ''),
    );
}

// ── Prompt UI helpers ─────────────────────────────────────────────────────────

/** Fill and submit the duration form on the blocking prompt. */
async function submitDuration(page, minutes) {
    await page.waitForSelector('#duration-input', { timeout: 5000 });
    await page.fill('#duration-input', String(minutes));
    await page.click('#confirm-btn');
}

/**
 * Switch to the Count tab and submit. Count button is only visible on YouTube;
 * call this only when the prompt URL contains youtube.com.
 */
async function submitCount(page, count) {
    await page.waitForSelector('#count-btn', { state: 'visible', timeout: 5000 });
    await page.click('[data-type="count"]');
    await page.waitForSelector('#count-input', { timeout: 3000 });
    await page.fill('#count-input', String(count));
    await page.click('#confirm-btn');
}

/**
 * After submitting the prompt, wait for the extension to redirect back to the
 * intended site (URL contains `domain` and is not a prompt page).
 */
async function waitForSiteAccess(page, domain) {
    await page.waitForURL(
        (url) => url.href.includes(domain) &&
                 !url.href.includes('prompt.html') &&
                 !url.href.includes('playwright-ext-prompt.invalid'),
        { timeout: 10000 },
    );
}

// ── Storage presets ───────────────────────────────────────────────────────────

/** Returns storage data for an active time-range block with limit already exhausted. */
function exhaustedTimeRange() {
    const now = new Date();
    const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return {
        timeRanges: [{
            id: 'range1',
            startHour: 0, startMinute: 0,
            endHour: 23, endMinute: 59,
            limitMinutes: 1,
        }],
        timeRangeUsage: {
            range1: { dateKey, usedSeconds: 120 }, // 2 min used > 1 min limit
        },
    };
}

module.exports = {
    YT_HOME, YT_SUBS, VIDEO_A, VIDEO_B, VIDEO_C, VIDEO_D, SHORTS_A, VIDEO_A_EXTRA,
    IG_HOME, IG_POST,
    REDDIT_HOME, REDDIT_POPULAR, POST_A, POST_A_ALT, POST_B,
    expectBlocked, expectAllowed,
    submitDuration, submitCount, waitForSiteAccess,
    exhaustedTimeRange,
};
