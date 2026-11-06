import { describe, it, expect } from 'vitest';
import {
  parseBattlefieldAbilities,
  parseCardAbilities,
  parseCondition,
  parseSpellText,
  parseTriggerText,
} from './cardText.js';

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
    expect(parseTriggerText('When you play me, stun a unit.')).toEqual([
      { on: 'PLAY', effects: [{ op: 'STUN_TARGET' }] },
    ]);
  });
});

describe('targeted triggers and abilities (R41)', () => {
  it('parses "When you play me, give a unit +N" and the other chooser sentences', () => {
    // Tests Rule 355.10: targets are chosen when the ability is put on the Chain
    expect(parseTriggerText('When you play me, give a unit +2 [M] this turn.')).toEqual([
      { on: 'PLAY', effects: [{ op: 'BUFF_TARGET', amount: 2, duration: 'TURN' }] },
    ]);
    expect(parseTriggerText('When you play me, give an enemy unit -3 [M] this turn.')).toEqual([
      { on: 'PLAY', effects: [{ op: 'DEBUFF_TARGET', amount: 3, side: 'enemy' }] },
    ]);
    expect(parseTriggerText('[Deathknell][>] Deal 4 to an enemy unit.')).toEqual([
      { on: 'DEATH', effects: [{ op: 'DAMAGE_TARGET', amount: 4, side: 'enemy' }] },
    ]);
    expect(parseTriggerText('When you play me, deal 1 to each of up to 2 units.')?.[0]).toEqual({
      on: 'PLAY',
      effects: [{ op: 'DAMAGE_TARGET', amount: 1, count: { min: 0, max: 2 } }],
    });
  });

  it('parses Legion-conditioned and activated targeted abilities', () => {
    // Tests Rule 145.1: an activated ability may choose targets
    const r = parseCardAbilities('[Legion] — When you play me, give a unit +2 [M] this turn.');
    expect(r?.triggers[0]).toMatchObject({ on: 'PLAY', condition: 'LEGION' });
    const a = parseCardAbilities('I enter ready.\n[E]: Give a unit +3 [M] this turn.');
    expect(a?.entersReady).toBe(true);
    expect(a?.abilities).toEqual([
      { cost: { exhaust: true }, effects: [{ op: 'BUFF_TARGET', amount: 3, duration: 'TURN' }] },
    ]);
    expect(parseCardAbilities('[E]: [Stun] an enemy unit.')?.abilities[0]?.effects).toEqual([
      { op: 'STUN_TARGET', side: 'enemy' },
    ]);
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

  it('refuses unknown trigger effects', () => {
    // Tests Rule 359.3: never half-execute an ability
    expect(
      parseTriggerText('When you play me, give a unit +1 [M] this turn. Fly away.'),
    ).toBeNull();
    expect(parseTriggerText('When you play me, choose a unit.')).toBeNull(); // chosen, never used
    expect(parseTriggerText('When you play me, draw 1. I enter ready.')).toBeNull();
    expect(parseTriggerText('I enter ready.')).toBeNull();
  });
});

describe('parseSpellText: tokens, "it" sentences, return / move / look (R3 round 2)', () => {
  it('parses unit-token sentences against the built-in token table', () => {
    // Tests Rule 186.1: a token is created with the characteristics its text gives
    expect(
      parseSpellText(
        '[Hidden] (Hide now.) [Action] (Play on your turn.) Play a ready 3 [M] Sprite unit token with [Temporary]. (Kill it at the start.)',
      ),
    ).toEqual([{ op: 'PLAY_TOKEN', token: 'tok-sprite', count: 1, ready: true }]);
    expect(parseSpellText('Play two ready 3 [M] Sprite unit tokens with [Temporary].')).toEqual([
      { op: 'PLAY_TOKEN', token: 'tok-sprite', count: 2, ready: true },
    ]);
    expect(parseSpellText('[Action] Play four 1 [M] Recruit unit tokens.')).toEqual([
      { op: 'PLAY_TOKEN', token: 'tok-recruit', count: 4 },
    ]);
    expect(parseSpellText('Play a 2 [M] Sand Soldier unit token.')).toEqual([
      { op: 'PLAY_TOKEN', token: 'tok-sand-soldier', count: 1 },
    ]);
    expect(parseSpellText('Play a 3 [M] Mech unit token to your base. Draw 1.')).toEqual([
      { op: 'PLAY_TOKEN', token: 'tok-mech', count: 1 },
      { op: 'DRAW', amount: 1 },
    ]);
  });

  it('refuses tokens it does not know or whose stats differ', () => {
    // Tests Rule 186.1: never invent a token
    expect(parseSpellText('Play a 4 [M] Recruit unit token.')).toBeNull();
    expect(parseSpellText('Play a 1 [M] Bird unit token.')).toBeNull(); // the table Bird has Deflect
    expect(parseSpellText('Play a Bomb gear token to a battlefield.')).toBeNull();
    expect(parseSpellText('Play three 1 [M] Recruit unit tokens there.')).toBeNull();
  });

  it('reads "it" as the single unit chosen by the previous sentence', () => {
    // Tests Rule 355.10: the chosen unit keeps the restrictions of the sentence that chose it
    expect(parseSpellText('Choose a friendly unit. Give it +2 [M] this turn.')).toEqual([
      { op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'friendly' },
    ]);
    expect(parseSpellText('Choose an enemy unit at a battlefield. Deal 3 to it. Stun it.')).toEqual(
      [
        { op: 'DAMAGE_TARGET', amount: 3, side: 'enemy', atBattlefield: true },
        { op: 'STUN_TARGET', side: 'enemy', atBattlefield: true },
      ],
    );
    expect(
      parseSpellText('Choose a unit. Give it -3 [M] this turn, to a minimum of 1 [M].'),
    ).toEqual([{ op: 'DEBUFF_TARGET', amount: 3, minMight: 1 }]);
    expect(parseSpellText('Choose an enemy unit. Kill it. Its controller draws 1.')).toEqual([
      { op: 'KILL_TARGET', side: 'enemy' },
      { op: 'TARGET_CONTROLLER_DRAW', amount: 1 },
    ]);
    expect(parseSpellText("Choose a friendly unit. Return it to its owner's hand.")).toEqual([
      { op: 'RETURN_TARGET', side: 'friendly' },
    ]);
  });

  it('refuses "it" without a unit, or a Choose nothing uses', () => {
    // Tests Rule 355.10: never half-execute a spell
    expect(parseSpellText('Give it +2 [M] this turn.')).toBeNull();
    expect(parseSpellText('Choose a unit.')).toBeNull();
    expect(parseSpellText('Choose a friendly unit and an enemy unit. Ready it.')).toBeNull();
    expect(parseSpellText('Choose a unit. Give it [Deflect] this turn.')).toBeNull();
  });

  it('parses return, move to base and kill-all sentences', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText("Return a unit at a battlefield to its owner's hand.")).toEqual([
      { op: 'RETURN_TARGET', atBattlefield: true },
    ]);
    expect(
      parseSpellText("Return a unit at a battlefield with 3 [M] or less to its owner's hand."),
    ).toEqual([{ op: 'RETURN_TARGET', atBattlefield: true, maxMight: 3 }]);
    expect(parseSpellText("Return a gear to its owner's hand.")).toEqual([
      { op: 'RETURN_TARGET', gear: true },
    ]);
    expect(parseSpellText('Move a unit from a battlefield to its base.')).toEqual([
      { op: 'MOVE_BASE_TARGET', atBattlefield: true },
    ]);
    expect(parseSpellText('Move up to 2 friendly units to base.')).toEqual([
      { op: 'MOVE_BASE_TARGET', side: 'friendly', count: { min: 0, max: 2 } },
    ]);
    expect(parseSpellText('Kill all units.')).toEqual([{ op: 'KILL_ALL_UNITS' }]);
    // A destination that needs a choice is still refused.
    expect(parseSpellText('Move an enemy unit.')).toBeNull();
  });

  it('parses the complete look-at-the-top forms and refuses incomplete ones', () => {
    // Tests Rule 417.5: the cards not taken are recycled to the bottom of the deck
    expect(
      parseSpellText(
        'Look at the top 3 cards of your Main Deck. Put 1 into your hand and recycle the rest.',
      ),
    ).toEqual([{ op: 'LOOK_TOP', count: 3, take: {} }]);
    expect(
      parseSpellText(
        'Look at the top 4 cards of your Main Deck. You may reveal a unit from among them and draw it. Recycle the rest.',
      ),
    ).toEqual([{ op: 'LOOK_TOP', count: 4, take: { filter: 'unit', reveal: true } }]);
    expect(parseSpellText('Look at the top 3 cards of your Main Deck.')).toBeNull();
    expect(
      parseSpellText('Look at the top 3 cards of your Main Deck. Put the rest into your trash.'),
    ).toBeNull();
  });
});

