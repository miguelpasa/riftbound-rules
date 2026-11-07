import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const retreat: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [{ op: 'RETURN_TARGET' }, { op: 'TARGET_OWNER_CHANNEL', amount: 1 }],
  },
};

describe('scenario: return a unit, its owner channels (R90)', () => {
  it('the owner of the returned unit channels one exhausted rune', () => {
    // Tests Rule 431: channeling puts a rune from the Rune Deck into play
    const sc = Scenario.start({}, retreat);
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const before = sc.runes('p1').length;
    const mineBefore = sc.runes('p0').length;
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: theirs }],
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(theirs).zone.kind).toBe('hand');
    const after = sc.runes('p1');
    expect(after.length).toBe(before + 1);
    expect(after.some((r) => !r.ready)).toBe(true);
    expect(sc.runes('p0').length).toBe(mineBefore); // the caster's runes are unchanged
    sc.verify();
  });

  it('does nothing when the return fizzled (no legal unit)', () => {
    // Tests Rule 355.10: a spell with no legal target cannot be played
    const sc = Scenario.start({}, retreat);
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: spell,
        payment: sc.exhaustPlan('p0', 1),
      }).code,
    ).toBeDefined();
  });
});

describe('parser: owner channels (R90)', () => {
  it('attaches to the previous return', () => {
    // Tests Rule 431: parsed text
    expect(
      parseSpellText(
        "Return a friendly unit to its owner's hand. Its owner channels 1 rune exhausted.",
      ),
    ).toEqual([
      { op: 'RETURN_TARGET', side: 'friendly' },
      { op: 'TARGET_OWNER_CHANNEL', amount: 1 },
    ]);
    expect(parseSpellText('Its owner channels 1 rune exhausted.')).toBeNull();
  });
});
