import { describe, it, expect } from 'vitest';
import { sanitizeEvents, sanitizeFor } from '../sanitize.js';
import { SC_LURKER_A, Scenario } from '../testing/scenario.js';
import { findLeaks } from '../testing/leakCheck.js';

const NAMES = { [SC_LURKER_A]: 'Lurker A' };

/** p0 controls bf0 with a Grunt and has a Hidden Lurker in hand plus one rune for the hide cost. */
function setup(): { sc: Scenario; lurker: string } {
  const sc = Scenario.start();
  sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
  const lurker = sc.putInHand('p0', SC_LURKER_A);
  return { sc, lurker };
}

describe('scenario: Hidden (Rule 811)', () => {
  it('hides a card facedown without telling the opponent which card it is', () => {
    // Tests Rule 811: a Hidden card may be placed facedown at a battlefield you control for 1 Power
    const { sc, lurker } = setup();
    const r = sc.do({
      type: 'HIDE_CARD',
      playerId: 'p0',
      cardInstanceId: lurker,
      battlefieldId: 'bf0',
    });

    expect(sc.obj(lurker).zone).toEqual({ kind: 'facedown', player: 'p0', battlefieldId: 'bf0' });
    expect(sc.bf('bf0').facedownSlotId).toBe(lurker);
    expect(sc.player('p0').hand).not.toContain(lurker);
    expect(sc.runes('p0')).toHaveLength(1); // one rune was recycled to pay the 1 Power
    expect(sc.player('p0').runePool).toEqual({ energy: 0, power: {} }); // surplus: none

    // The controller is told everything; the opponent's event stream is clean
    const mine = sanitizeEvents(r.events, 'p0');
    expect(mine.some((e) => e.type === 'CARD_PLAYED' && e.cardId === SC_LURKER_A)).toBe(true);
    const theirs = sanitizeEvents(r.events, 'p1');
    expect(findLeaks(theirs, sc.state, 'p1', { cardNames: NAMES })).toEqual([]);
    expect(JSON.stringify(theirs)).not.toContain(SC_LURKER_A);
    expect(JSON.stringify(theirs)).not.toContain(lurker);
    // ... and so is the opponent's view of the whole state
    const view = sanitizeFor(sc.state, 'p1');
    expect(findLeaks(view, sc.state, 'p1', { cardNames: NAMES })).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(SC_LURKER_A);
    expect(findLeaks(sanitizeFor(sc.state, 'p0'), sc.state, 'p0', { cardNames: NAMES })).toEqual(
      [],
    );
  });

  it('refuses to hide at a battlefield you do not control, or twice at the same one', () => {
    // Tests Rule 811: a battlefield holds at most one facedown card and only its controller may use it
    const { sc, lurker } = setup();
    const err = sc.reject({
      type: 'HIDE_CARD',
      playerId: 'p0',
      cardInstanceId: lurker,
      battlefieldId: 'bf1',
    });
    expect(err.code).toBe('HIDDEN_NOT_ALLOWED');
    expect(err.message).toBe(
      '[Rule Error] You cannot hide that card there. (Rule 700) [you do not control that battlefield]',
    );
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: lurker, battlefieldId: 'bf0' });
    sc.giveRunes('p0', 1);
    const second = sc.putInHand('p0', 'fx-grunt');
    expect(
      sc.reject({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: second, battlefieldId: 'bf0' })
        .code,
    ).toBe('HIDDEN_NOT_ALLOWED');
  });

  it('cannot be played on the turn it was hidden but costs 0 as a Reaction on a later turn', () => {
    // Tests Rule 811: a hidden card is played for 0 with Reaction speed from the next turn on
    const { sc, lurker } = setup();
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: lurker, battlefieldId: 'bf0' });
    const early = sc.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: lurker,
      payment: [],
    });
    expect(early.code).toBe('HIDDEN_NOT_ALLOWED');
    expect(early.message).toContain('a hidden card is usable only on a later turn');

    sc.endTurn('p0');
    sc.endTurn('p1');
    expect(sc.state.turn).toMatchObject({ number: 3, activePlayer: 'p0' });
    // Make the state Closed so that only a Reaction can answer: a Flare Bolt on the Chain
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1');
    expect(sc.state.turnState.open).toBe(false);
    expect(sc.state.flow.priority).toBe('p0');
    const poolBefore = structuredClone(sc.player('p0').runePool);
    const readyBefore = sc.runes('p0').filter((r) => r.ready).length;

    const r = sc.play('p0', lurker); // empty payment: costs 0
    expect(sc.player('p0').runePool).toEqual(poolBefore);
    expect(sc.runes('p0').filter((x) => x.ready)).toHaveLength(readyBefore);
    expect(sc.obj(lurker).zone).toEqual({
      kind: 'battlefield',
      player: 'p0',
      battlefieldId: 'bf0',
    });
    expect(sc.bf('bf0').facedownSlotId).toBeNull();
    expect(sc.eventsOfType('CARD_PLAYED', r.events)).toEqual([
      expect.objectContaining({ cardInstanceId: lurker, cardId: SC_LURKER_A }),
    ]);
    expect(sc.state.flow.chain).toHaveLength(1); // the unit resolved at once, Flare Bolt is still waiting
  });

  it('puts a facedown card in the Trash when its controller loses the battlefield', () => {
    // Tests Rule 323.6.a: a facedown card at a battlefield its controller no longer controls is trashed
    const { sc, lurker } = setup();
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: lurker, battlefieldId: 'bf0' });
    const guard = sc.unitsAt('bf0', 'p0')[0]?.id as string;
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [guard],
      destination: { kind: 'base' },
    });
    expect(sc.bf('bf0').controller).toBeNull();
    expect(sc.bf('bf0').facedownSlotId).toBeNull();
    expect(sc.obj(lurker).zone).toEqual({ kind: 'trash', player: 'p0' });
  });
});
