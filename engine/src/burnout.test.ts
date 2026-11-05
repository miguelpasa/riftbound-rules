import { describe, it, expect } from 'vitest';
import { burnOut, drawWithBurnOut } from './burnout.js';
import { FIXTURE_CARDS, makeTestGame } from './testing/fixtures.js';
import type { GameState } from './types/index.js';

function emptyDeckGame(trashCount: number, seed = 'bo'): GameState {
  const s = makeTestGame(seed);
  const p = s.players[0];
  const ids = p.mainDeck.splice(0, p.mainDeck.length);
  for (const id of ids.slice(0, trashCount)) {
    p.trash.push(id);
    s.objects[id]!.zone = { kind: 'trash', player: 'p0' };
  }
  return s;
}

describe('burnOut', () => {
  it('recycles trash into the deck, shuffles, and gives the opponent a point', () => {
    // Tests Rule 432.2: burn out recycles trash, shuffles, opponent gains 1 point
    const s = emptyDeckGame(5);
    const trash = [...s.players[0].trash];
    const ev = burnOut(s, 'p0', FIXTURE_CARDS);
    expect(s.players[0].trash).toEqual([]);
    expect([...s.players[0].mainDeck].sort()).toEqual([...trash].sort());
    for (const id of s.players[0].mainDeck) expect(s.objects[id]!.zone.kind).toBe('mainDeck');
    expect(s.players[1].points).toBe(1);
    expect(ev.map((e) => e.type)).toEqual(['BURN_OUT', 'POINT_GAINED']);
    expect(ev[1]).toMatchObject({ player: 'p1', amount: 1, source: 'BURN_OUT' });
  });

  it('shuffles deterministically by seed', () => {
    // Tests Rule 432.2.b: shuffle uses the seeded RNG
    const a = emptyDeckGame(12, 's1');
    const b = emptyDeckGame(12, 's1');
    burnOut(a, 'p0', FIXTURE_CARDS);
    burnOut(b, 'p0', FIXTURE_CARDS);
    expect(a.players[0].mainDeck).toEqual(b.players[0].mainDeck);
    expect(a.players[0].mainDeck).not.toEqual(emptyDeckGame(12, 's1').players[0].trash);
  });

  it('ends the game when the opponent reaches the victory score', () => {
    // Tests Rule 432.3.c: burn-out point can win the game
    const s = emptyDeckGame(3);
    s.players[1].points = 7;
    const ev = burnOut(s, 'p0', FIXTURE_CARDS);
    expect(s.gameStatus).toBe('FINISHED');
    expect(s.winner).toBe('p1');
    expect(ev[ev.length - 1]).toEqual({ type: 'GAME_ENDED', winner: 'p1' });
  });

  it('does not end the game if the opponent does not lead', () => {
    // Tests Rule 432.3.c: needs more points than the burning player
    const s = emptyDeckGame(3);
    s.players[1].points = 7;
    s.players[0].points = 8;
    burnOut(s, 'p0', FIXTURE_CARDS);
    expect(s.gameStatus).toBe('IN_PROGRESS');
  });
});

describe('drawWithBurnOut', () => {
  it('draws normally when the deck is large enough', () => {
    // Tests Rule 414.4: normal draw
    const s = makeTestGame();
    const ev = drawWithBurnOut(s, 'p0', 2, FIXTURE_CARDS);
    expect(ev.map((e) => e.type)).toEqual(['CARD_DRAWN', 'CARD_DRAWN']);
    expect(s.players[0].hand).toHaveLength(6);
    expect(s.players[1].points).toBe(0);
  });

  it('draws what remains, burns out, then draws the rest', () => {
    // Tests Rule 414.4: draw as many as possible, burn out, then draw the rest
    const s = makeTestGame();
    const p = s.players[0];
    const ids = p.mainDeck.splice(0, p.mainDeck.length);
    p.mainDeck.push(ids[0]!);
    for (const id of ids.slice(1, 6)) {
      p.trash.push(id);
      s.objects[id]!.zone = { kind: 'trash', player: 'p0' };
    }
    const ev = drawWithBurnOut(s, 'p0', 3, FIXTURE_CARDS);
    expect(ev.map((e) => e.type)).toEqual([
      'CARD_DRAWN',
      'BURN_OUT',
      'POINT_GAINED',
      'CARD_DRAWN',
      'CARD_DRAWN',
    ]);
    expect(p.hand).toHaveLength(7);
    expect(p.mainDeck).toHaveLength(3);
    expect(s.players[1].points).toBe(1);
  });

  it('keeps burning out with deck and trash empty until the opponent wins', () => {
    // Tests Rule 432.3.a: repeated Burn Out, 1 point each time, until an opponent wins
    const s = emptyDeckGame(0);
    const ev = drawWithBurnOut(s, 'p0', 3, FIXTURE_CARDS);
    expect(ev.filter((e) => e.type === 'BURN_OUT')).toHaveLength(8);
    expect(s.players[1].points).toBe(8);
    expect(s.gameStatus).toBe('FINISHED');
    expect(s.winner).toBe('p1');
  });

  it('burns out again when the recycled trash runs out mid-draw', () => {
    // Tests Rule 432.3: each further attempt burns out again
    const s = emptyDeckGame(1);
    s.players[1].points = 5;
    const ev = drawWithBurnOut(s, 'p0', 3, FIXTURE_CARDS);
    expect(ev.filter((e) => e.type === 'BURN_OUT')).toHaveLength(3);
    expect(s.players[0].hand).toHaveLength(5); // all three cards were drawn before the game ended
    expect(s.gameStatus).toBe('FINISHED');
  });

  it('stops drawing as soon as the game ends', () => {
    // Tests Rule 432.3.c: immediate game end
    const s = emptyDeckGame(4);
    s.players[1].points = 7;
    const ev = drawWithBurnOut(s, 'p0', 3, FIXTURE_CARDS);
    expect(s.gameStatus).toBe('FINISHED');
    expect(ev.filter((e) => e.type === 'CARD_DRAWN')).toHaveLength(0);
    expect(ev[ev.length - 1]).toMatchObject({ type: 'GAME_ENDED' });
  });
});
