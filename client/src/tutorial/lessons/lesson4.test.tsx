// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RULE_ERROR_MESSAGES } from '@riftbound/engine';
import type { Intent } from '@riftbound/engine';
import { TutorialSession } from '../sandbox';
import { validateLesson } from '../validate';
import { LESSON_4 } from './lesson4';

type Play = Extract<Intent, { type: 'PLAY_CARD' }>;

const mk = (startStep = 0) =>
  new TutorialSession(LESSON_4, { botDelayMs: 0, strict: true, startStep });

async function send(s: TutorialSession, intent: Intent) {
  const r = await s.snapshot.api.send(intent);
  await s.idle();
  return r;
}

const handId = (s: TutorialSession, who: 'p0' | 'p1', cardId: string) =>
  s
    .getState()
    .players[who === 'p0' ? 0 : 1].hand.find((id) => s.getState().objects[id]!.cardId === cardId)!;

const stepId = (s: TutorialSession) => s.snapshot.step?.id;

describe('lesson 4: the chain', () => {
  it('is a valid, playable lesson', () => {
    expect(LESSON_4.id).toBe('lesson4-chain');
    expect(LESSON_4.comingSoon).toBeFalsy();
    expect(validateLesson(LESSON_4)).toEqual([]);
  });

  it('completes through the real engine, with the exact Closed State message and LIFO order', async () => {
    const s = mk();
    expect(stepId(s)).toBe('intro');
    s.next();

    // end turn -> the opponent casts Plain Chant in their Main Phase
    expect(stepId(s)).toBe('end-turn');
    await send(s, { type: 'END_TURN', playerId: 'p0' });
    expect(stepId(s)).toBe('opp-cast');
    let st = s.getState();
    expect(st.turn.activePlayer).toBe('p1');
    expect(st.flow.chain).toHaveLength(1);
    expect(st.objects[st.flow.chain[0]!.sourceObjectId]!.cardId).toBe('fx-plain-spell');
    expect(st.flow.priority).toBe('p0'); // the engine hands Priority to the learner
    expect(st.turnState.open).toBe(false);
    s.next();
    expect(stepId(s)).toBe('closed');
    s.next();

    // mistake: a unit during a Closed State
    expect(stepId(s)).toBe('try-unit');
    const r = await send(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: handId(s, 'p0', 'fx-grunt'),
      payment: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('CLOSED_STATE_REACTION_ONLY');
      expect(r.message).toBe(RULE_ERROR_MESSAGES.CLOSED_STATE_REACTION_ONLY);
    }
    expect(s.snapshot.status).toBe('complete');
    expect(s.snapshot.errorExpected).toBe(true);
    expect(s.snapshot.lastError!.message).toContain('Closed State');
    s.next();

    // the Reaction is legal and goes on top
    expect(stepId(s)).toBe('react');
    const ward = s.snapshot.api.legal.find(
      (i): i is Play =>
        i.type === 'PLAY_CARD' && s.getState().objects[i.cardInstanceId]!.cardId === 'fx-ward',
    );
    expect(ward).toBeDefined();
    expect((await send(s, ward!)).ok).toBe(true);
    st = s.getState();
    expect(st.flow.chain).toHaveLength(2);
    expect(st.objects[st.flow.chain[1]!.sourceObjectId]!.cardId).toBe('fx-ward');
    const addedIds = st.flow.chain.map((i) => i.id);
    s.next();

    // pass: the newest resolves first
    expect(stepId(s)).toBe('pass-first');
    for (let n = 0; n < 4 && stepId(s) === 'pass-first' && s.snapshot.status === 'active'; n++) {
      await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
    }
    expect(s.snapshot.status).toBe('complete');
    st = s.getState();
    expect(st.flow.chain).toHaveLength(1);
    const wardObj = Object.values(st.objects).find(
      (o) => o.cardId === 'fx-ward' && o.zone.kind === 'trash',
    );
    expect(wardObj).toBeDefined(); // Ward is in the Trash, Plain Chant not yet
    expect(st.flow.priority).toBe('p0');
    s.next();

    expect(stepId(s)).toBe('pass-second');
    for (let n = 0; n < 4 && stepId(s) === 'pass-second' && s.snapshot.status === 'active'; n++) {
      await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
    }
    expect(s.snapshot.status).toBe('complete');
    st = s.getState();
    expect(st.flow.chain).toHaveLength(0);
    expect(st.turnState.open).toBe(true);
    expect(st.players[1].trash.some((id) => st.objects[id]!.cardId === 'fx-plain-spell')).toBe(
      true,
    );

    // LIFO from the events recorded across the two pass steps, newest-first
    const resolvedIds = s.snapshot.api.recentEvents
      .filter((e) => e.type === 'CHAIN_ITEM_RESOLVED')
      .map((e) => (e as { chainItemId: string }).chainItemId);
    expect(resolvedIds).toEqual([...addedIds].reverse());
    s.next();

    expect(stepId(s)).toBe('summary');
    s.next();
    expect(s.snapshot.status).toBe('finished');
    expect(s.snapshot.completedSteps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    s.dispose();
  });

  it('gates: only End turn at first, only Reaction (or Pass) afterwards, only Pass while resolving', async () => {
    const s = mk(1);
    const play = () => s.getState().players[0].hand.map((id) => id); // sanity: hand exists
    expect(play().length).toBe(2);
    // end-turn step: nothing but END_TURN
    expect(s.snapshot.api.legal.every((i) => i.type === 'END_TURN')).toBe(true);
    expect(s.snapshot.api.legal.some((i) => i.type === 'END_TURN')).toBe(true);
    const blocked = await s.snapshot.api.send({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: handId(s, 'p0', 'fx-grunt'),
      payment: [],
    });
    expect(blocked).toEqual({ ok: true }); // swallowed by the gate
    expect(s.snapshot.blockedMessage).toBe('press End turn.');
    expect(s.getState().turn.activePlayer).toBe('p0');
    s.dispose();

    // try-unit step: the Ward is gated out; only the Grunt attempt reaches the engine
    const t = mk(2); // opp-cast
    t.next();
    t.next();
    expect(stepId(t)).toBe('try-unit');
    const ward = await t.snapshot.api.send({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: handId(t, 'p0', 'fx-ward'),
      payment: [],
    });
    expect(ward).toEqual({ ok: true });
    expect(t.snapshot.blockedMessage).toBe('try the Cinder Grunt.');
    expect(t.getState().flow.chain).toHaveLength(1);
    t.dispose();

    // pass step: only PASS_PRIORITY is legal
    const u = mk(2);
    u.next();
    u.next();
    u.skip(); // try-unit
    u.skip(); // react (plays the Ward)
    expect(stepId(u)).toBe('pass-first');
    await u.idle();
    expect(u.snapshot.api.legal.length).toBeGreaterThan(0);
    expect(u.snapshot.api.legal.every((i) => i.type === 'PASS_PRIORITY')).toBe(true);
    u.dispose();
  });

  it('skip keeps the board consistent through every step', async () => {
    const s = mk();
    for (let n = 0; n < 12 && s.snapshot.status !== 'finished'; n++) {
      s.skip();
      await s.idle();
    }
    expect(s.snapshot.status).toBe('finished');
    s.dispose();

    // skipping from the start leaves the opponent's spell and (after Skip of react) our Ward on the chain
    const t = mk(1);
    t.skip(); // end-turn -> opp-cast onEnter
    expect(stepId(t)).toBe('opp-cast');
    expect(t.getState().turn.activePlayer).toBe('p1');
    expect(t.getState().flow.chain).toHaveLength(1);
    t.skip();
    t.skip();
    t.skip(); // try-unit
    expect(stepId(t)).toBe('react');
    t.skip(); // react: onSkip plays the Ward
    expect(stepId(t)).toBe('pass-first');
    expect(t.getState().flow.chain).toHaveLength(2);
    t.dispose();
  });

  it('reset step on opp-cast replays the opponent spell exactly', () => {
    const s = mk(2);
    expect(s.getState().flow.chain).toHaveLength(1);
    s.resetStep();
    expect(stepId(s)).toBe('opp-cast');
    expect(s.getState().flow.chain).toHaveLength(1);
    s.dispose();
  });
});
