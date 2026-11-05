import { describe, expect, it } from 'vitest';
import { runCleanup } from './cleanup.js';
import {
  assignCombatDamage,
  autoAssign,
  computeAssignmentConstraints,
  continueCombat,
  startCombat,
} from './combat.js';
import { getLegalActions } from './legalActions.js';
import { actorToAct, reduce } from './reducer.js';
import { stateHash } from './replay.js';
import { sanitizeFor } from './sanitize.js';
import { FIXTURE_CARDS, makeTestGame } from './testing/fixtures.js';
import { validateIntent } from './validator.js';
import { AIController } from './ai/bot.js';
import { SCENARIO_DECK_A, Scenario } from './testing/scenario.js';
import type { CardDatabase, GameState, Intent, PlayerId, ReduceResult } from './types/index.js';

function ok(r: ReduceResult): Extract<ReduceResult, { ok: true }> {
  if (!r.ok) throw new Error(r.message);
  return r;
}

function spawn(s: GameState, cardId: string, owner: PlayerId, where: string): string {
  const id = `o${s.nextObjectId++}`;
  s.objects[id] = {
    id,
    cardId,
    owner,
    controller: owner,
    zone:
      where === 'base'
        ? { kind: 'base', player: owner }
        : { kind: 'battlefield', player: owner, battlefieldId: where },
    ready: true,
    damage: 0,
    mightBonus: 0,
  };
  if (where === 'base') s.players[owner === 'p0' ? 0 : 1].base.push(id);
  return id;
}

const bf = (s: GameState, i: number): string => (s.battlefields[i] as { id: string }).id;
const choose = (p: PlayerId, battlefieldId: string): Intent => ({
  type: 'CHOOSE_STAGED',
  playerId: p,
  battlefieldId,
});

