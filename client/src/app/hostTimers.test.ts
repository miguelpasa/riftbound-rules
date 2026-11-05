import { describe, expect, it, vi } from 'vitest';
import { actorToAct, createGameWithSeating, reduce, type GameState } from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { HostSession } from '../host/hostSession';
import { createHostBridge } from './adapters';
import { HostTimers, timedSeat, timeoutIntent, timerSituation } from './hostTimers';

function freshState(): GameState {
  return createGameWithSeating(FIXTURE_CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'timer-test').state;
}

function mainPhaseState(): GameState {
  let s = freshState();
  for (let i = 0; i < 20 && s.turn.phase === 'MULLIGAN'; i++) {
    const r = reduce(s, FIXTURE_CARDS, {
      type: 'MULLIGAN',
      playerId: actorToAct(s),
      cardIds: [],
    });
    if (!r.ok) throw new Error(r.message);
    s = r.state;
  }
  return s;
}

describe('timerSituation / timeoutIntent', () => {
  it('a pending staged-order choice arms the showdown (reaction) timer', () => {
    const s = freshState();
    s.flow.pendingChoice = {
      kind: 'STAGED_ORDER',
      player: s.turn.activePlayer,
      stage: 'SHOWDOWN',
      options: ['bf1', 'bf2'],
    };
    expect(timerSituation(s).showdown).toBe(true);
  });

  it('maps the mulligan to a MULLIGAN situation whose timeout keeps the hand', () => {
    const s = freshState();
    const sit = timerSituation(s);
    expect(sit.mulliganPlayer).toBe(actorToAct(s));
    expect(sit.gameOver).toBe(false);
    expect(timedSeat(sit)).toBe(actorToAct(s));
    const intent = timeoutIntent(
      { kind: 'MULLIGAN', player: sit.mulliganPlayer! },
      s,
      FIXTURE_CARDS,
    );
    expect(intent).toEqual({ type: 'MULLIGAN', playerId: sit.mulliganPlayer, cardIds: [] });
    expect(reduce(s, FIXTURE_CARDS, intent!).ok).toBe(true);
  });

  it('maps REACTION to PASS_PRIORITY and TURN to END_TURN', () => {
    const s = mainPhaseState();
    const sit = timerSituation(s);
    expect(sit.mulliganPlayer).toBeNull();
    expect(sit.chainLength).toBe(0);
    expect(timeoutIntent({ kind: 'REACTION', player: 'p1' }, s, FIXTURE_CARDS)).toEqual({
      type: 'PASS_PRIORITY',
      playerId: 'p1',
    });
    expect(timeoutIntent({ kind: 'TURN', player: sit.actor }, s, FIXTURE_CARDS)).toEqual({
      type: 'END_TURN',
      playerId: sit.actor,
    });
  });

  it('maps ASSIGNMENT to the engine auto-assignment intent', () => {
    const s = mainPhaseState();
    const intent = timeoutIntent({ kind: 'ASSIGNMENT', player: 'p0' }, s, FIXTURE_CARDS);
    expect(intent?.type).toBe('ASSIGN_COMBAT_DAMAGE');
  });

  it('flags a finished game', () => {
    const s = mainPhaseState();
    const r = reduce(s, FIXTURE_CARDS, { type: 'CONCEDE', playerId: 'p0' });
    if (!r.ok) throw new Error(r.message);
    expect(timerSituation(r.state).gameOver).toBe(true);
  });
});

describe('HostTimers', () => {
  function build() {
    const bridge = createHostBridge();
    const session = new HostSession({
      cards: FIXTURE_CARDS,
      state: mainPhaseState(),
      hostSeat: 'p0',
      ...bridge.callbacks,
    });
    return { bridge, session };
  }

  it('does not arm a timer when the waiting seat is the bot', () => {
    vi.useFakeTimers();
    try {
      const { bridge, session } = build();
      const seen: Array<number | null> = [];
      const timers = new HostTimers({
        session,
        cards: FIXTURE_CARDS,
        bridge,
        humanSeats: ['p0'],
        turnMs: 1000,
        onPublish: (p) => seen.push(p.deadline),
      });
      const actor = actorToAct(session.getFullStateForPersistence());
      if (actor === 'p0') expect(seen.at(-1)).not.toBeNull();
      else expect(seen.at(-1)).toBeNull();
      timers.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the policy through a host-forced intent when the clock runs out', () => {
    vi.useFakeTimers();
    try {
      const { bridge, session } = build();
      const before = session.getFullStateForPersistence();
      const timers = new HostTimers({
        session,
        cards: FIXTURE_CARDS,
        bridge,
        humanSeats: ['p0', 'p1'],
        turnMs: 5000,
      });
      vi.advanceTimersByTime(5001);
      const after = session.getFullStateForPersistence();
      expect(after).not.toBe(before);
      expect(
        after.turn.number !== before.turn.number ||
          after.turn.activePlayer !== before.turn.activePlayer ||
          after.turn.phase !== before.turn.phase,
      ).toBe(true);
      timers.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
