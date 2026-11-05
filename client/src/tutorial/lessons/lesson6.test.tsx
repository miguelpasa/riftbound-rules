// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { Intent } from '@riftbound/engine';
import { setState } from '../../store/gameStore';
import { clearProgress } from '../progress';
import { TutorialSession } from '../sandbox';
import { validateLesson } from '../validate';
import { LESSON_6 } from './lesson6';

beforeEach(() => {
  clearProgress();
  setState({ toasts: [] });
});
afterEach(() => cleanup());

type Move = Extract<Intent, { type: 'STANDARD_MOVE' }>;
const mk = (startStep = 0) =>
  new TutorialSession(LESSON_6, { botDelayMs: 0, startStep, strict: true });
const stepId = (s: TutorialSession) => s.snapshot.step?.id ?? 'finished';

async function send(s: TutorialSession, intent: Intent) {
  const r = await s.snapshot.api.send(intent);
  await s.idle();
  return r;
}

/** The learner's legal single-unit move to battlefield index `i` (as the UI would offer it). */
function moveTo(s: TutorialSession, i: number): Move {
  const bf = s.getState().battlefields[i]!.id;
  const m = s.snapshot.api.legal.find(
    (x): x is Move =>
      x.type === 'STANDARD_MOVE' &&
      x.unitIds.length === 1 &&
      x.destination.kind === 'battlefield' &&
      x.destination.battlefieldId === bf,
  );
  expect(m, `legal move to bf ${i}`).toBeDefined();
  return m!;
}

async function passUntilComplete(s: TutorialSession) {
  for (let n = 0; n < 8 && s.snapshot.status !== 'complete'; n++) {
    if (!s.snapshot.api.legal.some((i) => i.type === 'PASS_PRIORITY')) break;
    await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
  }
  expect(s.snapshot.status).toBe('complete');
}

