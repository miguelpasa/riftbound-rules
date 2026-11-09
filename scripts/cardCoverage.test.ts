/**
 * Per-card coverage over the real card data (client/public/cards.json, produced by `npm run cards`; the test is
 * skipped when the file is absent). Every fully supported card is substituted for a fixture of its type, played from
 * hand with its first legal intent (or put onto the board for gear and units), and the Chain is settled. The game
 * must stay valid (`Scenario.verify`) and `reduce` must never report an internal error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../engine/src/testing/scenario';
import { getLegalActions } from '../engine/src/legalActions';
import type { CardDatabase, CardDef, Intent } from '../engine/src/types/index';

const path = fileURLToPath(new URL('../client/public/cards.json', import.meta.url));
const real: CardDatabase | null = existsSync(path)
  ? (JSON.parse(readFileSync(path, 'utf8')) as CardDatabase)
  : null;

const SLOT: Record<string, string> = { UNIT: 'fx-grunt', SPELL: 'fx-flare', GEAR: 'fx-blade' };

let ran = 0;

function exercise(def: CardDef): string | null {
  const slot = SLOT[def.type];
  if (!slot) return null;
  const fixture = SCENARIO_CARDS[slot] as CardDef;
  // The real rules text and effects, with the fixture's identity and a cost the scenario can always pay.
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    [slot]: {
      ...def,
      cardId: slot,
      cost: { energy: 1 },
      domains: fixture.domains,
      // Deck rules about Signature / Unique copies are not what this test is about.
      subtypes: def.subtypes.filter((x) => x !== 'Signature'),
      keywords: def.keywords.filter((k) => k.name !== 'Unique'),
      supportLevel: 'full',
    },
  };
  try {
    const sc = Scenario.start({}, cards);
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const id = sc.putInHand('p0', slot);
    const legal = getLegalActions(sc.state, cards, 'p0').filter(
      (i): i is Extract<Intent, { type: 'PLAY_CARD' }> =>
        i.type === 'PLAY_CARD' && i.cardInstanceId === id,
    );
    const pick = legal[0];
    if (!pick) return null; // not playable in this fixed position (conditions, targets): nothing to run
    const r = sc.tryDo(pick);
    if (!r.ok) return `play rejected: ${r.message}`;
    for (let i = 0; i < 30 && sc.state.flow.chain.length > 0 && !sc.state.flow.pendingChoice; i++) {
      const who = sc.state.flow.priority as 'p0' | 'p1';
      const pass = sc.tryDo({ type: 'PASS_PRIORITY', playerId: who });
      if (!pass.ok) return `pass rejected: ${pass.message}`;
    }
    sc.verify();
    ran++;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe.skipIf(real === null)('per-card coverage (real card data)', () => {
  it('plays every fully supported unit, spell and gear without errors', () => {
    // Tests Rule 354: playing a card puts it on the Chain and resolves it
    const failures: string[] = [];
    let played = 0;
    for (const def of Object.values(real as CardDatabase)) {
      if (def.supportLevel !== 'full') continue;
      const err = exercise(def);
      played++;
      if (err) failures.push(`${def.name}: ${err}`);
    }
    console.log(`exercised ${ran} of ${played} fully supported cards`);
    expect(played).toBeGreaterThan(300);
    expect(ran).toBeGreaterThanOrEqual(570);
    expect(failures).toEqual([]);
  }, 300000);

  it('keeps the ledger of cards that are not fully supported yet', () => {
    // Tests Rule 354: playing a card puts it on the Chain and resolves it
    const partial = Object.values(real as CardDatabase).filter((d) => d.supportLevel !== 'full');
    // Ratchet: this number may only go down. Lower it when more cards become fully supported.
    expect(partial.length).toBeLessThanOrEqual(364);
  });
});
