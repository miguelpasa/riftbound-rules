import { expect, menu, openApp, test } from './helpers';

test('tutorial lesson 1: steps advance and the engine refuses an out-of-turn play', async ({
  page,
  log,
}) => {
  log.watch(page);
  await openApp(page);
  await menu(page, 'Tutorial');
  await expect(page.getByRole('heading', { name: 'Tutorial', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Start The Turn Structure' }).click();

  const title = page.getByTestId('step-title');
  const stepText = page.getByText(/^Step \d+ of \d+$/);
  await expect(stepText).toHaveText(/^Step 1 of \d+$/);
  await expect(title).toHaveText('The phases of a turn');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(stepText).toHaveText(/^Step 2 of/);
  await expect(title).toHaveText('Your channeled runes');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(stepText).toHaveText(/^Step 3 of/);
  await expect(title).toHaveText('End your Main Phase');

  await page.locator('[data-tutorial-id="btn-end-turn"]').click();
  await expect(page.getByTestId('step-complete')).toBeVisible();
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(stepText).toHaveText(/^Step 4 of/);
  await expect(title).toHaveText('Not your turn to act');

  // clicking any hand card sends PLAY_CARD, which the real engine refuses
  await page.locator('[data-tutorial-id="hand"] [data-card-id]').first().click();
  await expect(page.getByTestId('step-complete')).toContainText('Exactly that refusal');
  await expect(page.getByTestId('engine-callout')).toContainText('[Rule Error]');
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(stepText).toHaveText(/^Step 5 of/);
  expect(log.errors).toEqual([]);
});

test('tutorial lesson 5: plain clicks select both units and the guide stays clickable over the damage dialog', async ({
  page,
  log,
}) => {
  log.watch(page);
  await openApp(page);
  await menu(page, 'Tutorial');
  await page.getByRole('button', { name: 'Start Showdowns and Combat Might' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // plain clicks (no Ctrl/Shift) add to the selection in the tutorial, as the hint says
  await page.locator('[data-card-id="fx-raider"]').first().click();
  await page.locator('[data-card-id="fx-grunt"]').first().click();
  await page
    .getByRole('button', { name: /^Move to/ })
    .last()
    .click();
  await expect(page.getByTestId('step-complete')).toBeVisible();
  await page.getByRole('button', { name: 'Next step' }).click();
  await page.locator('[data-tutorial-id="btn-pass"]').click();

  // the damage dialog is open; its backdrop must not cover the guide's Next button
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('step-complete')).toBeVisible();
  await expect(page.getByTestId('step-complete')).toContainText('Exactly that refusal');
  await page.getByRole('button', { name: 'Next step' }).click(); // real mouse click, no force
  await expect(page.getByTestId('step-title')).toHaveText('Assign your damage');
  expect(log.errors).toEqual([]);
});

test('tutorial at phone width: the board stays visible and the guide collapses', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openApp(page);
  await menu(page, 'Tutorial');
  await page.getByRole('button', { name: 'Start Meet the board' }).click();
  const toggle = page.getByRole('button', { name: /Hide guide/ });
  await expect(toggle).toBeVisible();
  const board = page.getByLabel('Your base');
  await expect(board).toBeVisible();
  const box = await board.boundingBox();
  expect(box!.x).toBeLessThan(390);
  await toggle.click();
  await expect(page.getByRole('button', { name: /Show guide/ })).toBeVisible();
  await expect(page.getByTestId('step-title')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(overflow).toBeLessThanOrEqual(390);
});
