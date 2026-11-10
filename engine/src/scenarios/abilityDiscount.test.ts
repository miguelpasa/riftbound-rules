import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { getLegalActions } from '../legalActions.js';
import { abilityEnergyDiscount, selfEnergyDiscount, selfPowerDiscount } from '../costReduction.js';
import { parseCardAbilities, parseSelfCostReduction } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const withGrunt = (patch: Partial<CardDef>): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), ...patch },
});

describe('scenario: ability cost reductions and counted Might (R91)', () => {
  const abilityCards = withGrunt({
    abilities: [
      {
        cost: { energy: 4 },
        costReduction: { energy: 1, per: 'RUNE' },
        effects: [{ op: 'EMPOWER_SELF' }],
      },
    ],
  });

  it('the ability costs 1 less for each rune, so it becomes affordable with fewer runes', () => {
    // Tests Rule 145.1: an ability's cost can be reduced by its own text
    const sc = Scenario.start({}, abilityCards);
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setRunes('p0', ['Fury', 'Fury', 'Fury']);
    const def = sc.cards['fx-grunt'] as CardDef;
    const ability = def.abilities?.[0];
    if (!ability) throw new Error('no ability');
    expect(abilityEnergyDiscount(sc.state, sc.cards, 'p0', def, ability, u)).toBe(3);
    // 4 - 3 = 1 Energy: playable with 3 runes, impossible with 0 runes (4 Energy needed).
    const can = (s: Scenario) =>
      getLegalActions(s.state, s.cards, 'p0').some(
        (i) => i.type === 'ACTIVATE_ABILITY' && i.sourceId === u,
      );
    expect(can(sc)).toBe(true);
    const none = Scenario.start({}, abilityCards);
    none.putUnit('p0', 'fx-grunt', 'base');
    none.setRunes('p0', []);
    expect(
      getLegalActions(none.state, none.cards, 'p0').some((i) => i.type === 'ACTIVATE_ABILITY'),
    ).toBe(false);
  });

  it('activating pays only the reduced cost', () => {
    // Tests Rule 145.1: the discount applies to the real payment
    const sc = Scenario.start({}, abilityCards);
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setRunes('p0', ['Fury', 'Fury', 'Fury', 'Fury']);
    sc.do({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: u,
      abilityIndex: 0,
      payment: sc.exhaustPlan('p0', 1),
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(u).empowered).toBe(true);
  });

  it('a spell costs less by the highest Might among your units', () => {
    // Tests Rule 156: cost reductions come from the card's own text
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        cost: { energy: 6 },
        costReduction: { energy: 1, per: 'HIGHEST_MIGHT' },
      },
    };
    const sc = Scenario.start({}, cards);
    const titan = sc.putUnit('p0', 'fx-titan', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    const might = effectiveMight(sc.state, sc.cards, titan, { role: null });
    expect(selfEnergyDiscount(sc.state, sc.cards, 'p0', cards['fx-flare'] as CardDef, spell)).toBe(
      might,
    );
  });

  it('"My Might is increased by the number of cards in your trash"', () => {
    // Tests Rule 143.2: static Might counts the Trash
    const sc = Scenario.start(
      {},
      withGrunt({ statics: [{ affects: 'SELF', might: 1, per: 'TRASH_CARDS' }] }),
    );
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const base = effectiveMight(sc.state, sc.cards, u, { role: null });
    const f1 = sc.putInHand('p0', 'fx-flare');
    const f2 = sc.putInHand('p0', 'fx-flare');
    const ps = sc.state.players[0] as (typeof sc.state.players)[number];
    for (const id of [f1, f2]) {
      ps.hand = ps.hand.filter((x) => x !== id);
      ps.trash.push(id);
      sc.obj(id).zone = { kind: 'trash', player: 'p0' };
    }
    expect(effectiveMight(sc.state, sc.cards, u, { role: null })).toBe(base + ps.trash.length);
  });
});