describe('parseTriggerText: tokens and multi-sentence abilities (R3 round 2)', () => {
  it('parses token triggers, keeping the token keyword out of the unit', () => {
    // Tests Rule 359.3: triggered abilities resolve their effects in order
    expect(
      parseTriggerText(
        'When you play me, play a ready 3 [M] Sprite unit token with [Temporary] here. (Kill it at the start.)',
      ),
    ).toEqual([
      {
        on: 'PLAY',
        effects: [{ op: 'PLAY_TOKEN', token: 'tok-sprite', count: 1, ready: true, here: true }],
      },
    ]);
    expect(
      parseTriggerText(
        '[Deathknell][>] Play a 1 [M] Bird unit token with [Deflect] to your base. (When I die, get the effect.)',
      ),
    ).toEqual([{ on: 'DEATH', effects: [{ op: 'PLAY_TOKEN', token: 'tok-bird', count: 1 }] }]);
    expect(
      parseTriggerText('[Deathknell] — Play three 1 [M] Recruit unit tokens into your base.'),
    ).toEqual([{ on: 'DEATH', effects: [{ op: 'PLAY_TOKEN', token: 'tok-recruit', count: 3 }] }]);
  });

  it('"When you play me or when I hold" makes two triggers; follow-up sentences join the ability', () => {
    // Tests Rule 359.3: triggered abilities resolve their effects in order
    const look = {
      op: 'LOOK_TOP',
      count: 4,
      take: { filter: 'gear', reveal: true },
    };
    expect(
      parseTriggerText(
        'When you play me or when I hold, look at the top 4 cards of your Main Deck. You may reveal a gear from among them and draw it. Then recycle the rest.',
      ),
    ).toEqual([
      { on: 'PLAY', effects: [look] },
      { on: 'HOLD', effects: [look] },
    ]);
    expect(parseTriggerText('When I hold, draw 1. Draw 1.')).toEqual([
      {
        on: 'HOLD',
        effects: [
          { op: 'DRAW', amount: 1 },
          { op: 'DRAW', amount: 1 },
        ],
      },
    ]);
    // A sentence that is not part of an ability still refuses the whole text.
    expect(parseTriggerText('When I hold, draw 1. I enter ready.')).toBeNull();
  });
});

