// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Intent } from '@riftbound/engine';
import { TutorialSession } from '../sandbox';
import { validateLesson } from '../validate';
import { LESSON_3 } from './lesson3';

type Play = Extract<Intent, { type: 'PLAY_CARD' }>;

const mk = (startStep = 0) =>
  new TutorialSession(LESSON_3, { botDelayMs: 0, strict: true, startStep });

async function send(s: TutorialSession, intent: Intent) {
  const r = await s.snapshot.api.send(intent);
  await s.idle();
  return r;
}

const ids = (s: TutorialSession, cardId: string) =>
  Object.values(s.getState().objects)
    .filter((o) => o.cardId === cardId && o.owner === 'p0')
    .map((o) => o.id);

describe('lesson 3: zones and movement', () => {
  it('is valid and not a placeholder', () => {
    expect(LESSON_3.comingSoon).toBeFalsy();
    expect(validateLesson(LESSON_3)).toEqual([]);
  });

  it('completes through the real engine, with both expected refusals and the Conquer point', async () => {
    const s = mk();
    const stepIds = () => s.snapshot.step?.id ?? 'finished';

    expect(stepIds()).toBe('zones');
    s.next();

    // play-wisp
    expect(stepIds()).toBe('play-wisp');
    const wispPlay = s.snapshot.api.legal.find(
      (i): i is Play =>
        i.type === 'PLAY_CARD' &&
        s.getState().objects[i.cardInstanceId]!.cardId === 'fx-wisp' &&
        i.location?.kind === 'base',
    )!;
    expect(wispPlay).toBeDefined();
    expect((await send(s, wispPlay)).ok).toBe(true);
    for (let n = 0; n < 4 && s.snapshot.status === 'active'; n++) {
      if (s.snapshot.api.legal.some((i) => i.type === 'PASS_PRIORITY')) {
        await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
      }
    }
    expect(s.snapshot.status).toBe('complete');
    const wisp = ids(s, 'fx-wisp').find((id) => s.getState().objects[id]!.zone.kind === 'base')!;
    expect(s.getState().objects[wisp]!.ready).toBe(false); // entered exhausted
    s.next();

    // exhausted: real engine text
    expect(stepIds()).toBe('exhausted');
    const r1 = await send(s, {
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [wisp],
      destination: { kind: 'battlefield', battlefieldId: s.getState().battlefields[0]!.id },
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.code).toBe('UNIT_EXHAUSTED');
      expect(r1.message).toContain('exhausted');
    }
    expect(s.snapshot.errorExpected).toBe(true);
    s.next();

    // move the ready Grunt: a wrong destination is gated, the right one opens a Showdown
    expect(stepIds()).toBe('move');
    const grunt = ids(s, 'fx-grunt').find((id) => s.getState().objects[id]!.zone.kind === 'base')!;
    const bf0 = s.getState().battlefields[0]!.id;
    const bf1 = s.getState().battlefields[1]!.id;
    await send(s, {
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [grunt],
      destination: { kind: 'battlefield', battlefieldId: bf1 },
    });
    expect(s.snapshot.blockedMessage).toContain('Battlefield 1');
    expect(s.getState().objects[grunt]!.zone.kind).toBe('base');
    expect(
      (
        await send(s, {
          type: 'STANDARD_MOVE',
          playerId: 'p0',
          unitIds: [grunt],
          destination: { kind: 'battlefield', battlefieldId: bf0 },
        })
      ).ok,
    ).toBe(true);
    expect(s.snapshot.status).toBe('complete');
    expect(s.getState().flow.showdown?.battlefieldId).toBe(bf0);
    expect(s.getState().objects[grunt]!.ready).toBe(false);
    s.next();

    // showdown: pass until conquered
    expect(stepIds()).toBe('showdown');
    expect(s.getState().players[0].points).toBe(0);
    for (
      let n = 0;
      n < 6 && s.snapshot.step?.id === 'showdown' && s.snapshot.status === 'active';
      n++
    ) {
      await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
    }
    expect(s.snapshot.status).toBe('complete');
    expect(s.getState().players[0].points).toBe(1);
    expect(s.getState().battlefields[0]!.controller).toBe('p0');
    s.next();

    // no-ganking
    expect(stepIds()).toBe('no-ganking');
    expect(s.getState().objects[grunt]!.ready).toBe(true);
    const r2 = await send(s, {
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [grunt],
      destination: { kind: 'battlefield', battlefieldId: bf1 },
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe('ILLEGAL_MOVE_DESTINATION');
      expect(r2.message).toContain('Ganking');
    }
    expect(s.snapshot.errorExpected).toBe(true);
    s.next();

    expect(stepIds()).toBe('summary');
    s.next();
    expect(s.snapshot.status).toBe('finished');
    s.dispose();
  });

  it('can be skipped through every step with a consistent board', () => {
    const s = mk();
    for (let n = 0; n < LESSON_3.steps.length; n++) s.skip();
    expect(s.snapshot.status).toBe('finished');
    expect(s.scriptErrors).toEqual([]);
    s.dispose();
  });
});
