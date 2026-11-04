import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';

const CLOSED_BASE =
  '[Rule Error] Action illegal during an active Chain (Closed State). Only Reactions permitted.';

/** p0 has played Flare Bolt (Action); p1 holds priority with a Tidal Guard (Reaction) and Tide Surge (Action). */
function flareOnChain(): { sc: Scenario; flare: string; guard: string; surge: string } {
  const sc = Scenario.start();
  const flare = sc.putInHand('p0', 'fx-flare');
  sc.giveRunes('p1', 2);
  const guard = sc.putInHand('p1', 'fx-tide-guard');
  const surge = sc.putInHand('p1', 'fx-tide-surge');
  sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
  return { sc, flare, guard, surge };
}

describe('scenario: Closed State and the Chain', () => {
  it('puts the played spell on the Chain, closes the state and passes priority to the opponent', () => {
    // Tests Rule 309.1.a: a non-empty Chain makes the game state Closed
    const { sc, flare } = flareOnChain();
    expect(sc.state.flow.chain).toHaveLength(1);
    expect(sc.state.flow.chain[0]).toMatchObject({ sourceObjectId: flare, controller: 'p0' });
    expect(sc.state.flow.chain[0]?.status).toBe('FINALIZED');
    expect(sc.state.turnState).toEqual({ kind: 'NEUTRAL', open: false });
    expect(sc.state.flow.priority).toBe('p1');
    expect(sc.obj(flare).zone.kind).toBe('chain');
  });

  it('rejects a non-Reaction play with the exact Closed State message', () => {
    // Tests Rule 309.1.a: while Closed only Reactions may be played
    const { sc, surge } = flareOnChain();
    const before = sc.state;
    const err = sc.reject({
      type: 'PLAY_CARD',
      playerId: 'p1',
      cardInstanceId: surge,
      payment: [],
    });
    expect(err.code).toBe('CLOSED_STATE_REACTION_ONLY');
    expect(err.message.startsWith(CLOSED_BASE)).toBe(true);
    expect(err.message).toBe(`${CLOSED_BASE} (Rule 309.1.a)`);
    expect(sc.state).toBe(before);
  });

  it('also refuses Moves and END_TURN while Closed', () => {
    // Tests Rule 309.1.a: Standard Moves and ending the turn are not Reactions
    const sc = Scenario.start();
    const flare = sc.putInHand('p0', 'fx-flare');
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1'); // priority returns to p0
    expect(sc.state.flow.priority).toBe('p0');
    const move = sc.reject({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    expect(move.code).toBe('CLOSED_STATE_REACTION_ONLY');
    expect(move.message.startsWith(CLOSED_BASE)).toBe(true);
    const end = sc.reject({ type: 'END_TURN', playerId: 'p0' });
    expect(end.code).toBe('CLOSED_STATE_REACTION_ONLY');
    expect(end.message.startsWith(CLOSED_BASE)).toBe(true);
  });

  it('rejects a player who does not hold priority', () => {
    // Tests Rule 312.1: only the player with priority may act on the Chain
    const { sc } = flareOnChain();
    const err = sc.reject({ type: 'PASS_PRIORITY', playerId: 'p0' });
    expect(err.code).toBe('NOT_YOUR_PRIORITY');
    expect(err.message).toBe('[Rule Error] You do not have priority. (Rule 310) [priority: p1]');
  });

  it('resolves a Reaction played in response first (LIFO) and returns priority to the turn player', () => {
    // Tests Rule 335: after the Chain empties, priority returns to the turn player (Neutral Open)
    const { sc, flare, guard } = flareOnChain();
    const cast = sc.play('p1', guard, { payment: sc.exhaustPlan('p1', 1) });
    expect(sc.eventsOfType('CHAIN_ITEM_ADDED', cast.events)).toHaveLength(1);
    expect(sc.state.flow.chain.map((c) => c.sourceObjectId)).toEqual([flare, guard]);
    expect(sc.state.flow.priority).toBe('p0');

    sc.pass('p0');
    expect(sc.state.flow.priority).toBe('p1');
    const first = sc.pass('p1'); // everyone passed: the newest item resolves
    expect(sc.eventsOfType('CHAIN_ITEM_RESOLVED', first.events)).toHaveLength(1);
    expect(sc.obj(guard).zone).toEqual({ kind: 'trash', player: 'p1' });
    expect(sc.obj(flare).zone.kind).toBe('chain'); // still waiting
    expect(sc.state.flow.chain.map((c) => c.sourceObjectId)).toEqual([flare]);
    expect(sc.state.turnState.open).toBe(false);

    sc.pass('p1');
    expect(sc.state.flow.priority).toBe('p0');
    const second = sc.pass('p0');
    expect(sc.eventsOfType('CHAIN_ITEM_RESOLVED', second.events)).toHaveLength(1);
    expect(sc.obj(flare).zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(sc.player('p0').trash).toContain(flare);
    expect(sc.player('p1').trash).toContain(guard);
    expect(sc.state.flow.chain).toHaveLength(0);
    expect(sc.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(sc.state.flow.priority).toBe('p0');
    // the turn player may act normally again
    sc.endTurn('p0');
  });

  it('resolves a spell whose effect is not implemented as a no-op with EFFECT_UNIMPLEMENTED', () => {
    // Tests Rule 337: the item leaves the Chain; unsupported effects do nothing but are reported
    const sc = Scenario.start();
    const odd = sc.putInHand('p0', 'fx-odd-reaction');
    const handBefore = sc.player('p0').hand.length;
    const pointsBefore = [sc.player('p0').points, sc.player('p1').points];
    sc.play('p0', odd, { payment: sc.exhaustPlan('p0', 1) });
    expect(sc.player('p0').hand).toHaveLength(handBefore - 1);
    sc.pass('p1');
    const r = sc.pass('p0');

    expect(sc.eventsOfType('EFFECT_UNIMPLEMENTED', r.events)).toEqual([
      expect.objectContaining({ cardId: 'fx-odd-reaction' }),
    ]);
    expect(sc.eventsOfType('CHAIN_ITEM_RESOLVED', r.events)).toHaveLength(1);
    expect(sc.obj(odd).zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(sc.state.flow.chain).toHaveLength(0);
    expect(sc.state.flow.priority).toBe('p0');
    expect([sc.player('p0').points, sc.player('p1').points]).toEqual(pointsBefore);
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
  });
});
