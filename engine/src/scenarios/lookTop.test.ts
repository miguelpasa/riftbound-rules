import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const cast = (effect: CardEffect): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [effect],
  },
});

/** Cast the Flare with the top of p0's deck replaced by `tops` (card ids), return the sc and top object ids. */
function run(effect: CardEffect, tops: string[]): { sc: Scenario; ids: string[] } {
  const sc = Scenario.start({}, cast(effect));
  const spell = sc.putInHand('p0', 'fx-flare');
  const ids = (sc.state.players[0]?.mainDeck ?? []).slice(0, tops.length);
  ids.forEach((id, k) => {
    sc.obj(id).cardId = tops[k] as string;
  });
  sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1) });
  sc.pass('p1');
  sc.pass('p0');
  return { sc, ids };
}

describe('scenario: look at the top cards with limits (R96)', () => {
  it('takes the first card that matches the type and Energy limits, recycling the rest', () => {
    // Tests Rule 159: look at the top cards, take one, put the rest on the bottom
    const { sc, ids } = run(
      { op: 'LOOK_TOP', count: 3, take: { filter: 'unit', reveal: true, maxEnergy: 1 } },
      ['fx-titan', 'fx-wisp', 'fx-flare'],
    );
    // fx-titan is too expensive, fx-wisp (cheap unit) is taken.
    const hand = sc.player('p0').hand;
    expect(hand).toContain(ids[1]);
    expect(hand).not.toContain(ids[0]);
    const deck = sc.player('p0').mainDeck;
    expect(deck.slice(-2)).toEqual([ids[0], ids[2]]);
  });

  it('can put the cards that are not taken into the Trash', () => {
    // Tests Rule 159: "Put the rest into your trash"
    const { sc, ids } = run({ op: 'LOOK_TOP', count: 3, take: {}, rest: 'TRASH' }, [
      'fx-grunt',
      'fx-grunt',
      'fx-titan',
    ]);
    const trash = sc.player('p0').trash;
    const taken = sc.player('p0').hand.filter((id) => ids.includes(id));
    expect(taken).toHaveLength(1);
    for (const id of ids.filter((x) => !taken.includes(x))) expect(trash).toContain(id);
    expect(
      sc.obj(ids[0] as string).zone.kind === 'hand' ||
        sc.obj(ids[0] as string).zone.kind === 'trash',
    ).toBe(true);
  });

  it('a spell filter finds only spells', () => {
    // Tests Rule 159: the filter limits what can be drawn
    const { sc, ids } = run(
      { op: 'LOOK_TOP', count: 2, take: { filter: 'spell', reveal: true, minEnergy: 99 } },
      ['fx-grunt', 'fx-flare'],
    );
    expect(sc.player('p0').hand).not.toContain(ids[0]);
    expect(sc.player('p0').hand).not.toContain(ids[1]); // no spell costs 99
  });
});

describe('parser: look at the top with limits (R96)', () => {
  it('reads the filters, Draw-one-recycle-other and Put-the-rest-into-trash', () => {
    // Tests Rule 159: parsed text
    expect(
      parseCardAbilities(
        'When you play me, look at the top 4 cards of your Main Deck. You may reveal a spell with Energy cost [4] or more from among them and draw it. Recycle the rest.',
      )?.triggers[0]?.effects,
    ).toEqual([
      { op: 'LOOK_TOP', count: 4, take: { filter: 'spell', reveal: true, minEnergy: 4 } },
    ]);
    expect(
      parseSpellText('Look at the top 2 cards of your Main Deck. Draw one and recycle the other.'),
    ).toEqual([{ op: 'LOOK_TOP', count: 2, take: {} }]);
    expect(
      parseSpellText(
        'Look at the top 3 cards of your Main Deck. You may choose a card from among them and draw it. Put the rest into your trash.',
      ),
    ).toEqual([{ op: 'LOOK_TOP', count: 3, take: {}, rest: 'TRASH' }]);
  });
});
