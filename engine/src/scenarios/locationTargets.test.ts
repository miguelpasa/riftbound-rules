import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { enumerateSpellTargets, spellTargetsLegal } from '../effects.js';
import { parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect, PlayerId, Target } from '../types/index.js';

const bf = (battlefieldId: string): Target => ({ kind: 'battlefield', battlefieldId });
const obj = (id: string): Target => ({ kind: 'object', id });

const spellWith = (effects: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': { ...(SCENARIO_CARDS['fx-flare'] as CardDef), supportLevel: 'partial', effects },
});

/** Cast fx-flare with `targets`, then let both players pass until the Chain is empty. */
function cast(sc: Scenario, targets: Target[]): void {
  sc.giveRunes('p0', 4);
  const spell = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets });
  for (let k = 0; k < 8 && sc.state.flow.chain.length > 0; k++) {
    sc.pass(sc.state.flow.priority as PlayerId);
  }
}

describe('parser: choose a battlefield and move spells', () => {
  it('reads Siphon Power, For Demacia!, Charm and Ride the Wind', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(
      parseSpellText(
        'Choose a battlefield. Give friendly units there +1 [M] this turn and enemy units there -1 [M] this turn, to a minimum of 1 [M].',
      ),
    ).toEqual([{ op: 'BF_AREA', slot: 0, friendlyMight: 1, enemyMight: 1, minMight: 1 }]);
    expect(
      parseSpellText('Choose a battlefield. Give friendly units there [Shield 2] this turn.'),
    ).toEqual([{ op: 'BF_AREA', slot: 0, keywords: [{ name: 'Shield', value: 2 }] }]);
    expect(parseSpellText('Move an enemy unit.')).toEqual([
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, side: 'enemy' },
    ]);
    expect(parseSpellText('Move a friendly unit and ready it.')).toEqual([
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, side: 'friendly', ready: true },
    ]);
  });
});

describe('scenario: a chosen battlefield (Siphon Power, For Demacia!)', () => {
  it('buffs friendly units there, shrinks enemy units there to a minimum, and leaves others alone', () => {
    // Tests Rule 355.10: the battlefield is a chosen target
    const cards = spellWith([
      { op: 'BF_AREA', slot: 0, friendlyMight: 1, enemyMight: 5, minMight: 1 },
    ]);
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    const away = sc.putUnit('p0', 'fx-grunt', 'base');
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const printed = (id: string): number => effectiveMight(sc.state, sc.cards, id, { role: null });
    const [m0, a0] = [printed(mine), printed(away)];
    cast(sc, [bf('bf0')]);
    expect(printed(mine)).toBe(m0 + 1);
    expect(printed(away)).toBe(a0);
    expect(printed(theirs)).toBe(1); // cut by 5, but never below the minimum
  });

  it('grants a keyword to friendly units there until end of turn', () => {
    // Tests Rule 355.10: the battlefield is a chosen target
    const cards = spellWith([{ op: 'BF_AREA', slot: 0, keywords: [{ name: 'Shield', value: 2 }] }]);
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    cast(sc, [bf('bf0')]);
    expect(sc.obj(mine).tempKeywords).toEqual([{ name: 'Shield', value: 2 }]);
  });

  it('needs a battlefield target, and lists one choice per battlefield', () => {
    // Tests Rule 355.10: a spell needs its targets chosen
    const cards = spellWith([{ op: 'BF_AREA', slot: 0, friendlyMight: 1 }]);
    const sc = Scenario.start({}, cards);
    const effects = [{ op: 'BF_AREA', slot: 0, friendlyMight: 1 }] as CardEffect[];
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [])).toBe(false);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [bf('bf0')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [bf('nope')])).toBe(false);
    expect(enumerateSpellTargets(sc.state, cards, 'p0', effects)).toEqual([
      [bf('bf0')],
      [bf('bf1')],
    ]);
  });
});

describe('scenario: moving a chosen unit to a chosen location (Charm, Ride the Wind)', () => {
  const move = (ready: boolean): CardDatabase =>
    spellWith([
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, side: 'any', ...(ready ? { ready } : {}) },
    ]);

  it('moves an enemy unit to a battlefield, then another time back to its Base', () => {
    // Tests Rule 596.2.a: a unit moves when a game effect says so
    const sc = Scenario.start({}, move(false));
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    cast(sc, [obj(enemy), bf('bf0')]);
    expect(sc.obj(enemy).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf0' });

    const sc2 = Scenario.start({}, move(false));
    const e2 = sc2.putUnit('p1', 'fx-tide-grunt', 'bf1');
    cast(sc2, [obj(e2), bf('base')]);
    expect(sc2.obj(e2).zone).toMatchObject({ kind: 'base', player: 'p1' });
  });

  it('readies a moved friendly unit', () => {
    // Tests Rule 596.2.a: a unit moves when a game effect says so
    const sc = Scenario.start({}, move(true));
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'base', { ready: false });
    cast(sc, [obj(mine), bf('bf0')]);
    expect(sc.obj(mine).ready).toBe(true);
    expect(sc.obj(mine).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf0' });
  });

  it('cannot move a unit to where it already is, or from its Base to its Base', () => {
    // Tests Rule 596.1: moving is between two locations
    const cards = move(false);
    const sc = Scenario.start({}, cards);
    const atBf = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    const inBase = sc.putUnit('p0', 'fx-grunt', 'base');
    const effects = [{ op: 'MOVE_TARGET', slot: 0, destSlot: 1 }] as CardEffect[];
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(atBf), bf('bf0')])).toBe(false);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(atBf), bf('bf1')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(atBf), bf('base')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(inBase), bf('base')])).toBe(
      false,
    );
    const picks = enumerateSpellTargets(sc.state, cards, 'p0', effects) ?? [];
    expect(picks).toContainEqual([obj(atBf), bf('base')]);
    expect(picks).not.toContainEqual([obj(atBf), bf('bf0')]);
  });

  it('a friendly unit arriving at an enemy-held battlefield contests it', () => {
    // Tests Rule 190.3: a moved unit contests a battlefield its owner does not control
    const sc = Scenario.start({}, move(false));
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'base');
    expect(sc.bf('bf1').controller).not.toBe('p0');
    cast(sc, [obj(mine), bf('bf1')]);
    expect(sc.obj(mine).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
  });
});
