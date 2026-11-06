import { describe, expect, it } from 'vitest';
import { getLegalActions, sanitizeFor } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import {
  moveOptions,
  movableUnitIds,
  type PlayIntent,
  playVariants,
  playableIds,
  primaryAction,
  variantLabel,
} from './interaction';

function setup() {
  const sc = Scenario.start();
  sc.giveRunes('p0', 4);
  const a = sc.putUnit('p0', 'fx-grunt', 'base');
  const b = sc.putUnit('p0', 'fx-ash-tank', 'base');
  sc.setBattlefield('bf0', { controller: 'p0' });
  const hand = sc.putInHand('p0', 'fx-raider');
  const legal = getLegalActions(sc.state, SCENARIO_CARDS, 'p0');
  return { sc, a, b, hand, legal, view: sanitizeFor(sc.state, 'p0') };
}

describe('interaction helpers', () => {
  it('derives play variants per location from legal', () => {
    const { hand, legal, view } = setup();
    const v = playVariants(legal, hand);
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.every((i) => legal.includes(i))).toBe(true);
    expect(playableIds(legal).has(hand)).toBe(true);
    expect(v.map((i) => variantLabel(i, view, SCENARIO_CARDS))).toContain('Play to Base');
  });

  it('matches exact unit sets, falls back to single-unit moves, and yields nothing for illegal sets', () => {
    const { a, b, legal } = setup();
    expect(movableUnitIds(legal).has(a)).toBe(true);
    const single = moveOptions(legal, [a]);
    expect(single.length).toBeGreaterThan(0);
    for (const o of single) {
      expect(o.intents).toHaveLength(1);
      expect(legal).toContain(o.intents[0]);
    }
    const group = moveOptions(legal, [a, b]);
    expect(group.length).toBeGreaterThan(0);
    expect(moveOptions(legal, [])).toEqual([]);
    expect(moveOptions(legal, ['nope'])).toEqual([]);
  });

  it('picks End turn in an open Main phase', () => {
    const { legal, view } = setup();
    expect(primaryAction(view, legal)?.label).toBe('End turn');
    expect(primaryAction(view, [])).toBeNull();
  });
});

describe('Repeat variants (R42)', () => {
  it('keeps the Repeat and plain plays of one spell apart and labels the Repeat one', () => {
    const { hand, view } = setup();
    const base: PlayIntent = {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: hand,
      payment: [],
    };
    const plain = { ...base };
    const rep: PlayIntent = { ...base, additionalCosts: { repeat: true } };
    expect(playVariants([plain, rep], hand)).toHaveLength(2);
    expect(variantLabel(rep, view, SCENARIO_CARDS)).toContain('Repeat');
    expect(variantLabel(plain, view, SCENARIO_CARDS)).not.toContain('Repeat');
  });

  it('offers an Ambush unit in a Showdown, only at a battlefield where I have units (R43, 822)', () => {
    const cards = {
      ...SCENARIO_CARDS,
      'fx-raider': { ...SCENARIO_CARDS['fx-raider']!, keywords: [{ name: 'Ambush' as const }] },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const att = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [att],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    const ambusher = sc.putInHand('p0', 'fx-raider');
    sc.setPool('p0', 2);
    const legal = getLegalActions(sc.state, cards, 'p0');
    const view = sanitizeFor(sc.state, 'p0');
    const variants = playVariants(legal, ambusher);
    expect(variants).toHaveLength(1);
    expect(variantLabel(variants[0]!, view, cards)).toMatch(/^Play to /);
    expect(playableIds(legal).has(ambusher)).toBe(true);
  });
});
