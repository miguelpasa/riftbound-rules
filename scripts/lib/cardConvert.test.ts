import { describe, expect, it } from 'vitest';
import {
  convertRow,
  createCardValidator,
  dedupePrintings,
  normalizeRow,
  normalizeText,
  parseEquipCost,
  type RawRow,
} from './cardConvert';

const row = (over: Partial<RawRow> = {}): RawRow => ({
  cardCode: 'ogn-001',
  name: 'Test Unit',
  fullName: 'Test Unit',
  cardNumber: '001',
  rarity: 'Common',
  domain: 'Fury',
  domains: ['Fury'],
  cardType: 'Unit',
  cardTypeLabels: ['Unit'],
  tags: [],
  energy: 3,
  power: 0,
  might: 3,
  abilityEffective: '',
  imageUrl: 'http://img/1.png',
  ...over,
});

describe('cardConvert', () => {
  // Tests: [S] becomes [M] and [T] becomes [E]
  it('normalises symbols', () => {
    expect(normalizeText('Give +1 [S]. [T]: draw.')).toBe('Give +1 [M]. [E]: draw.');
  });

  // Tests: errata marker, including the newline-split real form, is stripped with trailing text
  it('strips the old-text marker', () => {
    expect(normalizeText('New text.\n▲ [OLD TEXT]\nOld text.')).toBe('New text.');
    expect(normalizeText('New text.\n▲\n[OLD TEXT]')).toBe('New text.');
  });

  // Tests: colorless power keeps power number with an empty domain list
  it('handles colorless power', () => {
    const { card } = convertRow(row({ domain: 'Colorless', domains: ['Colorless'], power: 2 }));
    expect(card?.domains).toEqual([]);
    expect(card?.cost).toEqual({ energy: 3, power: 2 });
  });

  // Tests: single-domain power produces a domain cost entry
  it('builds domain cost', () => {
    const { card } = convertRow(row({ power: 2 }));
    expect(card?.cost).toEqual({ energy: 3, power: 2, domain: [{ element: 'Fury', amount: 2 }] });
  });

  // Tests: unknown domains are reported
  it('reports unknown domains', () => {
    const res = convertRow(row({ domains: ['Fury', 'Plasma'] }));
    expect(res.unknownDomains).toEqual(['Plasma']);
    expect(res.card?.domains).toEqual(['Fury']);
  });

  // Tests: keywords with values; symbols and reminder text are not keywords
  it('extracts keywords with values', () => {
    const { card } = convertRow(
      row({
        abilityEffective:
          '[Assault 2] [Shield 1] [Quick-Draw] [Show Off] (When played, [Tank] does nothing.) Pay [1][C] [>]',
      }),
    );
    expect(card?.keywords).toEqual([
      { name: 'Assault', value: 2 },
      { name: 'Shield', value: 1 },
      { name: 'QuickDraw' },
      { name: 'ShowOff' },
    ]);
  });

  // Tests: supportLevel full for keyword-only, partial for prose or deferred keywords
  it('computes supportLevel', () => {
    const lvl = (t: string): string | undefined =>
      convertRow(row({ abilityEffective: t })).card?.supportLevel;
    expect(lvl('')).toBe('full');
    expect(lvl('[Tank] [Assault 2] (Reminder text.)')).toBe('full');
    expect(lvl('[Equip] [1][C]')).toBe('full');
    expect(lvl('When I attack, draw 1.')).toBe('full'); // R42: attack triggers are parsed
    expect(lvl('When I move, draw 1.')).toBe('full'); // R43: move triggers are parsed
    expect(lvl('When I move to a battlefield, draw 1.')).toBe('full');
    expect(lvl('[Deathknell] (Reminder.)')).toBe('partial');
    expect(lvl('[Tank] [Buff]')).toBe('partial');
  });

  // Tests: subtypes drop the primary type and add tags
  it('builds subtypes', () => {
    const { card } = convertRow(row({ cardTypeLabels: ['Unit', 'Champion'], tags: ['Ahri'] }));
    expect(card?.subtypes).toEqual(['Champion', 'Ahri']);
  });

  // Tests: showcase printing is deduped to the base printing, with alias map
  it('dedupes showcase against base', () => {
    const rows = [
      row({ cardCode: 'sp-1', rarity: 'Showcase', cardNumber: 'sp1-001' }),
      row({ cardCode: 'alt', cardNumber: '001a-100' }),
      row({ cardCode: 'base', cardNumber: '001' }),
      row({ cardCode: 'spell', cardType: 'Spell' }),
    ];
    const { kept, aliases } = dedupePrintings(rows);
    expect(kept.map((r) => r.cardCode).sort()).toEqual(['base', 'spell']);
    expect(aliases).toEqual({ 'sp-1': 'base', alt: 'base' });
  });

  // Tests: snake_case rows are accepted
  it('accepts snake_case input', () => {
    const r = normalizeRow({ card_code: 'x-1', name: 'X', card_type: 'Spell', full_name: 'X' });
    expect(r.cardCode).toBe('x-1');
    expect(r.cardType).toBe('Spell');
  });

  // Tests: schema validation accepts converted cards and rejects bad ones
  it('validates against the schema', () => {
    const validate = createCardValidator();
    const { card } = convertRow(row({ abilityEffective: '[Tank]' }));
    expect(validate(card)).toEqual([]);
    expect(validate({ ...card, type: 'NOPE' }).length).toBeGreaterThan(0);
    expect(validate({ cardId: 'a', name: 'b', type: 'UNIT' }).length).toBeGreaterThan(0);
  });
});

