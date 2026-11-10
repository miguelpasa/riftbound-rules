import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseStaticLines } from '../cardText.js';
import { computeAssignmentConstraints } from '../combat.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const text = 'You ignore [Tank] while assigning combat damage here.';
const statics = parseStaticLines(text)?.statics ?? [];
const toBf = (battlefieldId: string) => ({ kind: 'battlefield' as const, battlefieldId });

/** `fx-grunt` stands in for Dune Surfer. */
const surfer: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), statics },
};

/** p0 attacks bf1 with `attacker`; p1 defends with a Tank and an ordinary unit. Returns the required order. */
function tiersFor(cards: CardDatabase, attacker: 'fx-grunt' | 'fx-archer'): string[] {
  const sc = Scenario.start({}, cards);
  sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true }); // Tank, Might 3
  sc.putUnit('p1', 'fx-tide-grunt', 'bf1'); // ordinary
  const unit = sc.putUnit('p0', attacker, 'base');
  sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [unit], destination: toBf('bf1') });
  sc.pass('p0');
  sc.pass('p1');
  return computeAssignmentConstraints(sc.state, cards, 'p0').ordered.map((u) => u.tier);
}

describe('parser: "You ignore [Tank] while assigning combat damage here" (Dune Surfer)', () => {
  it('reads as a static on the unit', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(statics).toEqual([{ affects: 'SELF', ignoreTank: true }]);
  });
});

describe('scenario: ignoring Tank while assigning combat damage (467.2.c)', () => {
  it('without the static the Tank must be assigned damage first', () => {
    // Tests Rule 467.2.c: Tank units are assigned lethal damage first
    expect(tiersFor(SCENARIO_CARDS, 'fx-grunt')).toEqual(['TANK', 'NORMAL']);
  });

  it('with a Surfer among the attackers the Tank is an ordinary unit', () => {
    // Tests Rule 467.2.c: the assigner ignores Tank
    expect(tiersFor(surfer, 'fx-grunt')).toEqual(['NORMAL', 'NORMAL']);
  });
});
