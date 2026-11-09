import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import { allowedModes } from '../triggers.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger, Intent, PlayerId } from '../types/index.js';

const modal = (over: Partial<CardTrigger> = {}): CardTrigger => ({
  on: 'PLAY',
  effects: [],
  modes: [
    [{ op: 'DRAW', amount: 1 }],
    [{ op: 'GRANT_KEYWORDS', keywords: [{ name: 'Ganking' }], to: 'SELF' }],
  ],
  modeTexts: ['Draw 1.', '[Ganking]'],
  ...over,
});

const cardsWith = (t: CardTrigger): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers: [t] },
});

/** Play fx-grunt so its modal "when you play me" ability goes on the Chain and waits for a mode. */
function playIt(sc: Scenario): string {
  sc.giveRunes('p0', 4);
  const g = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
  return g;
}

const answers = (sc: Scenario): Extract<Intent, { type: 'CHOOSE_TRIGGER_TARGET' }>[] =>
  getLegalActions(sc.state, sc.cards, 'p0').filter(
    (i): i is Extract<Intent, { type: 'CHOOSE_TRIGGER_TARGET' }> =>
      i.type === 'CHOOSE_TRIGGER_TARGET',
  );

describe('scenario: "choose one —" triggered abilities (Jayce, Reckless Innovator, Minah)', () => {
  it('parses the bullets as modes, with their printed text', () => {
    // Tests Rule 583.3: a triggered ability with modes
    const r = parseCardAbilities(
      'When I become ready, choose one to give me this turn —\n- [Assault 2]\n- [Deflect 2]\n- [Ganking]',
    );
    expect(r?.triggers[0]).toMatchObject({
      on: 'BECOME_READY',
      effects: [],
      modeTexts: ['[Assault 2]', '[Deflect 2]', '[Ganking]'],
    });
    expect(r?.triggers[0]?.modes).toHaveLength(3);
    const once = parseCardAbilities(
      "When I become exhausted, choose one that hasn't been chosen this turn —\n- [Buff] me.\n- Ready me.",
    );
    expect(once?.triggers[0]?.modeOnce).toBe(true);
  });

  it('asks for a mode, lists one answer per mode, and runs only the chosen one', () => {
    // Tests Rule 583.3: the mode is chosen as the ability is put on the Chain
    const sc = Scenario.start({}, cardsWith(modal()));
    const g = playIt(sc);
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    const list = answers(sc);
    expect(list.map((a) => a.mode).sort()).toEqual([0, 1]);
    // a missing or unknown mode is refused
    const item = sc.state.flow.chain[0]?.id as string;
    sc.reject({ type: 'CHOOSE_TRIGGER_TARGET', playerId: 'p0', chainItemId: item, targets: [] });
    sc.reject({
      type: 'CHOOSE_TRIGGER_TARGET',
      playerId: 'p0',
      chainItemId: item,
      targets: [],
      mode: 5,
    });
    const hand = sc.player('p0').hand.length;
    sc.do({
      type: 'CHOOSE_TRIGGER_TARGET',
      playerId: 'p0',
      chainItemId: item,
      targets: [],
      mode: 0,
    });
    for (let k = 0; k < 6 && sc.state.flow.chain.length > 0; k++) {
      sc.pass(sc.state.flow.priority as PlayerId);
    }
    expect(sc.player('p0').hand.length).toBe(hand + 1);
    expect(sc.obj(g).tempKeywords).toBeUndefined();
  });

  it('a mode already chosen this turn cannot be chosen again (modeOnce)', () => {
    // Tests Rule 583.3: "choose one that hasn't been chosen this turn"
    const sc = Scenario.start({}, cardsWith(modal({ modeOnce: true })));
    const g = playIt(sc);
    const item = sc.state.flow.chain[0]?.id as string;
    expect(allowedModes(sc.state, sc.cards, sc.state.flow.chain[0] as never)).toEqual([0, 1]);
    sc.do({
      type: 'CHOOSE_TRIGGER_TARGET',
      playerId: 'p0',
      chainItemId: item,
      targets: [],
      mode: 1,
    });
    expect(sc.obj(g).modesUsed).toEqual({ turn: sc.state.turn.number, used: { 0: [1] } });
    expect(allowedModes(sc.state, sc.cards, sc.state.flow.chain[0] as never)).toEqual([0]);
  });
});
