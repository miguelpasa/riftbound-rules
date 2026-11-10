import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { getAbilityActivations, getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

type Activate = Extract<Intent, { type: 'ACTIVATE_ABILITY' }>;
const D = '—';
const SPELLS = `[E]: [Reaction] ${D} [Add] [2]. Use only to play spells.`;

function setup(text: string): { sc: Scenario; src: string } {
  const fx = parseCardAbilities(text);
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), abilities: fx?.abilities ?? [] },
    'fx-flare': { ...(SCENARIO_CARDS['fx-flare'] as CardDef), cost: { energy: 2 } },
    'fx-wisp': { ...(SCENARIO_CARDS['fx-wisp'] as CardDef), cost: { energy: 2 } },
  };
  const sc = Scenario.start({}, cards);
  sc.setRunes('p0', []);
  const src = sc.putUnit('p0', 'fx-ash-tank', 'base');
  return { sc, src };
}
const activate = (sc: Scenario, src: string): void => {
  const a = getAbilityActivations(sc.state, sc.cards, 'p0').find(
    (i): i is Activate => i.type === 'ACTIVATE_ABILITY' && i.sourceId === src,
  );
  expect(a).toBeDefined();
  sc.do(a as Intent);
};
const offered = (sc: Scenario, id: string): boolean =>
  getLegalActions(sc.state, sc.cards, 'p0').some(
    (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === id,
  );

describe('scenario: restricted mana "Use only to play spells" (Lux)', () => {
  it('reads the restriction onto the Add effect', () => {
    // Tests Rule 168: [Add] puts resources in the Rune Pool
    expect(parseCardAbilities(SPELLS)?.abilities[0]?.effects).toEqual([
      { op: 'ADD_ENERGY', amount: 2, only: ['SPELL'] },
    ]);
  });

  it('pays for a spell but not for a unit, and is gone when the pool empties', () => {
    // Tests Rule 168: restricted resources can only be spent on what they allow
    const { sc, src } = setup(SPELLS);
    const spell = sc.putInHand('p0', 'fx-flare');
    const unit = sc.putInHand('p0', 'fx-wisp');
    expect(offered(sc, spell)).toBe(false); // no runes, nothing in the pool
    activate(sc, src);
    expect(offered(sc, spell)).toBe(true);
    expect(offered(sc, unit)).toBe(false); // the Energy is for spells only
    const before = sc.player('p0').hand.length;
    sc.play('p0', spell, { payment: [] });
    expect(sc.player('p0').hand.length).toBe(before - 1);
    expect(sc.player('p0').runePool.restricted ?? []).toEqual([]); // spent
  });
});

describe('scenario: "Spend this Energy only during showdowns" (Scorn of the Moon)', () => {
  const TEXT = '[Reaction][>] [E]: [Add] [1]. Spend this Energy only during showdowns.';

  it('reads the restriction', () => {
    // Tests Rule 168: [Add] puts resources in the Rune Pool
    expect(parseCardAbilities(TEXT)?.abilities[0]?.effects).toEqual([
      { op: 'ADD_ENERGY', amount: 1, only: ['SHOWDOWN'] },
    ]);
  });

  it('is spendable only while a showdown is in progress', () => {
    // Tests Rule 168: restricted resources can only be spent on what they allow
    const { sc, src } = setup(TEXT);
    (sc.cards as Record<string, CardDef>)['fx-flare'] = {
      ...(sc.cards['fx-flare'] as CardDef),
      cost: { energy: 1 },
    };
    const spell = sc.putInHand('p0', 'fx-flare');
    activate(sc, src);
    expect(offered(sc, spell)).toBe(false); // no showdown: the Energy cannot pay for it
    // A showdown: p0 moves a unit onto the enemy-held bf1.
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const att = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [att],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    expect(sc.state.flow.showdown).toBeDefined();
    expect(sc.player('p0').runePool.restricted?.[0]?.energy).toBe(1);
    expect(offered(sc, spell)).toBe(true); // now the restricted Energy pays for the spell
  });
});

describe('scenario: "Use only to play gear or use gear abilities" (Fire Below the Mountain)', () => {
  it('reads the restriction onto the Universal Power', () => {
    // Tests Rule 168: [Add] puts resources in the Rune Pool
    expect(
      parseCardAbilities(`[E]: [Reaction] ${D} [Add] [A]. Use only to play gear or use gear abilities.`)
        ?.abilities[0]?.effects,
    ).toEqual([{ op: 'ADD_POWER', amount: 1, domain: 'ANY', only: ['GEAR', 'GEAR_ABILITY'] }]);
  });
});
