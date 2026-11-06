import { describe, expect, it } from 'vitest';
import { sanitizeFor } from '@riftbound/engine';
import type { GameEvent, GameEventType } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import { describeEvent, isImportantEvent, isLoggedEvent } from './describeEvent';

const sc = Scenario.start();
const view = sanitizeFor(sc.state, 'p0');
const myCard = Object.values(sc.state.objects).find(
  (o) => o.zone.kind === 'hand' && o.zone.player === 'p0',
)!;
const oppHandCard = Object.values(sc.state.objects).find(
  (o) => o.zone.kind === 'hand' && o.zone.player === 'p1',
)!;

/** One sample per event type; the Record type forces this table to stay exhaustive. */
const SAMPLES: { [K in GameEventType]: Extract<GameEvent, { type: K }> } = {
  CARD_DRAWN: { seq: 1, type: 'CARD_DRAWN', player: 'p0', cardInstanceId: myCard.id },
  RUNE_CHANNELED: { seq: 2, type: 'RUNE_CHANNELED', player: 'p1', runeId: 'x' },
  PHASE_CHANGED: { seq: 3, type: 'PHASE_CHANGED', player: 'p0', turn: 2, phase: 'MAIN' },
  CARD_PLAYED: {
    seq: 4,
    type: 'CARD_PLAYED',
    player: 'p0',
    cardId: 'fx-grunt',
    cardInstanceId: 'o1',
  },
  CARD_HIDDEN: { seq: 5, type: 'CARD_HIDDEN', player: 'p1', battlefieldId: 'bf0' },
  FACEDOWN_REMOVED: { seq: 6, type: 'FACEDOWN_REMOVED', battlefieldId: 'bf0', cardId: 'fx-grunt' },
  EQUIPPED: { seq: 7, type: 'EQUIPPED', equipmentId: myCard.id, unitId: myCard.id },
  CHAIN_ITEM_ADDED: { seq: 8, type: 'CHAIN_ITEM_ADDED', chainItemId: 'c1', controller: 'p1' },
  CHAIN_ITEM_RESOLVED: { seq: 9, type: 'CHAIN_ITEM_RESOLVED', chainItemId: 'c1' },
  EFFECT_DAMAGE: { seq: 31, type: 'EFFECT_DAMAGE', unitId: 'o1', amount: 2 },
  EFFECT_BUFF: { seq: 32, type: 'EFFECT_BUFF', unitId: 'o1', amount: 2 },
  BATTLEFIELD_SCORED: {
    seq: 35,
    type: 'BATTLEFIELD_SCORED',
    player: 'p0',
    battlefieldId: 'bf1',
    method: 'HOLD',
  },
  EFFECT_EMPOWERED: { seq: 35, type: 'EFFECT_EMPOWERED', unitId: 'o1' },
  EFFECT_READIED: { seq: 34, type: 'EFFECT_READIED', unitId: 'o1' },
  EFFECT_FIZZLED: { seq: 33, type: 'EFFECT_FIZZLED', cardId: 'fx-flare' },
  EFFECT_STUNNED: { seq: 35, type: 'EFFECT_STUNNED', unitId: 'o1' },
  EFFECT_KEYWORD_GRANTED: { seq: 70, type: 'EFFECT_KEYWORD_GRANTED', unitId: 'o1' },
  EFFECT_COUNTERED: { seq: 36, type: 'EFFECT_COUNTERED', cardId: 'fx-flare' },
  GEAR_KILLED: { seq: 37, type: 'GEAR_KILLED', gearId: 'o1' },
  EFFECT_UNIMPLEMENTED: { seq: 10, type: 'EFFECT_UNIMPLEMENTED', cardId: 'fx-odd-reaction' },
  UNIT_MOVED: { seq: 11, type: 'UNIT_MOVED', unitId: myCard.id, from: 'base', to: 'bf0' },
  SHOWDOWN_STARTED: { seq: 12, type: 'SHOWDOWN_STARTED', battlefieldId: 'bf1', isCombat: true },
  STAGED_ORDER_CHOSEN: {
    seq: 38,
    type: 'STAGED_ORDER_CHOSEN',
    player: 'p0',
    battlefieldId: 'bf1',
    stage: 'COMBAT',
  },
  COMBAT_DAMAGE_ASSIGNED: {
    seq: 13,
    type: 'COMBAT_DAMAGE_ASSIGNED',
    player: 'p0',
    unitId: myCard.id,
    amount: 3,
  },
  UNIT_KILLED: { seq: 14, type: 'UNIT_KILLED', unitId: myCard.id },
  POINT_GAINED: { seq: 15, type: 'POINT_GAINED', player: 'p0', amount: 1, source: 'CONQUER' },
  FINAL_POINT_DENIED_DREW_CARD: { seq: 16, type: 'FINAL_POINT_DENIED_DREW_CARD', player: 'p1' },
  BURN_OUT: { seq: 17, type: 'BURN_OUT', player: 'p0' },
  BATTLEFIELD_CONTROL_CHANGED: {
    seq: 18,
    type: 'BATTLEFIELD_CONTROL_CHANGED',
    battlefieldId: 'bf0',
    controller: null,
  },
  GAME_ENDED: { seq: 19, type: 'GAME_ENDED', winner: 'p1' },
  GAME_ABORTED: { seq: 20, type: 'GAME_ABORTED', reason: 'test' },
  CLEANUP_ITERATION: { seq: 21, type: 'CLEANUP_ITERATION', iteration: 3 },
  TOKEN_PLAYED: { seq: 41, type: 'TOKEN_PLAYED', player: 'p0', unitId: 'o9', cardId: 'fx-grunt' },
  UNIT_RETURNED: { seq: 42, type: 'UNIT_RETURNED', player: 'p1', unitId: 'o9', cardId: 'fx-grunt' },
  CARDS_LOOKED_AT: { seq: 43, type: 'CARDS_LOOKED_AT', player: 'p0', count: 3 },
  CARDS_RECYCLED: { seq: 44, type: 'CARDS_RECYCLED', player: 'p0', count: 2 },
  CARDS_BURNED: { seq: 144, type: 'CARDS_BURNED', player: 'p0', count: 3 },
  CARD_REVEALED: {
    seq: 45,
    type: 'CARD_REVEALED',
    player: 'p1',
    cardInstanceId: 'o9',
    cardId: 'fx-grunt',
  },
  ABILITY_ACTIVATED: {
    seq: 46,
    type: 'ABILITY_ACTIVATED',
    player: 'p0',
    sourceId: 'o9',
    abilityIndex: 0,
  },
  RESOURCES_ADDED: { seq: 47, type: 'RESOURCES_ADDED', player: 'p0', energy: 0, power: 1 },
  TRIGGER_TARGETED: {
    seq: 48,
    type: 'TRIGGER_TARGETED',
    player: 'p0',
    sourceId: myCard.id,
    targets: [{ kind: 'object', id: myCard.id }],
  },
  TRIGGER_NO_TARGET: { seq: 49, type: 'TRIGGER_NO_TARGET', player: 'p0', sourceId: myCard.id },
  COST_CARDS_PAID: {
    seq: 51,
    type: 'COST_CARDS_PAID',
    player: 'p0',
    sourceId: myCard.id,
    kind: 'DISCARD',
    cardIds: ['o1'],
    cardNames: ['Cinder Grunt'],
  },
  OPTIONAL_EFFECT_DECIDED: {
    seq: 50,
    type: 'OPTIONAL_EFFECT_DECIDED',
    player: 'p0',
    sourceId: myCard.id,
    accepted: true,
  },
};

