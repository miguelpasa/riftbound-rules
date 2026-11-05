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
