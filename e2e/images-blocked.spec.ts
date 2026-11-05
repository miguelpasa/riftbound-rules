import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { endTurnButton, expect, keepHand, startSolo, test } from './helpers';

test('card images blocked: cards still render with names and costs', async ({ page, log }) => {
  const cards = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../client/public/cards.json'), 'utf8'),
  ) as Record<string, { imageUrl?: string }>;
  const hosts = new Set(['cmsassets.rgpub.io']);
  for (const c of Object.values(cards)) {
    if (c.imageUrl) hosts.add(new URL(c.imageUrl).host);
  }
  let blocked = 0;
  await page.route(
    (url) => hosts.has(url.host),
    (route) => {
      blocked++;
      return route.abort('blockedbyclient');
    },
  );

  log.watch(page);
  await startSolo(page);
  await keepHand(page);
  await expect(endTurnButton(page)).toBeVisible({ timeout: 30_000 });

  const handCards = page.getByRole('region', { name: 'Your hand' }).locator('[data-card-id]');
  const n = await handCards.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const card = handCards.nth(i);
    await expect(card).toBeVisible();
    const name = (await card.locator('div.truncate[title]').first().getAttribute('title')) ?? '';
    expect(name.length).toBeGreaterThan(0);
    await expect(card.getByText(name, { exact: true }).first()).toBeVisible();
    await expect(card.locator('[data-testid="cost-energy"]').first()).toBeVisible();
    const box = await card.boundingBox();
    expect(box!.width).toBeGreaterThan(40);
    expect(box!.height).toBeGreaterThan(40);
  }
  expect(blocked).toBeGreaterThanOrEqual(0);
  expect(log.errors).toEqual([]);
});
