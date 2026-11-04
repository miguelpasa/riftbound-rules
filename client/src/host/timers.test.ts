import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TurnTimer,
  defaultTimeoutPolicy,
  type TimeoutInfo,
  type TimerSituation,
} from './timers.js';

const idle: TimerSituation = {
  actor: 'p0',
  phase: 'MAIN',
  chainLength: 0,
  showdown: false,
  combatAwaiting: null,
  mulliganPlayer: null,
  gameOver: false,
};

const reacting = (actor: 'p0' | 'p1', extra: Partial<TimerSituation> = {}): TimerSituation => ({
  ...idle,
  actor,
  phase: 'MAIN',
  chainLength: 1,
  ...extra,
});

function setup(opts: { turnMs?: number | null; reactionWindowMs?: number } = {}) {
  const fired: TimeoutInfo[] = [];
  const timer = new TurnTimer({
    onTimeout: (info) => fired.push(info),
    ...opts,
  });
  return { timer, fired };
}

describe('TurnTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms a 30 s reaction window on a non-empty chain and fires once', () => {
    const { timer, fired } = setup();
    timer.sync(reacting('p1'));
    expect(timer.current()).toEqual({ kind: 'REACTION', player: 'p1' });

    vi.advanceTimersByTime(29_999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ kind: 'REACTION', player: 'p1' }]);

    vi.advanceTimersByTime(120_000);
    expect(fired).toHaveLength(1);
    timer.dispose();
  });

  it('arms the reaction window during a showdown without a chain', () => {
    const { timer, fired } = setup({ reactionWindowMs: 5000 });
    timer.sync({ ...idle, showdown: true, actor: 'p0' });
    expect(timer.current()).toEqual({ kind: 'REACTION', player: 'p0' });
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual([{ kind: 'REACTION', player: 'p0' }]);
    timer.dispose();
  });

  it('does not arm a turn clock by default (turnMs null) and arms one when configured', () => {
    const unlimited = setup();
    unlimited.timer.sync(idle);
    expect(unlimited.timer.current()).toBeNull();
    expect(unlimited.timer.remainingMs()).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(unlimited.fired).toEqual([]);
    unlimited.timer.dispose();

    const limited = setup({ turnMs: 5000 });
    limited.timer.sync(idle);
    expect(limited.timer.current()).toEqual({ kind: 'TURN', player: 'p0' });
    vi.advanceTimersByTime(5000);
    expect(limited.fired).toEqual([{ kind: 'TURN', player: 'p0' }]);
    limited.timer.dispose();
  });

  it('does not arm the turn clock outside MAIN', () => {
    const { timer, fired } = setup({ turnMs: 1000 });
    timer.sync({ ...idle, phase: 'BEGINNING' });
    expect(timer.current()).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual([]);
    timer.dispose();
  });

  it('arms 60 s mulligan and assignment timers that take precedence', () => {
    const { timer, fired } = setup({ turnMs: 1000 });
    timer.sync({ ...idle, phase: 'MULLIGAN', mulliganPlayer: 'p1' });
    expect(timer.current()).toEqual({ kind: 'MULLIGAN', player: 'p1' });
    vi.advanceTimersByTime(59_999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ kind: 'MULLIGAN', player: 'p1' }]);

    timer.sync({ ...idle, phase: 'BEGINNING', combatAwaiting: 'p0', actor: 'p0' });
    expect(timer.current()).toEqual({ kind: 'ASSIGNMENT', player: 'p0' });
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(2);
    expect(fired[1]).toEqual({ kind: 'ASSIGNMENT', player: 'p0' });
    timer.dispose();
  });

  it('re-arms when the actor changes (the new actor gets a full window)', () => {
    const { timer, fired } = setup();
    timer.sync(reacting('p0'));
    vi.advanceTimersByTime(20_000);
    timer.sync(reacting('p1'));
    expect(timer.remainingMs()).toBe(30_000);

    vi.advanceTimersByTime(29_999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ kind: 'REACTION', player: 'p1' }]);
    timer.dispose();
  });

  it('does not restart the window on repeated syncs of the same situation', () => {
    const { timer, fired } = setup();
    timer.sync(reacting('p0'));
    vi.advanceTimersByTime(20_000);
    timer.sync(reacting('p0'));
    expect(timer.remainingMs()).toBe(10_000);
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([{ kind: 'REACTION', player: 'p0' }]);
    timer.dispose();
  });

  it('does not double fire: an expired timer stays quiet on identical syncs', () => {
    const { timer, fired } = setup();
    timer.sync(reacting('p0'));
    vi.advanceTimersByTime(30_000);
    expect(fired).toHaveLength(1);
    timer.sync(reacting('p0'));
    timer.sync(reacting('p0'));
    vi.advanceTimersByTime(120_000);
    expect(fired).toHaveLength(1);
    expect(timer.remainingMs()).toBe(0);
    timer.dispose();
  });

  it('a new revision for the same player gets a fresh window after an expiry', () => {
    const { timer, fired } = setup();
    timer.sync({ ...reacting('p0'), revision: 4 });
    vi.advanceTimersByTime(30_000);
    timer.sync({ ...reacting('p0'), revision: 4 });
    vi.advanceTimersByTime(30_000);
    expect(fired).toHaveLength(1);

    timer.sync({ ...reacting('p0'), revision: 5 });
    vi.advanceTimersByTime(30_000);
    expect(fired).toHaveLength(2);
    timer.dispose();
  });

  it('a timeout handler may sync a new situation without double firing the old one', () => {
    const fired: TimeoutInfo[] = [];
    const timer: TurnTimer = new TurnTimer({
      onTimeout: (info) => {
        fired.push(info);
        timer.sync(reacting('p1'));
      },
    });
    timer.sync(reacting('p0'));
    vi.advanceTimersByTime(30_000);
    expect(fired).toEqual([{ kind: 'REACTION', player: 'p0' }]);
    expect(timer.current()).toEqual({ kind: 'REACTION', player: 'p1' });
    vi.advanceTimersByTime(30_000);
    expect(fired).toEqual([
      { kind: 'REACTION', player: 'p0' },
      { kind: 'REACTION', player: 'p1' },
    ]);
    timer.dispose();
  });

  it('clears everything when the game is over', () => {
    const { timer, fired } = setup();
    timer.sync(reacting('p0'));
    timer.sync({ ...reacting('p0'), gameOver: true });
    expect(timer.current()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    timer.dispose();
  });

  it('pause freezes the remaining time and resume continues from it', () => {
    const { timer, fired } = setup();
    timer.sync(reacting('p0'));
    vi.advanceTimersByTime(10_000);
    timer.pause();
    expect(timer.remainingMs()).toBe(20_000);
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    expect(timer.remainingMs()).toBe(20_000);

    timer.resume();
    vi.advanceTimersByTime(19_999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ kind: 'REACTION', player: 'p0' }]);
    timer.dispose();
  });

  it('a situation synced while paused starts only on resume', () => {
    const { timer, fired } = setup();
    timer.pause();
    timer.sync(reacting('p1'));
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    expect(timer.remainingMs()).toBe(30_000);
    timer.resume();
    vi.advanceTimersByTime(30_000);
    expect(fired).toEqual([{ kind: 'REACTION', player: 'p1' }]);
    timer.dispose();
  });

  it('dispose cancels pending timers and makes later calls no-ops', () => {
    const { timer, fired } = setup();
    timer.sync(reacting('p0'));
    timer.dispose();
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    timer.sync(reacting('p1'));
    timer.resume();
    expect(timer.current()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });

  it('emits a once-per-second countdown until unsubscribed', () => {
    const { timer } = setup();
    const ticks: number[] = [];
    const off = timer.onTick((t) => ticks.push(t.remainingMs));
    timer.sync(reacting('p0'));
    vi.advanceTimersByTime(3000);
    expect(ticks).toEqual([29_000, 28_000, 27_000]);
    off();
    vi.advanceTimersByTime(2000);
    expect(ticks).toHaveLength(3);
    timer.dispose();
  });

  it('reports paused state in ticks', () => {
    const { timer } = setup();
    const seen: boolean[] = [];
    timer.onTick((t) => seen.push(t.paused));
    timer.sync(reacting('p0'));
    vi.advanceTimersByTime(1000);
    timer.pause();
    vi.advanceTimersByTime(3000);
    expect(seen).toEqual([false]);
    timer.dispose();
  });

  it('rejects non-positive durations', () => {
    expect(() => new TurnTimer({ onTimeout: () => {}, reactionWindowMs: 0 })).toThrow(RangeError);
    expect(() => new TurnTimer({ onTimeout: () => {}, turnMs: -1 })).toThrow(RangeError);
  });

  it('accepts an injected clock', () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    let now = 0;
    const timer = new TurnTimer({
      onTimeout: () => {},
      clock: {
        now: () => now,
        setTimeout: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => {},
      },
    });
    timer.sync(reacting('p0'));
    const deadline = scheduled.find((s) => s.ms === 30_000);
    expect(deadline).toBeDefined();
    now = 12_000;
    expect(timer.remainingMs()).toBe(18_000);
    timer.dispose();
  });
});

describe('defaultTimeoutPolicy', () => {
  it('maps every timeout kind to its documented action', () => {
    expect(defaultTimeoutPolicy).toEqual({
      REACTION: expect.objectContaining({ action: 'PASS_PRIORITY' }),
      TURN: expect.objectContaining({ action: 'END_TURN' }),
      MULLIGAN: expect.objectContaining({ action: 'KEEP_HAND' }),
      ASSIGNMENT: expect.objectContaining({ action: 'AUTO_ASSIGN' }),
    });
  });
});
