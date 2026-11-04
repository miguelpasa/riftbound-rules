import { describe, expect, it } from 'vitest';
import { FIXTURE_CARDS } from '../../../engine/src/testing/fixtures.js';
import { createLocalGameApi, createMockGame } from './mockGame';

describe('createLocalGameApi', () => {
  it('runs a real game: sanitised view, legal list, and a bot that answers for the other seat', async () => {
    const bot = { decide: () => null }; // forces the built-in fallback action
    const local = createLocalGameApi({
      cards: FIXTURE_CARDS,
      seat: 'p0',
      opponent: bot,
      botDelayMs: 0,
    });
    let notified = 0;
    local.subscribe(() => notified++);
    const first = local.api;
    expect(local.api).toBe(first); // stable snapshot
    expect(first.view.viewer).toBe('p0');
    expect(first.legal.some((i) => i.type === 'MULLIGAN')).toBe(true);
    expect(await first.send({ type: 'MULLIGAN', playerId: 'p0', cardIds: [] })).toEqual({
      ok: true,
    });
    await local.idle();
    expect(notified).toBeGreaterThan(1);
    expect(local.getState().turn.phase).not.toBe('MULLIGAN');
    expect(local.api).not.toBe(first);
  });

  it('returns the engine rule error for an illegal intent', async () => {
    const local = createLocalGameApi({ cards: FIXTURE_CARDS, seat: 'p0' });
    const r = await local.api.send({ type: 'END_TURN', playerId: 'p0' });
    expect(r.ok).toBe(false);
  });

  it('createMockGame builds a game without a bot when opponent is null', () => {
    const g = createMockGame({ opponent: null });
    expect(g.api.cards).toBe(FIXTURE_CARDS);
    expect(g.api.view.players[0].handCount).toBe(4);
  });
});
