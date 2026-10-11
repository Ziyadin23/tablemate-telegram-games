import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 390, height: 844 }, screenshot: 'only-on-failure', trace: 'retain-on-failure', launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) } },
  webServer: {
    command: 'npm run dev', url: 'http://127.0.0.1:5174/api/health', reuseExistingServer: false, timeout: 60_000,
    env: { APP_MODE: 'demo', NODE_ENV: 'development', PORT: '3101', VITE_PORT: '5174', DB_PATH: 'data/e2e.sqlite', PUBLIC_URL: 'http://127.0.0.1:5174' },
  },
});
