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
  EFFECT_READIED: { seq: 34, type: 'EFFECT_READIED', unitId: 'o1' },
  EFFECT_FIZZLED: { seq: 33, type: 'EFFECT_FIZZLED', cardId: 'fx-flare' },
  EFFECT_UNIMPLEMENTED: { seq: 10, type: 'EFFECT_UNIMPLEMENTED', cardId: 'fx-odd-reaction' },
  UNIT_MOVED: { seq: 11, type: 'UNIT_MOVED', unitId: myCard.id, from: 'base', to: 'bf0' },
  SHOWDOWN_STARTED: { seq: 12, type: 'SHOWDOWN_STARTED', battlefieldId: 'bf1', isCombat: true },
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

  it('classifies announcement and log events', () => {
    expect(isImportantEvent(SAMPLES.POINT_GAINED)).toBe(true);
    expect(isImportantEvent(SAMPLES.RUNE_CHANNELED)).toBe(false);
    expect(isLoggedEvent(SAMPLES.CLEANUP_ITERATION)).toBe(false);
    expect(isLoggedEvent(SAMPLES.UNIT_KILLED)).toBe(true);
  });
});
