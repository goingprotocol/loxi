import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    timeout: 300_000, // 5 min per test (VRP solve can take a while)
    use: {
        headless: true,
        launchOptions: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--enable-features=SharedArrayBuffer',
            ],
        },
    },
    reporter: [['list'], ['html', { open: 'never' }]],
});
