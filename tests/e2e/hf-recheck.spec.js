const { test, expect } = require('./fixture');
const { YT_HOME, expectBlocked } = require('./helpers');

test.beforeEach(async ({ storage }) => {
    await storage.clear();
});

test('Half Full block screen: "check again" clears cache and grants access once tasks are done', async ({ page, storage, context }) => {
    const now = Date.now();

    // Simulate a fresh re-check finding NO incomplete tasks (404 -> tasks = []).
    await context.route('https://firestore.googleapis.com/**', (route) => {
        route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    await storage.set({
        halfFullAuth: {
            email: 'test@example.com', idToken: 'faketoken', refreshToken: 'fakerefresh',
            uid: 'u1', expiresAt: now + 3600000,
        },
        // Pre-populate the cache with an INCOMPLETE matching task so the limit starts active/blocking.
        halfFullTaskCache: {
            fetchedAt: now,
            tasks: [{ name: 'homework essay', checked: false }],
        },
        scheduledLimits: [{
            id: 'limit1', days: [0, 1, 2, 3, 4, 5, 6],
            startHour: 0, startMinute: 0, endHour: 23, endMinute: 59,
            limitMinutes: 0,
            halfFullPattern: { id: 'p1', pattern: 'homework', type: 'contains', color: 'purple' },
        }],
    });

    await expectBlocked(page, YT_HOME);
    await expect(page.locator('h1')).toContainText('Access Blocked (Scheduled Limit)');
    const recheckBtn = page.locator('#hf-recheck-btn');
    await expect(recheckBtn).toBeVisible();
    await expect(recheckBtn).toContainText('Finished? Check again');

    await recheckBtn.click();

    // Access should now be granted (fresh fetch found no incomplete tasks -> pattern inactive
    // -> limit skipped), landing back on the real site, not stuck on prompt.html.
    await page.waitForURL(
        (u) => u.href.includes('youtube.com') && !u.href.includes('prompt.html'),
        { timeout: 10000 },
    );
    expect(page.url()).not.toContain('prompt.html');
});
