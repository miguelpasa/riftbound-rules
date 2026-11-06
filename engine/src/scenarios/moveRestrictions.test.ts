import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { expireTurnEffects, runEffects } from '../effects.js';
import { getLegalActions } from '../legalActions.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import { parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, StaticAbility } from '../types/index.js';

const withStatics = (statics: StaticAbility[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), statics },
});
const moves = (sc: Scenario, unit: string, to: 'base' | 'bf'): number =>
  getLegalActions(sc.state, sc.cards, 'p0').filter(
    (i) =>
      i.type === 'STANDARD_MOVE' &&
      i.unitIds.includes(unit) &&
      (to === 'base' ? i.destination.kind === 'base' : i.destination.kind === 'battlefield'),
  ).length;

describe('scenario: movement restrictions (R57)', () => {
  it('"can\'t move to base" removes that destination for the affected unit only', () => {
    // Tests Rule 144: a standard move needs a legal destination
    const sc = Scenario.start({}, withStatics([{ affects: 'SELF', restrict: 'NO_MOVE_TO_BASE' }]));
    const stuck = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const free = sc.putUnit('p0', 'fx-grunt', 'bf0');
    expect(moves(sc, stuck, 'base')).toBe(0);
    expect(moves(sc, free, 'base')).toBeGreaterThan(0);
    sc.reject({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [stuck],
      destination: { kind: 'base' },
    });
  });

  it('a static for all units restricts every unit', () => {
    // Tests Rule 144: the restriction reads the source's reach
    const sc = Scenario.start(
      {},
      withStatics([{ affects: 'ALL_UNITS', restrict: 'NO_MOVE_TO_BASE' }]),
    );
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const u = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    expect(moves(sc, u, 'base')).toBe(0);
  });

  it('"it can\'t move this turn" blocks all moves until the Ending step', () => {
    // Tests Rule 144: a locked unit cannot be moved; the lock expires with "this turn" effects
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'LOCK_MOVE_TARGET' }], sc.cards, [{ kind: 'object', id: u }]);
    sc.state = s;
    expect(moves(sc, u, 'base') + moves(sc, u, 'bf')).toBe(0);
    sc.state = expireTurnEffects(sc.state, sc.cards).state;
    expect(moves(sc, u, 'bf')).toBeGreaterThan(0);
  });
});

describe('parser: movement restrictions', () => {
  it('reads the static restrictions and "It can\'t move this turn"', () => {
    // Tests Rule 144: parsed text
    expect(parseStaticLines("I can't move to base.")?.statics).toEqual([
      { affects: 'SELF', restrict: 'NO_MOVE_TO_BASE' },
    ]);
    expect(parseStaticLines("Units can't move to base.")?.statics[0]?.affects).toBe('ALL_UNITS');
    expect(parseStaticLines("Units can't move from here to base.")?.statics[0]?.affects).toBe(
      'UNITS_HERE',
    );
    expect(parseSpellText("Ready a friendly unit. It can't move this turn. Draw 1.")).toEqual([
      { op: 'READY_TARGET', side: 'friendly' },
      { op: 'LOCK_MOVE_TARGET', side: 'friendly' },
      { op: 'DRAW', amount: 1 },
    ]);
    expect(parseCardAbilities('When you play me, draw 1.')).not.toBeNull();
  });
});
