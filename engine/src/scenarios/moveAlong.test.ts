import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT =
  'When I move to a battlefield, you may pay [C] to move a unit you control to the same battlefield.';

function setup(): { sc: Scenario; porter: string; buddy: string } {
  const fx = parseCardAbilities(TEXT);
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers: fx?.triggers ?? [] },
  };
  const sc = Scenario.start({}, cards);
  const porter = sc.putUnit('p0', 'fx-grunt', 'base');
  const buddy = sc.putUnit('p0', 'fx-ash-tank', 'base');
  sc.giveRunes('p0', 2);
  sc.do({
    type: 'STANDARD_MOVE',
    playerId: 'p0',
    unitIds: [porter],
    destination: { kind: 'battlefield', battlefieldId: 'bf1' },
  });
  return { sc, porter, buddy };
}

describe('scenario: "When I move to a battlefield, you may pay [C] to move a unit you control to the same battlefield" (Fae Porter)', () => {
  it('reads a MOVE trigger with an optional [C] cost and a move-here effect', () => {
    // Tests Rule 303: parsed trigger text
    expect(parseCardAbilities(TEXT)?.triggers[0]).toEqual({
      on: 'MOVE',
      optional: { power: 1 },
      effects: [{ op: 'MOVE_HERE_TARGET', side: 'friendly' }],
    });
  });

  it('moves the chosen unit along when the cost is paid, and not when declined', () => {
    // Tests Rule 303: a "you may pay" ability is paid only on accept
    for (const accept of [true, false]) {
      const { sc, porter, buddy } = setup();
      for (let i = 0; i < 8 && !sc.state.flow.pendingChoice; i++) sc.pass(sc.state.flow.priority!);
      let pc = sc.state.flow.pendingChoice;
      if (pc?.kind === 'TRIGGER_TARGET') {
        sc.do({
          type: 'CHOOSE_TRIGGER_TARGET',
          playerId: pc.player,
          chainItemId: pc.chainItemId,
          targets: [{ kind: 'object', id: buddy }],
        });
        for (let i = 0; i < 8 && !sc.state.flow.pendingChoice; i++) sc.pass(sc.state.flow.priority!);
        pc = sc.state.flow.pendingChoice;
      }
      expect(pc?.kind).toBe('OPTIONAL_EFFECT');
      if (pc?.kind !== 'OPTIONAL_EFFECT') return;
      sc.do({ type: 'DECIDE_OPTIONAL', playerId: 'p0', chainItemId: pc.chainItemId, accept });
      expect(sc.obj(porter).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
      expect(sc.obj(buddy).zone.kind).toBe(accept ? 'battlefield' : 'base');
    }
  });
});