describe('parseCardAbilities (R38)', () => {
  const gold = { op: 'PLAY_TOKEN', token: 'tok-gold', count: 1 };

  it('parses Gold gear token clauses in spells and triggers', () => {
    // Tests Rule 186.1: tokens are created on the Board
    expect(
      parseSpellText(
        '[Action] Deal 3 to a unit at a battlefield. Play a Gold gear token exhausted.',
      ),
    ).toEqual([{ op: 'DAMAGE_TARGET', amount: 3, atBattlefield: true }, gold]);
    expect(
      parseCardAbilities('When I hold, play two Gold gear tokens exhausted.')?.triggers,
    ).toEqual([{ on: 'HOLD', effects: [{ ...gold, count: 2 }] }]);
    expect(parseSpellText('Play three ready Gold gear tokens.')).toEqual([
      { ...gold, count: 3, ready: true },
    ]);
    expect(
      parseSpellText('Kill a gear. Its controller plays a Gold gear token exhausted.'),
    ).toEqual([
      { op: 'KILL_GEAR' },
      { op: 'TARGET_CONTROLLER_PLAY_TOKEN', token: 'tok-gold', count: 1 },
    ]);
    // "Its controller plays" needs an earlier kill
    expect(parseSpellText('Its controller plays a Gold gear token exhausted.')).toBeNull();
  });

  it('parses [Add] effects and activated abilities', () => {
    // Tests Rule 168: [Add] puts Energy or Power in the Rune Pool
    expect(
      parseCardAbilities(
        '[E]: [Reaction] — [Add] [C]. (Abilities that add resources cannot be reacted to.)',
      )?.abilities,
    ).toEqual([
      {
        cost: { exhaust: true },
        reaction: true,
        effects: [{ op: 'ADD_POWER', amount: 1, domain: 'SOURCE' }],
      },
    ]);
    expect(parseCardAbilities('[Reaction][>] [E]: [Add] [1].')?.abilities).toEqual([
      { cost: { exhaust: true }, reaction: true, effects: [{ op: 'ADD_ENERGY', amount: 1 }] },
    ]);
    expect(
      parseCardAbilities('[Reaction][>] Kill this, [E]: [Add] [A].', { gearLike: true })?.abilities,
    ).toEqual([
      {
        cost: { exhaust: true, killSelf: true },
        reaction: true,
        effects: [{ op: 'ADD_POWER', amount: 1, domain: 'ANY' }],
      },
    ]);
    expect(parseCardAbilities('[1], [E]: Draw 1.')?.abilities).toEqual([
      { cost: { exhaust: true, energy: 1 }, effects: [{ op: 'DRAW', amount: 1 }] },
    ]);
    expect(parseCardAbilities('When I conquer, [Add] [A].')?.triggers[0]?.effects).toEqual([
      { op: 'ADD_POWER', amount: 1, domain: 'ANY' },
    ]);
  });

  it('refuses abilities it cannot run', () => {
    // Tests Rule 145.1: an unknown cost, speed or follow-up sentence refuses the whole text
    expect(parseCardAbilities('Kill this, [E]: [Add] [A].')).toBeNull(); // not gear-like
    expect(parseCardAbilities('[E]: [Action] — [Add] [A][A].')).toBeNull();
    expect(parseCardAbilities('[E]: [Reaction] — [Add] [2]. Use only to play spells.')).toBeNull();
    expect(parseCardAbilities('Kill an enemy unit, [E]: [Add] [A].')).toBeNull(); // not a cost
    expect(parseCardAbilities('Discard 1, Discard 1: [Add] [A].')).toBeNull(); // one card choice
    expect(parseCardAbilities('[E]: Give a unit +3 [M] this turn. Then fly.')).toBeNull();
  });

  it('parses Legion forms', () => {
    // Tests Rule 812: Legion effects are gotten only while another card was played this turn
    const r = parseCardAbilities(
      '[Legion] — When you play me, play two 1 [M] Recruit unit tokens here. (Get the effect if you have played another card this turn.)',
    );
    expect(r?.triggers).toEqual([
      {
        on: 'PLAY',
        condition: 'LEGION',
        effects: [{ op: 'PLAY_TOKEN', token: 'tok-recruit', count: 2, here: true }],
      },
    ]);
    expect(parseCardAbilities('[Legion] — I cost [2] less.')?.legionCostReduction).toBe(2);
    expect(
      parseCardAbilities('[Legion][>] You may play me from your trash for [3][C].'),
    ).toBeNull();
    expect(parseCardAbilities('I cost [2] less.')).toBeNull(); // only the Legion form is modelled
  });

  it('parses "I enter ready"', () => {
    // Tests Rule 359.2.c: Units enter exhausted unless an effect says otherwise
    expect(parseCardAbilities('I enter ready.')).toMatchObject({ entersReady: true });
    expect(
      parseCardAbilities(
        'I enter ready. When you play me, play a ready 3 [M] Mech unit token here.',
      )?.triggers,
    ).toHaveLength(1);
    expect(parseCardAbilities('I enter ready if you control a battlefield.')).toBeNull();
  });
});

