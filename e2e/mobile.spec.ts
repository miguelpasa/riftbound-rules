import { endTurnButton, expect, keepHand, test } from './helpers';

// R18: the game screen at phone width. The header is compact and sticky, so End turn stays
// reachable at any scroll position; the page never scrolls sideways.
test('game screen at 390px: no horizontal overflow, End turn stays in view', async ({
  page,
  log,
}) => {
  log.watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?mock&gold=2');
  await keepHand(page);
  await expect(endTurnButton(page)).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(endTurnButton(page)).toBeInViewport();
  const box = await endTurnButton(page).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(log.errors).toEqual([]);
});
