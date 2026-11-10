import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { getAbilityActivations, getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

type Activate = Extract<Intent, { type: 'ACTIVATE_ABILITY' }>;
const TEXT =
  '[Reaction][>] Banish a unit or gear from your trash, [E]: [Add] [A]. Spend this Power only to play units or gear.';

function setup(): { sc: Scenario; src: string; fodder: string } {
  const fx = parseCardAbilities(TEXT, { legend: true });
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), abilities: fx?.abilities ?? [] },
    'fx-wisp': { ...(SCENARIO_CARDS['fx-wisp'] as CardDef), cost: { energy: 0, power: 1, domain: [{ element: 'Fury', amount: 1 }] } },
  };
  const sc = Scenario.start({}, cards);
  sc.setRunes('p0', []);
  const src = sc.putUnit('p0', 'fx-ash-tank', 'base');
  const ps = sc.state.players[0] as { hand: string[]; trash: string[] };
  const fodder = ps.hand.find((id) => (sc.state.objects[id] as { cardId: string }).cardId === 'fx-grunt') as string;
  ps.hand = ps.hand.filter((id) => id !== fodder);
  ps.trash.push(fodder);
  (sc.state.objects[fodder] as { zone: unknown }).zone = { kind: 'trash', player: 'p0' };
  return { sc, src, fodder };
}

describe('scenario: "Banish a unit or gear from your trash, [E]: [Add] [A]" (Iron Revenant)', () => {
  it('reads a banish-from-trash cost', () => {
    // Tests Rule 145.1: the part before the colon is the cost
    expect(parseCardAbilities(TEXT, { legend: true })?.abilities[0]?.cost).toEqual({
      card: { kind: 'BANISH', what: 'unitOrGear' },
      exhaust: true,
    });
  });

  it('is offered only with a unit or gear in the Trash, banishes it, and adds restricted Power', () => {
    // Tests Rule 145.1: a cost must be paid in full
    const { sc, src, fodder } = setup();
    const acts = (): Activate[] =>
      getAbilityActivations(sc.state, sc.cards, 'p0').filter(
        (i): i is Activate => i.type === 'ACTIVATE_ABILITY' && i.sourceId === src,
      );
    expect(acts().map((a) => a.costCards)).toEqual([[fodder]]);
    sc.do(acts()[0] as Activate);
    expect(sc.obj(fodder).zone.kind).toBe('banishment');
    expect(sc.player('p0').banishment).toContain(fodder);
    expect(sc.player('p0').runePool.restricted?.[0]?.universal).toBe(1);
    expect(acts()).toEqual([]); // nothing left to banish (and the source is exhausted)
  });

  it('the Power pays for a unit but not for a spell', () => {
    // Tests Rule 168: restricted resources can only be spent on what they allow
    const { sc, src } = setup();
    const a = getAbilityActivations(sc.state, sc.cards, 'p0').find(
      (i): i is Activate => i.type === 'ACTIVATE_ABILITY' && i.sourceId === src,
    );
    sc.do(a as Intent);
    const unit = sc.putInHand('p0', 'fx-wisp');
    (sc.cards as Record<string, CardDef>)['fx-flare'] = {
      ...(sc.cards['fx-flare'] as CardDef),
      cost: { energy: 0, power: 1, domain: [{ element: 'Fury', amount: 1 }] },
    };
    const spell = sc.putInHand('p0', 'fx-flare');
    const offered = (id: string): boolean =>
      getLegalActions(sc.state, sc.cards, 'p0').some(
        (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === id,
      );
    expect(offered(unit)).toBe(true);
    expect(offered(spell)).toBe(false);
  });
});
