import { describe, it, expect } from 'vitest';
import { parseSpellText, parseTriggerText } from './cardText.js';

describe('parseSpellText', () => {
  it('parses draw, damage and buff sentences', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText('Draw 4.')).toEqual([{ op: 'DRAW', amount: 4 }]);
    expect(
      parseSpellText(
        '[Action] (Play on your turn or in showdowns.) Deal 4 to a unit at a battlefield. Draw 1.',
      ),
    ).toEqual([
      { op: 'DAMAGE_TARGET', amount: 4, atBattlefield: true },
      { op: 'DRAW', amount: 1 },
    ]);
    expect(parseSpellText('[Reaction] Give a friendly unit +2 [M] this turn. Draw 1.')).toEqual([
      { op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'friendly' },
      { op: 'DRAW', amount: 1 },
    ]);
  });

  it('parses kill, ready and mass-buff sentences', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText('Kill a unit at a battlefield with 3 [M] or less.')).toEqual([
      { op: 'KILL_TARGET', atBattlefield: true, maxMight: 3 },
    ]);
    expect(parseSpellText('Ready a friendly unit.')).toEqual([
      { op: 'READY_TARGET', side: 'friendly' },
    ]);
    expect(parseSpellText('Give friendly units +1 [M] this turn.')).toEqual([
      { op: 'BUFF_ALL', amount: 1, side: 'friendly', duration: 'TURN' },
    ]);
  });

  it('refuses anything it only partly understands', () => {
    // Tests Rule 359.3: never half-execute a spell
    expect(parseSpellText('Deal 3 to a unit. If this kills it, draw 1.')).toBeNull();
    expect(parseSpellText('Kill all gear. Draw 1. Banish a unit.')).toBeNull();
    expect(parseSpellText('Deal 1 to a unit. Deal 2 to a unit.')).toBeNull();
    expect(parseSpellText('')).toBeNull();
  });
});

describe('parseSpellText: widened coverage (R3)', () => {
  it('parses stun, debuffs with a minimum, counter and kill-gear sentences', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText('[Action] [Stun] a unit.')).toEqual([{ op: 'STUN_TARGET' }]);
    expect(parseSpellText('Stun an enemy unit at a battlefield.')).toEqual([
      { op: 'STUN_TARGET', side: 'enemy', atBattlefield: true },
    ]);
    expect(
      parseSpellText('[Reaction] Give a unit -4 [M] this turn, to a minimum of 1 [M]. Draw 1.'),
    ).toEqual([
      { op: 'DEBUFF_TARGET', amount: 4, minMight: 1 },
      { op: 'DRAW', amount: 1 },
    ]);
    expect(parseSpellText('Give a unit \u201310 [M] this turn.')).toEqual([
      { op: 'DEBUFF_TARGET', amount: 10 },
    ]);
    expect(parseSpellText('[Reaction] Counter a spell.')).toEqual([{ op: 'COUNTER_SPELL' }]);
    expect(parseSpellText('Kill a gear. Its controller draws 2.')).toEqual([
      { op: 'KILL_GEAR' },
      { op: 'TARGET_CONTROLLER_DRAW', amount: 2 },
    ]);
    expect(parseSpellText('Kill a unit at a battlefield. Its controller draws 2.')).toEqual([
      { op: 'KILL_TARGET', atBattlefield: true },
      { op: 'TARGET_CONTROLLER_DRAW', amount: 2 },
    ]);
    expect(parseSpellText('Kill all gear.')).toEqual([{ op: 'KILL_ALL_GEAR' }]);
    expect(parseSpellText('You may kill up to one gear. Draw 1.')).toEqual([
      { op: 'KILL_GEAR', count: { min: 0, max: 1 } },
      { op: 'DRAW', amount: 1 },
    ]);
  });

  it('parses two-unit effects', () => {
    // Tests Rule 355.10: each chosen unit is a separate target
    expect(
      parseSpellText(
        '[Action] Choose a friendly unit and an enemy unit. They deal damage equal to their Mights to each other.',
      ),
    ).toEqual([{ op: 'MUTUAL_DAMAGE', slots: [0, 1], sides: ['friendly', 'enemy'] }]);
    expect(
      parseSpellText(
        'Give a friendly unit +3 [M] this turn. Then choose an enemy unit. They deal damage equal to their Mights to each other.',
      ),
    ).toEqual([
      { op: 'BUFF_TARGET', amount: 3, duration: 'TURN', side: 'friendly' },
      { op: 'MUTUAL_DAMAGE', slots: [0, 1], sides: ['friendly', 'enemy'] },
    ]);
    expect(
      parseSpellText(
        'Give an enemy unit -2 [M] this turn and a friendly unit +2 [M] this turn. They deal damage equal to their Mights to each other.',
      ),
    ).toEqual([
      { op: 'DEBUFF_TARGET', amount: 2, side: 'enemy' },
      { op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'friendly', slot: 1 },
      { op: 'MUTUAL_DAMAGE', slots: [0, 1], sides: ['enemy', 'friendly'] },
    ]);
    expect(parseSpellText('Deal 6 to each of up to two units.')).toEqual([
      { op: 'DAMAGE_TARGET', amount: 6, count: { min: 0, max: 2 } },
    ]);
    expect(parseSpellText('Give two friendly units each +2 [M] this turn.')).toEqual([
      {
        op: 'BUFF_TARGET',
        amount: 2,
        duration: 'TURN',
        side: 'friendly',
        count: { min: 2, max: 2 },
      },
    ]);
    expect(
      parseSpellText('Give a unit +2 [M] this turn and another unit -2 [M] this turn.'),
    ).toEqual([
      { op: 'BUFF_TARGET', amount: 2, duration: 'TURN' },
      { op: 'DEBUFF_TARGET', amount: 2, slot: 1 },
    ]);
  });

  it('parses mass effects and channeling', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText('Deal 1 to all units at battlefields.')).toEqual([
      { op: 'DAMAGE_ALL', amount: 1, side: 'any', scope: 'battlefields' },
    ]);
    expect(parseSpellText('Deal 3 to all units in bases.')).toEqual([
      { op: 'DAMAGE_ALL', amount: 3, side: 'any', scope: 'bases' },
    ]);
    expect(parseSpellText('Deal 2 to all enemy units in combat.')).toEqual([
      { op: 'DAMAGE_ALL', amount: 2, side: 'enemy', scope: 'combat' },
    ]);
    expect(
      parseSpellText('Exhaust all friendly units. Then deal 12 to all units at battlefields.'),
    ).toEqual([
      { op: 'EXHAUST_ALL', side: 'friendly' },
      { op: 'DAMAGE_ALL', amount: 12, side: 'any', scope: 'battlefields' },
    ]);
    expect(parseSpellText('Ready your units and give them +3 [M] this turn.')).toEqual([
      { op: 'READY_ALL', side: 'friendly' },
      { op: 'BUFF_ALL', amount: 3, side: 'friendly', duration: 'TURN' },
    ]);
    expect(parseSpellText('Draw 1 and channel 1 rune exhausted.')).toEqual([
      { op: 'DRAW', amount: 1 },
      { op: 'CHANNEL', amount: 1, exhausted: true },
    ]);
    expect(
      parseSpellText(
        "Channel 2 runes exhausted. If you couldn't channel 2 runes this way, draw 1.",
      ),
    ).toEqual([{ op: 'CHANNEL', amount: 2, exhausted: true, elseDraw: 1 }]);
    expect(parseSpellText("Channel 1 rune exhausted. If you can't, draw 1.")).toEqual([
      { op: 'CHANNEL', amount: 1, exhausted: true, elseDraw: 1 },
    ]);
  });

  it('refuses ambiguous multi-target text', () => {
    // Tests Rule 355.10: never guess which units are chosen
    expect(
      parseSpellText('Give a unit +1 [M] this turn. Give a unit -1 [M] this turn.'),
    ).toBeNull();
    expect(
      parseSpellText(
        'Choose a unit and a unit. They deal damage equal to their Mights to each other.',
      ),
    ).toBeNull();
    expect(parseSpellText('Its controller draws 2.')).toBeNull();
  });
});

