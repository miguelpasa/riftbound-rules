import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { reduce } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef, CostCardChoice, Intent } from '../types/index.js';

const equipWith = (card: CostCardChoice): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-blade': {
    ...(SCENARIO_CARDS['fx-blade'] as CardDef),
    equipCost: { energy: 0, power: 0, anyPower: 0, card },
  },
});

describe('scenario: Equip with a card-choice cost (Blade of the Ruined King, Last Rites)', () => {
  it('"Kill a friendly unit": needs the chosen unit, kills it, then attaches', () => {
    // Tests Rule 818: the Equip cost must be paid in full
    const cards = equipWith({ kind: 'KILL', what: 'unit' });
    const sc = Scenario.start({}, cards);
    const blade = sc.putUnit('p0', 'fx-blade', 'base');
    const carrier = sc.putUnit('p0', 'fx-grunt', 'base');
    const fodder = sc.putUnit('p0', 'fx-archer', 'base');
    const equip = (costCards?: string[]): ReturnType<typeof reduce> =>
      reduce(sc.state, cards, {
        type: 'EQUIP',
        playerId: 'p0',
        equipmentId: blade,
        unitId: carrier,
        ...(costCards ? { costCards } : {}),
      } as Intent);
    expect(equip().ok).toBe(false); // no cost cards chosen
    expect(equip([carrier]).ok).toBe(false); // cannot kill the unit being equipped
    const r = equip([fodder]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the fodder took lethal damage (Cleanup kills it); the Equip waits on the Chain
    expect(
      (r.state.objects[fodder]?.damage ?? 0) > 0 || r.state.objects[fodder]?.zone.kind === 'trash',
    ).toBe(true);
    expect(r.state.flow.chain.length).toBe(1);
  });

  it('"Recycle 2 cards from your trash": recycles exactly those cards', () => {
    // Tests Rule 818: the Equip cost must be paid in full
    const cards = equipWith({ kind: 'RECYCLE', count: 2 });
    const sc = Scenario.start({}, cards);
    const blade = sc.putUnit('p0', 'fx-blade', 'base');
    const carrier = sc.putUnit('p0', 'fx-grunt', 'base');
    const ps = sc.state.players[0] as { hand: string[]; trash: string[] };
    const moved = ps.hand.splice(0, 2);
    for (const id of moved) {
      ps.trash.push(id);
      (sc.state.objects[id] as { zone: unknown }).zone = { kind: 'trash', player: 'p0' };
    }
    const intent = (costCards: string[]): Intent =>
      ({
        type: 'EQUIP',
        playerId: 'p0',
        equipmentId: blade,
        unitId: carrier,
        costCards,
      }) as Intent;
    expect(reduce(sc.state, cards, intent([moved[0] as string])).ok).toBe(false); // needs 2
    const r = reduce(sc.state, cards, intent(moved));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const id of moved) expect(r.state.objects[id]?.zone.kind).toBe('mainDeck');
  });

  it('the legal actions offer the Equip with the cost cards chosen', () => {
    // Tests Rule 818: an Equip that cannot be paid is not offered
    const cards = equipWith({ kind: 'KILL', what: 'unit' });
    const sc = Scenario.start({}, cards);
    const blade = sc.putUnit('p0', 'fx-blade', 'base');
    const carrier = sc.putUnit('p0', 'fx-grunt', 'base');
    const fodder = sc.putUnit('p0', 'fx-archer', 'base');
    const equips = getLegalActions(sc.state, cards, 'p0').filter(
      (i) => i.type === 'EQUIP' && i.equipmentId === blade && i.unitId === carrier,
    );
    expect(equips.length).toBeGreaterThan(0);
    expect(equips.every((i) => (i as { costCards?: string[] }).costCards !== undefined)).toBe(true);
    expect(equips.some((i) => (i as { costCards?: string[] }).costCards?.includes(fodder))).toBe(
      true,
    );
  });
});