describe('parser: ability discounts (R91)', () => {
  it('reads "This ability costs [N] less ..." after an ability and the highest-Might spell discount', () => {
    // Tests Rule 145.1: parsed text
    const a = parseCardAbilities(
      '[Empower] [12]. This ability costs [1] less for each rune you control.',
    )?.abilities[0];
    expect(a).toMatchObject({ cost: { energy: 12 }, costReduction: { energy: 1, per: 'RUNE' } });
    expect(
      parseSelfCostReduction(
        "This spell's Energy cost is reduced by the highest Might among units you control.\nDeal 5 to a unit.",
      ),
    ).toMatchObject({ reduction: { energy: 1, per: 'HIGHEST_MIGHT' }, rest: 'Deal 5 to a unit.' });
  });
});

describe('scenario: tiered "[Level N][>] This costs [X] less ... instead" (Concentrate)', () => {
  const text =
    'Draw 2.\n[Level 6][>] This costs [2] less. (While you have 6+ XP, get the effect.)\n[Level 11][>] This costs [4] less instead.';

  it('reads a Level 6 discount that a Level 11 discount replaces', () => {
    // Tests Rule 560.4: a cost reduction counts what it names
    const parsed = parseSelfCostReduction(text);
    expect(parsed?.reduction).toEqual({
      energy: 2,
      when: { kind: 'XP', n: 6 },
      instead: [{ energy: 4, when: { kind: 'XP', n: 11 } }],
    });
    expect(parsed?.rest.trim()).toBe('Draw 2.');
  });

  it('takes the deepest tier the XP reaches, not the sum', () => {
    // Tests Rule 560.4: the later "instead" replaces the earlier discount
    const reduction = parseSelfCostReduction(text)?.reduction;
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-plain-spell': {
        ...(SCENARIO_CARDS['fx-plain-spell'] as CardDef),
        cost: { energy: 6 },
        ...(reduction ? { costReduction: reduction } : {}),
      },
    };
    const sc = Scenario.start({}, cards);
    const id = sc.putInHand('p0', 'fx-plain-spell');
    const def = cards['fx-plain-spell'] as CardDef;
    const at = (xp: number): number => {
      (sc.state.players[0] as { xp?: number }).xp = xp;
      return selfEnergyDiscount(sc.state, cards, 'p0', def, id);
    };
    expect(at(5)).toBe(0);
    expect(at(6)).toBe(2);
    expect(at(10)).toBe(2);
    expect(at(11)).toBe(4);
  });
});

describe('scenario: Level tiers with Power parts (Master Yi)', () => {
  const text =
    '[Level 3][>] I cost [2][C] less.\n[Level 6][>] I cost [4][C][C] less instead.\n[Level 11][>] I cost [6][C][C][C] less instead.';

  it('reads Energy and Power for every tier', () => {
    // Tests Rule 560.4: a cost reduction counts what it names
    expect(parseSelfCostReduction(text)?.reduction).toEqual({
      energy: 2,
      power: 1,
      when: { kind: 'XP', n: 3 },
      instead: [
        { energy: 4, power: 2, when: { kind: 'XP', n: 6 } },
        { energy: 6, power: 3, when: { kind: 'XP', n: 11 } },
      ],
    });
  });

  it('takes the deepest tier the XP reaches for both Energy and Power', () => {
    // Tests Rule 560.4: the later "instead" replaces the earlier discount
    const reduction = parseSelfCostReduction(text)?.reduction;
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        cost: { energy: 7, power: 3 },
        ...(reduction ? { costReduction: reduction } : {}),
      },
    };
    const sc = Scenario.start({}, cards);
    const id = sc.putInHand('p0', 'fx-grunt');
    const def = cards['fx-grunt'] as CardDef;
    const at = (xp: number): [number, number] => {
      (sc.state.players[0] as { xp?: number }).xp = xp;
      return [
        selfEnergyDiscount(sc.state, cards, 'p0', def, id),
        selfPowerDiscount(sc.state, cards, 'p0', def, id),
      ];
    };
    expect(at(2)).toEqual([0, 0]);
    expect(at(3)).toEqual([2, 1]);
    expect(at(6)).toEqual([4, 2]);
    expect(at(11)).toEqual([6, 3]);
  });
});
