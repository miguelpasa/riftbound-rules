import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

describe('scenario: "When an opponent scores" (R92)', () => {
  it("fires for the other player's permanents when a player gains a point", () => {
    // Tests Rule 473: scoring a point is an event abilities can trigger on
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-tide-grunt': {
        ...(SCENARIO_CARDS['fx-tide-grunt'] as CardDef),
        triggers: [{ on: 'OPP_SCORES', effects: [{ op: 'DRAW', amount: 1 }] }],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    const hand = sc.player('p1').hand.length;
    // p0 conquers an empty battlefield and scores.
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p0');
    sc.pass('p1');
    for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect(sc.player('p0').points).toBe(1);
    expect(sc.player('p1').hand.length).toBe(hand + 1);
  });
});

describe('scenario: Tentacle tokens (R92)', () => {
  it('the token table has a 1 Might Tentacle', () => {
    // Tests Rule 186: tokens are defined by the built-in table
    expect(TOKEN_CARDS['tok-tentacle']?.stats.might).toBe(1);
  });
});

describe('parser: Tentacle tokens and score heads (R92)', () => {
  it('reads "from Bilgewater", "[1] [M]" and "when I score"', () => {
    // Tests Rule 186: parsed text
    expect(parseSpellText('Play two 1 [M] Tentacle unit tokens from Bilgewater.')).toEqual([
      { op: 'PLAY_TOKEN', token: 'tok-tentacle', count: 2 },
    ]);
    expect(
      parseCardAbilities(
        'When you play me or when I score, play a [1] [M] Tentacle unit token from Bilgewater.',
      )?.triggers.map((t) => t.on),
    ).toEqual(['PLAY', 'HOLD', 'CONQUER']);
    expect(parseCardAbilities('When an opponent scores, draw 1.')?.triggers[0]?.on).toBe(
      'OPP_SCORES',
    );
  });
});
