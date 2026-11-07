import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import { parsePlayTo } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const withPlayTo = (playTo: ('OPEN' | 'ENEMY')[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), playTo },
});

const bf = (id: string) => ({ kind: 'battlefield' as const, battlefieldId: id });

describe('scenario: playing a Unit to extra battlefields (R76)', () => {
  it('an open battlefield accepts the Unit and rejects it without the permission', () => {
    // Tests Rule 359.2: a Unit enters the Base or a battlefield its controller may play to
    const plain = Scenario.start();
    const g0 = plain.putInHand('p0', 'fx-grunt');
    expect(
      plain.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: g0,
        payment: plain.exhaustPlan('p0', 2),
        location: bf('bf1'),
      }).code,
    ).toBe('ILLEGAL_LOCATION');

    const sc = Scenario.start({}, withPlayTo(['OPEN']));
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: bf('bf1') });
    expect(sc.obj(g).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    // The Unit contests the empty battlefield: a Showdown follows and the player conquers it.
    expect(sc.state.flow.showdown?.battlefieldId).toBe('bf1');
    sc.pass('p0');
    sc.pass('p1');
    expect(sc.bf('bf1').controller).toBe('p0');
    expect(sc.player('p0').points).toBe(1);
    sc.verify();
  });

  it('an open battlefield must have no units on it', () => {
    // Tests Rule 359.2: "open" means nobody has units there
    const sc = Scenario.start({}, withPlayTo(['OPEN']));
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const g = sc.putInHand('p0', 'fx-grunt');
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: g,
        payment: sc.exhaustPlan('p0', 2),
        location: bf('bf1'),
      }).code,
    ).toBe('ILLEGAL_LOCATION');
  });

  it('an occupied enemy battlefield is allowed with the ENEMY permission only', () => {
    // Tests Rule 359.2: the Unit may enter a battlefield an opponent controls and occupies
    const sc = Scenario.start({}, withPlayTo(['ENEMY']));
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const g = sc.putInHand('p0', 'fx-grunt');
    const legal = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === g,
    );
    expect(
      legal.some(
        (i) =>
          i.type === 'PLAY_CARD' &&
          i.location?.kind === 'battlefield' &&
          i.location.battlefieldId === 'bf1',
      ),
    ).toBe(true);
    // bf2 is empty and uncontrolled: not allowed with ENEMY alone.
    expect(
      legal.some(
        (i) =>
          i.type === 'PLAY_CARD' &&
          i.location?.kind === 'battlefield' &&
          i.location.battlefieldId === 'bf2',
      ),
    ).toBe(false);
  });
});

describe('parser: play-to lines (R76)', () => {
  it('reads both phrases and removes the lines', () => {
    // Tests Rule 359.2: parsed card text
    expect(parsePlayTo('You may play me to an open battlefield.')).toEqual({
      playTo: ['OPEN'],
      rest: '',
    });
    expect(parsePlayTo('[Deflect]\nYou may play me to an occupied enemy battlefield.')).toEqual({
      playTo: ['ENEMY'],
      rest: '[Deflect]',
    });
    expect(parsePlayTo('Draw 1.')).toBeNull();
  });
});
