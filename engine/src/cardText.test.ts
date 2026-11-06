import { describe, it, expect } from 'vitest';
import { parseCardAbilities, parseSpellText, parseTriggerText } from './cardText.js';

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
    expect(parseCardAbilities('Kill a friendly unit or gear, [E]: [Add] [A].')).toBeNull();
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
