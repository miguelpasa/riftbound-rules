import { describe, expect, it } from 'vitest';
import type { GameSummary } from '../host/persistence';
import { resultOf, soloRecord } from './Replays';

const g = (o: Partial<GameSummary>): GameSummary => ({
  gameId: 'x',
  mode: 'SOLO',
  status: 'FINISHED',
  createdAt: 0,
  engineVersion: '1',
  intentCount: 3,
  hostSeat: 'p0',
  ...o,
});

describe('match history', () => {
  it('reads the result from the host seat', () => {
    expect(resultOf(g({ winner: 'p0' }))).toBe('won');
    expect(resultOf(g({ winner: 'p1' }))).toBe('lost');
    expect(resultOf(g({ winner: null }))).toBe('draw');
    expect(resultOf(g({ status: 'IN_PROGRESS' }))).toBe('playing');
    expect(resultOf(g({ winner: 'p1', hostSeat: 'p1' }))).toBe('won');
  });

  it('is unknown for old summaries without a host seat', () => {
    const old = g({ winner: 'p0' });
    delete old.hostSeat;
    expect(resultOf(old)).toBe('unknown');
  });

  it('counts finished solo games only', () => {
    const rec = soloRecord([
      g({ winner: 'p0' }),
      g({ winner: 'p0' }),
      g({ winner: 'p1' }),
      g({ winner: null }),
      g({ mode: 'MULTIPLAYER', winner: 'p0' }),
      g({ status: 'IN_PROGRESS' }),
    ]);
    expect(rec).toEqual({ won: 2, lost: 1, draw: 1 });
  });
});
