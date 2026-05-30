import { type APIRequestContext, expect, test } from '@playwright/test';

/**
 * Switch the active bobina cassette by POSTing to the control-plane route. The
 * Next server (started by Playwright's `webServer`, see playwright.config.ts)
 * owns the bobina singleton; the test runner is a separate process and only
 * tells the server which cassette to load.
 */
async function setCassette(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post('/api/cassette', { data: { name } });
  expect(res.ok()).toBeTruthy();
}

test.beforeEach(async ({ request }) => {
  // Each test gets a clean, deterministic cassette before it touches the UI.
  await setCassette(request, 'chat-happy');
});

test.afterEach(async ({ request }) => {
  // Point the server at a blank cassette between tests so a stray request can't
  // accidentally replay (or, while recording, append to) the wrong one.
  await setCassette(request, 'blank');
});

test('streams an assistant reply without touching the real API', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('textbox').fill('ping');
  await page.getByRole('button', { name: 'Send' }).click();
  // The reply is served from tests/e2e/cassettes/chat-happy.json — no network.
  await expect(page.getByText('pong')).toBeVisible();
});
