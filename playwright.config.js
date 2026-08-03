const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  retries: 1,
  // Two workers: Chrome and Firefox run in parallel, one browser per worker.
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],

  projects: [
    { name: 'chrome', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