describe('parseTriggerText: widened coverage (R3)', () => {
  it('parses new target-free trigger effects', () => {
    // Tests Rule 359.3: triggered abilities resolve their effects in order
    expect(parseTriggerText('When you play me, deal 2 to all units at battlefields.')).toEqual([
      {
        on: 'PLAY',
        effects: [{ op: 'DAMAGE_ALL', amount: 2, side: 'any', scope: 'battlefields' }],
      },
    ]);
    expect(parseTriggerText('When I hold, you score 1 point.')).toEqual([
      { on: 'HOLD', effects: [{ op: 'GAIN_POINT', amount: 1 }] },
    ]);
    expect(parseTriggerText('When you play me, stun a unit.')).toBeNull();
  });
});

describe('parseTriggerText', () => {
  it('parses play, hold, conquer and Deathknell triggers with target-free effects', () => {
    // Tests Rule 359.3: triggered abilities resolve their effects in order
    expect(parseTriggerText('When you play me, draw 1.')).toEqual([
      { on: 'PLAY', effects: [{ op: 'DRAW', amount: 1 }] },
    ]);
    expect(parseTriggerText('[Tank] (reminder) When I hold, draw 2.')).toEqual([
      { on: 'HOLD', effects: [{ op: 'DRAW', amount: 2 }] },
    ]);
    expect(parseTriggerText('When I conquer, give friendly units +1 [M] this turn.')).toEqual([
      {
        on: 'CONQUER',
        effects: [{ op: 'BUFF_ALL', amount: 1, side: 'friendly', duration: 'TURN' }],
      },
    ]);
    expect(parseTriggerText('[Deathknell][>] Draw 1.')).toEqual([
      { on: 'DEATH', effects: [{ op: 'DRAW', amount: 1 }] },
    ]);
  });

  it('refuses targeted or unknown trigger effects', () => {
    // Tests Rule 359.3: never half-execute an ability
    expect(parseTriggerText('When you play me, give a unit +1 [M] this turn.')).toBeNull();
    expect(parseTriggerText('When you play me, draw 1. I enter ready.')).toBeNull();
    expect(parseTriggerText('I enter ready.')).toBeNull();
  });
});
