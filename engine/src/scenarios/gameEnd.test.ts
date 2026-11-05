import { describe, it, expect } from 'vitest';
import { getLegalActions } from '../legalActions.js';
import { actorToAct } from '../reducer.js';
import { Scenario } from '../testing/scenario.js';
import { MAX_CLEANUP_ITERATIONS } from '../types/index.js';
import type { Intent } from '../types/index.js';

const GAME_OVER = '[Rule Error] The game has ended. (Rule 473.1)';

describe('scenario: Concede', () => {
  it('ends the game at once with the other player as the winner', () => {
    // Tests Rule 650: conceding makes the opponent win
    const sc = Scenario.start();
    const r = sc.do({ type: 'CONCEDE', playerId: 'p0' });
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p1');
    expect(sc.eventsOfType('GAME_ENDED', r.events)).toEqual([
      expect.objectContaining({ winner: 'p1' }),
    ]);
  });

  it('may be done out of turn by the player who is not acting', () => {
    // Tests Rule 651: a player may concede at any time
    const sc = Scenario.start();
    sc.do({ type: 'CONCEDE', playerId: 'p1' });
    expect(sc.state.winner).toBe('p0');
  });

  it('rejects every later action with GAME_OVER', () => {
    // Tests Rule 473.1: once the game has ended nothing else happens
    const sc = Scenario.start();
    sc.do({ type: 'CONCEDE', playerId: 'p0' });
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    const attempts: Intent[] = [
      { type: 'END_TURN', playerId: 'p0' },
      { type: 'END_TURN', playerId: 'p1' },
      { type: 'PASS_PRIORITY', playerId: 'p0' },
      { type: 'CONCEDE', playerId: 'p1' },
      { type: 'MULLIGAN', playerId: 'p0', cardIds: [] },
      {
        type: 'STANDARD_MOVE',
        playerId: 'p0',
        unitIds: [unit],
        destination: { kind: 'battlefield', battlefieldId: 'bf0' },
      },
      {
        type: 'ACTIVATE_RUNE',
        playerId: 'p0',
        runeId: sc.runes('p0')[0]?.id as string,
        mode: 'EXHAUST',
      },
    ];
    for (const intent of attempts) {
      const err = sc.reject(intent);
      expect(err.code, intent.type).toBe('GAME_OVER');
      expect(err.message).toBe(GAME_OVER);
    }
    expect(sc.state.winner).toBe('p1'); // the second concede did not flip it
    expect(getLegalActions(sc.state, sc.cards, 'p0')).toEqual([]);
  });

  it('can end the game during the mulligan', () => {
    // Tests Rule 650: conceding is possible before the first turn
    const sc = Scenario.begin();
    sc.do({ type: 'CONCEDE', playerId: 'p1' });
    expect(sc.state.winner).toBe('p0');
    expect(sc.reject({ type: 'MULLIGAN', playerId: 'p0', cardIds: [] }).message).toBe(GAME_OVER);
  });
});

describe('scenario: Cleanup circuit breaker', () => {
  it('is capped at MAX_CLEANUP_ITERATIONS and a normal long game never aborts', () => {
    // Tests Rule 322: a Cleanup always stabilises; the cap only guards against runaway rules
    expect(MAX_CLEANUP_ITERATIONS).toBe(25);
    const sc = Scenario.start();
    let longest = 0;
    for (let step = 0; step < 300 && sc.state.gameStatus === 'IN_PROGRESS'; step++) {
      const actor = actorToAct(sc.state);
      const actions = getLegalActions(sc.state, sc.cards, actor);
      // deterministic policy: mostly act (assign, move, play, pass), end the turn every 7th step
      const end = actions.find((a) => a.type === 'END_TURN');
      const pick =
        actions.find((a) => a.type === 'CHOOSE_STAGED') ??
        (step % 7 === 6 ? end : undefined) ??
        actions.find((a) => a.type === 'ASSIGN_COMBAT_DAMAGE') ??
        actions.find((a) => a.type === 'STANDARD_MOVE') ??
        actions.find((a) => a.type === 'PLAY_CARD') ??
        actions.find((a) => a.type === 'PASS_PRIORITY') ??
        end;
      expect(pick, `step ${step}: nothing to do`).toBeDefined();
      const r = sc.do(pick as Intent);
      longest = Math.max(longest, sc.eventsOfType('CLEANUP_ITERATION', r.events).length);
      expect(sc.state.gameStatus).not.toBe('ABORTED');
      expect(sc.eventsOfType('GAME_ABORTED', r.events)).toHaveLength(0);
      expect(sc.state.flow.cleanupIterations).toBe(0); // reset once stable
    }
    expect(longest).toBeLessThan(MAX_CLEANUP_ITERATIONS);
    expect(sc.state.turn.number).toBeGreaterThan(5);
  });
});
