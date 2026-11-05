import { describe, expect, it, vi } from 'vitest';
import { passPriority } from './chain.js';
import {
  assignCombatDamage,
  autoAssign,
  computeAssignmentConstraints,
  continueCombat,
  continueCombatHook,
  effectiveMight,
  killLethalUnits,
  resolveCombat,
  resolveCombatWithResult,
  startCombat,
  startCombatHook,
} from './combat.js';
import { checkInvariants } from './invariants.js';
import { closeShowdown, showdownAfterPass, unitsAt } from './showdown.js';
import type { ShowdownDeps } from './showdown.js';
import { FIXTURE_CARDS, makeTestGame } from './testing/fixtures.js';
import type { GameState, PlayerId, ReduceResult } from './types/index.js';

const BF = 'bf0';

function ok(r: ReduceResult): Extract<ReduceResult, { ok: true }> {
  if (!r.ok) throw new Error(r.message);
  return r;
}

/** Create a fresh unit object for `owner` at `where` ('base' or a battlefield id); returns its id. */
function spawn(
  s: GameState,
  cardId: string,
  owner: PlayerId,
  where: string,
  extra: { damage?: number; mightBonus?: number } = {},
): string {
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
    damage: extra.damage ?? 0,
    mightBonus: extra.mightBonus ?? 0,
  };
  if (where === 'base') s.players[owner === 'p0' ? 0 : 1].base.push(id);
  return id;
}

/** p0 contests bf0 (attacker p0, defender p1). */
function base(): GameState {
  const s = makeTestGame('combat');
  const bf = s.battlefields.find((b) => b.id === BF);
  if (!bf) throw new Error('no bf0');
  bf.contestedBy = 'p0';
  s.flow.priority = 'p0';
  return s;
}

/** startCombat then continueCombat (skipping the showdown turns). */
function toDamage(s: GameState): GameState {
  const a = ok(startCombat(s, FIXTURE_CARDS, BF)).state;
  const b = { ...a, flow: { ...a.flow } };
  delete b.flow.showdown;
  return ok(continueCombat(b, FIXTURE_CARDS)).state;
}

function assign(s: GameState, p: PlayerId, assignments: { unitId: string; amount: number }[]) {
  return assignCombatDamage(s, FIXTURE_CARDS, {
    type: 'ASSIGN_COMBAT_DAMAGE',
    playerId: p,
    assignments,
  });
}

