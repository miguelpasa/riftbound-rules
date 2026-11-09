import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { fireTriggers } from '../triggers.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardInstance, GameEvent } from '../types/index.js';

const cards: CardDatabase = {
  ...TOKEN_CARDS,
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    triggers: [{ on: 'DISCARD_SELF', effects: [{ op: 'PLAY_SELF' }] }],
  },
};

describe('scenario: "When you discard me" (X9)', () => {
  it('fires for the discarded card in the Trash, and "play me" returns it to the base', () => {
    // Tests Rule 598.1.b: a card discarded triggers its own "when you discard me"
    const sc = Scenario.start({}, cards);
    const g = sc.putInHand('p0', 'fx-grunt');
    const s = structuredClone(sc.state);
    const o = s.objects[g] as CardInstance;
    s.players[0].hand = s.players[0].hand.filter((x) => x !== g);
    s.players[0].trash.push(g);
    o.zone = { kind: 'trash', player: 'p0' };
    const ev = {
      seq: 1,
      type: 'COST_CARDS_PAID',
      player: 'p0',
      sourceId: 'o0',
      kind: 'DISCARD',
      cardIds: [g],
      cardNames: ['x'],
    } as GameEvent;
    const t = fireTriggers(s, cards, [ev]);
    expect(t.state.flow.chain).toHaveLength(1);
    sc.state = t.state;
    for (let k = 0; k < 6 && sc.state.flow.chain.length > 0; k++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect((sc.state.objects[g] as CardInstance).zone.kind).toBe('base');
    expect(sc.state.players[0].trash).not.toContain(g);
  });

  it('parses Flame Chompers and Mask Mother', () => {
    // Tests Rule 598.1.b: triggers on being discarded
    const chompers = parseCardAbilities('When you discard me, you may pay [C] to play me.');
    expect(chompers?.triggers[0]).toMatchObject({
      on: 'DISCARD_SELF',
      optional: { power: 1 },
      effects: [{ op: 'PLAY_SELF' }],
    });
    const mother = parseCardAbilities(
      'When you discard me, you may pay [1] to give a friendly unit +2 [M] this turn.',
    );
    expect(mother?.triggers[0]).toMatchObject({ on: 'DISCARD_SELF', optional: { energy: 1 } });
  });
});
