import { endTurnButton, expect, keepHand, test } from './helpers';

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

// R45: an optional "you may pay [1] to draw 1" trigger. `?mock&optional=1` puts a Cinder Grunt (with that
// trigger) in the human's hand plus two extra ready runes. When the trigger resolves the engine asks:
// Decline does nothing, Pay and do it exhausts a rune and draws.
for (const accept of [true, false]) {
  test(`optional pay-to-draw trigger: ${accept ? 'accept' : 'decline'}`, async ({ page, log }) => {
    log.watch(page);
    await page.goto('/?mock&optional=1');
    await keepHand(page);
    await expect(endTurnButton(page)).toBeVisible({ timeout: 60_000 });
    const hand = page.getByRole('region', { name: 'Your hand' }).locator('[data-card-id]');
    const before = await hand.count();
    await page
      .getByRole('region', { name: 'Your hand' })
      .locator('[data-card-id][aria-label^="Cinder Grunt"]')
      .first()
      .click();
    const pop = page.getByRole('menu').first();
    if (await pop.isVisible().catch(() => false)) {
      await pop.getByRole('menuitem').first().click();
    }
    // The trigger is on the Chain: once the opponent has passed, passing lets it resolve and the engine asks.
    await page.getByRole('button', { name: /^Pass \(let it resolve\)/ }).click({ timeout: 60_000 });
    const prompt = page.getByTestId('optional-prompt');
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('optional-cost')).toContainText('Pay 1 Energy');
    await page.getByTestId(accept ? 'optional-accept' : 'optional-decline').click();
    await expect(prompt).toBeHidden();
    // played one card; the draw (accept) gives it back
    await expect.poll(() => hand.count()).toBe(accept ? before : before - 1);
    expect(log.errors).toEqual([]);
  });
}