describe('parseEquipCost (Rule 818)', () => {
  it('parses Energy, domain Power and any-domain Power', () => {
    expect(parseEquipCost('[Equip] [1] ([1]: Attach this to a unit you control.)')).toEqual({
      energy: 1,
      power: 0,
      anyPower: 0,
    });
    expect(parseEquipCost('[Equip] [1][C] ([1][C]: Attach this to a unit you control.)')).toEqual({
      energy: 1,
      power: 1,
      anyPower: 0,
    });
    expect(parseEquipCost('[Equip] [C] ([C]: Attach)')).toEqual({
      energy: 0,
      power: 1,
      anyPower: 0,
    });
  });
  it('flags non-resource parts and the Might reduction', () => {
    expect(parseEquipCost('[Equip] — [C], Kill a friendly unit (Pay the cost: Attach)')).toEqual({
      energy: 0,
      power: 1,
      anyPower: 0,
      nonResource: 'Kill a friendly unit',
    });
    expect(
      parseEquipCost(
        '[Equip] [3][A]. This ability Energy cost is reduced by the Might of the unit you choose. (x)',
      ),
    ).toEqual({
      energy: 3,
      power: 0,
      anyPower: 1,
      energyReducedByMight: true,
    });
    expect(parseEquipCost('[Equip] — Spend 1 XP (Pay the cost: Attach)')?.nonResource).toBe(
      'Spend 1 XP',
    );
    expect(parseEquipCost('[Tank]')).toBeUndefined();
  });
});

describe('cardConvert: unit tokens (R3 round 2)', () => {
  // Tests: the keyword in "token with [Keyword]" belongs to the token, and the trigger parses
  it('does not give a unit the keyword of the token it plays', () => {
    const { card } = convertRow(
      row({
        abilityEffective:
          'When you play me, play a ready 3 [M] Sprite unit token with [Temporary] here. (Kill it later.)',
      }),
    );
    expect(card?.keywords).toEqual([]);
    expect(card?.supportLevel).toBe('full');
    expect(card?.triggers?.[0]?.effects[0]).toMatchObject({
      op: 'PLAY_TOKEN',
      token: 'tok-sprite',
    });
  });
});

describe('cardConvert: abilities (R38)', () => {
  // Tests Rule 168: a Seal's [Add] ability makes the gear fully supported
  it('gives a Seal its activated ability', () => {
    const { card } = convertRow(
      row({
        cardType: 'Gear',
        abilityEffective:
          "[E]: [Reaction] — [Add] [C]. (Abilities that add resources can't be reacted to.)",
      }),
    );
    expect(card?.supportLevel).toBe('full');
    expect(card?.abilities).toEqual([
      {
        cost: { exhaust: true },
        reaction: true,
        effects: [{ op: 'ADD_POWER', amount: 1, domain: 'SOURCE' }],
      },
    ]);
  });

  // Tests Rule 812: Legion cost reduction and "I enter ready" land on the card definition
  it('records Legion cost reduction and entering ready', () => {
    const a = convertRow(
      row({ abilityEffective: '[Legion] — I cost [2] less. (Get the effect.)' }),
    ).card;
    expect(a?.supportLevel).toBe('full');
    expect(a?.legionCostReduction).toBe(2);
    const b = convertRow(row({ abilityEffective: 'I enter ready.' })).card;
    expect(b).toMatchObject({ supportLevel: 'full', entersReady: true });
  });

  // Tests Rule 145.1: a unit cannot use "Kill this" as a cost
  it('refuses Kill this on a unit', () => {
    const { card } = convertRow(row({ abilityEffective: '[E]: Kill this, draw 1.' }));
    expect(card?.supportLevel).toBe('partial');
  });
});