describe('parseBattlefieldAbilities (R44)', () => {
  it('rewrites "When you hold / conquer / defend here" into the trigger kinds', () => {
    // Tests Rule 473.2: Hold and Conquer triggers of a Battlefield card
    expect(parseBattlefieldAbilities('When you hold here, draw 1.')).toEqual([
      { on: 'HOLD', effects: [{ op: 'DRAW', amount: 1 }] },
    ]);
    expect(parseBattlefieldAbilities('When you conquer here, draw 1.')?.[0]?.on).toBe('CONQUER');
    expect(
      parseBattlefieldAbilities('When you defend here, you may move a friendly unit here to base.'),
    ).toEqual([
      {
        on: 'DEFEND',
        effects: [
          { op: 'MOVE_BASE_TARGET', side: 'friendly', here: true, count: { min: 0, max: 1 } },
        ],
      },
    ]);
  });

  it('parses the effect shapes of the supported battlefield cards', () => {
    // Tests Rule 473.2: the effects of Battlefield card triggers
    const one = (t: string) => parseBattlefieldAbilities(t)?.[0];
    expect(
      one('When you hold here, [Burn 3]. (Put the top 3 cards of your Main Deck into your trash.)')
        ?.effects,
    ).toEqual([{ op: 'BURN', amount: 3 }]);
    expect(
      one('When you conquer here, put the top 2 cards of your Main Deck into your trash.')?.effects,
    ).toEqual([{ op: 'BURN', amount: 2 }]);
    expect(one('When you hold here, each player channels 1 rune exhausted.')?.effects).toEqual([
      { op: 'CHANNEL', amount: 1, exhausted: true, eachPlayer: true },
    ]);
    expect(
      one('When you conquer here, draw 1 for each other battlefield you or allies control.')
        ?.effects,
    ).toEqual([{ op: 'DRAW', amount: 1, perOtherBattlefield: true }]);
    expect(
      one('When you hold here, play a 1 [M] Recruit unit token in your base.')?.effects[0],
    ).toMatchObject({ op: 'PLAY_TOKEN', count: 1 });
    const vista = one('When you hold here, if your Rune Deck is empty, you score 1 point.');
    expect(vista?.when).toEqual({
      kind: 'COUNT',
      what: 'card',
      where: 'runeDeck',
      who: 'friendly',
      cmp: 'EQ',
      n: 0,
    });
    expect(vista?.effects).toEqual([{ op: 'GAIN_POINT', amount: 1 }]);
    const plaza = one('When you hold here, if you have 7+ units here, you win the game.');
    expect(plaza?.when).toMatchObject({
      kind: 'COUNT',
      what: 'unit',
      where: 'here',
      cmp: 'GTE',
      n: 7,
    });
    expect(plaza?.effects).toEqual([{ op: 'WIN_GAME' }]);
  });

  it('is all-or-nothing and refuses static, non-trigger and unsupported text', () => {
    // Tests Rule 473.2: partially understood text is never half-executed
    expect(parseBattlefieldAbilities('Units here have +1 [M].')).toBeNull();
    expect(
      parseBattlefieldAbilities('When you hold here, draw 1. Units here have [Ganking].'),
    ).toBeNull();
    expect(
      parseBattlefieldAbilities(
        'When you conquer here, you may pay [1] and discard 1 and discard 1 to draw 1.',
      ),
    ).toBeNull();
    expect(
      parseBattlefieldAbilities('When you hold here, activate the conquer effects of units here.'),
    ).toBeNull();
    expect(parseBattlefieldAbilities('When you win here, draw 1.')).toBeNull();
    expect(parseBattlefieldAbilities('')).toBeNull();
  });

  it('parseCondition: units / gear "here" with "+" or "or more", and the Rune Deck', () => {
    // Tests Rule 473.2: conditions evaluated at the battlefield
    expect(parseCondition('you control 3+ gear here')).toMatchObject({
      what: 'gear',
      where: 'here',
      cmp: 'GTE',
      n: 3,
    });
    expect(parseCondition('you have two or more units here')).toMatchObject({
      what: 'unit',
      where: 'here',
      cmp: 'GTE',
      n: 2,
    });
    expect(parseCondition('you control 4 or fewer runes')).toMatchObject({
      what: 'rune',
      where: 'board',
      cmp: 'LTE',
      n: 4,
    });
    expect(parseCondition('you have 7+ cards here')).toBeNull();
  });
});

