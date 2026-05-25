import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'open-design:config';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
      }),
    );
  }, STORAGE_KEY);
});

test('Open Slide present mode applies page-level motion when advancing slides', async ({ page }) => {
  const projectId = `motion-browser-${Date.now()}`;
  const createResponse = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name: 'Motion browser acceptance',
      metadata: {
        kind: 'deck',
        slideId: 'main-deck',
      },
    },
  });
  expect(createResponse.ok()).toBeTruthy();

  const source = `
import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';

export const design: DesignSystem = {
  palette: { bg: '#101010', text: '#f8fafc', accent: '#f97316' },
  fonts: { display: 'Inter, sans-serif', body: 'Inter, sans-serif' },
  radius: 14,
};

const First: Page = () => (
  <section style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: '#101010', color: '#f8fafc' }}>
    <h1 style={{ fontSize: 96 }}>Browser Motion One</h1>
  </section>
);

const Second: Page = () => (
  <section style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: '#f8fafc', color: '#101010' }}>
    <h1 style={{ fontSize: 96 }}>Browser Motion Two</h1>
  </section>
);

export const meta: SlideMeta = { title: 'Motion browser acceptance' };
export default [First, Second] satisfies Page[];
`;

  const writeResponse = await page.request.patch(`/api/projects/${projectId}/open-slide/source`, {
    data: {
      slideId: 'main-deck',
      content: source,
    },
  });
  expect(writeResponse.ok()).toBeTruthy();

  await page.goto(`/projects/${projectId}/files/slides/main-deck/index.tsx`);
  await page.getByRole('button', { name: /OpenPPT Web-PPT deck/i }).click();
  await page.getByRole('button', { name: /^Open$/i }).click();
  await expect(page.getByRole('button', { name: /present/i })).toBeEnabled();
  await page.getByRole('button', { name: /present/i }).click();

  const initialStage = page.getByTestId('open-slide-player-stage');
  await expect(initialStage).toHaveAttribute('data-transition', 'initial');
  await expect(initialStage.getByText('Browser Motion One')).toBeVisible();

  await page.locator('.open-slide-player-zone.next').click();

  const stage = page.getByTestId('open-slide-player-stage');
  await expect(stage).toHaveAttribute('data-transition', 'forward');
  await expect(stage).toHaveAttribute('data-page-index', '1');
  await expect(stage.getByText('Browser Motion Two')).toBeVisible();
  await expect(stage).toHaveCSS('animation-name', 'open-slide-player-stage-forward');
});
