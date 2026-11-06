import { expect, keepHand, startSolo, test } from './helpers';

// R48: after a solo game ends the banner offers a Rematch (same decks, fresh seed), and the saved
// games list shows the result from the player's side plus a running record.
test('solo: concede, rematch, and see the record in saved games', async ({ page, log }) => {
  log.watch(page);
  await startSolo(page);
  await keepHand(page);

  await page.getByRole('button', { name: 'Concede' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Concede' }).click();
  const over = page.getByRole('dialog', { name: 'Game over' });
  await expect(over).toContainText('You lose');
  await over.getByRole('button', { name: 'Rematch' }).click();

  // A brand-new game starts with its own mulligan.
  await keepHand(page);
  await expect(page.getByRole('dialog', { name: 'Game over' })).toBeHidden();

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Leave now' }).click();
  await page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('button', { name: /Saved games/ })
    .click();
  await expect(page.getByTestId('solo-record')).toContainText('0 won, 1 lost');
  await expect(page.getByLabel('Saved games')).toContainText('you lost');
  expect(log.errors).toEqual([]);
});