describe('lesson 6: victory and the final point rule', () => {
  it('is valid and not a placeholder', () => {
    expect(LESSON_6.comingSoon).toBeFalsy();
    expect(LESSON_6.id).toBe('lesson6-victory');
    expect(validateLesson(LESSON_6)).toEqual([]);
  });

  it('completes through the real engine and ends in a FINISHED game won by the learner', async () => {
    let finished = 0;
    const s = new TutorialSession(LESSON_6, {
      botDelayMs: 0,
      strict: true,
      onFinish: () => finished++,
    });
    const st = () => s.getState();
    const p0 = () => st().players[0];

    expect(stepId(s)).toBe('two-ways');
    s.next();
    expect(stepId(s)).toBe('burn-out');
    s.next();

    // Conquer at 6 -> 7
    expect(stepId(s)).toBe('conquer-normal');
    expect(p0().points).toBe(6);
    await send(s, moveTo(s, 0));
    await passUntilComplete(s);
    expect(p0().points).toBe(7);
    expect(st().battlefields[0]!.controller).toBe('p0');
    s.next();

    // Final point denied: no point, a card instead
    expect(stepId(s)).toBe('final-point-denied');
    expect(st().battlefields[0]!.scoredThisTurnBy).toEqual([]);
    const handBefore = p0().hand.length;
    await send(s, moveTo(s, 1));
    await passUntilComplete(s);
    expect(p0().points).toBe(7);
    expect(p0().hand.length).toBe(handBefore + 1);
    expect(st().gameStatus).toBe('IN_PROGRESS');
    expect(st().battlefields[1]!.controller).toBe('p0'); // control still established
    expect(st().battlefields[1]!.scoredThisTurnBy).toEqual(['p0']);
    s.next();

    // Rewind, end the turn, Hold in the Beginning Phase
    expect(stepId(s)).toBe('hold-first');
    expect(p0().points).toBe(6);
    expect(st().battlefields[1]!.controller).toBeNull();
    await send(s, { type: 'END_TURN', playerId: 'p0' });
    expect(s.snapshot.status).toBe('complete');
    expect(st().turn.number).toBeGreaterThanOrEqual(3);
    expect(p0().points).toBe(7);
    expect(st().battlefields[0]!.scoredThisTurnBy).toEqual(['p0']);
    s.next();

    // Conquer the other battlefield with everything scored: 8th point, win at Cleanup
    expect(stepId(s)).toBe('conquer-last');
    await send(s, moveTo(s, 1));
    await passUntilComplete(s);
    expect(p0().points).toBe(8);
    expect(st().gameStatus).toBe('FINISHED');
    expect(st().winner).toBe('p0');
    s.next();

    expect(stepId(s)).toBe('summary');
    s.next();
    expect(s.snapshot.status).toBe('finished');
    expect(finished).toBe(1);
    expect(s.snapshot.completedSteps).toEqual([0, 1, 2, 3, 4, 5, 6]);
    s.dispose();
  });

  it('the denied step emits FINAL_POINT_DENIED_DREW_CARD, one CARD_DRAWN and no POINT_GAINED', async () => {
    const s = mk(3);
    expect(stepId(s)).toBe('final-point-denied');
    await send(s, moveTo(s, 1));
    await passUntilComplete(s);
    // the step's events are still visible while it waits for Next
    const log = s.snapshot.api.view.players.find((p) => p.id === 'p0')!;
    expect(log.points).toBe(7);
    const events = (s as unknown as { stepEvents: { type: string; player?: string }[] }).stepEvents;
    expect(events.filter((e) => e.type === 'FINAL_POINT_DENIED_DREW_CARD')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'CARD_DRAWN')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'POINT_GAINED')).toHaveLength(0);
    s.dispose();
  });

  it('gates: only the lesson moves are allowed, and Next is required after a step completes', async () => {
    const s = mk(2);
    const r = await s.snapshot.api.send({ type: 'END_TURN', playerId: 'p0' });
    expect(r).toEqual({ ok: true });
    expect(s.snapshot.blockedMessage).toContain('move one Grunt');
    expect(s.getState().turn.number).toBe(1);
    // moving to the wrong battlefield is blocked
    await s.snapshot.api.send({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [
        s.getState().players[0].base.find((id) => s.getState().objects[id]!.cardId === 'fx-grunt')!,
      ],
      destination: { kind: 'battlefield', battlefieldId: s.getState().battlefields[1]!.id },
    });
    expect(s.snapshot.blockedMessage).toContain('left battlefield');
    expect(s.getState().battlefields[1]!.contestedBy).toBeNull();
    await send(s, moveTo(s, 0));
    await passUntilComplete(s);
    await s.snapshot.api.send({ type: 'END_TURN', playerId: 'p0' });
    expect(s.snapshot.blockedMessage).toContain('Next');
    expect(s.getState().turn.number).toBe(1);
    s.dispose();
  });

  it('skipping every step leaves a consistent board', () => {
    const s = mk(0);
    for (let n = 0; n < 12 && s.snapshot.status !== 'finished'; n++) s.skip();
    expect(s.snapshot.status).toBe('finished');
    s.dispose();
  });

  it('skip then play on: the later steps still work from a skipped board', async () => {
    const s = mk(2);
    s.skip(); // conquer-normal skipped (onSkip conquers for you)
    expect(stepId(s)).toBe('final-point-denied');
    expect(s.getState().players[0].points).toBe(7);
    await send(s, moveTo(s, 1));
    await passUntilComplete(s);
    expect(s.getState().players[0].points).toBe(7);
    s.dispose();
  });

  it('reset step on the denied step restores the starting board', async () => {
    const s = mk(3);
    const bf1Before = s.getState().battlefields[1]!.controller;
    await send(s, moveTo(s, 1));
    s.resetStep();
    expect(stepId(s)).toBe('final-point-denied');
    expect(s.getState().players[0].points).toBe(7);
    expect(s.getState().battlefields[1]!.controller).toBe(bf1Before);
    s.dispose();
  });
});
