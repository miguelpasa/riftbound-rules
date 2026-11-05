import { bothKeepHand, expectInSync, startDuo, takeTurn } from './multi';
import { expect, menu, test, turnNumber } from './helpers';

test('reconnect: guest waits for the host, host resumes from Saved games, game continues', async ({
  browser,
  log,
}) => {
  const duo = await startDuo(browser, (p) => log.watch(p));
  try {
    const { host, guest } = duo;
    await bothKeepHand(duo);
    await takeTurn(duo);
    await expectInSync(duo);
    const turnBefore = await turnNumber(guest);

    // the host's tab is reloaded: it drops back to the menu, the guest sees the host leave
    await host.goto(host.url());
    await expect(host.getByRole('status').filter({ hasText: /Loaded \d+ cards/ })).toBeVisible();
    await expect(guest.getByText('Host disconnected, waiting for host to return...')).toBeVisible({
      timeout: 45_000,
    });

    await menu(host, /Saved games/);
    const entry = host
      .getByRole('list', { name: 'Saved games' })
      .getByRole('listitem')
      .filter({ hasText: duo.roomCode });
    await expect(entry).toBeVisible();
    await entry.getByRole('button', { name: 'Resume' }).click();

    // guest recovers on its own
    await expect(guest.getByText('Host disconnected, waiting for host to return...')).toBeHidden({
      timeout: 60_000,
    });
    await expect(
      guest.getByRole('dialog', { name: /./ }).filter({ hasText: 'Connecting' }),
    ).toBeHidden({ timeout: 60_000 });
    await expect(host.getByRole('region', { name: 'Your hand' })).toBeVisible();
    await expect(host.getByRole('listitem').filter({ hasText: 'Opponent connected' })).toBeVisible({
      timeout: 30_000,
    });
    await expectInSync(duo);
    expect(await turnNumber(host)).toBe(turnBefore);
    expect(await turnNumber(guest)).toBe(turnBefore);

    // and play goes on
    await takeTurn(duo);
    await expectInSync(duo);
    expect(await turnNumber(host)).toBeGreaterThan(turnBefore);
    expect(log.errors).toEqual([]);
  } finally {
    await duo.hostCtx.close();
    await duo.guestCtx.close();
  }
});
