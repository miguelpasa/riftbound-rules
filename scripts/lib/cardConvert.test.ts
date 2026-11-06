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
    expect(lvl('When I attack, draw 1.')).toBe('partial');
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
    expect(parseEquipCost('[Equip] [C] ([C]: Attach)')).toEqual({ energy: 0, power: 1, anyPower: 0 });
  });
  it('flags non-resource parts and the Might reduction', () => {
    expect(parseEquipCost('[Equip] — [C], Kill a friendly unit (Pay the cost: Attach)')).toEqual({
      energy: 0,
      power: 1,
      anyPower: 0,
      nonResource: 'Kill a friendly unit',
    });
    expect(parseEquipCost('[Equip] [3][A]. This ability Energy cost is reduced by the Might of the unit you choose. (x)')).toEqual({
      energy: 3,
      power: 0,
      anyPower: 1,
      energyReducedByMight: true,
    });
    expect(parseEquipCost('[Equip] — Spend 1 XP (Pay the cost: Attach)')?.nonResource).toBe('Spend 1 XP');
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
    expect(card?.triggers?.[0]?.effects[0]).toMatchObject({ op: 'PLAY_TOKEN', token: 'tok-sprite' });
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
      { cost: { exhaust: true }, reaction: true, effects: [{ op: 'ADD_POWER', amount: 1, domain: 'SOURCE' }] },
    ]);
  });

  // Tests Rule 812: Legion cost reduction and "I enter ready" land on the card definition
  it('records Legion cost reduction and entering ready', () => {
    const a = convertRow(row({ abilityEffective: "[Legion] — I cost [2] less. (Get the effect.)" })).card;
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
