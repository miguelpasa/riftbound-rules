import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { runCleanup } from '../cleanup.js';
import { runEffects } from '../effects.js';
import { getLegalActions } from '../legalActions.js';
import { parseSpellText, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, CardInstance, DeathOffer } from '../types/index.js';

const withOffer = (offer: DeathOffer): CardDatabase => ({
  ...TOKEN_CARDS,
  ...SCENARIO_CARDS,
  'fx-ember-totem': {
    ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef),
    statics: [{ affects: 'FRIENDLY_UNITS', replaceDeath: { offer } }],
  },
});

const BOSS: DeathOffer = {
  cost: { energy: 1 },
  exhaustSource: true,
  spendBuff: true,
  buffedOnly: true,
};

/** A buffed unit with lethal damage and the offering gear, after one Cleanup. */
function setup(offer: DeathOffer): { sc: Scenario; unit: string; totem: string } {
  const sc = Scenario.start({}, withOffer(offer));
  const totem = sc.putUnit('p0', 'fx-ember-totem', 'base');
  const unit = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
  const s = structuredClone(sc.state);
  (s.objects[unit] as CardInstance).buffed = true;
  runEffects(s, 'p0', [{ op: 'KILL_ALL_UNITS' }], sc.cards);
  const cl = runCleanup(s, sc.cards);
  if (!cl.ok) throw new Error(cl.message);
  sc.state = cl.state;
  return { sc, unit, totem };
}

describe('scenario: optional "you may pay ... would die ... instead" (X7)', () => {
  it('pauses the Cleanup and keeps the unit alive until its controller answers', () => {
    // Tests Rule 575: the owner of the object being acted on decides
    const { sc, unit } = setup(BOSS);
    const pc = sc.state.flow.pendingChoice;
    expect(pc?.kind).toBe('DEATH_REPLACE');
    expect((sc.state.objects[unit] as CardInstance).zone.kind).toBe('battlefield');
    expect((sc.state.objects[unit] as CardInstance).damage).toBeGreaterThan(0);
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(legal[0]).toMatchObject({ type: 'DECIDE_REPLACEMENT', accept: false });
    expect(legal.some((i) => i.type === 'DECIDE_REPLACEMENT' && i.accept)).toBe(true);
    expect(getLegalActions(sc.state, sc.cards, 'p1')).toEqual([]);
  });

  it('accepting pays, exhausts the source, spends the buff and recalls the unit', () => {
    // Tests Rule 573: the replacement alters the death; costs are paid on acceptance
    const { sc, unit, totem } = setup(BOSS);
    const energyBefore = sc.player('p0').runePool.energy;
    const accept = getLegalActions(sc.state, sc.cards, 'p0').find(
      (i) => i.type === 'DECIDE_REPLACEMENT' && i.accept,
    );
    if (!accept) throw new Error('no accept listed');
    sc.do(accept);
    const o = sc.state.objects[unit] as CardInstance;
    expect(o.zone.kind).toBe('base');
    expect(o.ready).toBe(false);
    expect(o.damage).toBe(0);
    expect(o.buffed).toBeUndefined();
    expect((sc.state.objects[totem] as CardInstance).ready).toBe(false);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.player('p0').runePool.energy).toBeLessThanOrEqual(energyBefore);
  });

  it('declining lets the unit die', () => {
    // Tests Rule 575: "may" - declining leaves the death unchanged
    const { sc, unit } = setup(BOSS);
    sc.do({ type: 'DECIDE_REPLACEMENT', playerId: 'p0', unitId: unit, accept: false });
    expect((sc.state.objects[unit] as CardInstance).zone.kind).toBe('trash');
    expect(sc.state.flow.pendingChoice).toBeUndefined();
  });

  it('nothing else may happen while the choice is pending', () => {
    // Tests Rule 323: the Cleanup waits for the decision
    const { sc } = setup(BOSS);
    expect(() => sc.do({ type: 'PASS_PRIORITY', playerId: 'p0' })).toThrow(/waiting/);
  });

  it('an offer that cannot be paid is not made, and the unit dies at once', () => {
    // Tests Rule 575: only payable replacements apply
    const { sc, unit } = setup({ ...BOSS, cost: { energy: 99 } });
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect((sc.state.objects[unit] as CardInstance).zone.kind).toBe('trash');
  });

  it('a buffed-only offer is not made for an unbuffed unit', () => {
    // Tests Rule 575: "If a buffed unit you control would die"
    const sc = Scenario.start({}, withOffer(BOSS));
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    const unit = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'KILL_ALL_UNITS' }], sc.cards);
    const cl = runCleanup(s, sc.cards);
    if (!cl.ok) throw new Error(cl.message);
    expect(cl.state.flow.pendingChoice).toBeUndefined();
    expect((cl.state.objects[unit] as CardInstance).zone.kind).toBe('trash');
  });

  it('parses the four cards', () => {
    // Tests Rule 573.1: "instead" marks a replacement effect
    expect(
      parseStaticLines(
        'If a unit here would die during combat, its controller may pay [A][A][A] to heal it, exhaust it, and recall it instead.',
      )?.statics[0],
    ).toEqual({
      affects: 'UNITS_HERE',
      replaceDeath: { offer: { cost: { anyPower: 3 }, combatOnly: true } },
    });
    const boss = parseStaticLines(
      'If a buffed unit you control would die, you may pay [C], exhaust me, and spend its buff to heal it, exhaust it, and recall it instead. When you conquer, ready me.',
    );
    expect(boss?.statics[0]).toMatchObject({
      affects: 'FRIENDLY_UNITS',
      replaceDeath: { offer: { cost: { power: 1 }, exhaustSource: true, spendBuff: true } },
    });
    expect(boss?.rest).toBe('When you conquer, ready me');
    expect(
      parseStaticLines(
        'Once each turn, if I would die, you may kill a friendly unit to heal me, exhaust me, and recall me instead.',
      )?.statics[0],
    ).toMatchObject({ affects: 'SELF', replaceDeath: { offer: { oncePerTurn: true } } });
    expect(
      parseSpellText(
        'Choose a friendly unit. The next time it would die this turn, you may pay [C] to heal it, exhaust it, and recall it instead.',
      ),
    ).toEqual([
      { op: 'DEATH_REPLACE_TARGET', mode: 'RECALL', offer: { power: 1 }, side: 'friendly' },
    ]);
  });
});
