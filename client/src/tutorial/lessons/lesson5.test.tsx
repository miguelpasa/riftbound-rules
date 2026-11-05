import { describe, expect, it, vi } from 'vitest';
import type { Intent } from '@riftbound/engine';
import { TutorialSession } from '../sandbox';
import { validateLesson } from '../validate';
import { LESSON_5 } from './lesson5';

const mk = (startStep = 0, extra: { onFinish?: () => void } = {}) =>
  new TutorialSession(LESSON_5, { botDelayMs: 0, strict: true, startStep, ...extra });

async function send(s: TutorialSession, intent: Intent) {
  const r = await s.snapshot.api.send(intent);
  await s.idle();
  return r;
}

const settle = () => new Promise((r) => setTimeout(r, 400));
const stepId = (s: TutorialSession) => s.snapshot.step?.id ?? 'finished';

function checkFinalBoard(s: TutorialSession) {
  const st = s.getState();
  const trashOf = (p: 0 | 1) => st.players[p].trash.map((id) => st.objects[id]!.cardId);
  expect(trashOf(1)).toEqual(
    expect.arrayContaining(['fx-order-tank', 'fx-wisp', 'fx-tide-archer']),
  );
  expect(trashOf(0)).toContain('fx-raider');
  const grunt = Object.values(st.objects).find((o) => o.cardId === 'fx-grunt' && o.owner === 'p0')!;
  // the survivor is healed and holds the battlefield
  expect(grunt.zone).toMatchObject({ kind: 'battlefield', battlefieldId: st.battlefields[1]!.id });
  expect(grunt.damage).toBe(0);
  expect(st.battlefields[1]).toMatchObject({ controller: 'p0', contestedBy: null });
  expect(st.players[0].points).toBe(1);
  expect(st.flow.combat).toBeUndefined();
}

describe('lesson 5: Showdowns and Combat Might', () => {
  it('is a valid, playable lesson', () => {
    expect(LESSON_5.comingSoon).toBeFalsy();
    expect(LESSON_5.id).toBe('lesson5-combat');
    expect(validateLesson(LESSON_5)).toEqual([]);
  });

  it('completes through the real engine and GameApi in strict mode', async () => {
    const finished = vi.fn();
    const s = mk(0, { onFinish: finished });
    const ids: string[] = [];

    // 1 board (read-only)
    ids.push(stepId(s));
    expect(s.snapshot.manual).toBe(true);
    s.next();

    // 2 attack: moving a single unit is blocked by the gate, both together start combat
    ids.push(stepId(s));
    const raider = s
      .getState()
      .players[0].base.find((i) => s.getState().objects[i]!.cardId === 'fx-raider')!;
    const grunt = s
      .getState()
      .players[0].base.find((i) => s.getState().objects[i]!.cardId === 'fx-grunt')!;
    const bf1 = s.getState().battlefields[1]!.id;
    const dest = { kind: 'battlefield' as const, battlefieldId: bf1 };
    await send(s, { type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [raider], destination: dest });
    expect(s.snapshot.blockedMessage).toContain('together');
    expect(s.getState().flow.combat).toBeUndefined();
    expect(
      (
        await send(s, {
          type: 'STANDARD_MOVE',
          playerId: 'p0',
          unitIds: [raider, grunt],
          destination: dest,
        })
      ).ok,
    ).toBe(true);
    expect(s.getState().flow.combat?.step).toBe('SHOWDOWN');
    expect(s.getState().flow.combat).toMatchObject({ attacker: 'p0', defender: 'p1' });
    expect(s.snapshot.status).toBe('complete');
    s.next();

    // 3 showdown: pass; the scripted opponent passes back and damage starts
    ids.push(stepId(s));
    expect(s.snapshot.api.legal.map((i) => i.type)).toEqual(['PASS_PRIORITY']);
    await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
    expect(s.getState().flow.combat).toMatchObject({
      step: 'DAMAGE',
      awaitingAssignmentFrom: 'p0',
    });

    // 4a the wrong split is refused with the engine's own text
    ids.push(stepId(s));
    await settle(); // the lesson sends the illegal split on the learner's behalf
    expect(s.snapshot.status).toBe('complete');
    expect(s.snapshot.errorExpected).toBe(true);
    const err = s.snapshot.lastError!;
    expect(err.code).toBe('INVALID_DAMAGE_ASSIGNMENT');
    expect(err.message).toContain('[Rule Error]');
    expect(err.message).toMatch(
      /\(TANK\) must be assigned lethal damage before .* \(NORMAL\) \(467\.2\.c\)/,
    );
    expect(s.getState().flow.combat?.awaitingAssignmentFrom).toBe('p0'); // nothing changed
    s.next();

    // 4b the right split: totals come from the engine, Tank first
    ids.push(stepId(s));
    const legal = s.snapshot.api.legal.filter((i) => i.type === 'ASSIGN_COMBAT_DAMAGE');
    expect(legal.length).toBeGreaterThan(0);
    const right = legal[0]!;
    if (right.type !== 'ASSIGN_COMBAT_DAMAGE') throw new Error('unreachable');
    expect(right.assignments.reduce((n, a) => n + a.amount, 0)).toBe(5); // 3 (Assault) + 2
    expect(s.getState().objects[right.assignments[0]!.unitId]!.cardId).toBe('fx-order-tank');
    expect((await send(s, right)).ok).toBe(true);
    expect(s.getState().flow.combat?.awaitingAssignmentFrom).toBe('p1'); // the opponent has NOT auto-played
    expect(s.snapshot.status).toBe('complete');
    s.next();

    // 5 the Defender assigns (scripted on entry): damage is dealt, Cleanup kills
    ids.push(stepId(s));
    expect(s.getState().flow.combat).toBeUndefined();
    expect(s.snapshot.notes.join(' ')).toContain('4');
    s.next();

    // 6 result (done: points)
    ids.push(stepId(s));
    expect(s.snapshot.status).toBe('complete');
    checkFinalBoard(s);
    s.next();

    // 7 summary
    ids.push(stepId(s));
    expect(s.snapshot.manual).toBe(true);
    s.next();

    expect(s.snapshot.status).toBe('finished');
    expect(finished).toHaveBeenCalledTimes(1);
    expect(s.scriptErrors).toEqual([]);
    expect(ids).toEqual([
      'the-board',
      'attack',
      'showdown',
      'wrong-split',
      'right-split',
      'defender',
      'result',
      'summary',
    ]);
    checkFinalBoard(s);
    s.dispose();
  });

  it('skipping every step keeps the board consistent and ends in the same position', async () => {
    const s = mk(0);
    for (let n = 0; n < 12 && s.snapshot.status !== 'finished'; n++) {
      s.skip();
      await s.idle();
    }
    expect(s.snapshot.status).toBe('finished');
    expect(s.scriptErrors).toEqual([]);
    checkFinalBoard(s);
    s.dispose();
  });

  it('reset step on the wrong-split step re-sends the illegal split and stays consistent', async () => {
    const s = mk(0);
    const target = LESSON_5.steps.findIndex((x) => x.id === 'wrong-split');
    for (let n = 0; n < target; n++) {
      s.skip();
      await s.idle();
    }
    expect(stepId(s)).toBe('wrong-split');
    await settle();
    expect(s.snapshot.errorExpected).toBe(true);
    s.resetStep();
    await settle();
    expect(s.snapshot.errorExpected).toBe(true);
    expect(s.getState().flow.combat?.awaitingAssignmentFrom).toBe('p0');
    s.dispose();
  });
});
