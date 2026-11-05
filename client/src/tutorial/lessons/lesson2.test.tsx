import { describe, expect, it, vi } from 'vitest';
import { stateHash } from '@riftbound/engine';
import type { Intent } from '@riftbound/engine';
import { TutorialSession } from '../sandbox';
import { validateLesson } from '../validate';
import { LESSON_2 } from './lesson2';

type Play = Extract<Intent, { type: 'PLAY_CARD' }>;

const mk = (startStep = 0, extra: { onFinish?: () => void } = {}) =>
  new TutorialSession(LESSON_2, { botDelayMs: 0, strict: true, startStep, ...extra });

async function send(s: TutorialSession, intent: Intent) {
  const r = await s.snapshot.api.send(intent);
  await s.idle();
  return r;
}

const runeIds = (s: TutorialSession, cardId: string) =>
  s.getState().players[0].base.filter((id) => s.getState().objects[id]!.cardId === cardId);

const activate = (s: TutorialSession, runeId: string, mode: 'EXHAUST' | 'RECYCLE'): Intent => ({
  type: 'ACTIVATE_RUNE',
  playerId: 'p0',
  runeId,
  mode,
});

const titanId = (s: TutorialSession) =>
  s.getState().players[0].hand.find((id) => s.getState().objects[id]!.cardId === 'fx-titan')!;

const pool = (s: TutorialSession) => s.getState().players[0].runePool;

describe('lesson 2: resources', () => {
  it('is a valid, playable lesson', () => {
    expect(LESSON_2.comingSoon).toBeFalsy();
    expect(LESSON_2.id).toBe('lesson2-resources');
    expect(validateLesson(LESSON_2)).toEqual([]);
  });

  it('completes against the real engine, including the engine refusal and the pool emptying', async () => {
    const finished = vi.fn();
    const s = mk(0, { onFinish: finished });
    expect(runeIds(s, 'fx-rune-fury')).toHaveLength(6);
    expect(runeIds(s, 'fx-rune-calm')).toHaveLength(1);

    s.next(); // read
    // exhaust-one
    expect(s.snapshot.step?.id).toBe('exhaust-one');
    const fury = runeIds(s, 'fx-rune-fury');
    expect((await send(s, activate(s, fury[0]!, 'EXHAUST'))).ok).toBe(true);
    expect(pool(s).energy).toBe(1);
    expect(s.snapshot.status).toBe('complete');
    s.next();

    // exhaust-more
    expect(s.snapshot.step?.id).toBe('exhaust-more');
    for (const id of fury.slice(1, 5)) await send(s, activate(s, id, 'EXHAUST'));
    expect(pool(s).energy).toBe(5);
    expect(s.snapshot.step?.id).toBe('mistake');

    // mistake: the engine's real text
    const unpaid: Play = {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: titanId(s),
      location: { kind: 'base' },
      payment: [],
    };
    const r = await send(s, unpaid);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INSUFFICIENT_RESOURCES');
      expect(r.message).toContain('not enough Power');
    }
    expect(s.snapshot.errorExpected).toBe(true);
    expect(s.snapshot.lastError!.message).toContain('[Rule Error]');
    s.next();

    // recycle
    expect(s.snapshot.step?.id).toBe('recycle');
    const calm = runeIds(s, 'fx-rune-calm')[0]!;
    expect((await send(s, activate(s, calm, 'RECYCLE'))).ok).toBe(true);
    expect(pool(s).power.Calm).toBe(1);
    expect(runeIds(s, 'fx-rune-calm')).toHaveLength(0);
    s.next();

    // play from the pool
    expect(s.snapshot.step?.id).toBe('play');
    expect((await send(s, unpaid)).ok).toBe(true);
    for (let n = 0; n < 6 && s.snapshot.step?.id === 'play'; n++) {
      if (s.snapshot.api.legal.some((i) => i.type === 'PASS_PRIORITY')) {
        await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
      }
    }
    expect(pool(s)).toEqual({ energy: 0, power: {} });
    expect(s.snapshot.status).toBe('complete');
    s.next();

    // pool-empties: END_TURN is refused by the gate until there is something to lose
    expect(s.snapshot.step?.id).toBe('pool-empties');
    const before = stateHash(s.getState());
    await s.snapshot.api.send({ type: 'END_TURN', playerId: 'p0' });
    expect(stateHash(s.getState())).toBe(before);
    expect(s.snapshot.blockedMessage).toContain('exhaust the spare Fury rune');
    const spare = fury[5]!;
    expect((await send(s, activate(s, spare, 'EXHAUST'))).ok).toBe(true);
    expect(pool(s).energy).toBe(1);
    await send(s, { type: 'END_TURN', playerId: 'p0' });
    expect(pool(s).energy).toBe(0);
    expect(s.snapshot.status).toBe('complete');
    s.next();

    expect(s.snapshot.status).toBe('finished');
    expect(finished).toHaveBeenCalledTimes(1);
    expect(s.snapshot.completedSteps).toEqual([0, 1, 2, 3, 4, 5, 6]);
    s.dispose();
  });

  it('gates an off-script intent with a friendly message, never reaching the engine', async () => {
    const s = mk(1); // exhaust-one
    const before = stateHash(s.getState());
    const calm = runeIds(s, 'fx-rune-calm')[0]!;
    const r = await s.snapshot.api.send(activate(s, calm, 'RECYCLE'));
    expect(r).toEqual({ ok: true }); // swallowed by the gate
    expect(stateHash(s.getState())).toBe(before);
    expect(s.snapshot.blockedMessage).toBe('exhaust a Fury rune in the Resources panel.');
    await s.snapshot.api.send({ type: 'END_TURN', playerId: 'p0' });
    expect(stateHash(s.getState())).toBe(before);
    s.dispose();
  });

  it('keeps the board consistent when every step is skipped', () => {
    const s = mk(1);
    for (let n = 0; n < 6; n++) s.skip();
    expect(s.snapshot.status).toBe('finished');
    expect(s.getState().players[0].runePool).toEqual({ energy: 0, power: {} });
    s.dispose();
  });

  it('skipping into the play step leaves the exact payable pool', () => {
    const s = mk(1);
    s.skip();
    s.skip();
    s.skip();
    s.skip(); // now at play
    expect(s.snapshot.step?.id).toBe('play');
    expect(pool(s)).toEqual({ energy: 5, power: { Calm: 1 } });
    expect(
      s.snapshot.api.legal.some(
        (i) => i.type === 'PLAY_CARD' && i.payment.length === 0 && i.cardInstanceId === titanId(s),
      ),
    ).toBe(true);
    s.dispose();
  });
});
