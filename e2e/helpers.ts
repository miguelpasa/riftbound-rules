import { expect, test as base, type Locator, type Page } from '@playwright/test';

export const PEER_QUERY = '?peerHost=localhost&peerPort=9000&peerPath=/';

/** Console messages we tolerate: network failures of third-party images (offline CI, blocked CDN). */
const IGNORED_CONSOLE = [/Failed to load resource/i, /net::ERR_/i];

export interface ErrorLog {
  errors: string[];
  watch(page: Page): void;
}

export const test = base.extend<{ log: ErrorLog }>({
  log: async ({}, use) => {
    const errors: string[] = [];
    const log: ErrorLog = {
      errors,
      watch(page) {
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const t = m.text();
          if (IGNORED_CONSOLE.some((r) => r.test(t))) return;
          errors.push(`console: ${t}`);
        });
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      },
    };
    await use(log);
  },
});
export { expect };

export async function openApp(page: Page, opts: { peer?: boolean } = {}): Promise<void> {
  await page.goto(opts.peer ? `/${PEER_QUERY}` : '/');
  await expect(page.getByRole('status').filter({ hasText: /Loaded \d+ cards/ })).toBeVisible();
}

export async function menu(page: Page, label: string | RegExp): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('button', { name: label })
    .click();
}

/** Picks the first preset deck (the picker also selects it by default). */
export async function pickFirstDeck(page: Page): Promise<string> {
  const radio = page.getByRole('radiogroup', { name: 'Decks' }).getByRole('radio').first();
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
  return (await radio.innerText()).split('\n')[0] ?? '';
}

export async function startSolo(page: Page): Promise<void> {
  await openApp(page);
  await menu(page, 'Play vs AI');
  await pickFirstDeck(page);
  await page.getByRole('button', { name: 'Start game' }).click();
}

/** Keeps the opening hand when the mulligan dialog is shown. */
export async function keepHand(page: Page): Promise<void> {
  const dlg = page.getByRole('dialog', { name: 'Mulligan' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Keep hand' }).click();
  await expect(dlg).toBeHidden();
}

export const phaseTracker = (page: Page): Locator =>
  page.locator('[data-tutorial-id="phase-tracker"]');
export const endTurnButton = (page: Page): Locator =>
  page.locator('[data-tutorial-id="btn-end-turn"]');
export const passButton = (page: Page): Locator => page.locator('[data-tutorial-id="btn-pass"]');

/** "Turn N" from the phase tracker. */
export async function turnNumber(page: Page): Promise<number> {
  const m = /Turn (\d+)/.exec(await phaseTracker(page).innerText());
  return m ? Number(m[1]) : -1;
}

/** Everything that must be identical on both seats (mirrored for the viewer). */
export async function syncSnapshot(
  page: Page,
): Promise<{ turn: number; scores: string[]; phase: string }> {
  const turn = await turnNumber(page);
  const labels = await page
    .getByRole('list', { name: 'Scoreboard' })
    .getByRole('listitem')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const phase = await phaseTracker(page).locator('li[aria-current="step"]').allInnerTexts();
  // sort so "You"/"Opponent" order does not matter, and normalise the viewer label
  const scores = labels.map((l) => l.replace(/^(You|Opponent): /, '')).sort();
  return { turn, scores, phase: phase.join('|') };
}

const handCards = (page: Page): Locator =>
  page.getByRole('region', { name: 'Your hand' }).locator('[data-card-id]');

/** Card names currently shown in the viewer's hand (face-up cards only). */
export async function handCardNames(page: Page): Promise<string[]> {
  return handCards(page).evaluateAll((els) =>
    els.map((e) =>
      (e.getAttribute('aria-label') ?? '').replace(
        / \((?:(?:exhausted|\d+ damage|facedown|selected|disabled)(?:, )?)+\)$/,
        '',
      ),
    ),
  );
}

/** Highlighted (playable) hand cards. */
export const playableHandCards = (page: Page): Locator =>
  handCards(page)
    .filter({ has: page.locator(':scope') })
    .and(page.locator('.ring-amber-300'));

export async function isMyTurnWithPriority(page: Page): Promise<boolean> {
  return (await endTurnButton(page).count()) > 0;
}

/**
 * Plays one highlighted hand card, if there is one, on an active main phase. Handles the common
 * follow-ups (payment popovers are auto-resolved by the app when unambiguous). Returns true when the
 * hand shrank.
 */
export async function tryPlayHandCard(page: Page): Promise<boolean> {
  const cards = playableHandCards(page);
  if ((await cards.count()) === 0) return false;
  const before = (await handCardNames(page)).length;
  await cards.first().click();
  // a popover (target / destination choices) may open: pick its first enabled option
  const pop = page.getByRole('menu').first();
  if (await pop.isVisible().catch(() => false)) {
    await pop
      .getByRole('menuitem')
      .first()
      .click()
      .catch(() => undefined);
  }
  try {
    await expect
      .poll(async () => (await handCardNames(page)).length, { timeout: 3000 })
      .toBeLessThan(before);
    return true;
  } catch {
    await page.keyboard.press('Escape');
    return false;
  }
}

/** Text that changes whenever the game advances (turn, phase, whose turn). */
export async function progressKey(page: Page): Promise<string> {
  return (await phaseTracker(page).innerText()).replace(/s+/g, ' ');
}

/** Whichever primary action button is showing: "End turn" or "Pass"/"Pass focus". */
export const primaryButton = (page: Page): Locator =>
  page.locator('[data-tutorial-id="btn-end-turn"], [data-tutorial-id="btn-pass"]');

/**
 * Plays one of my turns (optionally casting a card first), ends it, then keeps passing priority /
 * focus until it is my main phase again two turn-numbers later. Works for solo and multiplayer.
 * `after` runs once per call, right after I clicked End turn (e.g. to assert on the opponent).
 */
export async function playRound(
  page: Page,
  opts: { playCard?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 90_000;
  let t0 = -1;
  let ended = false;
  let endedTurn = -1;
  await expect
    .poll(
      async () => {
        const turn = await turnNumber(page);
        if (t0 === -1) t0 = turn;
        const end = endTurnButton(page);
        if (await end.count()) {
          // A played card can leave a triggered ability on the Chain, which refuses End turn; if
          // End turn is still showing on the same turn, click it again.
          if (ended && turn === endedTurn) ended = false;
          if (!ended) {
            if (opts.playCard !== false) await tryPlayHandCard(page);
            await end.click({ timeout: 2000 }).catch(() => undefined);
            ended = true;
            endedTurn = turn;
            return 'ended';
          }
          return turn >= t0 + 2 ? 'done' : 'waiting';
        }
        const pass = page.locator('[data-tutorial-id="btn-pass"]');
        if (await pass.count()) {
          await pass.click({ timeout: 2000 }).catch(() => undefined);
          return 'passed';
        }
        return 'waiting';
      },
      { timeout, intervals: [150, 250, 500] },
    )
    .toBe('done');
}
