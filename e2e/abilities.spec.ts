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
