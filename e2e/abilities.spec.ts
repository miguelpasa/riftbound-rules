import { expect, keepHand, test } from './helpers';

// R40: a human activates a Gold token ([Add] ability) from the board. `?mock&gold=2` is a dev
// route: a real local engine game on the fixture decks where the human starts with two ready Gold.
for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile 390px', { width: 390, height: 844 }],
] as const) {
  test(`activate Gold: ${name}`, async ({ page, log }) => {
    log.watch(page);
    await page.setViewportSize(viewport);
    await page.goto('/?mock&gold=2');
    const base = page.getByLabel('Your base');
    await expect(base.getByLabel('Gear in base').getByText('Gold token')).toHaveCount(2);
    // No abilities during the mulligan.
    await expect(page.getByRole('button', { name: /^Activate Gold token/ })).toHaveCount(0);
    await keepHand(page);

    const buttons = page.getByRole('button', { name: /^Activate Gold token/ });
    await expect(buttons).toHaveCount(2);
    await expect(base.getByLabel('Units in base')).not.toContainText('Gold token');

    await buttons.first().click();
    await expect(page.getByTestId('pool-power-any')).toHaveText('Any 1');
    await expect(buttons).toHaveCount(1);
    await buttons.first().click();
    await expect(page.getByTestId('pool-power-any')).toHaveText('Any 2');
    await expect(buttons).toHaveCount(0);

    // Nothing may overflow horizontally (390px layout in particular).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(log.errors).toEqual([]);
  });
}

// R41: a targeted activated ability. `?mock&buffer=1` starts the human with a ready Cinder Grunt that has
// "[E]: Give a unit +2 [M] this turn": Activate starts click-to-target, the unit is the only legal target.
test('activate a targeted ability: click-to-target', async ({ page, log }) => {
  log.watch(page);
  await page.goto('/?mock&buffer=1');
  await keepHand(page);
  const activate = page.getByRole('button', { name: /^Activate Cinder Grunt/ });
  await expect(activate).toHaveCount(1, { timeout: 60_000 }); // on the human's own Main Phase
  await activate.click();
  await expect(page.getByRole('status').filter({ hasText: /Choose target 1 of 1/ })).toContainText(
    '(ability)',
  );
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await page
    .getByRole('button', { name: /^Target: Cinder Grunt/ })
    .first()
    .click();
  await expect(page.getByLabel('Targeting')).toHaveCount(0);
  await expect(activate).toHaveCount(0); // exhausted
  expect(log.errors).toEqual([]);
});
