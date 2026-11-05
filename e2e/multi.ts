import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  endTurnButton,
  expect,
  keepHand,
  menu,
  openApp,
  syncSnapshot,
  tryPlayHandCard,
} from './helpers';

export interface Duo {
  host: Page;
  guest: Page;
  hostCtx: BrowserContext;
  guestCtx: BrowserContext;
  roomCode: string;
}

async function pickDeck(page: Page, index: number): Promise<void> {
  const radios = page.getByRole('radiogroup', { name: 'Decks' }).getByRole('radio');
  const n = await radios.count();
  const radio = radios.nth(Math.min(index, n - 1));
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}

/** Host + guest in separate contexts, both on the local PeerJS server; stops at the mulligan dialogs. */
export async function startDuo(browser: Browser, onPage?: (p: Page) => void): Promise<Duo> {
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  onPage?.(host);
  onPage?.(guest);

  await openApp(host, { peer: true });
  await menu(host, 'Host Game');
  await pickDeck(host, 0);
  await host.getByRole('button', { name: 'Create room' }).click();
  const code = host.getByTestId('room-code');
  await expect(code).toHaveText(/^[A-Z0-9]{6}$/);
  const roomCode = (await code.innerText()).trim();

  await openApp(guest, { peer: true });
  await menu(guest, 'Join Game');
  await guest.getByLabel('Room code').fill(roomCode);
  await pickDeck(guest, 1);
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  return { host, guest, hostCtx, guestCtx, roomCode };
}

export async function bothKeepHand(d: Duo): Promise<void> {
  await Promise.all([keepHand(d.host), keepHand(d.guest)]);
}

/** Both sides report the same turn number / scores / phase. */
export async function expectInSync(d: Duo): Promise<void> {
  await expect
    .poll(
      async () =>
        JSON.stringify(await syncSnapshot(d.host)) === JSON.stringify(await syncSnapshot(d.guest)),
      {
        timeout: 20_000,
      },
    )
    .toBe(true);
}

/**
 * Whoever holds the End turn button plays a card (best effort) and ends the turn; any pass/focus
 * prompts on either side are cleared on the way. Resolves once the OTHER side has End turn.
 */
export async function takeTurn(d: Duo): Promise<'host' | 'guest'> {
  let acted: 'host' | 'guest' | null = null;
  await expect
    .poll(
      async () => {
        const sides = [
          ['host', d.host],
          ['guest', d.guest],
        ] as const;
        if (acted) {
          const other = acted === 'host' ? d.guest : d.host;
          if (await endTurnButton(other).count()) return 'done';
        }
        for (const [name, page] of sides) {
          if (!acted && (await endTurnButton(page).count())) {
            await tryPlayHandCard(page);
            const ok = await endTurnButton(page)
              .click({ timeout: 3000 })
              .then(
                () => true,
                () => false,
              );
            if (!ok) {
              await page.keyboard.press('Escape');
              return 'click-failed';
            }
            acted = name;
            return 'ended';
          }
          const pass = page.locator('[data-tutorial-id="btn-pass"]');
          if (await pass.count()) await pass.click({ timeout: 2000 }).catch(() => undefined);
        }
        return 'waiting';
      },
      { timeout: 60_000, intervals: [150, 250, 500] },
    )
    .toBe('done');
  return acted!;
}
