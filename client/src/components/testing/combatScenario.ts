import { Scenario, type PutUnitOptions } from '../../../../engine/src/testing/scenario.js';

export type UnitSpec = string | [cardId: string, opts: PutUnitOptions];

const spec = (u: UnitSpec): [string, PutUnitOptions] => (typeof u === 'string' ? [u, {}] : u);

/**
 * p0 attacks bf1 (held by p1 through `defenders`) with `attackers`. Returns right after the
 * STANDARD_MOVE: a combat Showdown with p0 holding Focus. Call `toDamage(sc)` to pass through it.
 */
export function combatShowdown(
  attackers: UnitSpec[],
  defenders: UnitSpec[],
): { sc: Scenario; att: string[]; def: string[] } {
  const sc = Scenario.start();
  const def = defenders.map((u, i) => {
    const [c, o] = spec(u);
    return sc.putUnit('p1', c, 'bf1', { ...o, control: i === 0 });
  });
  const att = attackers.map((u) => {
    const [c, o] = spec(u);
    return sc.putUnit('p0', c, 'base', o);
  });
  sc.do({
    type: 'STANDARD_MOVE',
    playerId: 'p0',
    unitIds: att,
    destination: { kind: 'battlefield', battlefieldId: 'bf1' },
  });
  return { sc, att, def };
}

/** Both players pass in the combat Showdown: the damage step begins, p0 assigning first. */
export function toDamage(sc: Scenario): Scenario {
  sc.pass('p0');
  sc.pass('p1');
  return sc;
}

export function damageScenario(attackers: UnitSpec[], defenders: UnitSpec[]) {
  const r = combatShowdown(attackers, defenders);
  toDamage(r.sc);
  return r;
}
