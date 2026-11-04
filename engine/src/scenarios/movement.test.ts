import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import type { Intent } from '../types/index.js';

const toBf = (bfId: string) => ({ kind: 'battlefield' as const, battlefieldId: bfId });

describe('scenario: Standard Move and the non-combat Showdown', () => {
  it('exhausts the mover, contests the battlefield and opens a Showdown with the mover holding Focus', () => {
    // Tests Rule 144: a Standard Move exhausts the unit; moving onto an uncontrolled battlefield contests it
    const sc = Scenario.start();
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    const r = sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: toBf('bf1'),
    });

    expect(sc.eventsOfType('UNIT_MOVED', r.events)).toEqual([
      expect.objectContaining({ unitId: unit, from: 'base', to: 'bf1' }),
    ]);
    expect(sc.obj(unit).ready).toBe(false);
    expect(sc.obj(unit).zone).toEqual({ kind: 'battlefield', player: 'p0', battlefieldId: 'bf1' });
    expect(sc.player('p0').base).not.toContain(unit);
    expect(sc.bf('bf1').contestedBy).toBe('p0');
    expect(sc.bf('bf1').controller).toBeNull();

    // 345 / 190: the Cleanup opened a Showdown (not combat); the applier has Focus and Priority
    expect(sc.state.flow.showdown).toEqual({
      battlefieldId: 'bf1',
      isCombat: false,
      passesInRow: 0,
    });
    expect(sc.state.flow.combat).toBeUndefined();
    expect(sc.state.flow.focus).toBe('p0');
    expect(sc.state.flow.priority).toBe('p0');
    expect(sc.state.turnState).toEqual({ kind: 'SHOWDOWN', open: true });
    expect(sc.eventsOfType('SHOWDOWN_STARTED', r.events)).toEqual([
      expect.objectContaining({ battlefieldId: 'bf1', isCombat: false }),
    ]);
  });

  it('establishes control and scores exactly one Conquer point when both players pass', () => {
    // Tests Rule 348: a Showdown closes after two passes in a row and the lone side takes control
    const sc = Scenario.start();
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [unit], destination: toBf('bf1') });

    sc.pass('p0');
    expect(sc.state.flow.showdown?.passesInRow).toBe(1);
    expect(sc.state.flow.priority).toBe('p1');
    expect(sc.player('p0').points).toBe(0); // not before the Showdown closes
    const r = sc.pass('p1');

    expect(sc.state.flow.showdown).toBeUndefined();
    expect(sc.state.flow.focus).toBeNull();
    expect(sc.state.flow.priority).toBe('p0'); // 335: back to the turn player
    expect(sc.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(sc.bf('bf1')).toMatchObject({ controller: 'p0', contestedBy: null });
    expect(sc.eventsOfType('BATTLEFIELD_CONTROL_CHANGED', r.events)).toEqual([
      expect.objectContaining({ battlefieldId: 'bf1', controller: 'p0' }),
    ]);
    expect(sc.eventsOfType('POINT_GAINED', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', amount: 1, source: 'CONQUER' }),
    ]);
    expect(sc.player('p0').points).toBe(1);
    expect(sc.player('p1').points).toBe(0);
    // no second Conquer on later reduces of the same turn
    sc.setBattlefield('bf1', {}); // no-op surgery keeps the state valid
    sc.endTurn('p0');
    expect(sc.player('p0').points).toBe(1);
  });

  it('refuses a Standard Move during a Showdown, with and without a Chain', () => {
    // Tests Rule 144.1.c: Standard Moves cannot be made during a Showdown
    const sc = Scenario.start();
    const first = sc.putUnit('p0', 'fx-grunt', 'base');
    const second = sc.putUnit('p0', 'fx-archer', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [first], destination: toBf('bf1') });

    const move: Intent = {
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [second],
      destination: toBf('bf0'),
    };
    const err = sc.reject(move);
    expect(err.code).toBe('MOVE_NOT_ALLOWED_IN_SHOWDOWN');
    expect(err.message).toBe(
      '[Rule Error] Standard Moves cannot be made during a Showdown. (Rule 144.1.c)',
    );

    // Closed Showdown: an Action on the Chain; the Showdown rule still wins
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
    expect(sc.state.turnState).toEqual({ kind: 'SHOWDOWN', open: false });
    expect(sc.reject(move).code).toBe('MOVE_NOT_ALLOWED_IN_SHOWDOWN');
    expect(sc.obj(second).zone.kind).toBe('base');
  });

  it('refuses a Move that is not legal: exhausted unit, wrong turn, base to base', () => {
    // Tests Rule 144.2: the Move cost is exhausting a ready unit controlled by the turn player
    const sc = Scenario.start();
    const tired = sc.putUnit('p0', 'fx-grunt', 'base', { ready: false });
    const ready = sc.putUnit('p0', 'fx-archer', 'base');
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const dest = toBf('bf0');
    expect(
      sc.reject({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [tired], destination: dest })
        .code,
    ).toBe('UNIT_EXHAUSTED');
    expect(
      sc.reject({ type: 'STANDARD_MOVE', playerId: 'p1', unitIds: [theirs], destination: dest })
        .code,
    ).toBe('NOT_YOUR_TURN');
    expect(
      sc.reject({
        type: 'STANDARD_MOVE',
        playerId: 'p0',
        unitIds: [ready],
        destination: { kind: 'base' },
      }).code,
    ).toBe('ILLEGAL_MOVE_DESTINATION');
  });

  it('only lets a unit move battlefield to battlefield if it has Ganking', () => {
    // Tests Rule 144.4.c.1: moving between battlefields requires Ganking
    const sc = Scenario.start();
    const plain = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    const err = sc.reject({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [plain],
      destination: toBf('bf1'),
    });
    expect(err.code).toBe('ILLEGAL_MOVE_DESTINATION');
    expect(err.message).toBe(
      `[Rule Error] That is not a legal destination for this move. (Rule 144) [unit ${plain} lacks Ganking]`,
    );

    const ganker = sc.putUnit('p0', 'fx-ganker', 'bf0');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [ganker], destination: toBf('bf1') });
    expect(sc.obj(ganker).zone).toEqual({
      kind: 'battlefield',
      player: 'p0',
      battlefieldId: 'bf1',
    });
    expect(sc.obj(ganker).ready).toBe(false);
    expect(sc.bf('bf1').contestedBy).toBe('p0');
    expect(sc.bf('bf0').controller).toBe('p0'); // the plain unit still holds it
  });

  it('lets a unit retreat from a battlefield to its base', () => {
    // Tests Rule 144.4.b: a unit may move from a battlefield to its controller's base
    const sc = Scenario.start();
    const unit = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: { kind: 'base' },
    });
    expect(sc.obj(unit).zone).toEqual({ kind: 'base', player: 'p0' });
    expect(sc.player('p0').base).toContain(unit);
    expect(sc.bf('bf0').controller).toBeNull(); // 323.5: nobody left to hold it
  });
});
