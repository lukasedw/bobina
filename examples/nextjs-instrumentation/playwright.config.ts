import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:3000' },
  webServer: {
    // CRITICAL: run against the production build, NOT `next dev`. React 19's
    // dev-mode hydration races break headless Playwright (PLAN gotcha #5).
    command: 'pnpm build && pnpm start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    env: {
      // `record` to capture fixtures the first time; `replay` (or `none`) for CI.
      E2E_MODE: process.env.E2E_MODE ?? 'replay',
      // Real keys are only needed while recording; redacted out of cassettes via
      // the `filters` in lib/bobina-e2e.ts, so CI replay needs no secrets.
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
    },
  },
});
