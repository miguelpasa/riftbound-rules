import {
  endTurnButton,
  expect,
  keepHand,
  passButton,
  phaseTracker,
  playRound,
  progressKey,
  startSolo,
  test,
  turnNumber,
} from './helpers';

test('solo vs AI: two full turns, bot moves, no errors', async ({ page, log }) => {
  log.watch(page);
  await startSolo(page);
  await keepHand(page);
  await expect(page.getByRole('region', { name: 'Your hand' })).toBeVisible();

  const logSummary = page.getByText(/^Game log \(\d+\)$/);
  await expect(logSummary).toBeVisible();
  // The bot may move first and put an ability on the Chain: pass priority until it is our turn.
  await expect
    .poll(
      async () => {
        if (await endTurnButton(page).isVisible()) return true;
        if (await passButton(page).isVisible())
          await passButton(page)
            .click({ timeout: 2_000 })
            .catch(() => undefined);
        return false;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);
  const startKey = await progressKey(page);

  await playRound(page);
  const afterOne = await progressKey(page);
  expect(afterOne).not.toBe(startKey);
  const logAfterOne = Number(/\((\d+)\)/.exec(await logSummary.innerText())![1]);
  expect(logAfterOne).toBeGreaterThan(0);

  await playRound(page);
  expect(await turnNumber(page)).toBeGreaterThanOrEqual(3);
  const logAfterTwo = Number(/\((\d+)\)/.exec(await logSummary.innerText())![1]);
  expect(logAfterTwo).toBeGreaterThan(logAfterOne);

  // the opponent's actions are in the log
  await logSummary.click();
  await expect(
    page.getByRole('list', { name: 'Game log' }).getByRole('listitem').first(),
  ).toBeVisible();

  // no flood of rule-error toasts
  expect(await page.getByText('[Rule Error]').count()).toBeLessThanOrEqual(1);
  await expect(phaseTracker(page)).toBeVisible();
  expect(log.errors).toEqual([]);
});