describe('R42 converter wiring', () => {
  const conv = (cardType: string, text: string) =>
    convertRow(row({ cardType, abilityEffective: text })).card;

  it('turns [Disarm N] and [Weaponmaster] into triggers and makes the card full', () => {
    const disarm = conv(
      'Unit',
      '[Disarm 2] (When I attack, give an enemy unit here -2 [M] this turn.)',
    );
    expect(disarm?.supportLevel).toBe('full');
    expect(disarm?.triggers?.[0]).toMatchObject({ on: 'ATTACK' });
    const wm = conv(
      'Unit',
      '[Weaponmaster] (When you play me, you may [Equip] one of your Equipment to me for [A] less.)',
    );
    expect(wm?.supportLevel).toBe('full');
    expect(wm?.triggers?.[0]?.effects[0]).toMatchObject({ op: 'WEAPONMASTER_EQUIP' });
    // Disarm mentioned in prose stays partial
    expect(conv('Unit', 'Your Mechs have [Disarm].')?.supportLevel).toBe('partial');
  });

  it('stores a Repeat cost on spells and keeps odd Repeat costs partial', () => {
    const ok = conv(
      'Spell',
      "[Repeat] [2] (You may pay the cost to repeat this spell's effect.)\nReady a unit.",
    );
    expect(ok?.supportLevel).toBe('full');
    expect(ok?.repeatCost).toEqual({ energy: 2, power: 0 });
    const c = conv('Spell', '[Repeat] [1][C] (Reminder.)\nDraw 1.');
    expect(c?.repeatCost).toEqual({ energy: 1, power: 1 });
    // R47: "Discard 1" is a card-choice Repeat cost; several costs stay partial
    const sq = conv('Spell', '[Repeat] — Discard 1 (Reminder.)\nReady a unit.');
    expect(sq?.supportLevel).toBe('full');
    expect(sq?.repeatCost).toEqual({ energy: 0, power: 0, card: { kind: 'DISCARD' } });
    expect(
      conv('Spell', '[Repeat] — Discard 1, [1] (Reminder.)\nReady a unit.')?.supportLevel,
    ).toBe('partial');
  });

  it('marks Gear that enters exhausted, and the result validates against the schema', () => {
    const g = conv('Gear', 'This enters exhausted.\n[T]: Deal 2 to a unit at a battlefield.');
    expect(g?.supportLevel).toBe('full');
    expect(g?.entersExhausted).toBe(true);
    const validate = createCardValidator();
    expect(validate(g)).toEqual([]);
    expect(validate(conv('Spell', '[Repeat] [2]\nReady a unit.'))).toEqual([]);
  });
});

describe('R43 converter wiring', () => {
  const conv = (type: string, text: string) =>
    convertRow(row({ cardType: type, cardTypeLabels: [type], abilityEffective: text })).card;
  const validate = createCardValidator();

  it('treats [Ambush] as an implemented keyword, alone or with a parsed trigger', () => {
    const bare = conv(
      'Unit',
      '[Ambush] (You may play me as a [Reaction] to a battlefield where you have units.)',
    );
    expect(bare?.supportLevel).toBe('full');
    expect(bare?.keywords).toEqual([{ name: 'Ambush' }]);
    const vi = conv('Unit', '[Ambush]\nWhen I attack, [Stun] an enemy unit here.');
    expect(vi?.supportLevel).toBe('full');
    expect(vi?.triggers?.[0]?.on).toBe('ATTACK');
    // Prose beyond the keyword (Rengar) still blocks full support.
    expect(
      conv('Unit', '[Ambush]\nI can be played to a battlefield where there are enemy units.')
        ?.supportLevel,
    ).toBe('partial');
    expect(validate(bare)).toEqual([]);
  });

  it('stores conditions and enters-ready conditions, and validates', () => {
    const shen = conv(
      'Unit',
      'When I hold, if there is exactly one other unit you control here, draw 1.',
    );
    expect(shen?.supportLevel).toBe('full');
    expect(shen?.triggers?.[0]?.when).toMatchObject({ kind: 'COUNT', where: 'here', n: 1 });
    const lone = conv('Unit', 'I enter ready if you control no other units.');
    expect(lone?.supportLevel).toBe('full');
    expect(lone?.entersReadyWhen).toMatchObject({ kind: 'COUNT', n: 0 });
    expect(conv('Unit', 'When I hold, if the moon is full, draw 1.')?.supportLevel).toBe('partial');
    expect(validate(shen)).toEqual([]);
    expect(validate(lone)).toEqual([]);
  });

  it('parses the temporary keyword grants of spells and units', () => {
    const block = conv('Spell', 'Give a unit [Shield 2] and [Tank] this turn.');
    expect(block?.supportLevel).toBe('full');
    expect(block?.effects?.[0]).toMatchObject({ op: 'GRANT_KEYWORD_TARGET' });
    const dancer = conv('Unit', 'When you play me, give your other units here [Shield] this turn.');
    expect(dancer?.supportLevel).toBe('full');
    expect(conv('Spell', 'Give a unit [Deflect] this turn.')?.supportLevel).toBe('partial');
  });
});

