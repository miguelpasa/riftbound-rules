import { describe, it, expect } from 'vitest';
import { stateHash } from '../replay.js';
import { Scenario } from '../testing/scenario.js';

describe('scenario: Resources', () => {
  it('exhausting a rune adds 1 Energy to the Rune Pool and exhausts the rune', () => {
    // Tests Rule 164.2.a: a rune's Energy ability exhausts it to add 1 Energy
    const sc = Scenario.start();
    const rune = sc.runes('p0')[0]!.id;
    sc.do({ type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: rune, mode: 'EXHAUST' });
    expect(sc.player('p0').runePool).toEqual({ energy: 1, power: {} });
    expect(sc.obj(rune).ready).toBe(false);
    expect(sc.player('p0').base).toContain(rune); // still on the board
    const again = sc.reject({
      type: 'ACTIVATE_RUNE',
      playerId: 'p0',
      runeId: rune,
      mode: 'EXHAUST',
    });
    expect(again.code).toBe('UNIT_EXHAUSTED');
  });

  it('recycling a rune adds 1 Power of its domain and sends it to the bottom of the Rune Deck', () => {
    // Tests Rule 164.2.b: a rune's Power ability recycles it into the Rune Pool
    const sc = Scenario.start();
    sc.setRunes('p0', ['Calm', 'Fury']);
    const calm = sc.runes('p0').find((r) => r.cardId === 'fx-rune-calm')!.id;
    const deckBefore = [...sc.player('p0').runeDeck];
    sc.do({ type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: calm, mode: 'RECYCLE' });

    expect(sc.player('p0').runePool).toEqual({ energy: 0, power: { Calm: 1 } });
    expect(sc.player('p0').base).not.toContain(calm);
    const deckAfter = sc.player('p0').runeDeck;
    expect(deckAfter).toEqual([...deckBefore, calm]);
    expect(deckAfter[deckAfter.length - 1]).toBe(calm);
    expect(sc.obj(calm).zone).toEqual({ kind: 'runeDeck', player: 'p0' });
    expect(sc.obj(calm).ready).toBe(true);
  });

  it('may recycle an already exhausted rune', () => {
    // Tests Rule 164.2.b: the cost of the Power ability is Recycle, not Exhaust
    const sc = Scenario.start();
    sc.setRunes('p0', ['Fury']);
    const rune = sc.runes('p0')[0]!.id;
    sc.do({ type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: rune, mode: 'EXHAUST' });
    sc.do({ type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: rune, mode: 'RECYCLE' });
    expect(sc.player('p0').runePool).toEqual({ energy: 1, power: { Fury: 1 } });
  });

  it('refuses to activate runes you do not control or that are not runes', () => {
    // Tests Rule 164.2: only your own runes in your base have rune abilities
    const sc = Scenario.start();
    sc.endTurn('p0');
    const theirs = sc.runes('p0')[0]!.id;
    expect(
      sc.reject({ type: 'ACTIVATE_RUNE', playerId: 'p1', runeId: theirs, mode: 'EXHAUST' }).code,
    ).toBe('NOT_OWNED');
    const unit = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    expect(
      sc.reject({ type: 'ACTIVATE_RUNE', playerId: 'p1', runeId: unit, mode: 'EXHAUST' }).code,
    ).toBe('WRONG_CARD_TYPE');
  });

  it('pays a cost with a PaymentPlan: Energy by exhausting, Power by recycling the right domain', () => {
    // Tests Rule 357.1.a: costs are paid from the Rune Pool filled by the plan's rune activations
    const sc = Scenario.start();
    sc.setRunes('p0', ['Fury', 'Fury', 'Fury', 'Fury', 'Fury', 'Calm']);
    const titan = sc.putInHand('p0', 'fx-titan'); // 5 Energy + 1 Calm Power
    const runes = sc.runes('p0');
    const fury = runes.filter((r) => r.cardId === 'fx-rune-fury');
    const calm = runes.find((r) => r.cardId === 'fx-rune-calm')!;
    const energy = fury.map((r) => ({ runeId: r.id, mode: 'EXHAUST' as const }));
    const handBefore = sc.player('p0').hand.length;
    const deckBefore = [...sc.player('p0').runeDeck];

    const play = {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: titan,
    } as const;
    // wrong domain: recycling a Fury rune cannot pay Calm Power
    const wrongDomain = sc.reject({
      ...play,
      payment: [
        ...fury.slice(0, 4).map((r) => ({ runeId: r.id, mode: 'EXHAUST' as const })),
        { runeId: fury[4]!.id, mode: 'RECYCLE' as const },
        { runeId: calm.id, mode: 'EXHAUST' as const },
      ],
    });
    expect(wrongDomain.code).toBe('INSUFFICIENT_RESOURCES');
    expect(wrongDomain.message).toBe(
      '[Rule Error] Not enough Energy or Power to pay the cost. (Rule 156) [not enough Power]',
    );
    // same rune twice
    expect(
      sc.reject({
        ...play,
        payment: [
          ...energy,
          { runeId: fury[0]!.id, mode: 'RECYCLE' },
          { runeId: calm.id, mode: 'RECYCLE' },
        ],
      }).code,
    ).toBe('INVALID_PAYMENT');

    const r = sc.play('p0', titan, {
      payment: [...energy, { runeId: calm.id, mode: 'RECYCLE' }],
    });
    expect(sc.player('p0').hand).toHaveLength(handBefore - 1);
    expect(sc.player('p0').runePool).toEqual({ energy: 0, power: {} }); // exactly paid
    expect(fury.every((x) => !sc.obj(x.id).ready)).toBe(true);
    expect(sc.player('p0').base).not.toContain(calm.id);
    expect(sc.player('p0').runeDeck).toEqual([...deckBefore, calm.id]);
    expect(sc.obj(titan).zone).toEqual({ kind: 'base', player: 'p0' });
    expect(sc.obj(titan).ready).toBe(false); // units enter exhausted
    expect(sc.eventsOfType('CARD_PLAYED', r.events)).toHaveLength(1);
  });

  it('rejects an unaffordable play and leaves the state exactly as it was', () => {
    // Tests Rule 358.5: a play that cannot be paid is undone as if it never happened
    const sc = Scenario.start();
    sc.setRunes('p0', ['Fury']);
    const grunt = sc.putInHand('p0', 'fx-grunt'); // costs 2 Energy
    const before = stateHash(sc.state);
    const snapshot = JSON.stringify(sc.state);
    const err = sc.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: grunt,
      payment: sc.exhaustPlan('p0', 1),
    });
    expect(err.code).toBe('INSUFFICIENT_RESOURCES');
    expect(err.message).toBe(
      '[Rule Error] Not enough Energy or Power to pay the cost. (Rule 156) [not enough Energy]',
    );
    expect(stateHash(sc.state)).toBe(before);
    expect(JSON.stringify(sc.state)).toBe(snapshot);
    expect(sc.runes('p0')[0]!.ready).toBe(true); // the rune was not spent
    expect(sc.player('p0').hand).toContain(grunt);
    // an empty payment is equally unaffordable
    expect(
      sc.reject({ type: 'PLAY_CARD', playerId: 'p0', cardInstanceId: grunt, payment: [] }).code,
    ).toBe('INSUFFICIENT_RESOURCES');
  });

  it('keeps surplus Energy in the pool until the end of the turn', () => {
    // Tests Rule 167: unspent resources stay in the Rune Pool until it empties
    const sc = Scenario.start();
    sc.setRunes('p0', ['Fury', 'Fury', 'Fury']);
    const grunt = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', grunt, { payment: sc.exhaustPlan('p0', 3) });
    expect(sc.player('p0').runePool.energy).toBe(1);
    sc.endTurn('p0');
    expect(sc.player('p0').runePool.energy).toBe(0);
  });
});
