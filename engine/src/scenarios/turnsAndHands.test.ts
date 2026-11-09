import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { runEffects } from '../effects.js';
import { parseSpellText } from '../cardText.js';

describe('scenario: Time Warp and Invert Timelines', () => {
  it('parses them', () => {
    // Tests Rule 317.3: next turn
    expect(parseSpellText('Take a turn after this one. Banish this.')).toEqual([
      { op: 'EXTRA_TURN' },
      { op: 'BANISH_THIS_SPELL' },
    ]);
    expect(parseSpellText('Each player discards their hand, then draws 4.')).toEqual([
      { op: 'DISCARD_HAND', eachPlayer: true },
      { op: 'DRAW', amount: 4, eachPlayer: true },
    ]);
  });

  it('the same player takes the next turn after an extra turn effect', () => {
    // Tests Rule 317.3: the turn passes to the next player unless an effect gives another turn
    const sc = Scenario.start();
    const s = structuredClone(sc.state);
    runEffects(s, sc.state.turn.activePlayer, [{ op: 'EXTRA_TURN' }], sc.cards);
    sc.state = s;
    const me = sc.state.turn.activePlayer;
    const turn = sc.state.turn.number;
    sc.endTurn(me);
    expect(sc.state.turn.activePlayer).toBe(me);
    expect(sc.state.turn.number).toBe(turn + 1);
    expect(sc.state.extraTurnFor).toBeUndefined();
    sc.endTurn(me);
    expect(sc.state.turn.activePlayer).not.toBe(me);
  });

  it('each player discards their whole hand, then draws', () => {
    // Tests Rule 107.1.a: discarded cards go to the Trash
    const sc = Scenario.start();
    const s = structuredClone(sc.state);
    const before = s.players.map((p) => p.hand.length);
    expect(before.every((n) => n > 0)).toBe(true);
    const trashBefore = s.players.map((p) => p.trash.length);
    const ev = runEffects(
      s,
      'p0',
      parseSpellText('Each player discards their hand, then draws 4.') ?? [],
      sc.cards,
    );
    expect(s.players.map((p) => p.hand.length)).toEqual([4, 4]);
    expect(s.players[0].trash.length).toBe(trashBefore[0]! + before[0]!);
    expect(ev.filter((e) => e.type === 'HAND_DISCARDED')).toHaveLength(2);
  });
});