describe('optional ("you may") triggered abilities (R45)', () => {
  it('"you may pay COST to ..." becomes an optional trigger with a structured cost', () => {
    // Tests Rule 357.1.a: an optional cost is paid from the Rune Pool / runes when it is accepted
    expect(
      parseCardAbilities(
        'When I attack, you may pay [1] to give an enemy unit here -1 [M] this turn.',
      )?.triggers,
    ).toEqual([
      {
        on: 'ATTACK',
        optional: { energy: 1 },
        effects: [{ op: 'DEBUFF_TARGET', amount: 1, side: 'enemy', here: true }],
      },
    ]);
    expect(
      parseCardAbilities(
        'When I attack or defend, you may pay [1][C][A] to give me +2 [M] this turn.',
      )?.triggers.map((t) => [t.on, t.optional, t.effects]),
    ).toEqual([
      ['ATTACK', { energy: 1, power: 1, anyPower: 1 }, [{ op: 'BUFF_SELF', amount: 2 }]],
      ['DEFEND', { energy: 1, power: 1, anyPower: 1 }, [{ op: 'BUFF_SELF', amount: 2 }]],
    ]);
    expect(
      parseCardAbilities('When I move, you may [Burn 1] to give me +1 [M] this turn.')?.triggers,
    ).toEqual([{ on: 'MOVE', optional: { burn: 1 }, effects: [{ op: 'BUFF_SELF', amount: 1 }] }]);
  });

  it('a free "you may <effect>" is an optional trigger with an empty cost', () => {
    // Tests Rule 473.2: a hold trigger whose effect is optional
    expect(
      parseBattlefieldAbilities('When you hold here, you may channel 1 rune exhausted.'),
    ).toEqual([
      { on: 'HOLD', optional: {}, effects: [{ op: 'CHANNEL', amount: 1, exhausted: true }] },
    ]);
  });

  it('keeps a condition in front of the optional part and parses ready-legend / score', () => {
    // Tests Rule 473.2: "if" conditions are read before the may-clause
    expect(
      parseBattlefieldAbilities(
        'When you conquer here, if you control 4 or fewer runes, you may pay [1] to draw 1.',
      ),
    ).toEqual([
      {
        on: 'CONQUER',
        when: { kind: 'COUNT', what: 'rune', where: 'board', who: 'friendly', cmp: 'LTE', n: 4 },
        optional: { energy: 1 },
        effects: [{ op: 'DRAW', amount: 1 }],
      },
    ]);
    expect(
      parseBattlefieldAbilities('When you hold here, you may pay [A][A][A][A] to score 1 point.'),
    ).toEqual([
      {
        on: 'HOLD',
        optional: { anyPower: 4 },
        effects: [{ op: 'GAIN_POINT', amount: 1 }],
      },
    ]);
    expect(
      parseBattlefieldAbilities('When you conquer here, you may pay [1] to ready your legend.'),
    ).toEqual([{ on: 'CONQUER', optional: { energy: 1 }, effects: [{ op: 'READY_LEGEND' }] }]);
  });

  it('refuses costs and effects it does not model (discard, kill, extra costs)', () => {
    // Tests Rule 473.2: partially understood text is never half-executed
    expect(parseCardAbilities('When I conquer, you may banish a card to draw 1.')).toBeNull();
    expect(parseCardAbilities('When I conquer, you may kill an enemy unit to draw 1.')).toBeNull();
    expect(parseCardAbilities('When I conquer, you may pay to draw 1.')).toBeNull();
    expect(parseCardAbilities('When I conquer, you may pay [E] to draw 1.')).toBeNull();
    expect(parseCardAbilities('When I conquer, you may do something odd.')).toBeNull();
  });

  it('"a unit you control", "at a battlefield" and "when you play me to a battlefield"', () => {
    // Tests Rule 355.10: unit choices of a triggered ability
    expect(
      parseCardAbilities(
        'When you play me to a battlefield, you may move another unit you control here to your base.',
      )?.triggers,
    ).toEqual([
      {
        on: 'PLAY',
        when: { kind: 'AT_BATTLEFIELD' },
        effects: [
          {
            op: 'MOVE_BASE_TARGET',
            side: 'friendly',
            here: true,
            another: true,
            count: { min: 0, max: 1 },
          },
        ],
      },
    ]);
    expect(
      parseBattlefieldAbilities(
        'When you hold here, you may move a unit at a battlefield to its base.',
      ),
    ).toEqual([
      {
        on: 'HOLD',
        effects: [{ op: 'MOVE_BASE_TARGET', atBattlefield: true, count: { min: 0, max: 1 } }],
      },
    ]);
  });
});