/** p0 (the turn player) contests the first `n` battlefields with a unit each: n staged Showdowns. */
function stagedShowdowns(n: number, total = Math.max(n, 3)): GameState {
  const s = makeTestGame('staged-order');
  s.flow.priority = 'p0';
  while (s.battlefields.length < total) {
    const proto = structuredClone(s.battlefields[0]) as GameState['battlefields'][number];
    s.battlefields.push({ ...proto, id: `bf${s.battlefields.length}` });
  }
  for (let i = 0; i < n; i++) {
    spawn(s, 'fx-grunt', 'p0', bf(s, i));
    (s.battlefields[i] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
  }
  return s;
}

/** Both players have a unit on each of the first `n` battlefields: n staged Combats. */
function stagedCombats(n: number): GameState {
  const s = makeTestGame('staged-order');
  s.flow.priority = 'p0';
  for (let i = 0; i < n; i++) {
    spawn(s, 'fx-grunt', 'p0', bf(s, i));
    spawn(s, 'fx-grunt', 'p1', bf(s, i));
    (s.battlefields[i] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
  }
  return s;
}

const cleaned = (s: GameState): GameState => ok(runCleanup(s, FIXTURE_CARDS)).state;

describe('staged Showdown/Combat order choice', () => {
  it('pauses the Cleanup with a pending choice for the turn player when several Showdowns are staged', () => {
    // Tests Rule 323.11: the turn player chooses which staged Showdown begins first
    const r = ok(runCleanup(stagedShowdowns(2), FIXTURE_CARDS));
    expect(r.state.flow.showdown).toBeUndefined();
    expect(r.state.gameStatus).toBe('IN_PROGRESS');
    expect(r.state.flow.cleanupIterations).toBe(0);
    expect(r.state.flow.pendingChoice).toEqual({
      kind: 'STAGED_ORDER',
      player: 'p0',
      stage: 'SHOWDOWN',
      options: [bf(r.state, 0), bf(r.state, 1)],
    });
    expect(r.events.some((e) => e.type === 'GAME_ABORTED')).toBe(false);
  });

  it('is idempotent while paused (no events, no abort)', () => {
    // Tests Rule 322: the Cleanup stabilises while it waits for the decision
    const paused = cleaned(stagedShowdowns(2));
    const again = ok(runCleanup(paused, FIXTURE_CARDS));
    expect(again.events).toEqual([]);
    expect(again.state).toEqual(paused);
  });

  it('asks nothing when exactly one Showdown is staged', () => {
    // Tests Rule 323.11: a single staged Showdown just begins
    const s = cleaned(stagedShowdowns(1));
    expect(s.flow.pendingChoice).toBeUndefined();
    expect(s.flow.showdown?.battlefieldId).toBe(bf(s, 0));
  });

  it('lets the turn player start the chosen (non-lowest) Showdown and keeps the rest staged', () => {
    // Tests Rule 323.11: the chosen battlefield's Showdown begins first
    const paused = cleaned(stagedShowdowns(2));
    const r = ok(reduce(paused, FIXTURE_CARDS, choose('p0', bf(paused, 1))));
    expect(r.state.flow.pendingChoice).toBeUndefined();
    expect(r.state.flow.showdown?.battlefieldId).toBe(bf(paused, 1));
    expect(r.state.flow.stagedShowdowns).toEqual([bf(paused, 0)]);
    expect(r.events.map((e) => e.type)).toEqual(['STAGED_ORDER_CHOSEN', 'SHOWDOWN_STARTED']);
    expect(r.events[0]).toMatchObject({ player: 'p0', stage: 'SHOWDOWN' });
    const seqs = r.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(r.state.nextEventSeq).toBe((seqs[seqs.length - 1] as number) + 1);
  });

  it('asks again for the remaining staged Showdowns (three battlefields)', () => {
    // Tests Rule 323.11: each start is a fresh choice while several remain
    const paused = cleaned(stagedShowdowns(3));
    expect(paused.flow.pendingChoice?.options).toHaveLength(3);
    const r = ok(reduce(paused, FIXTURE_CARDS, choose('p0', bf(paused, 2))));
    expect(r.state.flow.showdown?.battlefieldId).toBe(bf(paused, 2));
    const a = ok(reduce(r.state, FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: 'p0' }));
    const b = ok(reduce(a.state, FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: 'p1' }));
    expect(b.state.flow.showdown).toBeUndefined();
    expect(b.state.flow.pendingChoice).toMatchObject({
      stage: 'SHOWDOWN',
      options: [bf(paused, 0), bf(paused, 1)],
    });
  });

  it('chooses among staged Combats when no Showdown is staged', () => {
    // Tests Rule 323.12: the turn player chooses which staged Combat begins first
    const paused = cleaned(stagedCombats(2));
    expect(paused.flow.combat).toBeUndefined();
    expect(paused.flow.pendingChoice).toMatchObject({ stage: 'COMBAT', player: 'p0' });
    const r = ok(reduce(paused, FIXTURE_CARDS, choose('p0', bf(paused, 1))));
    expect(r.state.flow.combat?.battlefieldId).toBe(bf(paused, 1));
    expect(r.state.flow.pendingChoice).toBeUndefined();
    expect(r.events[0]).toMatchObject({ type: 'STAGED_ORDER_CHOSEN', stage: 'COMBAT' });
  });

  it('rejects other intents while the decision is pending, except CONCEDE', () => {
    // Tests Rule 323.11: nothing else happens until the choice is made
    const paused = cleaned(stagedShowdowns(2));
    const others: Intent[] = [
      { type: 'PASS_PRIORITY', playerId: 'p0' },
      { type: 'END_TURN', playerId: 'p0' },
      { type: 'PASS_PRIORITY', playerId: 'p1' },
    ];
    for (const i of others) {
      expect(reduce(paused, FIXTURE_CARDS, i)).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    }
    const c = ok(reduce(paused, FIXTURE_CARDS, { type: 'CONCEDE', playerId: 'p1' }));
    expect(c.state.gameStatus).toBe('FINISHED');
  });

  it('validates the chooser and the option', () => {
    // Tests Rule 463.1: only the turn player chooses, and only among the staged battlefields
    const paused = cleaned(stagedShowdowns(2));
    expect(reduce(paused, FIXTURE_CARDS, choose('p1', bf(paused, 0)))).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    expect(reduce(paused, FIXTURE_CARDS, choose('p0', 'nowhere'))).toMatchObject({
      ok: false,
      code: 'ILLEGAL_TARGET',
    });
    expect(reduce(paused, FIXTURE_CARDS, choose('p0', bf(paused, 2)))).toMatchObject({
      ok: false,
      code: 'ILLEGAL_TARGET',
    });
    const malformed = { type: 'CHOOSE_STAGED', playerId: 'p0' } as unknown as Intent;
    expect(reduce(paused, FIXTURE_CARDS, malformed)).toMatchObject({
      ok: false,
      code: 'UNKNOWN_INTENT',
    });
  });

  it('rejects CHOOSE_STAGED when nothing is pending', () => {
    // Tests Rule 323.11: there is no decision to answer
    const s = makeTestGame('staged-order');
    s.flow.priority = 'p0';
    expect(reduce(s, FIXTURE_CARDS, choose('p0', bf(s, 0)))).toMatchObject({
      ok: false,
      code: 'WRONG_PHASE',
    });
  });

  it('actorToAct, getLegalActions and the validator expose the decision', () => {
    // Tests Rule 323.11: the legal actions are exactly the staged battlefields, for the turn player only
    const paused = cleaned(stagedShowdowns(2));
    expect(actorToAct(paused)).toBe('p0');
    const legal = getLegalActions(paused, FIXTURE_CARDS, 'p0');
    expect(legal).toEqual([choose('p0', bf(paused, 0)), choose('p0', bf(paused, 1))]);
    expect(getLegalActions(paused, FIXTURE_CARDS, 'p1')).toEqual([]);
    expect(validateIntent(paused, FIXTURE_CARDS, choose('p0', bf(paused, 1)))).toEqual({
      ok: true,
    });
    expect(validateIntent(paused, FIXTURE_CARDS, choose('p1', bf(paused, 1))).ok).toBe(false);
  });

  it('is part of both players views', () => {
    // Tests Rule 323.11: the prompt state is public (the opponent sees who is deciding)
    const paused = cleaned(stagedShowdowns(2));
    for (const v of ['p0', 'p1'] as const) {
      expect(sanitizeFor(paused, v).flow.pendingChoice).toEqual(paused.flow.pendingChoice);
    }
  });

  it('replays deterministically from the intent log', () => {
    // Tests Rule 323.11: the same intents produce the same state
    const paused = cleaned(stagedShowdowns(2));
    const log: Intent[] = [choose('p0', bf(paused, 1)), { type: 'PASS_PRIORITY', playerId: 'p0' }];
    const run = (): GameState => {
      let st = paused;
      for (const i of log) st = ok(reduce(st, FIXTURE_CARDS, i)).state;
      return st;
    };
    expect(stateHash(run())).toBe(stateHash(run()));
  });

  it('the generic bot answers the decision with one of the legal CHOOSE_STAGED intents', () => {
    // Tests Rule 323.11: AI players must be able to resolve the pause
    const sc = Scenario.start();
    const [a, b] = sc.state.battlefields.map((x) => x.id) as [string, string];
    sc.putUnit('p0', 'fx-grunt', a);
    sc.putUnit('p0', 'fx-grunt', b);
    sc.setBattlefield(a, { contestedBy: 'p0' });
    sc.setBattlefield(b, { contestedBy: 'p0' });
    sc.state = cleaned(sc.state);
    expect(sc.state.flow.pendingChoice).toBeDefined();
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, seed: 'staged' });
    const intent = bot.decideNextAction(sanitizeFor(sc.state, 'p0'));
    expect(intent?.type).toBe('CHOOSE_STAGED');
    expect(getLegalActions(sc.state, sc.cards, 'p0')).toContainEqual(intent);
    expect(reduce(sc.state, sc.cards, intent as Intent).ok).toBe(true);
  });

  it('drops a stale pending choice when only one candidate remains', () => {
    // Tests Rule 323.9: staged items that no longer apply are cancelled, so no choice is needed
    const paused = cleaned(stagedShowdowns(2));
    const s = structuredClone(paused);
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = null;
    const r = cleaned(s);
    expect(r.flow.pendingChoice).toBeUndefined();
    expect(r.flow.showdown?.battlefieldId).toBe(bf(r, 1));
  });
});

