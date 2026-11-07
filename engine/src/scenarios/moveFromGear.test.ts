import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

const BUFF1: CardTrigger['effects'] = [{ op: 'BUFF_SELF', amount: 1 }];
const withTrigger = (id: string, t: CardTrigger, extra: Partial<CardDef> = {}): CardDatabase => ({
  ...SCENARIO_CARDS,
  [id]: { ...(SCENARIO_CARDS[id] as CardDef), triggers: [t], ...extra },
});
const mightOf = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });
function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('scenario: "When I move from a battlefield" (R108)', () => {
  it('fires for a Ganking move between battlefields, not for the move out of the Base', () => {
    // Tests Rule 303: moving is an event units can trigger on
    const sc = Scenario.start(
      {},
      withTrigger(
        'fx-grunt',
        { on: 'MOVE_FROM', effects: BUFF1 },
        { keywords: [{ name: 'Ganking' }] },
      ),
    );
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const base = mightOf(sc, u);
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [u],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    settle(sc);
    expect(mightOf(sc, u)).toBe(base); // left the Base, not a battlefield
    sc.pass('p0');
    sc.pass('p1'); // the Showdown at bf1 ends
    sc.setReady(u, true);
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [u],
      destination: {
        kind: 'battlefield',
        battlefieldId: sc.state.battlefields.find((b) => b.id !== 'bf1')?.id as string,
      },
    });
    settle(sc);
    expect(mightOf(sc, u)).toBe(base + 1);
  });
});

describe('scenario: "When you use an activated ability of a gear" (R108)', () => {
  it("fires when a gear's ability is used", () => {
    // Tests Rule 145.1: using an activated ability is an event
    const cards: CardDatabase = {
      ...withTrigger('fx-grunt', { on: 'USE_GEAR_ABILITY', effects: BUFF1 }),
      'fx-ember-totem': {
        ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef),
        abilities: [{ cost: { exhaust: true }, effects: [{ op: 'DRAW', amount: 1 }] }],
      },
    };
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.giveRunes('p0', 2);
    const totem = sc.putInHand('p0', 'fx-ember-totem');
    sc.play('p0', totem, { payment: sc.exhaustPlan('p0', 2) });
    settle(sc);
    const base = mightOf(sc, u);
    sc.do({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: totem,
      abilityIndex: 0,
      payment: [],
    });
    settle(sc);
    expect(mightOf(sc, u)).toBe(base + 1);
  });
});

describe('parser: move-from and gear-ability heads (R108)', () => {
  it('reads them', () => {
    // Tests Rule 303: parsed text
    expect(
      parseCardAbilities('When I move from a battlefield, give me +2 [M] this turn.')?.triggers[0]
        ?.on,
    ).toBe('MOVE_FROM');
    expect(
      parseCardAbilities('When you use an activated ability of a gear, give me +1 [M] this turn.')
        ?.triggers[0]?.on,
    ).toBe('USE_GEAR_ABILITY');
  });
});
