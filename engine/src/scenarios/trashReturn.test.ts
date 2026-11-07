import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const withCards = (patch: Record<string, Partial<CardDef>>): CardDatabase => {
  const out: CardDatabase = { ...SCENARIO_CARDS };
  for (const [id, p] of Object.entries(patch)) {
    out[id] = { ...(SCENARIO_CARDS[id] as CardDef), ...p };
  }
  return out;
};

/** Move an object to its owner's Trash (test helper). */
function toTrash(sc: Scenario, id: string): void {
  const o = sc.obj(id);
  const ps = sc.state.players[o.owner === 'p0' ? 0 : 1] as (typeof sc.state.players)[number];
  ps.hand = ps.hand.filter((x) => x !== id);
  ps.base = ps.base.filter((x) => x !== id);
  ps.mainDeck = ps.mainDeck.filter((x) => x !== id);
  ps.trash.push(id);
  o.zone = { kind: 'trash', player: o.owner };
}

const returning = (effect: CardEffect): CardDatabase =>
  withCards({ 'fx-grunt': { triggers: [{ on: 'PLAY', effects: [effect] }] } });

function playGrunt(sc: Scenario): void {
  const grunt = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', grunt, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
}

describe('scenario: return a card from the Trash to the hand (R75)', () => {
  it('returns the only matching unit from the Trash to the hand', () => {
    // Tests Rule 160: a card in the Trash may be returned to its owner's hand by an effect
    const sc = Scenario.start({}, returning({ op: 'RETURN_FROM_TRASH', what: 'unit' }));
    const dead = sc.putInHand('p0', 'fx-ash-tank');
    toTrash(sc, dead);
    playGrunt(sc);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(dead).zone.kind).toBe('hand');
    expect(sc.player('p0').hand).toContain(dead);
    expect(sc.player('p0').trash).not.toContain(dead);
    sc.verify();
  });

  it("only offers cards of the asked kind and subtype from the controller's own Trash", () => {
    // Tests Rule 160: the controller picks among their own Trash cards of the right kind
    const sc = Scenario.start({}, returning({ op: 'RETURN_FROM_TRASH', what: 'spell' }));
    const unit = sc.putInHand('p0', 'fx-ash-tank');
    const spell = sc.putInHand('p0', 'fx-flare');
    toTrash(sc, unit);
    toTrash(sc, spell);
    const theirs = sc.putInHand('p1', 'fx-tide-surge');
    toTrash(sc, theirs);
    playGrunt(sc);
    // Exactly one legal choice (the Flare): taken automatically.
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(spell).zone.kind).toBe('hand');
    expect(sc.obj(unit).zone.kind).toBe('trash');
    expect(sc.obj(theirs).zone.kind).toBe('trash');
  });

  it('a subtype list accepts any of the named subtypes', () => {
    // Tests Rule 160: "a Bird, Cat, Dog, or Poro" means any one of them
    const cards = withCards({
      'fx-grunt': {
        triggers: [
          { on: 'PLAY', effects: [{ op: 'RETURN_FROM_TRASH', what: 'unit', subtypes: ['Zzz'] }] },
        ],
      },
      'fx-ash-tank': { subtypes: ['Zzz'] },
    });
    const sc = Scenario.start({}, cards);
    const match = sc.putInHand('p0', 'fx-ash-tank');
    toTrash(sc, match);
    playGrunt(sc);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(match).zone.kind).toBe('hand');
  });

  it('does nothing without a legal card in the Trash', () => {
    // Tests Rule 160: with no legal target the ability is skipped
    const sc = Scenario.start({}, returning({ op: 'RETURN_FROM_TRASH', what: 'gear' }));
    playGrunt(sc);
    expect(sc.state.flow.chain.filter((i) => i.triggered)).toHaveLength(0);
  });
});

describe('parser: Trash returns, buff several, ready enemies (R75)', () => {
  const t = (s: string) => parseCardAbilities(s)?.triggers[0]?.effects;

  it('reads Trash returns for units, gear, spells and subtype lists', () => {
    // Tests Rule 160: parsed effect text
    expect(t('When you play me, return a gear from your trash to your hand.')).toEqual([
      { op: 'RETURN_FROM_TRASH', what: 'gear' },
    ]);
    expect(
      t('When you play me, return a Bird, Cat, Dog, or Poro from your trash to your hand.'),
    ).toEqual([
      { op: 'RETURN_FROM_TRASH', what: 'unit', subtypes: ['Bird', 'Cat', 'Dog', 'Poro'] },
    ]);
    expect(parseSpellText('Return a unit from your trash to your hand.')).toEqual([
      { op: 'RETURN_FROM_TRASH', what: 'unit' },
    ]);
    expect(t('When I hold, you may return a unit or gear from your trash to your hand.')).toEqual([
      { op: 'RETURN_FROM_TRASH', what: 'unitOrGear', count: { min: 0, max: 1 } },
    ]);
  });

  it('reads "buff up to N (other) friendly units", "ready all enemy units", "ready a friendly legend"', () => {
    // Tests Rule 303: parsed effect text
    expect(t('When you play me, buff up to two other friendly units.')).toEqual([
      {
        op: 'BUFF_TARGET',
        amount: 1,
        buff: true,
        side: 'friendly',
        count: { min: 0, max: 2 },
        another: true,
      },
    ]);
    expect(t('When you play me, ready all enemy units.')).toEqual([
      { op: 'READY_ALL', side: 'enemy' },
    ]);
    expect(t('When you play me, ready a friendly legend.')).toEqual([{ op: 'READY_LEGEND' }]);
  });
});
