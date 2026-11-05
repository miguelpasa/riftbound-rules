import { bothKeepHand, expectInSync, startDuo, takeTurn } from './multi';
import { expect, handCardNames, test, turnNumber } from './helpers';

test('multiplayer: host and guest play in sync with hidden hands', async ({ browser, log }) => {
  const duo = await startDuo(browser, (p) => log.watch(p));
  try {
    const { host, guest } = duo;
    await bothKeepHand(duo);
    await expect(host.getByRole('region', { name: 'Your hand' })).toBeVisible();
    await expect(guest.getByRole('region', { name: 'Your hand' })).toBeVisible();
    await expect(
      host.getByRole('listitem').filter({ hasText: 'Opponent connected' }),
    ).toBeVisible();

    // hand privacy: opponent hand is card backs only
    for (const [me, them] of [
      [host, guest],
      [guest, host],
    ] as const) {
      const opp = me.getByLabel(/^Opponent hand, \d+ cards$/);
      await expect(opp).toBeVisible();
      expect(await opp.locator('[data-card-back]').count()).toBeGreaterThan(0);
      expect(await opp.locator('[data-card-id]').count()).toBe(0);
      void them;
    }

    // DOM leak check: names only in the other seat's hand must not appear anywhere in my page.
    const hostHand = await handCardNames(host);
    const guestHand = await handCardNames(guest);
    expect(hostHand.length).toBeGreaterThan(0);
    expect(guestHand.length).toBeGreaterThan(0);
    const hostOnly = hostHand.filter((n) => !guestHand.includes(n));
    const guestOnly = guestHand.filter((n) => !hostHand.includes(n));
    const guestHtml = await guest.content();
    const hostHtml = await host.content();
    for (const n of hostOnly)
      expect(guestHtml, `guest page leaks host card "${n}"`).not.toContain(n);
    for (const n of guestOnly)
      expect(hostHtml, `host page leaks guest card "${n}"`).not.toContain(n);
    expect(hostOnly.length + guestOnly.length).toBeGreaterThan(0); // the check was not vacuous

    await expectInSync(duo);
    const t0 = await turnNumber(host);

    const who: string[] = [];
    for (let i = 0; i < 4; i++) {
      who.push(await takeTurn(duo));
      await expectInSync(duo);
    }
    expect(who).toContain('host');
    expect(who).toContain('guest');
    expect(await turnNumber(host)).toBeGreaterThanOrEqual(t0 + 4);
    expect(await turnNumber(guest)).toBe(await turnNumber(host));
    expect(log.errors).toEqual([]);
  } finally {
    await duo.hostCtx.close();
    await duo.guestCtx.close();
  }
});
