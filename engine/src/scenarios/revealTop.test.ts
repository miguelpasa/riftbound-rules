import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { runEffects } from '../effects.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardEffect, CardInstance } from '../types/index.js';

/** Put a copy of `cardId` on top of p0's Main Deck, run `effect`, and report where the card went. */
function reveal(cardId: string, effect: CardEffect) {
  const sc = Scenario.start();
  const src = sc.putUnit('p0', 'fx-grunt', 'base');
  const s2 = structuredClone(sc.state);
  const deck = s2.players[0].mainDeck;
  const id = deck.find((x) => (s2.objects[x] as CardInstance).cardId === cardId) as string;
  deck.splice(deck.indexOf(id), 1);
  deck.unshift(id);
  const handBefore = s2.players[0].hand.length;
  const out = runEffects(s2, 'p0', [effect], sc.cards, [], 'fx-grunt', src);
  const o = s2.objects[id] as CardInstance;
  return {
    zone: o.zone.kind,
    atBottom: s2.players[0].mainDeck[s2.players[0].mainDeck.length - 1] === id,
    handGain: s2.players[0].hand.length - handBefore,
    revealed: out.some((e) => e.type === 'CARD_REVEALED'),
    srcBonus: (s2.objects[src] as CardInstance).mightBonus,
  };
}

describe('scenario: reveal the top card (Apprentice Smith, Raving Witness, Pakaa Protector)', () => {
  it('parses the reveal sentences', () => {
    // Tests Rule 598: revealing a card shows it to every player
    const r = parseCardAbilities(
      "When I move, reveal the top card of your Main Deck. If it's a gear, draw it. Otherwise, recycle it.",
    );
    expect(r?.triggers[0]?.effects).toEqual([
      { op: 'REVEAL_TOP', filter: 'gear', hit: 'DRAW', miss: 'RECYCLE' },
    ]);
  });

  it('draws a card that matches, and shows it first', () => {
    // Tests Rule 598: revealing a card shows it to every player
    const r = reveal('fx-blade', {
      op: 'REVEAL_TOP',
      filter: 'gear',
      hit: 'DRAW',
      miss: 'RECYCLE',
    });
    expect(r.zone).toBe('hand');
    expect(r.revealed).toBe(true);
    expect(r.handGain).toBe(1);
  });

  it('recycles a card that does not match', () => {
    // Tests Rule 598: revealing a card shows it to every player
    const r = reveal('fx-grunt', {
      op: 'REVEAL_TOP',
      filter: 'gear',
      hit: 'DRAW',
      miss: 'RECYCLE',
    });
    expect(r.zone).toBe('mainDeck');
    expect(r.atBottom).toBe(true);
    expect(r.handGain).toBe(0);
  });

  it('puts a miss in the trash and buffs the source (Pakaa Protector)', () => {
    // Tests Rule 598: revealing a card shows it to every player
    const r = reveal('fx-blade', {
      op: 'REVEAL_TOP',
      filter: 'unit',
      hit: 'DRAW',
      miss: 'TRASH',
      missBuff: 2,
    });
    expect(r.zone).toBe('trash');
    expect(r.srcBonus).toBe(2);
  });

  it('puts a hit in the hand without a draw (Ravenbloom Conservatory)', () => {
    // Tests Rule 598: revealing a card shows it to every player
    const r = reveal('fx-flare', {
      op: 'REVEAL_TOP',
      filter: 'spell',
      hit: 'HAND',
      miss: 'RECYCLE',
    });
    expect(r.zone).toBe('hand');
    expect(r.handGain).toBe(1);
  });
});