describe('startCombat / continueCombat', () => {
  it('opens a combat Showdown with designations and attacker Focus', () => {
    // Tests Rule 466: combat begins with a Combat Showdown; attacker = contesting player
    const s = base();
    spawn(s, 'fx-grunt', 'p0', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const r = ok(startCombat(s, FIXTURE_CARDS, BF));
    expect(r.state.flow.combat).toEqual({
      battlefieldId: BF,
      attacker: 'p0',
      defender: 'p1',
      step: 'SHOWDOWN',
    });
    expect(r.state.flow.showdown).toMatchObject({ isCombat: true, attacker: 'p0', defender: 'p1' });
    expect(r.state.flow.focus).toBe('p0');
    expect(r.state.flow.priority).toBe('p0');
    expect(r.events).toMatchObject([
      { type: 'SHOWDOWN_STARTED', battlefieldId: BF, isCombat: true },
    ]);
  });

  it('uses the contesting player as attacker even if it is the non-turn player', () => {
    // Tests Rule 466.2.c: the attacker is the player whose units applied Contested
    const s = base();
    s.battlefields[0]!.contestedBy = 'p1';
    const r = ok(startCombat(s, FIXTURE_CARDS, BF));
    expect(r.state.flow.combat).toMatchObject({ attacker: 'p1', defender: 'p0' });
    expect(r.state.flow.focus).toBe('p1');
  });

  it('refuses to start while a combat or showdown is ongoing', () => {
    // Tests Rule 462: combat begins only when no other showdown or combat is ongoing
    const s = base();
    const started = ok(startCombat(s, FIXTURE_CARDS, BF)).state;
    const r = startCombat(started, FIXTURE_CARDS, BF);
    expect(r.ok).toBe(false);
    expect(startCombat(s, FIXTURE_CARDS, 'nope').ok).toBe(false);
  });

  it('works through ShowdownDeps and closeShowdown (full showdown -> damage)', () => {
    // Tests Rule 348.1: closing the combat showdown continues combat in the damage step
    const s = base();
    spawn(s, 'fx-grunt', 'p0', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const deps: ShowdownDeps = { startCombat: startCombatHook, continueCombat: continueCombatHook };
    let cur = ok(startCombat(s, FIXTURE_CARDS, BF)).state;
    for (let i = 0; i < 2; i++) {
      cur = ok(
        passPriority(cur, FIXTURE_CARDS, {
          type: 'PASS_PRIORITY',
          playerId: cur.flow.priority as PlayerId,
        }),
      ).state;
    }
    const closed = ok(showdownAfterPass(cur, FIXTURE_CARDS, deps));
    expect(closed.state.flow.showdown).toBeUndefined();
    expect(closed.state.flow.combat).toMatchObject({
      step: 'DAMAGE',
      awaitingAssignmentFrom: 'p0',
    });
    expect(closed.state.turnState.kind).toBe('SHOWDOWN');
  });

  it('startCombatHook plugs into closeShowdown after a non-combat showdown', () => {
    // Tests Rule 348.2.a: both players have units after a non-combat showdown -> combat
    const s = base();
    spawn(s, 'fx-grunt', 'p0', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    s.flow.showdown = { battlefieldId: BF, isCombat: false, passesInRow: 2 };
    const r = ok(closeShowdown(s, FIXTURE_CARDS, { startCombat: startCombatHook }));
    expect(r.state.flow.combat).toMatchObject({ step: 'SHOWDOWN', attacker: 'p0' });
    expect(r.state.flow.showdown).toMatchObject({ isCombat: true });
    expect(r.events.map((e) => e.type)).toEqual(['SHOWDOWN_STARTED']);
    expect(r.events[0]!.seq).toBe(s.nextEventSeq);
  });

  it('goes straight to Resolution when a side has no units', () => {
    // Tests Rule 467.1: damage only happens if both sides still have units
    const s = base();
    spawn(s, 'fx-grunt', 'p0', BF);
    const r = toDamage(s);
    expect(r.flow.combat).toMatchObject({ step: 'RESOLUTION', awaitingAssignmentFrom: null });
  });

  it('skips assigning for a side whose total Might is 0', () => {
    // Tests Rule 143.2.c: a side with no Might has nothing to assign
    const s = base();
    spawn(s, 'fx-wisp', 'p0', BF);
    const d = spawn(s, 'fx-grunt', 'p1', BF);
    const r = toDamage(s);
    expect(r.flow.combat).toMatchObject({ step: 'DAMAGE', awaitingAssignmentFrom: 'p1' });
    const w = ok(assign(r, 'p1', [{ unitId: unitsAt(r, BF, 'p0')[0]!.id, amount: 2 }]));
    expect(w.state.flow.combat!.step).toBe('RESOLUTION');
    expect(w.state.objects[d]!.damage).toBe(0);
  });
});

describe('effectiveMight and totals', () => {
  it('adds Assault only to the attacker and Shield only to the defender', () => {
    // Tests Rule 467.2.c: Assault N / Shield N apply by role, stacking with bonuses
    const s = base();
    const raiderA = spawn(s, 'fx-raider', 'p0', BF);
    const shielderA = spawn(s, 'fx-shielder', 'p0', BF);
    const raiderD = spawn(s, 'fx-raider', 'p1', BF);
    const shielderD = spawn(s, 'fx-shielder', 'p1', BF, { mightBonus: 2 });
    const c = ok(startCombat(s, FIXTURE_CARDS, BF)).state;
    expect(effectiveMight(c, FIXTURE_CARDS, raiderA)).toBe(3);
    expect(effectiveMight(c, FIXTURE_CARDS, shielderA)).toBe(2);
    expect(effectiveMight(c, FIXTURE_CARDS, raiderD)).toBe(2);
    expect(effectiveMight(c, FIXTURE_CARDS, shielderD)).toBe(5);
    expect(effectiveMight(c, FIXTURE_CARDS, raiderA, { role: null })).toBe(2);
    expect(effectiveMight(s, FIXTURE_CARDS, raiderA)).toBe(2); // no combat
  });

  it('sums side Might, counting negative Might as 0', () => {
    // Tests Rule 143.2.c: negative Might counts as 0 in a sum
    const s = base();
    spawn(s, 'fx-raider', 'p0', BF); // 3 as attacker
    spawn(s, 'fx-grunt', 'p0', BF, { mightBonus: -5 }); // -3 -> 0
    spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    expect(computeAssignmentConstraints(d, FIXTURE_CARDS, 'p0').total).toBe(3);
    expect(computeAssignmentConstraints(d, FIXTURE_CARDS, 'p1').total).toBe(2);
  });
});

describe('computeAssignmentConstraints / autoAssign', () => {
  it('orders Tank, then normal, then Backline with lethal amounts minus marked damage', () => {
    // Tests Rule 467.2.c.6: Tank first, Backline last; lethal accounts for marked damage
    const s = base();
    spawn(s, 'fx-titan', 'p0', BF);
    const back = spawn(s, 'fx-archer', 'p1', BF);
    const norm = spawn(s, 'fx-grunt', 'p1', BF, { damage: 1 });
    const tank = spawn(s, 'fx-ash-tank', 'p1', BF);
    const wisp = spawn(s, 'fx-wisp', 'p1', BF);
    const d = toDamage(s);
    const c = computeAssignmentConstraints(d, FIXTURE_CARDS, 'p0');
    expect(c.total).toBe(7);
    expect(c.ordered).toEqual([
      { unitId: tank, lethal: 3, tier: 'TANK' },
      { unitId: norm, lethal: 1, tier: 'NORMAL' },
      { unitId: wisp, lethal: 1, tier: 'NORMAL' },
      { unitId: back, lethal: 2, tier: 'BACKLINE' },
    ]);
    expect(computeAssignmentConstraints(base(), FIXTURE_CARDS, 'p0')).toEqual({
      total: 0,
      ordered: [],
    });
  });

  it('autoAssign produces assignments that the validator accepts', () => {
    // Tests Rule 467.2.c: the default assignment fills lethal in tier order
    const s = base();
    spawn(s, 'fx-titan', 'p0', BF);
    spawn(s, 'fx-archer', 'p1', BF);
    spawn(s, 'fx-ash-tank', 'p1', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    const a = autoAssign(d, FIXTURE_CARDS, 'p0');
    expect(a.reduce((x, y) => x + y.amount, 0)).toBe(7);
    expect(a[0]!.amount).toBe(3); // tank lethal first
    ok(assign(d, 'p0', a));
  });

  it('autoAssign puts excess on the last unit and handles a short total', () => {
    // Tests Rule 467.2.c.4: excess only once every unit has lethal
    const s = base();
    spawn(s, 'fx-titan', 'p0', BF);
    const w = spawn(s, 'fx-wisp', 'p1', BF);
    const d = toDamage(s);
    expect(autoAssign(d, FIXTURE_CARDS, 'p0')).toEqual([{ unitId: w, amount: 7 }]);
    const s2 = base();
    spawn(s2, 'fx-grunt', 'p0', BF);
    const t = spawn(s2, 'fx-ash-tank', 'p1', BF);
    const g = spawn(s2, 'fx-grunt', 'p1', BF);
    const d2 = toDamage(s2);
    const a = autoAssign(d2, FIXTURE_CARDS, 'p0');
    expect(a).toEqual([{ unitId: t, amount: 2 }]);
    expect(a.some((x) => x.unitId === g)).toBe(false);
    ok(assign(d2, 'p0', a));
  });
});

describe('assignCombatDamage validation', () => {
  function scenario() {
    const s = base();
    spawn(s, 'fx-titan', 'p0', BF); // 7 might
    const tank = spawn(s, 'fx-ash-tank', 'p1', BF); // lethal 3
    const g1 = spawn(s, 'fx-grunt', 'p1', BF); // lethal 2
    const g2 = spawn(s, 'fx-grunt', 'p1', BF);
    const back = spawn(s, 'fx-archer', 'p1', BF); // lethal 2
    return { d: toDamage(s), tank, g1, g2, back };
  }

  it('requires Tank units to receive lethal first', () => {
    // Tests Rule 467.2.c: units with Tank must be assigned lethal before units without
    const { d, tank, g1, g2 } = scenario();
    const r = assign(d, 'p0', [
      { unitId: g1, amount: 2 },
      { unitId: g2, amount: 2 },
      { unitId: tank, amount: 3 },
    ]);
    expect(r.ok).toBe(true); // all lethal on tank + both grunts = 7
    const bad = assign(d, 'p0', [
      { unitId: g1, amount: 4 },
      { unitId: tank, amount: 3 },
    ]);
    expect(bad.ok).toBe(false);
    const bad2 = assign(d, 'p0', [
      { unitId: g1, amount: 2 },
      { unitId: tank, amount: 2 },
      { unitId: g2, amount: 3 },
    ]);
    expect(bad2).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
  });

  it('requires Backline to be assigned last', () => {
    // Tests Rule 467.2.c.6: Backline units are assigned after all non-Backline units
    const { d, tank, g1, back } = scenario();
    const bad = assign(d, 'p0', [
      { unitId: tank, amount: 3 },
      { unitId: back, amount: 2 },
      { unitId: g1, amount: 2 },
    ]);
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
    // Backline cannot be touched before both grunts are lethal.
    const bad2 = assign(d, 'p0', [
      { unitId: tank, amount: 3 },
      { unitId: g1, amount: 2 },
      { unitId: back, amount: 2 },
    ]);
    expect(bad2.ok).toBe(false);
  });

  it('accepts a Backline hit once all others are lethal', () => {
    // Tests Rule 467.2.c.6: Backline receives damage after all non-Backline units have lethal
    const s = base();
    spawn(s, 'fx-titan', 'p0', BF);
    const g = spawn(s, 'fx-grunt', 'p1', BF);
    const back = spawn(s, 'fx-archer', 'p1', BF);
    const d = toDamage(s);
    const r1 = ok(
      assign(d, 'p0', [
        { unitId: g, amount: 2 },
        { unitId: back, amount: 5 },
      ]),
    );
    const r = ok(assign(r1.state, 'p1', autoAssign(r1.state, FIXTURE_CARDS, 'p1')));
    expect(r.state.objects[back]!.damage).toBe(5);
  });

  it('requires lethal before overflow and allows excess only at the end', () => {
    // Tests Rule 467.2.c.4: no more than lethal on a unit while another lacks lethal
    const s = base();
    spawn(s, 'fx-titan', 'p0', BF);
    const a = spawn(s, 'fx-grunt', 'p1', BF);
    const b = spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    const bad = assign(d, 'p0', [{ unitId: a, amount: 7 }]);
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
    const ok2 = assign(d, 'p0', [
      { unitId: a, amount: 2 },
      { unitId: b, amount: 5 },
    ]);
    expect(ok2.ok).toBe(true); // a has exactly lethal; the excess goes on the last unit
    // Both over lethal: only the last unit assigned may take excess (467.2.c.4).
    const both = assign(d, 'p0', [
      { unitId: a, amount: 3 },
      { unitId: b, amount: 4 },
    ]);
    expect(both).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
  });

  it('rejects excess on one unit when another has not received lethal', () => {
    // Tests Rule 467.2.c.4: overflow is illegal while a unit lacks lethal
    const s = base();
    spawn(s, 'fx-raider', 'p0', BF); // 3 as attacker
    const a = spawn(s, 'fx-grunt', 'p1', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    expect(assign(d, 'p0', [{ unitId: a, amount: 3 }]).ok).toBe(false);
    ok(
      assign(d, 'p0', [
        { unitId: a, amount: 2 },
        { unitId: unitsAt(d, BF, 'p1')[1]!.id, amount: 1 },
      ]),
    );
  });

  it('allows excess only on the last unit of the ordering (Tank T=2,N=1 rejected, T=1,N=2 accepted)', () => {
    // Tests Rule 467.2.c.4: no excess on a unit unless no other units remain to be assigned
    const s = base();
    spawn(s, 'fx-ganker', 'p0', BF); // 3 Might
    const t = spawn(s, 'fx-ash-tank', 'p1', BF, { damage: 2 }); // lethal 1
    const n = spawn(s, 'fx-grunt', 'p1', BF, { damage: 1 }); // lethal 1
    const d = toDamage(s);
    const bad = assign(d, 'p0', [
      { unitId: t, amount: 2 },
      { unitId: n, amount: 1 },
    ]);
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
    expect(
      assign(d, 'p0', [
        { unitId: t, amount: 1 },
        { unitId: n, amount: 2 },
      ]).ok,
    ).toBe(true);
    expect(autoAssign(d, FIXTURE_CARDS, 'p0')).toEqual([
      { unitId: t, amount: 1 },
      { unitId: n, amount: 2 },
    ]);
  });

  it('allows excess on one of two equal-tier units but not on both', () => {
    // Tests Rule 467.2.c.7: ties are the assigner's choice, so one of them is simply assigned last
    const s = base();
    spawn(s, 'fx-ganker', 'p0', BF);
    spawn(s, 'fx-titan', 'p0', BF); // 10 Might in total
    const a = spawn(s, 'fx-grunt', 'p1', BF);
    const b = spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    expect(
      assign(d, 'p0', [
        { unitId: a, amount: 2 },
        { unitId: b, amount: 8 },
      ]).ok,
    ).toBe(true);
    expect(
      assign(d, 'p0', [
        { unitId: a, amount: 8 },
        { unitId: b, amount: 2 },
      ]).ok,
    ).toBe(true);
    expect(
      assign(d, 'p0', [
        { unitId: a, amount: 5 },
        { unitId: b, amount: 5 },
      ]),
    ).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
  });

  it('rejects two partially damaged units (one unit must be finished first)', () => {
    // Tests Rule 467.2.c.3: each unit receives lethal before the next receives any
    const s = base();
    spawn(s, 'fx-ganker', 'p0', BF); // 3
    const a = spawn(s, 'fx-grunt', 'p1', BF);
    const b = spawn(s, 'fx-grunt', 'p1', BF);
    const c = spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    const bad = assign(d, 'p0', [
      { unitId: a, amount: 1 },
      { unitId: b, amount: 1 },
      { unitId: c, amount: 1 },
    ]);
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
    ok(
      assign(d, 'p0', [
        { unitId: a, amount: 2 },
        { unitId: b, amount: 1 },
      ]),
    );
  });

  it('lets the assigner choose among units of the same tier', () => {
    // Tests Rule 467.2.c.7: ties between same-priority units are the assigner's choice
    const s = base();
    spawn(s, 'fx-grunt', 'p0', BF);
    const a = spawn(s, 'fx-grunt', 'p1', BF);
    const b = spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    expect(assign(d, 'p0', [{ unitId: a, amount: 2 }]).ok).toBe(true);
    expect(assign(d, 'p0', [{ unitId: b, amount: 2 }]).ok).toBe(true);
  });

  it('rejects the wrong player and the wrong step', () => {
    // Tests Rule 467.2.c: the attacker assigns first; only the awaited player may assign
    const { d, tank } = scenario();
    expect(assign(d, 'p1', [{ unitId: tank, amount: 1 }])).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_PRIORITY',
    });
    const sd = ok(startCombat(base(), FIXTURE_CARDS, BF)).state;
    expect(assign(sd, 'p0', [])).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    expect(assign(base(), 'p0', [])).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });

  it('rejects a wrong total (too little or too much)', () => {
    // Tests Rule 467.2.c: the total assigned must equal the assigner's total Might
    const { d, tank } = scenario();
    expect(assign(d, 'p0', [{ unitId: tank, amount: 3 }])).toMatchObject({
      ok: false,
      code: 'INVALID_DAMAGE_ASSIGNMENT',
    });
    expect(assign(d, 'p0', [])).toMatchObject({ ok: false, code: 'INVALID_DAMAGE_ASSIGNMENT' });
    expect(assign(d, 'p0', [{ unitId: tank, amount: 8 }]).ok).toBe(false);
  });

  it('rejects own units, units elsewhere, unknown ids, duplicates and bad amounts', () => {
    // Tests Rule 467.2.c: only the opponent's units at the battlefield may receive damage
    const s = base();
    const own = spawn(s, 'fx-titan', 'p0', BF);
    const enemy = spawn(s, 'fx-grunt', 'p1', BF);
    const away = spawn(s, 'fx-grunt', 'p1', 'bf1');
    const d = toDamage(s);
    expect(assign(d, 'p0', [{ unitId: own, amount: 7 }])).toMatchObject({ code: 'ILLEGAL_TARGET' });
    expect(assign(d, 'p0', [{ unitId: away, amount: 7 }])).toMatchObject({
      code: 'ILLEGAL_TARGET',
    });
    expect(assign(d, 'p0', [{ unitId: 'zzz', amount: 7 }])).toMatchObject({ code: 'NOT_FOUND' });
    expect(
      assign(d, 'p0', [
        { unitId: enemy, amount: 3 },
        { unitId: enemy, amount: 4 },
      ]),
    ).toMatchObject({ code: 'INVALID_DAMAGE_ASSIGNMENT' });
    expect(assign(d, 'p0', [{ unitId: enemy, amount: 3.5 }])).toMatchObject({
      code: 'INVALID_DAMAGE_ASSIGNMENT',
    });
    expect(assign(d, 'p0', [{ unitId: enemy, amount: -1 }])).toMatchObject({
      code: 'INVALID_DAMAGE_ASSIGNMENT',
    });
  });

  it('needs 1 damage to be lethal on a 0-Might unit', () => {
    // Tests Rule 142.4: lethal damage is a non-zero amount, so 0-Might needs 1
    const s = base();
    spawn(s, 'fx-grunt', 'p0', BF); // 2
    const w1 = spawn(s, 'fx-wisp', 'p1', BF);
    const w2 = spawn(s, 'fx-wisp', 'p1', BF);
    const d = toDamage(s);
    expect(
      computeAssignmentConstraints(d, FIXTURE_CARDS, 'p0').ordered.map((u) => u.lethal),
    ).toEqual([1, 1]);
    expect(assign(d, 'p0', [{ unitId: w1, amount: 2 }]).ok).toBe(false);
    ok(
      assign(d, 'p0', [
        { unitId: w1, amount: 1 },
        { unitId: w2, amount: 1 },
      ]),
    );
  });

  it('counts assault in the total and shield in lethal', () => {
    // Tests Rule 467.2.c: Assault raises the attacker total; Shield raises the defender lethal
    const s = base();
    spawn(s, 'fx-raider', 'p0', BF); // 3
    const sh = spawn(s, 'fx-shielder', 'p1', BF); // 3 lethal as defender
    const d = toDamage(s);
    const c = computeAssignmentConstraints(d, FIXTURE_CARDS, 'p0');
    expect(c.total).toBe(3);
    expect(c.ordered[0]).toEqual({ unitId: sh, lethal: 3, tier: 'NORMAL' });
  });
});

describe('damage dealing', () => {
  it('stores the attacker assignment, asks the defender, then deals simultaneously', () => {
    // Tests Rule 467.2.d: damage is dealt simultaneously after both players assigned
    const s = base();
    const a1 = spawn(s, 'fx-grunt', 'p0', BF);
    const d1 = spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    const r1 = ok(assign(d, 'p0', [{ unitId: d1, amount: 2 }]));
    expect(r1.events).toEqual([]);
    expect(r1.state.objects[d1]!.damage).toBe(0); // assignment is not dealing (467.2.c.1)
    expect(r1.state.flow.combat).toMatchObject({ step: 'DAMAGE', awaitingAssignmentFrom: 'p1' });
    const r2 = ok(assign(r1.state, 'p1', [{ unitId: a1, amount: 2 }]));
    expect(r2.state.objects[d1]!.damage).toBe(2);
    expect(r2.state.objects[a1]!.damage).toBe(2);
    expect(r2.state.flow.combat).toMatchObject({
      step: 'RESOLUTION',
      awaitingAssignmentFrom: null,
    });
    expect(r2.events).toMatchObject([
      { type: 'COMBAT_DAMAGE_ASSIGNED', player: 'p0', unitId: d1, amount: 2 },
      { type: 'COMBAT_DAMAGE_ASSIGNED', player: 'p1', unitId: a1, amount: 2 },
    ]);
    // killing is not done here; the cleanup loop does it
    expect(r2.state.objects[d1]!.zone.kind).toBe('battlefield');
    expect(r2.state.flow.priority).toBeNull();
  });

  it('the defender sees the attacker totals unchanged and a dead-to-be unit still hits back', () => {
    // Tests Rule 467.2.d: damage is simultaneous, so a unit lethally assigned still deals damage
    const s = base();
    spawn(s, 'fx-grunt', 'p0', BF);
    const dUnit = spawn(s, 'fx-grunt', 'p1', BF);
    const d = toDamage(s);
    const r1 = ok(assign(d, 'p0', [{ unitId: dUnit, amount: 2 }]));
    expect(computeAssignmentConstraints(r1.state, FIXTURE_CARDS, 'p1').total).toBe(2);
  });

  it('killLethalUnits kills only lethally damaged units, to the owner trash', () => {
    // Tests Rule 323.4: units with lethal damage are killed in Cleanup
    const s = base();
    const a1 = spawn(s, 'fx-grunt', 'p0', BF);
    const d1 = spawn(s, 'fx-grunt', 'p1', BF);
    const d2 = spawn(s, 'fx-titan', 'p1', BF);
    const w = spawn(s, 'fx-wisp', 'p1', BF); // 0 might, 0 damage: survives
    const blade = spawn(s, 'fx-blade', 'p0', 'base');
    s.objects[blade]!.attachedTo = a1;
    s.objects[a1]!.damage = 2;
    s.objects[d1]!.damage = 2;
    s.objects[d2]!.damage = 6;
    const work = structuredClone(s);
    const events = killLethalUnits(work, FIXTURE_CARDS);
    expect(events).toEqual([
      { type: 'UNIT_KILLED', unitId: a1 },
      { type: 'UNIT_KILLED', unitId: d1 },
    ]);
    expect(work.objects[a1]!.zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(work.players[0].trash).toContain(a1);
    expect(work.players[1].trash).toContain(d1);
    expect(work.objects[d2]!.zone.kind).toBe('battlefield');
    expect(work.objects[w]!.zone.kind).toBe('battlefield');
    expect(work.objects[blade]!.attachedTo).toBeUndefined();
    expect(work.objects[blade]!.zone.kind).toBe('base');
    expect(s.objects[a1]!.zone.kind).toBe('battlefield'); // input untouched
  });

  it('a killed token ceases to exist instead of going to the trash', () => {
    // Tests Rule 186.1: a token in a non-Board zone ceases to exist
    const cards = {
      ...FIXTURE_CARDS,
      'cx-token': { ...FIXTURE_CARDS['fx-grunt']!, cardId: 'cx-token', type: 'TOKEN' as const },
    };
    const s = base();
    const tok = spawn(s, 'cx-token', 'p1', BF, { damage: 2 });
    const blade = spawn(s, 'fx-blade', 'p1', 'base');
    s.objects[blade]!.attachedTo = tok;
    const events = killLethalUnits(s, cards);
    expect(events).toEqual([{ type: 'UNIT_KILLED', unitId: tok }]);
    expect(s.objects[tok]).toBeUndefined();
    expect(s.players[1].trash).not.toContain(tok);
    expect(s.players[1].base).not.toContain(tok);
    expect(s.objects[blade]!.attachedTo).toBeUndefined();
    expect(checkInvariants(s, cards)).toEqual([]);
  });

  it('a 1-damage kill of a 0-Might unit', () => {
    // Tests Rule 142.4: a 0-Might unit is lethally damaged by 1 damage
    const s = base();
    const w = spawn(s, 'fx-wisp', 'p1', BF, { damage: 1 });
    const events = killLethalUnits(s, FIXTURE_CARDS);
    expect(events).toEqual([{ type: 'UNIT_KILLED', unitId: w }]);
  });
});

/** Run a full combat: assign auto for each side, kill, resolve. */
function fight(
  s: GameState,
  conquer = vi.fn<NonNullable<ShowdownDeps['onConquer']>>((st) => ({ state: st, events: [] })),
) {
  let cur = toDamage(s);
  for (let i = 0; i < 2; i++) {
    const p = cur.flow.combat?.awaitingAssignmentFrom;
    if (!p) break;
    cur = ok(assign(cur, p, autoAssign(cur, FIXTURE_CARDS, p))).state;
  }
  const killed = structuredClone(cur);
  killLethalUnits(killed, FIXTURE_CARDS);
  const r = resolveCombatWithResult(killed, FIXTURE_CARDS, { onConquer: conquer });
  if ('ok' in r) throw new Error(r.message);
  return { r, conquer, before: cur };
}

describe('resolveCombat', () => {
  it('attacker wins, takes control and Conquers exactly once', () => {
    // Tests Rule 468.3: the sole surviving designated player wins; 468.5 establishes control
    const s = base();
    const a = spawn(s, 'fx-titan', 'p0', BF);
    const dUnit = spawn(s, 'fx-grunt', 'p1', BF);
    const { r, conquer } = fight(s);
    expect(r.result).toBe('ATTACKER_WINS');
    expect(r.state.objects[dUnit]!.zone.kind).toBe('trash');
    expect(r.state.objects[a]!.zone.kind).toBe('battlefield');
    const bf = r.state.battlefields.find((b) => b.id === BF)!;
    expect(bf.controller).toBe('p0');
    expect(bf.contestedBy).toBeNull();
    expect(conquer).toHaveBeenCalledTimes(1);
    expect(conquer.mock.calls[0]![1]).toBe('p0');
    expect(r.events.map((e) => e.type)).toContain('BATTLEFIELD_CONTROL_CHANGED');
    expect(r.state.flow.combat).toBeUndefined();
    expect(r.state.flow.showdown).toBeUndefined();
    expect(r.state.flow.priority).toBe(r.state.turn.activePlayer);
    expect(r.state.flow.focus).toBeNull();
    expect(r.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
  });

  it('awards the real point through scoring.onConquer by default, once', () => {
    // Tests Rule 473.1: a Conquer scores one point; not again on a battlefield already scored
    const s = base();
    spawn(s, 'fx-titan', 'p0', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const start = s.players[0].points;
    const a = toDamage(s);
    const b = ok(assign(a, 'p0', autoAssign(a, FIXTURE_CARDS, 'p0'))).state;
    const c = ok(assign(b, 'p1', autoAssign(b, FIXTURE_CARDS, 'p1'))).state;
    killLethalUnits(c, FIXTURE_CARDS);
    const r = ok(resolveCombat(c, FIXTURE_CARDS));
    expect(r.state.players[0].points).toBe(start + 1);
    expect(r.state.battlefields.find((x) => x.id === BF)!.scoredThisTurnBy).toContain('p0');
  });

  it('does not Conquer a battlefield the player already scored this turn', () => {
    // Tests Rule 472: a battlefield is scored at most once per turn
    const s = base();
    s.battlefields.find((b) => b.id === BF)!.scoredThisTurnBy.push('p0');
    spawn(s, 'fx-titan', 'p0', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const { r, conquer } = fight(s);
    expect(conquer).not.toHaveBeenCalled();
    expect(r.state.battlefields.find((b) => b.id === BF)!.controller).toBe('p0');
  });

  it('does not Conquer when the winner already controls the battlefield', () => {
    // Tests Rule 468.5: control is established; Conquer only when it was not controlled
    const s = base();
    s.battlefields.find((b) => b.id === BF)!.controller = 'p0';
    spawn(s, 'fx-titan', 'p0', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const { conquer } = fight(s);
    expect(conquer).not.toHaveBeenCalled();
  });

  it('defender holds and the surviving attackers are recalled to base', () => {
    // Tests Rule 468.1.a.2: Attackers are Recalled (to base, not a Move) if Defenders remain
    const s = base();
    const att = spawn(s, 'fx-grunt', 'p0', BF);
    const def = spawn(s, 'fx-titan', 'p1', BF);
    s.battlefields.find((b) => b.id === BF)!.controller = 'p1';
    const { r, conquer } = fight(s);
    expect(r.result).toBe('DEFENDER_WINS');
    expect(r.state.objects[att]!.zone.kind).toBe('trash');
    expect(r.state.objects[def]!.zone.kind).toBe('battlefield');
    expect(r.state.battlefields.find((b) => b.id === BF)!.controller).toBe('p1');
    expect(conquer).not.toHaveBeenCalled();
  });

  it('recalls a surviving attacker (moves to its owner base zone)', () => {
    // Tests Rule 468.1.a.2: Recall moves a permanent to base and is not a Move
    const s = base();
    const att = spawn(s, 'fx-titan', 'p0', BF);
    const def = spawn(s, 'fx-titan', 'p1', BF);
    s.battlefields.find((b) => b.id === BF)!.controller = 'p1';
    // custom: attacker assigns onto defender 3 (survives), defender assigns 3 onto attacker (survives)
    let cur = toDamage(s);
    cur = ok(assign(cur, 'p0', [{ unitId: def, amount: 7 }])).state;
    // defender deals only... auto assign legal amount is 7: both die
    cur = ok(assign(cur, 'p1', [{ unitId: att, amount: 7 }])).state;
    // reduce damage manually to simulate prevention so both survive
    cur.objects[att]!.damage = 3;
    cur.objects[def]!.damage = 3;
    killLethalUnits(cur, FIXTURE_CARDS);
    const r = resolveCombatWithResult(cur, FIXTURE_CARDS);
    if ('ok' in r) throw new Error(r.message);
    expect(r.result).toBe('NO_RESULT');
    expect(r.state.objects[att]!.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(r.state.players[0].base).toContain(att);
    expect(r.state.objects[att]!.ready).toBe(true); // Recall does not exhaust
    expect(r.state.objects[def]!.zone.kind).toBe('battlefield');
    expect(r.state.objects[att]!.damage).toBe(0); // healed
    expect(r.state.objects[def]!.damage).toBe(0);
    expect(r.state.battlefields.find((b) => b.id === BF)!.controller).toBe('p1');
    expect(r.events).toContainEqual({
      type: 'UNIT_MOVED',
      unitId: att,
      from: BF,
      to: 'base',
      seq: expect.any(Number),
    });
  });

  it('mutual destruction: No Result and the battlefield becomes uncontrolled', () => {
    // Tests Rule 468.3: both sides lose all units -> No Result; control is lost
    const s = base();
    s.battlefields.find((b) => b.id === BF)!.controller = 'p1';
    spawn(s, 'fx-grunt', 'p0', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const { r, conquer } = fight(s);
    expect(r.result).toBe('NO_RESULT');
    const bf = r.state.battlefields.find((b) => b.id === BF)!;
    expect(bf.controller).toBeNull();
    expect(bf.contestedBy).toBeNull();
    expect(conquer).not.toHaveBeenCalled();
    expect(r.events).toContainEqual({
      type: 'BATTLEFIELD_CONTROL_CHANGED',
      battlefieldId: BF,
      controller: null,
      seq: expect.any(Number),
    });
    expect(r.state.flow.combat).toBeUndefined();
  });

  it('heals the survivors at the battlefield', () => {
    // Tests Rule 468.1.a.1: damage is removed from units after the cleanup kills
    const s = base();
    const a = spawn(s, 'fx-titan', 'p0', BF);
    spawn(s, 'fx-grunt', 'p1', BF);
    const { r, before } = fight(s);
    expect(before.objects[a]!.damage).toBe(2);
    expect(r.state.objects[a]!.damage).toBe(0);
  });

  it('requires the Resolution step', () => {
    // Tests Rule 468: resolution only happens in the Resolution step
    expect(resolveCombat(base(), FIXTURE_CARDS)).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    const d = toDamage(
      (() => {
        const s = base();
        spawn(s, 'fx-grunt', 'p0', BF);
        spawn(s, 'fx-grunt', 'p1', BF);
        return s;
      })(),
    );
    expect(resolveCombat(d, FIXTURE_CARDS)).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });

  it('resolves straight away when one side was empty at the damage step', () => {
    // Tests Rule 468.5: with no opposing units the sole player establishes control
    const s = base();
    spawn(s, 'fx-grunt', 'p0', BF);
    const conquer = vi.fn((st: GameState) => ({ state: st, events: [] }));
    const d = toDamage(s);
    const r = ok(resolveCombat(d, FIXTURE_CARDS, { onConquer: conquer }));
    expect(r.state.battlefields.find((b) => b.id === BF)!.controller).toBe('p0');
    expect(conquer).toHaveBeenCalledTimes(1);
  });
});

describe('purity and determinism', () => {
  it('never mutates its input state', () => {
    // Tests Rule 467.2: combat functions are pure
    const s = base();
    spawn(s, 'fx-titan', 'p0', BF);
    const u = spawn(s, 'fx-grunt', 'p1', BF);
    const snap = JSON.stringify(s);
    const started = ok(startCombat(s, FIXTURE_CARDS, BF)).state;
    const startedSnap = JSON.stringify(started);
    const d = ok(continueCombat(started, FIXTURE_CARDS)).state;
    const dSnap = JSON.stringify(d);
    const a = ok(assign(d, 'p0', [{ unitId: u, amount: 7 }]));
    const aSnap = JSON.stringify(a.state);
    resolveCombat(a.state, FIXTURE_CARDS);
    computeAssignmentConstraints(d, FIXTURE_CARDS, 'p0');
    autoAssign(d, FIXTURE_CARDS, 'p0');
    expect(JSON.stringify(s)).toBe(snap);
    expect(JSON.stringify(started)).toBe(startedSnap);
    expect(JSON.stringify(d)).toBe(dSnap);
    expect(JSON.stringify(a.state)).toBe(aSnap);
  });

  it('is deterministic', () => {
    // Tests Rule 467.2.d: identical inputs give identical results
    const make = () => {
      const s = base();
      spawn(s, 'fx-titan', 'p0', BF);
      spawn(s, 'fx-ash-tank', 'p1', BF);
      spawn(s, 'fx-archer', 'p1', BF);
      return fight(s).r;
    };
    const x = make();
    const y = make();
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
  });
});
