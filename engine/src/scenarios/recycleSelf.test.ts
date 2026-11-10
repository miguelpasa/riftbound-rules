import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

const text = '[Deathknell] — Recycle me to ready your runes.';
const triggers = parseCardAbilities(text)?.triggers ?? [];
/** `fx-grunt` stands in for Ekko. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers },
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [{ op: 'KILL_TARGET' }],
  },
};

function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0 && !sc.state.flow.pendingChoice; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

/** Ekko dies with every rune exhausted; returns the scenario waiting on the optional recycle. */
function ekkoDies(): { sc: Scenario; ekko: string; chainItemId: string } {
  const sc = Scenario.start({}, cards);
  const ekko = sc.putUnit('p0', 'fx-grunt', 'base');
  sc.giveRunes('p0', 3);
  const flare = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', flare, {
    payment: sc.exhaustPlan('p0', 1),
    targets: [{ kind: 'object', id: ekko }],
  });
  for (const id of sc.state.players[0]?.base ?? []) {
    const o = sc.state.objects[id];
    if (o && cards[o.cardId]?.type === 'RUNE') o.ready = false;
  }
  sc.pass('p1');
  sc.pass('p0');
  settle(sc);
  const pc = sc.state.flow.pendingChoice;
  if (pc?.kind !== 'OPTIONAL_EFFECT') throw new Error('no optional choice: ' + JSON.stringify(pc));
  return { sc, ekko, chainItemId: pc.chainItemId };
}

const runes = (sc: Scenario, onlyReady: boolean): number =>
  (sc.state.players[0]?.base ?? []).filter((id) => {
    const o = sc.state.objects[id];
    return o && cards[o.cardId]?.type === 'RUNE' && (!onlyReady || o.ready);
  }).length;
const readyRunes = (sc: Scenario): number => runes(sc, true);

describe('parser: "Recycle me to ready your runes" (Ekko)', () => {
  it('reads an optional self-recycle cost and a ready-all-runes effect', () => {
    // Tests Rule 583: triggered abilities have a trigger condition and an effect
    expect(triggers).toMatchObject([
      { on: 'DEATH', optional: { recycleSelf: true }, effects: [{ op: 'READY_RUNES', count: 99 }] },
    ]);
  });
});

describe('scenario: Deathknell "Recycle me to ready your runes"', () => {
  it('accepting puts the card in the Main Deck and readies the runes', () => {
    // Tests Rule 583: the optional cost is paid together with the effect
    const { sc, ekko, chainItemId } = ekkoDies();
    expect(sc.obj(ekko).zone.kind).toBe('trash');
    expect(readyRunes(sc)).toBe(0);
    sc.do({ type: 'DECIDE_OPTIONAL', playerId: 'p0', chainItemId, accept: true } as Intent);
    expect(sc.obj(ekko).zone.kind).toBe('mainDeck');
    expect(sc.player('p0').trash).not.toContain(ekko);
    expect(readyRunes(sc)).toBe(runes(sc, false)); // every rune in play
  });

  it('declining keeps the card in the Trash and the runes exhausted', () => {
    // Tests Rule 583: declining pays nothing and skips the effect
    const { sc, ekko, chainItemId } = ekkoDies();
    sc.do({ type: 'DECIDE_OPTIONAL', playerId: 'p0', chainItemId, accept: false } as Intent);
    expect(sc.obj(ekko).zone.kind).toBe('trash');
    expect(readyRunes(sc)).toBe(0);
  });
});