// ------------------------------------------------------------------ Tank + Backline (467.2.c.8)

const GRUNT = FIXTURE_CARDS['fx-grunt'] as NonNullable<(typeof FIXTURE_CARDS)[string]>;
const CARDS: CardDatabase = {
  ...FIXTURE_CARDS,
  'x-dual': {
    ...GRUNT,
    cardId: 'x-dual',
    name: 'Tank Backliner',
    keywords: [{ name: 'Tank' }, { name: 'Backline' }],
  },
};

function damageStep(attackers: number, defenders: string[]): { s: GameState; ids: string[] } {
  const s = makeTestGame('dual');
  s.flow.priority = 'p0';
  const bfId = bf(s, 0);
  (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
  for (let i = 0; i < attackers; i++) spawn(s, 'fx-grunt', 'p0', bfId); // 2 might each
  const ids = defenders.map((c) => spawn(s, c, 'p1', bfId));
  const a = ok(startCombat(s, CARDS, bfId)).state;
  delete a.flow.showdown;
  return { s: ok(continueCombat(a, CARDS)).state, ids };
}

const assign = (s: GameState, assignments: { unitId: string; amount: number }[]): ReduceResult =>
  assignCombatDamage(s, CARDS, { type: 'ASSIGN_COMBAT_DAMAGE', playerId: 'p0', assignments });

describe('a unit with both Tank and Backline (467.2.c.8)', () => {
  it('is flagged dual and listed as Tank by default; autoAssign stays valid', () => {
    // Tests Rule 467.2.c.8: the assigner chooses whether Tank or Backline applies
    const { s, ids } = damageStep(2, ['fx-grunt', 'x-dual']);
    const c = computeAssignmentConstraints(s, CARDS, 'p0');
    expect(c.ordered[0]).toMatchObject({ unitId: ids[1], tier: 'TANK', dual: true });
    expect(c.ordered[1]).toMatchObject({ unitId: ids[0], tier: 'NORMAL' });
    expect(c.ordered[1]).not.toHaveProperty('dual');
    expect(assign(s, autoAssign(s, CARDS, 'p0')).ok).toBe(true);
  });

  it('may be assigned first (as Tank)', () => {
    // Tests Rule 467.2.c.8: choosing Tank means lethal goes to it before other units
    const { s, ids } = damageStep(2, ['fx-grunt', 'x-dual']); // total 4
    ok(
      assign(s, [
        { unitId: ids[1] as string, amount: 2 },
        { unitId: ids[0] as string, amount: 2 },
      ]),
    );
  });

  it('may be assigned last (as Backline), including surplus damage', () => {
    // Tests Rule 467.2.c.8: choosing Backline means other units take lethal first
    const { s, ids } = damageStep(3, ['fx-grunt', 'x-dual']); // total 6
    ok(
      assign(s, [
        { unitId: ids[0] as string, amount: 2 },
        { unitId: ids[1] as string, amount: 4 },
      ]),
    );
  });

  it('is ordered after a plain Backline unit when it chooses Backline', () => {
    // Tests Rule 467.2.c.8: with Backline chosen, ties are the assigner's choice
    const { s, ids } = damageStep(1, ['fx-archer', 'x-dual']); // total 2
    ok(assign(s, [{ unitId: ids[0] as string, amount: 2 }]));
    ok(assign(s, [{ unitId: ids[1] as string, amount: 2 }]));
  });

  it('still enforces every other assignment rule', () => {
    // Tests Rule 467.2.c.4: surplus may not go on a unit while another lacks lethal
    const { s, ids } = damageStep(2, ['fx-grunt', 'x-dual']); // total 4
    expect(
      assign(s, [
        { unitId: ids[0] as string, amount: 1 },
        { unitId: ids[1] as string, amount: 3 },
      ]),
    ).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
    expect(assign(s, [{ unitId: ids[0] as string, amount: 4 }])).toMatchObject({
      ok: false,
      code: 'INVALID_DAMAGE_ASSIGNMENT',
    });
  });

  it('does not loosen a plain Tank', () => {
    // Tests Rule 467.2.c: a Tank without Backline must still be assigned first
    const { s, ids } = damageStep(2, ['fx-grunt', 'fx-ash-tank']); // total 4, tank lethal 3
    expect(
      assign(s, [
        { unitId: ids[0] as string, amount: 2 },
        { unitId: ids[1] as string, amount: 2 },
      ]),
    ).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
  });
});