describe('R44 converter wiring (Battlefield cards)', () => {
  const conv = (text: string) =>
    convertRow(
      row({
        cardType: 'Battlefield',
        cardTypeLabels: ['Battlefield'],
        energy: 0,
        might: null,
        abilityEffective: text,
      }),
    ).card;
  const validate = createCardValidator();

  it('makes a Battlefield card full when every sentence is a parsed trigger, and stores the triggers', () => {
    const grove = conv('When you hold here, draw 1.');
    expect(grove?.supportLevel).toBe('full');
    expect(grove?.triggers).toEqual([{ on: 'HOLD', effects: [{ op: 'DRAW', amount: 1 }] }]);
    expect(validate(grove)).toEqual([]);
    const temple = conv(
      'When you hold here, [Burn 3]. (Put the top 3 cards of your Main Deck into your trash.)',
    );
    expect(temple?.supportLevel).toBe('full');
    expect(temple?.triggers?.[0]?.effects).toEqual([{ op: 'BURN', amount: 3 }]);
  });

  it('keeps Battlefield cards with any unparsed sentence partial', () => {
    expect(conv('When you hold here, draw 1. Units here have +1 [M].')?.supportLevel).toBe(
      'partial',
    );
    expect(conv('Units here have [Backline].')?.supportLevel).toBe('partial'); // R51: a Ganking grant is supported
    expect(conv('When you conquer here, you may banish a card to draw 1.')?.supportLevel).toBe(
      'partial',
    );
    expect(conv('')?.supportLevel).toBe('full'); // vanilla stays full as before
  });

  it('stores optional ("you may pay ...") triggers with their structured cost (R45)', () => {
    const nexus = conv('When you hold here, you may pay [A][A][A][A] to score 1 point.');
    expect(nexus?.supportLevel).toBe('full');
    expect(nexus?.triggers).toEqual([
      { on: 'HOLD', optional: { anyPower: 4 }, effects: [{ op: 'GAIN_POINT', amount: 1 }] },
    ]);
    expect(validate(nexus)).toEqual([]);
    const unit = convertRow(
      row({ abilityEffective: 'When I attack, you may pay [C] to give me +2 [M] this turn.' }),
    ).card;
    expect(unit?.supportLevel).toBe('full');
    expect(unit?.triggers?.[0]).toMatchObject({ on: 'ATTACK', optional: { power: 1 } });
    expect(validate(unit)).toEqual([]);
    // costs the engine does not model keep the card partial
    expect(
      convertRow(row({ abilityEffective: 'When I attack, you may banish a card to draw 1.' })).card
        ?.supportLevel,
    ).toBe('partial');
  });

  it('stores card-choice costs (discard / kill / return / recycle) structurally (R46)', () => {
    const monastery = conv(
      'When you conquer here, you may discard 1 and channel 1 rune exhausted.',
    );
    expect(monastery?.supportLevel).toBe('full');
    expect(monastery?.triggers).toEqual([
      {
        on: 'CONQUER',
        optional: { card: { kind: 'DISCARD' } },
        effects: [{ op: 'CHANNEL', amount: 1, exhausted: true }],
      },
    ]);
    expect(validate(monastery)).toEqual([]);
    const cruiser = convertRow(
      row({ abilityEffective: 'Discard a gear, [T], [1]: Deal 4 to a unit at a battlefield.' }),
    ).card;
    expect(cruiser?.supportLevel).toBe('full');
    expect(cruiser?.abilities?.[0]?.cost).toEqual({
      card: { kind: 'DISCARD', what: 'gear' },
      exhaust: true,
      energy: 1,
    });
    expect(validate(cruiser)).toEqual([]);
    // an enemy kill is not a cost, a second card choice is not modelled
    expect(
      convertRow(row({ abilityEffective: 'Kill an enemy unit, [T]: Draw 1.' })).card?.supportLevel,
    ).toBe('partial');
  });

  it('does not give Units a battlefield-only head', () => {
    const unit = convertRow(row({ abilityEffective: 'When you hold here, draw 1.' })).card;
    expect(unit?.supportLevel).toBe('partial');
  });
});

