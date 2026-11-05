import { expect, openApp, test } from './helpers';

test('menu loads with the card count and no console errors', async ({ page, log }) => {
  log.watch(page);
  await openApp(page);
  await expect(page.getByRole('heading', { name: 'Riftbound Local Duelist' })).toBeVisible();
  const status = await page
    .getByRole('status')
    .filter({ hasText: /Loaded \d+ cards/ })
    .innerText();
  expect(Number(/Loaded (\d+) cards/.exec(status)![1])).toBeGreaterThan(0);
  expect(status).not.toContain('fixture');
  for (const name of [
    'Host Game',
    'Join Game',
    'Play vs AI',
    'Tutorial',
    /Saved games/,
    'Settings',
  ]) {
    await expect(
      page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name }),
    ).toBeEnabled();
  }
  expect(log.errors).toEqual([]);
});
