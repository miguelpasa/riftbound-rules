import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseBattlefieldAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'When combat starts here, the attacker and defender each [Add] [1].';
const BF_IDS = ['fx-bf-1', 'fx-bf-2', 'fx-bf-3', 'fx-bf-4', 'fx-bf-5', 'fx-bf-6'];

describe('scenario: "When combat starts here, the attacker and defender each [Add] [1]" (Threshold of the Gray)', () => {
  it('reads one trigger for the attacker and one for the defender', () => {
    // Tests Rule 466.2.c: attacker and defender designations when a combat Showdown starts
    const ts = parseBattlefieldAbilities(TEXT);
    expect(ts?.map((t) => t.on)).toEqual(['ATTACK', 'DEFEND']);
    expect(ts?.every((t) => JSON.stringify(t.effects) === '[{"op":"ADD_ENERGY","amount":1}]')).toBe(
      true,
    );
  });

  it('adds 1 Energy to both players when a combat starts at that battlefield', () => {
    // Tests Rule 466.2.c: both the attacker and the defender get the Energy
    const triggers = parseBattlefieldAbilities(TEXT) ?? [];
    const cards: CardDatabase = { ...SCENARIO_CARDS };
    for (const id of BF_IDS) {
      cards[id] = { ...(SCENARIO_CARDS[id] as CardDef), supportLevel: 'full', triggers };
    }
    const sc = Scenario.start({}, cards);
    sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const att = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [att],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    expect(sc.state.flow.chain).toHaveLength(2);
    const e0 = sc.player('p0').runePool.energy ?? 0;
    const e1 = sc.player('p1').runePool.energy ?? 0;
    for (let i = 0; i < 8 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
    expect(sc.player('p0').runePool.energy ?? 0).toBe(e0 + 1);
    expect(sc.player('p1').runePool.energy ?? 0).toBe(e1 + 1);
  });
});
