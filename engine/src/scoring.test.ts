import { describe, it, expect } from 'vitest';
import { checkWin, gainPoints, holdScoringStep, onConquer, scoreBattlefield } from './scoring.js';
import { FIXTURE_CARDS, makeTestGame } from './testing/fixtures.js';
import type { GameState } from './types/index.js';

function game(): GameState {
  const s = makeTestGame('score');
  s.battlefields.forEach((b) => {
    b.controller = null;
    b.scoredThisTurnBy = [];
  });
  return s;
}
const bfId = (s: GameState, i: number): string => s.battlefields[i]!.id;

describe('holdScoringStep', () => {
  it('holds 1 point per controlled battlefield, not the opponent battlefields', () => {
    // Tests Rule 471.2: Hold scores each battlefield the turn player controls
    const s = game();
    s.battlefields[0]!.controller = 'p0';
    s.battlefields[1]!.controller = 'p1';
    const r = holdScoringStep(s, FIXTURE_CARDS);
    expect(r.state.players[0].points).toBe(1);
    expect(r.state.players[1].points).toBe(0);
    expect(r.events).toEqual([{ type: 'POINT_GAINED', player: 'p0', amount: 1, source: 'HOLD' }]);
    expect(s.players[0].points).toBe(0);
  });

  it('scores both battlefields when both are controlled', () => {
    // Tests Rule 473.1: each scoring gains one point
    const s = game();
    s.battlefields.forEach((b) => (b.controller = 'p0'));
    expect(holdScoringStep(s, FIXTURE_CARDS).state.players[0].points).toBe(2);
  });

  it('does not hold a battlefield already scored this turn', () => {
    // Tests Rule 472: a battlefield is scored once per turn
    const s = game();
    s.battlefields[0]!.controller = 'p0';
    s.battlefields[0]!.scoredThisTurnBy = ['p0'];
    const r = holdScoringStep(s, FIXTURE_CARDS);
    expect(r.state.players[0].points).toBe(0);
    expect(r.events).toEqual([]);
  });

  it('is deterministic', () => {
    // Tests Rule 471.2: pure function of state
    const s = game();
    s.battlefields[0]!.controller = 'p0';
    expect(holdScoringStep(s, FIXTURE_CARDS)).toEqual(holdScoringStep(s, FIXTURE_CARDS));
  });
});

