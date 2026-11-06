import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { runEffects } from '../effects.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

/** Every card costs 0 except the given card id, which costs 9 (too expensive to keep on top). */
function costs(expensive: string): CardDatabase {
  const db: CardDatabase = {};
  for (const [id, def] of Object.entries(SCENARIO_CARDS)) {
    db[id] = {
      ...(def as CardDef),
      cost: { ...(def as CardDef).cost, energy: id === expensive ? 9 : 0 },
    };
  }
  return db;
}

describe('scenario: Predict / Vision (R55)', () => {
  it('recycles an unaffordable top card to the bottom and keeps playable ones on top', () => {
    // Tests Rule 359: effects resolve in printed order; the deck keeps its remaining order
    const probe = Scenario.start();
    const deck = probe.state.players[0]?.mainDeck as string[];
    const topCard = probe.state.objects[deck[0] as string]?.cardId as string;
    const sc = Scenario.start({}, costs(topCard));
    const before = [...(sc.state.players[0]?.mainDeck as string[])];
    const s = structuredClone(sc.state);
    const ev = runEffects(s, 'p0', [{ op: 'PREDICT', count: 1 }], sc.cards);
    const after = s.players[0]?.mainDeck as string[];
    expect(after).toHaveLength(before.length);
    expect(after[after.length - 1]).toBe(before[0]);
    expect(after.slice(0, -1)).toEqual(before.slice(1));
    expect(ev.map((e) => e.type)).toEqual(['CARDS_LOOKED_AT', 'CARDS_RECYCLED']);
  });

  it('keeps everything when nothing is too expensive', () => {
    // Tests Rule 359: a no-op Predict leaves the deck order alone
    const sc = Scenario.start({}, costs('none'));
    const before = [...(sc.state.players[0]?.mainDeck as string[])];
    const s = structuredClone(sc.state);
    const ev = runEffects(s, 'p0', [{ op: 'PREDICT', count: 3 }], sc.cards);
    expect(s.players[0]?.mainDeck).toEqual(before);
    expect(ev.map((e) => e.type)).toEqual(['CARDS_LOOKED_AT']);
  });
});

describe('parser: Predict / Vision', () => {
  it('reads [Predict N] sentences and the Vision keyword as a play trigger', () => {
    // Tests Rule 359: parsed text
    expect(parseSpellText('Give a unit [Shield 2] this turn. [Predict].')).toEqual([
      { op: 'GRANT_KEYWORD_TARGET', keywords: [{ name: 'Shield', value: 2 }] },
      { op: 'PREDICT', count: 1 },
    ]);
    expect(parseCardAbilities('When you play me, [Predict 2].')?.triggers[0]?.effects).toEqual([
      { op: 'PREDICT', count: 2 },
    ]);
    expect(parseCardAbilities('[Vision]')?.triggers[0]).toMatchObject({
      on: 'PLAY',
      effects: [{ op: 'PREDICT', count: 1 }],
    });
  });
});
