import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';

const toBf = (bfId: string) => ({ kind: 'battlefield' as const, battlefieldId: bfId });

/** p0 attacks bf1 (held by p1 through `defenders`) with `attackers`; ends in the combat damage step. */
function startCombat(
  attackers: string[],
  defenders: string[],
  tweak: (sc: Scenario, ids: { att: string[]; def: string[] }) => void = () => {},
): { sc: Scenario; att: string[]; def: string[] } {
  const sc = Scenario.start();
  const def = defenders.map((c, i) => sc.putUnit('p1', c, 'bf1', { control: i === 0 }));
  const att = attackers.map((c) => sc.putUnit('p0', c, 'base'));
  tweak(sc, { att, def });
  sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: att, destination: toBf('bf1') });
  return { sc, att, def };
}

const assign = (player: 'p0' | 'p1', pairs: [string, number][]) =>
  ({
    type: 'ASSIGN_COMBAT_DAMAGE',
    playerId: player,
    assignments: pairs.map(([unitId, amount]) => ({ unitId, amount })),
  }) as const;

describe('scenario: Combat', () => {
  it('opens a combat Showdown for the attacker and prompts the attacker to assign damage first', () => {
    // Tests Rule 462: moving onto an enemy-held battlefield starts combat with a combat Showdown
    const { sc, att } = startCombat(['fx-ash-tank'], ['fx-order-tank']);
    expect(sc.state.flow.showdown).toMatchObject({
      battlefieldId: 'bf1',
      isCombat: true,
      attacker: 'p0',
      defender: 'p1',
    });
    expect(sc.state.flow.combat).toMatchObject({
      battlefieldId: 'bf1',
      attacker: 'p0',
      defender: 'p1',
      step: 'SHOWDOWN',
    });
    expect(sc.state.flow.focus).toBe('p0');
    expect(sc.eventsOfType('SHOWDOWN_STARTED')).toEqual([
      expect.objectContaining({ battlefieldId: 'bf1', isCombat: true }),
    ]);
    // Damage cannot be assigned before the Showdown ends
    expect(sc.reject(assign('p0', [[att[0] as string, 3]])).code).toBe('WRONG_PHASE');

    sc.pass('p0');
    sc.pass('p1');
    expect(sc.state.flow.combat).toMatchObject({
      step: 'DAMAGE',
      awaitingAssignmentFrom: 'p0',
    });
    expect(sc.state.flow.priority).toBeNull(); // 467.3: no Chain, nobody has Priority
    // The defender may not jump the queue
    const early = sc.reject(assign('p1', [[att[0] as string, 3]]));
    expect(early.code).toBe('NOT_YOUR_PRIORITY');
    expect(early.message).toContain('waiting for p0 to assign');
  });

  it('forces Tank first and Backline last, rejects bad assignments, kills lethal units in Cleanup', () => {
    // Tests Rule 467.2.c: damage goes to Tank units first and to Backline units last
    const { sc, att, def } = startCombat(
      ['fx-ash-tank', 'fx-grunt'],
      ['fx-order-tank', 'fx-tide-grunt', 'fx-tide-archer'],
    );
    const [aTank, aGrunt] = att as [string, string];
    const [dTank, dGrunt, dArcher] = def as [string, string, string];
    sc.pass('p0');
    sc.pass('p1');

    // attacker has 3 + 2 = 5 Might
    const wrongTotal = sc.reject(assign('p0', [[dTank, 3]]));
    expect(wrongTotal.code).toBe('INVALID_DAMAGE_ASSIGNMENT');
    expect(wrongTotal.message).toContain('assign exactly 5 damage (got 3)');

    const tankSkipped = sc.reject(
      assign('p0', [
        [dGrunt, 2],
        [dArcher, 2],
        [dTank, 1],
      ]),
    );
    expect(tankSkipped.code).toBe('INVALID_DAMAGE_ASSIGNMENT');
    expect(tankSkipped.message).toContain(
      `${dTank} (TANK) must be assigned lethal damage before ${dGrunt} (NORMAL) (467.2.c)`,
    );

    const backlineEarly = sc.reject(
      assign('p0', [
        [dTank, 3],
        [dArcher, 2],
      ]),
    );
    expect(backlineEarly.code).toBe('INVALID_DAMAGE_ASSIGNMENT');
    expect(backlineEarly.message).toContain(
      `${dGrunt} (NORMAL) must be assigned lethal damage before ${dArcher} (BACKLINE) (467.2.c.6)`,
    );

    const notEnemy = sc.reject(assign('p0', [[aTank, 5]]));
    expect(notEnemy.code).toBe('ILLEGAL_TARGET');
    expect(
      sc.reject(
        assign('p0', [
          [dTank, -1],
          [dGrunt, 6],
        ]),
      ).code,
    ).toBe('INVALID_DAMAGE_ASSIGNMENT');

    // legal: Tank lethal (3), then the normal unit lethal (2)
    const mid = sc.do(
      assign('p0', [
        [dTank, 3],
        [dGrunt, 2],
      ]),
    );
    expect(mid.events).toHaveLength(0); // assignment is not dealing damage (467.2.c.1)
    expect(sc.state.flow.combat?.awaitingAssignmentFrom).toBe('p1');
    expect(sc.obj(dTank).damage).toBe(0);

    // defender has 3 + 2 + 2 = 7 Might against Tank (3) and a normal unit (2): extra may pile up
    const fin = sc.do(
      assign('p1', [
        [aTank, 3],
        [aGrunt, 4],
      ]),
    );
    const dealt = sc.eventsOfType('COMBAT_DAMAGE_ASSIGNED', fin.events);
    expect(dealt).toHaveLength(4);
    expect(dealt.filter((e) => e.player === 'p0').map((e) => e.amount)).toEqual([3, 2]);
    // lethal damage killed everything that took it, in the same reduce (Cleanup, 323)
    const killed = sc.eventsOfType('UNIT_KILLED', fin.events).map((e) => e.unitId);
    expect(new Set(killed)).toEqual(new Set([aTank, aGrunt, dTank, dGrunt]));
    expect(sc.obj(dTank).zone).toEqual({ kind: 'trash', player: 'p1' });
    expect(sc.obj(aTank).zone).toEqual({ kind: 'trash', player: 'p0' });
    // the Backline survivor holds the battlefield; combat is over (468.7)
    expect(sc.obj(dArcher).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    expect(sc.obj(dArcher).damage).toBe(0);
    expect(sc.state.flow.combat).toBeUndefined();
    expect(sc.state.flow.showdown).toBeUndefined();
    expect(sc.state.flow.priority).toBe('p0');
    expect(sc.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(sc.bf('bf1')).toMatchObject({ controller: 'p1', contestedBy: null });
    expect(sc.player('p0').points).toBe(0);
  });

  it('heals survivors, lets the winning attacker establish control and score a Conquer', () => {
    // Tests Rule 468: the surviving side takes control; survivors are healed; a new controller Conquers
    const { sc, att, def } = startCombat(['fx-titan'], ['fx-order-tank', 'fx-tide-archer']);
    const [titan] = att as [string];
    const [dTank, dArcher] = def as [string, string];
    sc.pass('p0');
    sc.pass('p1');
    // 7 Might: 3 lethal on the Tank, 2 lethal on the Backline unit, 2 extra on the last
    sc.do(
      assign('p0', [
        [dTank, 3],
        [dArcher, 4],
      ]),
    );
    const fin = sc.do(assign('p1', [[titan, 5]]));

    expect(new Set(sc.eventsOfType('UNIT_KILLED', fin.events).map((e) => e.unitId))).toEqual(
      new Set([dTank, dArcher]),
    );
    expect(sc.obj(titan).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    expect(sc.obj(titan).damage).toBe(0); // 468.1.a.1: 5 damage marked, healed on resolution
    expect(sc.obj(titan).ready).toBe(false); // moved in exhausted; nothing readies it
    expect(sc.bf('bf1')).toMatchObject({ controller: 'p0', contestedBy: null });
    expect(sc.eventsOfType('BATTLEFIELD_CONTROL_CHANGED', fin.events)).toEqual([
      expect.objectContaining({ battlefieldId: 'bf1', controller: 'p0' }),
    ]);
    expect(sc.eventsOfType('POINT_GAINED', fin.events)).toEqual([
      expect.objectContaining({ player: 'p0', amount: 1, source: 'CONQUER' }),
    ]);
    expect(sc.player('p0').points).toBe(1);
    expect(sc.state.flow.combat).toBeUndefined();
  });

  it('recalls the attackers to their base when defenders survive', () => {
    // Tests Rule 468.1.a.2: attackers are Recalled if any defender remains
    const { sc, att, def } = startCombat(['fx-wisp'], ['fx-wisp', 'fx-wisp'], (s, ids) => {
      s.setMightBonus(ids.att[0] as string, 1); // a 1 Might attacker
    });
    const [wisp] = att as [string];
    const [d1, d2] = def as [string, string];
    sc.pass('p0');
    const r = sc.pass('p1');
    expect(r.events.some((e) => e.type === 'COMBAT_DAMAGE_ASSIGNED')).toBe(false);
    // defenders have 0 Might, so only the attacker is asked
    expect(sc.state.flow.combat?.awaitingAssignmentFrom).toBe('p0');
    const fin = sc.do(assign('p0', [[d1, 1]]));

    expect(sc.eventsOfType('UNIT_KILLED', fin.events).map((e) => e.unitId)).toEqual([d1]);
    expect(sc.obj(d2).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    expect(sc.obj(wisp).zone).toEqual({ kind: 'base', player: 'p0' });
    expect(sc.player('p0').base).toContain(wisp);
    expect(sc.eventsOfType('UNIT_MOVED', fin.events)).toEqual([
      expect.objectContaining({ unitId: wisp, from: 'bf1', to: 'base' }),
    ]);
    expect(sc.bf('bf1')).toMatchObject({ controller: 'p1', contestedBy: null });
    expect(sc.player('p0').points).toBe(0);
    expect(sc.state.flow.combat).toBeUndefined();
  });

  it('adds Assault to the attacker and Shield to the defender only in their roles', () => {
    // Tests Rule 467.2.c: combat Might includes Assault N for Attackers and Shield N for Defenders
    const { sc, att, def } = startCombat(['fx-raider'], ['fx-order-shielder']);
    const [raider] = att as [string];
    const [shielder] = def as [string];
    sc.pass('p0');
    sc.pass('p1');
    // base Might is 2 for both; Assault 1 / Shield 1 make it 3
    const low = sc.reject(assign('p0', [[shielder, 2]]));
    expect(low.message).toContain('assign exactly 3 damage (got 2)');
    // the Shield unit's lethal is also 3, the Assault unit's lethal is 3 as well
    sc.do(assign('p0', [[shielder, 3]]));
    const lowDef = sc.reject(assign('p1', [[raider, 2]]));
    expect(lowDef.message).toContain('assign exactly 3 damage (got 2)');
    const fin = sc.do(assign('p1', [[raider, 3]]));
    expect(new Set(sc.eventsOfType('UNIT_KILLED', fin.events).map((e) => e.unitId))).toEqual(
      new Set([raider, shielder]),
    );
    // nobody left: the battlefield is uncontrolled and no longer contested
    expect(sc.bf('bf1')).toMatchObject({ controller: null, contestedBy: null });
    expect(sc.player('p0').points).toBe(0);
    expect(sc.player('p1').points).toBe(0);
  });

  it('does not start combat against an empty battlefield, even with an Assault unit', () => {
    // Tests Rule 462: combat needs units of both players at the battlefield
    const sc = Scenario.start();
    const raider = sc.putUnit('p0', 'fx-raider', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [raider], destination: toBf('bf0') });
    sc.pass('p0');
    sc.pass('p1');
    expect(sc.state.flow.combat).toBeUndefined();
    expect(sc.player('p0').points).toBe(1);
  });
});