describe('card-choice costs (R46)', () => {
  it('optional triggers: "you may discard 1 and ..." and "you may discard 1 to ..."', () => {
    // Tests Rule 357.1.a: a cost that needs a choice of cards
    expect(
      parseBattlefieldAbilities(
        'When you conquer here, you may discard 1 and channel 1 rune exhausted.',
      ),
    ).toEqual([
      {
        on: 'CONQUER',
        optional: { card: { kind: 'DISCARD' } },
        effects: [{ op: 'CHANNEL', amount: 1, exhausted: true }],
      },
    ]);
    expect(
      parseCardAbilities('When I conquer, you may discard two cards to draw 1.')?.triggers,
    ).toEqual([
      {
        on: 'CONQUER',
        optional: { card: { kind: 'DISCARD', count: 2 } },
        effects: [{ op: 'DRAW', amount: 1 }],
      },
    ]);
  });

  it('kill / exhaust / return need "friendly" or "you control", and carry here / another', () => {
    // Tests Rule 357.1.a: only your own permanents can be a cost
    expect(
      parseCardAbilities('When I defend, you may kill a friendly gear to give me +2 [M] this turn.')
        ?.triggers,
    ).toEqual([
      {
        on: 'DEFEND',
        optional: { card: { kind: 'KILL', what: 'gear' } },
        effects: [{ op: 'BUFF_SELF', amount: 2 }],
      },
    ]);
    expect(
      parseCardAbilities(
        'When I hold, you may kill another unit or gear you control here to draw 1.',
      )?.triggers?.[0]?.optional,
    ).toEqual({ card: { kind: 'KILL', what: 'unitOrGear', another: true, here: true } });
    expect(
      parseCardAbilities('When I hold, you may exhaust three other friendly units to draw 1.')
        ?.triggers?.[0]?.optional,
    ).toEqual({ card: { kind: 'EXHAUST', count: 3, another: true } });
    expect(parseCardAbilities('When I hold, you may kill an enemy unit to draw 1.')).toBeNull();
    expect(parseCardAbilities('When I hold, you may kill a unit to draw 1.')).toBeNull();
  });

  it('combines with a payment: "pay [1] and return a unit you control here to its owner\'s hand to ..."', () => {
    // Tests Rule 357.1.a: Energy and a card choice together
    expect(
      parseBattlefieldAbilities(
        "When you conquer here, you may pay [1] and return a unit you control here to its owner's hand to play a 2 [M] Sand Soldier unit token here.",
      ),
    ).toEqual([
      {
        on: 'CONQUER',
        optional: { energy: 1, card: { kind: 'RETURN', what: 'unit', here: true } },
        effects: [{ op: 'PLAY_TOKEN', token: 'tok-sand-soldier', count: 1, here: true }],
      },
    ]);
  });

  it('"When you play me or when I attack" and "kill a unit or gear" (Mordekaiser)', () => {
    // Tests Rule 355.10: the target of the kill is chosen when the ability goes on the Chain
    const r = parseCardAbilities(
      'When you play me or when I attack, you may discard 1 to kill a unit or gear.',
    );
    expect(r?.triggers.map((t) => t.on)).toEqual(['PLAY', 'ATTACK']);
    expect(r?.triggers[0]).toEqual({
      on: 'PLAY',
      optional: { card: { kind: 'DISCARD' } },
      effects: [{ op: 'KILL_TARGET', orGear: true }],
    });
  });

  it('a Deathknell that says "here" stays partial (the place of death is not kept)', () => {
    // Tests Rule 473.2: partially understood text is never half-executed
    expect(parseCardAbilities('[Deathknell][>] You may kill a unit or gear here.')).toBeNull();
    expect(parseCardAbilities('[Deathknell][>] Kill a unit or gear.')?.triggers).toHaveLength(1);
  });

  it('activated abilities: "Discard a gear, [1], [E]:", "Recycle 3 from your trash, [1], [E]:", "[1][C], ...:"', () => {
    // Tests Rule 145.1: the part before the colon is the cost
    expect(
      parseCardAbilities('Discard a gear, [1], [E]: Deal 4 to a unit at a battlefield.')
        ?.abilities[0]?.cost,
    ).toEqual({ card: { kind: 'DISCARD', what: 'gear' }, energy: 1, exhaust: true });
    expect(
      parseCardAbilities('Recycle 3 from your trash, [1], [E]: Draw 1.')?.abilities[0]?.cost,
    ).toEqual({ card: { kind: 'RECYCLE', count: 3 }, energy: 1, exhaust: true });
    expect(
      parseCardAbilities(
        '[1][C], Recycle a unit from your trash, [E]: Play a 3 [M] Mech unit token to your base.',
      )?.abilities[0]?.cost,
    ).toEqual({ energy: 1, power: 1, card: { kind: 'RECYCLE', what: 'unit' }, exhaust: true });
    expect(
      parseCardAbilities('Kill a friendly gear, [E]: Play a 1 [M] Recruit unit token.', {
        gearLike: true,
      })?.abilities[0]?.cost,
    ).toEqual({ card: { kind: 'KILL', what: 'gear' }, exhaust: true });
    expect(parseCardAbilities('Discard 1, Kill a friendly unit: Draw 1.')).toBeNull(); // one choice only
    expect(parseCardAbilities('Banish a card, [E]: Draw 1.')).toBeNull();
  });
});
