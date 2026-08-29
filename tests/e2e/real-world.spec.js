/**
 * Real-world smoke tests. Every other spec file mocks target-site network requests for
 * speed/determinism (see fixture.js's routeTargetSites) — these instead hit the actual
 * youtube.com / instagram.com over the real network, bypassing that mock for just this page.
 *
 * Why: local mocking can't reproduce a real multi-hop HTTP redirect chain (e.g. bare domain
 * -> apex -> www), and that's exactly the class of race this exists to catch (see the "opens
 * a new tab / types the URL, no block until reload" bug fixed alongside this).
 *
 * Kept deliberately minimal to limit real traffic to these sites: two tests, navigation-commit
 * only (no scrolling/clicking/interaction, no waiting for full page load), Chrome only.
 */
const { test, expect } = require('./fixture');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Real-network smoke tests run on Chrome only to keep external traffic minimal.',
);

function isBlockedUrl(u) {
    const href = typeof u === 'string' ? u : u.href;
    return href.includes('prompt.html');
}

test('Real youtube.com: bare-domain navigation still gets blocked (redirect-chain regression)', async ({ page }) => {
    // Let requests to youtube.com hit the real network instead of the fixture's local mock.
    await page.route(/(^|\.)youtube\.com/, (route) => route.continue());

    await Promise.all([
        page.waitForURL(isBlockedUrl, { timeout: 15000 }),
        page.goto('https://youtube.com/', { waitUntil: 'commit' }).catch(() => null),
    ]);
    expect(isBlockedUrl(page.url())).toBe(true);
    await expect(page.locator('#target-site-display')).toContainText('youtube.com');
});

test('Real instagram.com: bare-domain navigation still gets blocked (redirect-chain regression)', async ({ page }) => {
    await page.route(/(^|\.)instagram\.com/, (route) => route.continue());

    await Promise.all([
        page.waitForURL(isBlockedUrl, { timeout: 15000 }),
        page.goto('https://instagram.com/', { waitUntil: 'commit' }).catch(() => null),
    ]);
    expect(isBlockedUrl(page.url())).toBe(true);
    await expect(page.locator('#target-site-display')).toContainText('instagram.com');
});