describe('scoreBattlefield', () => {
  it('conquer scores a point and marks the battlefield', () => {
    // Tests Rule 471.1: Conquer scores
    const s = game();
    const r = onConquer(s, 'p0', bfId(s, 0), FIXTURE_CARDS);
    expect(r.state.players[0].points).toBe(1);
    expect(r.state.battlefields[0]!.scoredThisTurnBy).toEqual(['p0']);
    expect(r.events[0]).toMatchObject({ type: 'POINT_GAINED', source: 'CONQUER' });
    expect(s.players[0].points).toBe(0);
    expect(s.battlefields[0]!.scoredThisTurnBy).toEqual([]);
  });

  it('prevents double scoring across methods', () => {
    // Tests Rule 472: at most once per turn by either method
    const s = game();
    const a = scoreBattlefield(s, FIXTURE_CARDS, 'p0', bfId(s, 0), 'CONQUER');
    const b = scoreBattlefield(a.state, FIXTURE_CARDS, 'p0', bfId(s, 0), 'HOLD');
    expect(b.state.players[0].points).toBe(1);
    expect(b.events).toEqual([]);
  });

  it('final point: conquering with the other battlefield unscored draws a card instead', () => {
    // Tests Rule 473.1.b.1: draw a card instead of the Final Point
    const s = game();
    s.players[0].points = 7;
    const hand = s.players[0].hand.length;
    const r = scoreBattlefield(s, FIXTURE_CARDS, 'p0', bfId(s, 0), 'CONQUER');
    expect(r.state.players[0].points).toBe(7);
    expect(r.state.players[0].hand.length).toBe(hand + 1);
    expect(r.state.battlefields[0]!.scoredThisTurnBy).toEqual(['p0']);
    expect(r.events.map((e) => e.type)).toEqual(['FINAL_POINT_DENIED_DREW_CARD', 'CARD_DRAWN']);
    expect(r.state.gameStatus).toBe('IN_PROGRESS');
  });

  it('final point: scoring every battlefield grants the point and checkWin ends the game', () => {
    // Tests Rule 473.1.b: Hold of one plus Conquer of the other satisfies "scored every battlefield"
    const s = game();
    s.players[0].points = 6;
    s.battlefields[0]!.controller = 'p0';
    const held = holdScoringStep(s, FIXTURE_CARDS).state;
    expect(held.players[0].points).toBe(7);
    const c = scoreBattlefield(held, FIXTURE_CARDS, 'p0', bfId(s, 1), 'CONQUER');
    expect(c.state.players[0].points).toBe(8);
    expect(c.state.gameStatus).toBe('IN_PROGRESS');
    const w = checkWin(c.state);
    expect(w.state.gameStatus).toBe('FINISHED');
    expect(w.state.winner).toBe('p0');
    expect(w.events).toEqual([{ type: 'GAME_ENDED', winner: 'p0' }]);
  });

  it('hold at 7 points still gives the point (assumption)', () => {
    // Tests Rule 473.1.b: restriction is written for Conquer only (docs/ASSUMPTIONS.md)
    const s = game();
    s.players[0].points = 7;
    s.battlefields[0]!.controller = 'p0';
    expect(holdScoringStep(s, FIXTURE_CARDS).state.players[0].points).toBe(8);
  });

  it('draw-instead with an empty deck triggers burn out', () => {
    // Tests Rule 473.1.b.1: the draw uses draw-with-burn-out (Rule 414.4)
    const s = game();
    s.players[0].points = 7;
    s.players[0].mainDeck.length = 0;
    const r = scoreBattlefield(s, FIXTURE_CARDS, 'p0', bfId(s, 0), 'CONQUER');
    expect(r.events.map((e) => e.type)).toContain('BURN_OUT');
    expect(r.state.players[1].points).toBe(1);
  });

  it('is a no-op for unknown battlefields', () => {
    // Tests Rule 470: only existing battlefields are scored
    const s = game();
    expect(scoreBattlefield(s, FIXTURE_CARDS, 'p0', 'nope', 'CONQUER').events).toEqual([]);
  });
});

describe('gainPoints', () => {
  it('burn-out points are exempt from the final point restriction', () => {
    // Tests Rule 473.1.a.1: non-Conquer sources are exempt
    const s = game();
    s.players[0].points = 7;
    const ev = gainPoints(s, 'p0', 1, 'BURN_OUT');
    expect(s.players[0].points).toBe(8);
    expect(ev).toEqual([{ type: 'POINT_GAINED', player: 'p0', amount: 1, source: 'BURN_OUT' }]);
  });

  it('never drops points below zero', () => {
    // Tests Rule 194.4: points cannot go below 0
    const s = game();
    gainPoints(s, 'p0', -3, 'EFFECT');
    expect(s.players[0].points).toBe(0);
  });
});

describe('checkWin', () => {
  const run = (a: number, b: number) => {
    const s = game();
    s.players[0].points = a;
    s.players[1].points = b;
    return checkWin(s);
  };

  it('8 vs 5: leader wins', () => {
    // Tests Rule 194.2: reaching the victory score with more points wins
    const r = run(8, 5);
    expect(r.state.gameStatus).toBe('FINISHED');
    expect(r.state.winner).toBe('p0');
  });

  it('8 vs 8: tie continues', () => {
    // Tests Rule 194.2: a tie continues play
    const r = run(8, 8);
    expect(r.state.gameStatus).toBe('IN_PROGRESS');
    expect(r.events).toEqual([]);
  });

  it('9 vs 8: the leader wins', () => {
    // Tests Rule 194.2: the player with more points wins
    expect(run(8, 9).state.winner).toBe('p1');
  });

  it('7 points: no win', () => {
    // Tests Rule 194.2: below victory score does not win
    expect(run(7, 0).state.gameStatus).toBe('IN_PROGRESS');
  });

  it('is idempotent and leaves ended games alone', () => {
    // Tests Rule 323.1: win check does nothing once the game is over
    const once = run(8, 0);
    const twice = checkWin(once.state);
    expect(twice.events).toEqual([]);
    expect(twice.state).toEqual(once.state);
  });
});