describe('describeEvent', () => {
  it('describes every event type with non-empty plain English', () => {
    for (const [type, ev] of Object.entries(SAMPLES)) {
      const text = describeEvent(ev, view, SCENARIO_CARDS);
      expect(text.length, type).toBeGreaterThan(5);
      expect(text, type).not.toMatch(/undefined|\[object/);
    }
  });

  it('says who did what and uses card names', () => {
    expect(describeEvent(SAMPLES.POINT_GAINED, view, SCENARIO_CARDS)).toBe(
      'You gained 1 point from conquering a battlefield.',
    );
    expect(describeEvent(SAMPLES.CARD_PLAYED, view, SCENARIO_CARDS)).toBe(
      `You played ${SCENARIO_CARDS['fx-grunt']!.name}.`,
    );
    expect(describeEvent(SAMPLES.GAME_ENDED, view, SCENARIO_CARDS)).toContain('the opponent wins');
  });

  it('words a negative Might change and the new effect events', () => {
    expect(
      describeEvent(
        { seq: 40, type: 'EFFECT_BUFF', unitId: 'o1', amount: -2 },
        view,
        SCENARIO_CARDS,
      ),
    ).toBe('A unit got -2 Might.');
    expect(describeEvent(SAMPLES.EFFECT_COUNTERED, view, SCENARIO_CARDS)).toBe(
      `${SCENARIO_CARDS['fx-flare']!.name} was countered.`,
    );
    expect(describeEvent(SAMPLES.EFFECT_STUNNED, view, SCENARIO_CARDS)).toContain('stunned');
    expect(describeEvent(SAMPLES.EFFECT_KEYWORD_GRANTED, view, SCENARIO_CARDS)).toContain(
      'gained a keyword',
    );
  });

  it('words the ability and resource events', () => {
    expect(describeEvent(SAMPLES.RESOURCES_ADDED, view, SCENARIO_CARDS)).toBe(
      'You added 1 Power to the Rune Pool.',
    );
    expect(describeEvent(SAMPLES.ABILITY_ACTIVATED, view, SCENARIO_CARDS)).toContain('activated');
  });

  it('words the token, return and look-at events', () => {
    const grunt = SCENARIO_CARDS['fx-grunt']!.name;
    expect(describeEvent(SAMPLES.TOKEN_PLAYED, view, SCENARIO_CARDS)).toBe(`You played ${grunt}.`);
    expect(describeEvent(SAMPLES.UNIT_RETURNED, view, SCENARIO_CARDS)).toBe(
      `${grunt} was returned to its owner's hand.`,
    );
    expect(describeEvent(SAMPLES.CARDS_LOOKED_AT, view, SCENARIO_CARDS)).toBe(
      'You looked at the top 3 cards of your Main Deck.',
    );
    expect(describeEvent(SAMPLES.CARD_REVEALED, view, SCENARIO_CARDS)).toContain(grunt);
  });

  it('never names an opponent hand card (redacted draw id)', () => {
    const name = SCENARIO_CARDS[oppHandCard.cardId]!.name;
    const ev: GameEvent = {
      seq: 30,
      type: 'CARD_DRAWN',
      player: 'p1',
      cardInstanceId: 'hidden:p1:drawn',
    };
    expect(describeEvent(ev, view, SCENARIO_CARDS)).toBe('Opponent drew a card.');
    // even with the REAL id, a hidden placeholder/missing object yields no name
    const leak = describeEvent({ ...ev, cardInstanceId: oppHandCard.id }, view, SCENARIO_CARDS);
    expect(leak).not.toContain(name);
  });

  it('words the trigger-target events', () => {
    expect(describeEvent(SAMPLES.TRIGGER_TARGETED, view, SCENARIO_CARDS)).toContain('targeted');
    expect(describeEvent(SAMPLES.TRIGGER_NO_TARGET, view, SCENARIO_CARDS)).toContain(
      'no legal target',
    );
  });

  it('words the optional-effect answer (R45)', () => {
    expect(describeEvent(SAMPLES.OPTIONAL_EFFECT_DECIDED, view, SCENARIO_CARDS)).toContain(
      'was used',
    );
    const declined: GameEvent = {
      ...SAMPLES.OPTIONAL_EFFECT_DECIDED,
      accepted: false,
    } as GameEvent;
    expect(describeEvent(declined, view, SCENARIO_CARDS)).toContain('declined');
  });

  it('words each kind of card-choice cost (R46)', () => {
    const base = SAMPLES.COST_CARDS_PAID as Extract<GameEvent, { type: 'COST_CARDS_PAID' }>;
    expect(describeEvent(base, view, SCENARIO_CARDS)).toContain(
      'discarded Cinder Grunt to pay for',
    );
    for (const [kind, word] of [
      ['KILL', 'killed'],
      ['EXHAUST', 'exhausted'],
      ['RETURN', 'returned to hand'],
      ['RECYCLE', 'recycled from their Trash'],
    ] as const) {
      expect(describeEvent({ ...base, kind }, view, SCENARIO_CARDS)).toContain(word);
    }
  });

  it('names the Battlefield card behind a battlefield-sourced ability (R44)', () => {
    const bfCard = SCENARIO_CARDS[view.battlefields[1]!.cardId]!.name;
    const targeted: GameEvent = { ...SAMPLES.TRIGGER_NO_TARGET, sourceId: 'bf1' };
    expect(describeEvent(targeted, view, SCENARIO_CARDS)).toContain(bfCard);
    expect(describeEvent(SAMPLES.CARDS_BURNED, view, SCENARIO_CARDS)).toContain('3 cards');
  });

  it('classifies announcement and log events', () => {
    expect(isImportantEvent(SAMPLES.POINT_GAINED)).toBe(true);
    expect(isImportantEvent(SAMPLES.RUNE_CHANNELED)).toBe(false);
    expect(isLoggedEvent(SAMPLES.CLEANUP_ITERATION)).toBe(false);
    expect(isLoggedEvent(SAMPLES.UNIT_KILLED)).toBe(true);
  });
});
