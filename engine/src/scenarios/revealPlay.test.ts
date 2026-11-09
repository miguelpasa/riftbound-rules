import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { runEffects } from '../effects.js';
import type { CardEffect, CardInstance, GameState } from '../types/index.js';

/** Put the cards with these card ids on top of `player`'s Main Deck (first = top), run the effect. */
function run(
  topIds: string[],
  effect: CardEffect,
  opts: { giveRunes?: boolean } = {},
): { s: GameState; ids: string[]; events: string[]; sc: Scenario } {
  const sc = Scenario.start();
  if (opts.giveRunes) sc.giveRunes('p0', 6);
  const s = structuredClone(sc.state);
  const deck = s.players[0].mainDeck;
  const ids = topIds.map((cardId) => {
    const id = deck.find(
      (x) => (s.objects[x] as CardInstance).cardId === cardId && !topIds.slice(0).includes(x),
    ) as string;
    return id;
  });
  const uniq = [...new Set(ids)];
  for (const id of uniq) deck.splice(deck.indexOf(id), 1);
  deck.unshift(...uniq);
  const out = runEffects(s, 'p0', [effect], sc.cards, [], 'fx-grunt', '');
  return { s, ids: uniq, events: out.map((e) => e.type), sc };
}

describe('scenario: reveal, banish and play (Dazzling Aurora, Void Rush, Blind Fury)', () => {
  it('reveals until a unit, plays it for free and recycles the rest', () => {
    // Tests Rule 595.3: a card played by an effect is played like any other
    const { s, ids, events } = run(['fx-blade', 'fx-grunt'], {
      op: 'REVEAL_PLAY',
      from: 'SELF',
      untilUnit: true,
      play: 'ALL',
      rest: 'RECYCLE',
    });
    const [gear, unit] = ids as [string, string];
    expect((s.objects[unit] as CardInstance).zone.kind).toBe('base');
    expect(s.players[0].mainDeck[s.players[0].mainDeck.length - 1]).toBe(gear);
    expect(events.filter((t) => t === 'CARD_REVEALED')).toHaveLength(2);
    expect(events).toContain('CARD_PLAYED');
  });

  it('plays the most expensive card, reduced, and draws the one it did not banish', () => {
    // Tests Rule 595.3: a card played by an effect is played like any other
    const { s, ids } = run(
      ['fx-grunt', 'fx-wisp'],
      { op: 'REVEAL_PLAY', from: 'SELF', count: 2, play: 'REDUCE', reduceBy: 9, rest: 'DRAW' },
      { giveRunes: true },
    );
    const [a, b] = ids as [string, string];
    const zones = [a, b].map((id) => (s.objects[id] as CardInstance).zone.kind).sort();
    expect(zones).toEqual(['base', 'hand']);
  });

  it('plays an opponent card under the control of the player who revealed it', () => {
    // Tests Rule 595.3: a card played by an effect is played like any other
    const sc = Scenario.start();
    const s = structuredClone(sc.state);
    const top = s.players[1].mainDeck.find(
      (x) => (s.objects[x] as CardInstance).cardId === 'fx-tide-grunt',
    ) as string;
    s.players[1].mainDeck.splice(s.players[1].mainDeck.indexOf(top), 1);
    s.players[1].mainDeck.unshift(top);
    runEffects(
      s,
      'p0',
      [{ op: 'REVEAL_PLAY', from: 'OPPONENT', count: 1, play: 'ALL', rest: 'RECYCLE' }],
      sc.cards,
    );
    const o = s.objects[top] as CardInstance;
    expect(o.owner).toBe('p1');
    expect(o.controller).toBe('p0');
    expect(o.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(s.players[0].base).toContain(top);
    expect(s.players[1].banishment).not.toContain(top);
  });
});
