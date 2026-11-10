import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { allowedModes } from '../triggers.js';
import { getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

const D = '—';
const TEXT = `When I become exhausted, choose one that hasn't been chosen this turn ${D}\n- [Buff] me.\n- Spend my buff to [Stun] an enemy unit.\n- Spend my buff to ready me.`;

function setup(buffed: boolean): { sc: Scenario; riven: string } {
  const fx = parseCardAbilities(TEXT);
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers: fx?.triggers ?? [] },
  };
  const sc = Scenario.start({}, cards);
  const riven = sc.putUnit('p0', 'fx-grunt', 'base');
  sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
  if (buffed) (sc.state.objects[riven] as { buffed?: boolean }).buffed = true;
  sc.do({
    type: 'STANDARD_MOVE',
    playerId: 'p0',
    unitIds: [riven],
    destination: { kind: 'battlefield', battlefieldId: 'bf0' },
  });
  return { sc, riven };
}

describe('scenario: "Spend my buff to ..." modes (Riven)', () => {
  it('reads the three modes, the last two costing the source’s own buff', () => {
    // Tests Rule 583.3: a triggered ability with modes
    const t = parseCardAbilities(TEXT)?.triggers[0];
    expect(t?.on).toBe('BECOME_EXHAUSTED');
    expect(t?.modes).toHaveLength(3);
    expect(t?.modeOptional?.map((c) => c?.card?.kind)).toEqual([undefined, 'SPEND_BUFF', 'SPEND_BUFF']);
  });

  it('a mode that spends my buff cannot be chosen while I have no buff', () => {
    // Tests Rule 583.3: a mode whose cost cannot be paid is not available
    const { sc } = setup(false);
    const item = sc.state.flow.chain.find((i) => i.triggered);
    expect(item).toBeDefined();
    expect(allowedModes(sc.state, sc.cards, item as never)).toEqual([0]);
  });

  it('with a buff all three modes are available, and the buff mode needs no cost', () => {
    // Tests Rule 583.3: modes are chosen as the ability is put on the Chain
    const { sc } = setup(true);
    const item = sc.state.flow.chain.find((i) => i.triggered);
    expect(allowedModes(sc.state, sc.cards, item as never)).toEqual([0, 1, 2]);
    const answers = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i): i is Extract<Intent, { type: 'CHOOSE_TRIGGER_TARGET' }> =>
        i.type === 'CHOOSE_TRIGGER_TARGET',
    );
    expect(answers.map((a) => a.mode)).toContain(2);
  });

  it('"Spend my buff to ready me": pays the buff and readies the unit', () => {
    // Tests Rule 583.3: the chosen mode resolves; its cost is paid on accept
    const { sc, riven } = setup(true);
    expect(sc.obj(riven).ready).toBe(false); // exhausted by the move
    const item = sc.state.flow.chain.find((i) => i.triggered) as { id: string };
    sc.do({ type: 'CHOOSE_TRIGGER_TARGET', playerId: 'p0', chainItemId: item.id, targets: [], mode: 2 });
    for (let i = 0; i < 8 && sc.state.flow.pendingChoice?.kind !== 'OPTIONAL_EFFECT'; i++) {
      sc.pass(sc.state.flow.priority!);
    }
    const pc = sc.state.flow.pendingChoice as { kind: string; chainItemId: string };
    expect(pc.kind).toBe('OPTIONAL_EFFECT');
    const spend = getLegalActions(sc.state, sc.cards, 'p0').find(
      (i): i is Extract<Intent, { type: 'DECIDE_OPTIONAL' }> =>
        i.type === 'DECIDE_OPTIONAL' && i.accept,
    );
    expect(spend?.costCards).toEqual([riven]);
    sc.do(spend as Intent);
    expect(sc.obj(riven).ready).toBe(true);
    expect(sc.obj(riven).buffed).toBeFalsy();
  });
});
