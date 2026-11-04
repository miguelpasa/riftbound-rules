import { describe, expect, it } from 'vitest';
import {
  assignCombatDamage,
  autoAssign,
  computeAssignmentConstraints,
  effectiveMight,
  sanitizeFor,
  type CardDatabase,
  type GameState,
  type PlayerId,
} from '@riftbound/engine';
import { damageScenario } from '../testing/combatScenario';
import {
  assignmentConstraintsFromView,
  autoAssignFromView,
  effectiveMightFromView,
  validateAssignment,
} from './damage';

/** All ways to spread exactly `total` over `n` slots. */
function compositions(total: number, n: number): number[][] {
  if (n === 1) return [[total]];
  const out: number[][] = [];
  for (let first = 0; first <= total; first++) {
    for (const rest of compositions(total - first, n - 1)) out.push([first, ...rest]);
  }
  return out;
}

function compareWithEngine(state: GameState, db: CardDatabase, who: PlayerId) {
  const view = sanitizeFor(state, who);
  const engine = computeAssignmentConstraints(state, db, who);
  const mine = assignmentConstraintsFromView(view, db, who);
  expect(mine.total).toBe(engine.total);
  expect(mine.ordered.map((u) => [u.unitId, u.lethal, u.tier])).toEqual(
    engine.ordered.map((u) => [u.unitId, u.lethal, u.tier]),
  );
  // autoAssign agrees with the engine's.
  expect(autoAssignFromView(mine)).toEqual(
    Object.fromEntries(autoAssign(state, db, who).map((a) => [a.unitId, a.amount])),
  );
  // Every distribution (also over-assigning is excluded: total is fixed) is accepted/rejected alike.
  const check = engine.ordered.length > 0 ? compositions(engine.total, engine.ordered.length) : [];
  const awaiting = state.flow.combat?.awaitingAssignmentFrom === who;
  for (const dist of check) {
    const amounts = Object.fromEntries(mine.ordered.map((u, i) => [u.unitId, dist[i] as number]));
    const mineOk = validateAssignment(mine, amounts).ok;
    if (awaiting) {
      const r = assignCombatDamage(state, db, {
        type: 'ASSIGN_COMBAT_DAMAGE',
        playerId: who,
        assignments: mine.ordered.map((u, i) => ({ unitId: u.unitId, amount: dist[i] as number })),
      });
      expect(mineOk, `${JSON.stringify(dist)}`).toBe(r.ok);
    }
  }
  return { view, mine, engine, checked: check.length };
}

describe('damage helpers vs the engine', () => {
  it('Tank first, Backline last: same order, lethal, total and verdict for every distribution', () => {
    const { sc } = damageScenario(
      ['fx-ash-tank', 'fx-grunt'],
      ['fx-order-tank', 'fx-tide-grunt', 'fx-tide-archer'],
    );
    const r = compareWithEngine(sc.state, sc.cards, 'p0');
    expect(r.mine.total).toBe(5);
    expect(r.mine.ordered.map((u) => u.tier)).toEqual(['TANK', 'NORMAL', 'BACKLINE']);
    expect(r.checked).toBeGreaterThan(10);
  });

  it('puts the Tank first even when it is the newest unit', () => {
    const { sc } = damageScenario(['fx-grunt', 'fx-ash-tank'], ['fx-tide-grunt', 'fx-order-tank']);
    const r = compareWithEngine(sc.state, sc.cards, 'p0');
    expect(r.mine.ordered.map((u) => u.tier)).toEqual(['TANK', 'NORMAL']);
  });

  it('applies Assault (attacker), Shield (defender), Might bonus and marked damage', () => {
    const { sc, att, def } = damageScenario(
      ['fx-raider', 'fx-grunt'],
      [
        ['fx-order-shielder', { mightBonus: 1 }],
        ['fx-order-tank', { damage: 1 }],
        'fx-tide-archer',
      ],
    );
    const state = sc.state;
    // raider 2+Assault 1 = 3, grunt 2 => 5 for the attacker
    const view0 = sanitizeFor(state, 'p0');
    expect(effectiveMightFromView(view0, sc.cards, att[0] as string)).toBe(3);
    expect(effectiveMight(state, sc.cards, att[0] as string)).toBe(3);
    // shielder 2 + bonus 1 + Shield 1 = 4 as the defender
    expect(effectiveMightFromView(view0, sc.cards, def[0] as string)).toBe(4);
    expect(effectiveMightFromView(view0, sc.cards, def[0] as string)).toBe(
      effectiveMight(state, sc.cards, def[0] as string),
    );
    // keywords can be switched off with a null role
    expect(effectiveMightFromView(view0, sc.cards, def[0] as string, { role: null })).toBe(3);

    const r = compareWithEngine(state, sc.cards, 'p0');
    expect(r.mine.total).toBe(5);
    const tank = r.mine.ordered[0]!;
    expect(tank.tier).toBe('TANK');
    expect(tank.lethal).toBe(2); // Might 3 minus 1 marked damage
    expect(r.mine.ordered.find((u) => u.unitId === def[0])!.lethal).toBe(4);
  });

  it('matches the engine for the second assigner (defender) too', () => {
    const { sc, def } = damageScenario(
      ['fx-ash-tank', 'fx-archer'],
      ['fx-order-shielder', 'fx-order-tank'],
    );
    const att = computeAssignmentConstraints(sc.state, sc.cards, 'p0');
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: autoAssign(sc.state, sc.cards, 'p0'),
    });
    expect(att.total).toBeGreaterThan(0);
    if (sc.state.flow.combat?.awaitingAssignmentFrom === 'p1') {
      const r = compareWithEngine(sc.state, sc.cards, 'p1');
      expect(r.mine.total).toBeGreaterThan(0);
      expect(def.length).toBe(2);
    }
  });

  it('names the blocking rule for invalid distributions', () => {
    const { sc, def } = damageScenario(
      ['fx-ash-tank', 'fx-grunt'],
      ['fx-order-tank', 'fx-tide-grunt', 'fx-tide-archer'],
    );
    const c = assignmentConstraintsFromView(sanitizeFor(sc.state, 'p0'), sc.cards, 'p0');
    const [tank, grunt, archer] = def as [string, string, string];
    const wrongTotal = validateAssignment(c, { [tank]: 3 });
    expect(wrongTotal).toMatchObject({ ok: false });
    expect(!wrongTotal.ok && wrongTotal.message).toContain('Assign exactly 5 damage (currently 3)');

    const skipTank = validateAssignment(c, { [grunt]: 2, [archer]: 2, [tank]: 1 });
    expect(!skipTank.ok && skipTank.message).toContain(
      'Order Warden (Tank) must be assigned lethal damage before Tide Scholar (Normal)',
    );
    expect(!skipTank.ok && skipTank.rule).toBe('467.2.c');

    const backline = validateAssignment(c, { [tank]: 3, [archer]: 2 });
    expect(!backline.ok && backline.rule).toBe('467.2.c.6');

    const good = validateAssignment(c, { [tank]: 3, [grunt]: 2 });
    expect(good).toEqual({
      ok: true,
      assignments: [
        { unitId: tank, amount: 3 },
        { unitId: grunt, amount: 2 },
      ],
    });
  });
});