describe('R47 converter wiring: additional costs to play', () => {
  const conv = (cardType: string, text: string) =>
    convertRow(row({ cardType, cardTypeLabels: [cardType], abilityEffective: text })).card;
  const validate = createCardValidator();

  it('stores "As an additional cost to play this/me, <card cost>" and makes the card full', () => {
    const ki = conv(
      'Spell',
      "[Action] (Play on your turn or in showdowns.)\nAs an additional cost to play this, exhaust a friendly unit.\n[Stun] a unit. (It doesn't deal combat damage this turn.)",
    );
    expect(ki?.supportLevel).toBe('full');
    expect(ki?.additionalCost).toEqual({ card: { kind: 'EXHAUST' } });
    expect(ki?.effects?.length).toBeGreaterThan(0);
    expect(ki?.text).toContain('additional cost');
    const sac = conv(
      'Spell',
      '[Reaction]\nAs an additional cost to play this, kill a friendly [Mighty] unit. (A unit is Mighty while it has 5+ [S].)\nDraw 2 and channel 1 rune exhausted.',
    );
    expect(sac?.additionalCost).toEqual({ card: { kind: 'KILL', what: 'unit', mighty: true } });
    const ekko = conv(
      'Unit',
      "As an additional cost to play me, return a friendly unit to its owner's hand.\n[Ganking] (I can move from battlefield to battlefield.)",
    );
    expect(ekko?.supportLevel).toBe('full');
    expect(ekko?.additionalCost).toEqual({ card: { kind: 'RETURN', what: 'unit' } });
    const patron = conv('Unit', 'As an additional cost to play me, kill a friendly unit.');
    expect(patron?.supportLevel).toBe('full');
    expect(patron?.additionalCost?.card).toEqual({ kind: 'KILL', what: 'unit' });
    const gearReturn = conv(
      'Unit',
      "As an additional cost to play me, return a friendly gear to its owner's hand.",
    );
    expect(gearReturn?.additionalCost?.card).toEqual({ kind: 'RETURN', what: 'gear' });
    for (const c of [ki, sac, ekko, patron, gearReturn]) expect(validate(c)).toEqual([]);
  });

  it('keeps cards partial when the rest or the cost is not understood', () => {
    // an unparsed effect sentence: partial, and no additionalCost is stored
    const odd = conv(
      'Spell',
      'As an additional cost to play this, exhaust a friendly unit.\nSwap two things.',
    );
    expect(odd?.supportLevel).toBe('partial');
    expect(odd?.additionalCost).toBeUndefined();
    // a cost that is not a card choice (an Energy part, a Legend's reduction) is not parsed
    expect(
      conv('Unit', 'As an additional cost to play me, pay [2] and exhaust me.')?.supportLevel,
    ).toBe('partial');
    expect(
      conv('Legend', 'As an additional cost to play a spell, you may exhaust me.')?.supportLevel,
    ).toBe('partial');
  });
});

describe('Equip written without keyword brackets (R69)', () => {
  it('treats a line starting "Equip [N]" as the Equip keyword', () => {
    expect(normalizeText('Equip [1] ([1]: Attach this to a unit you control.)')).toBe(
      '[Equip] [1] ([1]: Attach this to a unit you control.)',
    );
    expect(parseEquipCost(normalizeText('Equip [C] ([C]: Attach this.)'))).toMatchObject({
      power: 1,
    });
  });
});

describe('Keywords written as plain words before their reminder (R103)', () => {
  it('brackets Ganking / Hidden / Action at the start of a line when a reminder follows', () => {
    // Tests Rule 799: keywords are bracketed tokens in the card data
    expect(normalizeText('Ganking (I can move from battlefield to battlefield.)')).toBe(
      '[Ganking] (I can move from battlefield to battlefield.)',
    );
    expect(normalizeText('Hidden (Hide now.)\nWhen you play me, draw 1.')).toBe(
      '[Hidden] (Hide now.)\nWhen you play me, draw 1.',
    );
    // A sentence that merely starts with the word is left alone.
    expect(normalizeText('Action figures are not keywords.')).toBe(
      'Action figures are not keywords.',
    );
  });
});

describe('"a card from [Hidden]" (R110)', () => {
  it('reads it as a card played from face down, not as the Hidden keyword', () => {
    // Tests Rule 811: Hidden cards are played from face down
    expect(normalizeText('When you play a card from [Hidden], give me +2 [S] this turn.')).toBe(
      'When you play a card from face down, give me +2 [M] this turn.',
    );
  });
});
