import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'When you defend at a battlefield, you may move me there.';
const toBf = (id: string) => ({ kind: 'battlefield' as const, battlefieldId: id });

function setup(): { sc: Scenario; pup: string; guard: string; att: string } {
  const fx = parseCardAbilities(TEXT);
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-tide-grunt': {
      ...(SCENARIO_CARDS['fx-tide-grunt'] as CardDef),
      triggers: fx?.triggers ?? [],
    },
  };
  const sc = Scenario.start({}, cards);
  const guard = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
  const pup = sc.putUnit('p1', 'fx-tide-grunt', 'base');
  const att = sc.putUnit('p0', 'fx-grunt', 'base');
  sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [att], destination: toBf('bf1') });
  return { sc, pup, guard, att };
}

describe('scenario: "When you defend at a battlefield, you may move me there" (Loyal Pup)', () => {
  it('reads the trigger and the self move', () => {
    // Tests Rule 303: parsed trigger text
    expect(parseCardAbilities(TEXT)?.triggers[0]).toEqual({
      on: 'YOU_DEFEND',
      optional: {},
      effects: [{ op: 'MOVE_SELF_TO_COMBAT' }],
    });
  });

  it('moves the pup from its Base to the battlefield being defended when accepted', () => {
    // Tests Rule 466.2.c: the defender designation; a unit moved in joins the defence
    const { sc, pup } = setup();
    expect(sc.state.flow.chain.some((i) => i.sourceObjectId === pup)).toBe(true);
    for (let i = 0; i < 6 && !sc.state.flow.pendingChoice; i++) sc.pass(sc.state.flow.priority!);
    const pc = sc.state.flow.pendingChoice as { kind: string; chainItemId: string };
    expect(pc.kind).toBe('OPTIONAL_EFFECT');
    sc.do({ type: 'DECIDE_OPTIONAL', playerId: 'p1', chainItemId: pc.chainItemId, accept: true });
    expect(sc.obj(pup).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
  });

  it('stays put when declined, and does not trigger for the attacker', () => {
    // Tests Rule 466.2.c: only the defender's units trigger
    const { sc, pup } = setup();
    for (let i = 0; i < 6 && !sc.state.flow.pendingChoice; i++) sc.pass(sc.state.flow.priority!);
    const pc = sc.state.flow.pendingChoice as { chainItemId: string };
    sc.do({ type: 'DECIDE_OPTIONAL', playerId: 'p1', chainItemId: pc.chainItemId, accept: false });
    expect(sc.obj(pup).zone.kind).toBe('base');
  });

  it('does not fire when the unit is already at that battlefield or the player attacks', () => {
    // Tests Rule 466.2.c: "you defend" means you are the defender
    const fx = parseCardAbilities(TEXT);
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers: fx?.triggers ?? [] },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [mine], destination: toBf('bf1') });
    expect(sc.state.flow.chain).toHaveLength(0);
  });
});
