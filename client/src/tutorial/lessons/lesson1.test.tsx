// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Intent } from '@riftbound/engine';
import { setState } from '../../store/gameStore';
import { clearProgress } from '../progress';
import { TutorialSession } from '../sandbox';
import { validateLesson } from '../validate';
import { LESSON_1 } from './lesson1';

beforeEach(() => {
  clearProgress();
  setState({ toasts: [] });
});

const mk = (startStep = 0) =>
  new TutorialSession(LESSON_1, { botDelayMs: 0, strict: true, startStep });

async function send(s: TutorialSession, intent: Intent) {
  const r = await s.snapshot.api.send(intent);
  await s.idle();
  return r;
}

/** Index of the step with this id (keeps the tests independent of the step order). */
const indexOf = (id: string) => LESSON_1.steps.findIndex((st) => st.id === id);

describe('lesson 1: the turn structure', () => {
  it('is a valid, enabled lesson with the expected id and export', () => {
    expect(validateLesson(LESSON_1)).toEqual([]);
    expect(LESSON_1.id).toBe('lesson1-turn-structure');
    expect(LESSON_1.comingSoon).toBeFalsy();
    expect(LESSON_1.steps.length).toBeGreaterThanOrEqual(7);
  });

  it('can be completed by driving the real engine through every step', async () => {
    const s = mk();
    const titles: string[] = [];
    const seen = () => titles.push(s.snapshot.step?.id ?? 'finished');

    // 0 phases (read-only), 1 runes (read-only)
    seen();
    expect(s.snapshot.manual).toBe(true);
    s.next();
    seen();
    expect(s.snapshot.notes.join(' ')).toContain('2 runes in play');
    s.next();

    // 2 end-turn: the learner ends the Main Phase; the opponent's turn starts and is held
    seen();
    expect(s.snapshot.step?.id).toBe('end-turn');
    const end = s.snapshot.api.legal.find((i) => i.type === 'END_TURN')!;
    expect(end).toBeDefined();
    expect((await send(s, end)).ok).toBe(true);
    expect(s.snapshot.status).toBe('complete'); // explain: waits for Next
    expect(s.getState().turn.activePlayer).toBe('p1');
    expect(s.getState().turn.phase).toBe('MAIN');
    s.next();

    // 3 out-of-turn: the learner's card play is refused by the real engine
    seen();
    expect(s.snapshot.step?.id).toBe('out-of-turn');
    const hand = s.getState().players[0].hand;
    const card = hand[0]!;
    const r = await send(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: card,
      payment: [],
    });
    expect(r.ok).toBe(false);
    expect(s.snapshot.status).toBe('complete');
    expect(s.snapshot.errorExpected).toBe(true);
    s.next();

    // 4 opponent-turn: the scripted autopilot ends the opponent's turn, and the learner's turn begins
    seen();
    expect(s.snapshot.step?.id).toBe('opponent-turn');
    await s.idle();
    expect(s.snapshot.status).toBe('complete');
    expect(s.getState().turn.activePlayer).toBe('p0');
    expect(s.getState().turn.number).toBe(3);
    s.next();

    // 5 your-turn (read-only): the note reads the real state
    seen();
    expect(s.snapshot.notes.join(' ')).toContain('Awaken: 1 of 1 Cinder Grunt ready');
    expect(s.snapshot.notes.join(' ')).toContain('4 runes in play');
    s.next();

    // 6 summary
    seen();
    s.next();
    expect(s.snapshot.status).toBe('finished');
    expect(s.snapshot.completedSteps).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(titles).toEqual([
      'phases',
      'runes',
      'end-turn',
      'out-of-turn',
      'opponent-turn',
      'your-turn',
      'summary',
    ]);
    s.dispose();
  });

  it('the expectError step produces the real engine refusal and shows its text', async () => {
    const s = mk(indexOf('out-of-turn'));
    const card = s.getState().players[0].hand[0]!;
    const r = await send(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: card,
      payment: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_YOUR_PRIORITY');
      expect(r.message).toContain('[Rule Error]');
    }
    expect(s.snapshot.lastError?.code).toBe('NOT_YOUR_PRIORITY');
    s.dispose();
  });

  it('a gated-out intent is not sent to the engine and keeps the step open', async () => {
    const s = mk(indexOf('out-of-turn'));
    const before = s.getState();
    const r = await s.snapshot.api.send({ type: 'END_TURN', playerId: 'p0' });
    expect(r).toEqual({ ok: true }); // swallowed by the gate, not refused by the engine
    expect(s.getState()).toBe(before);
    expect(s.snapshot.blockedMessage).toBe('play a card from your hand anyway.');
    expect(s.snapshot.status).toBe('active');
    s.dispose();
  });

  it('skipping every step keeps the board consistent and finishes the lesson', async () => {
    const s = mk();
    for (let n = 0; n < LESSON_1.steps.length + 2 && s.snapshot.status !== 'finished'; n++) {
      s.skip();
      await s.idle();
    }
    expect(s.snapshot.status).toBe('finished');
    // skipped steps are not completed; only a step whose done() is already true on the board
    // (the opponent's turn ending, step 4) may complete on its own
    expect(s.snapshot.completedSteps).not.toContain(0);
    expect(s.snapshot.completedSteps.every((i) => i === indexOf('opponent-turn'))).toBe(true);
    s.dispose();
  });

  it('reset step on the expectError step restores the board and the refusal can be repeated', async () => {
    const s = mk(indexOf('out-of-turn'));
    const before = s.getState().flow.priority;
    const card = s.getState().players[0].hand[0]!;
    await send(s, { type: 'PLAY_CARD', playerId: 'p0', cardInstanceId: card, payment: [] });
    expect(s.snapshot.status).toBe('complete');
    s.resetStep();
    expect(s.snapshot.step?.id).toBe('out-of-turn');
    expect(s.snapshot.status).toBe('active');
    expect(s.getState().flow.priority).toBe(before);
    const again = await send(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: card,
      payment: [],
    });
    expect(again.ok).toBe(false);
    expect(s.snapshot.status).toBe('complete');
    s.dispose();
  });
});
