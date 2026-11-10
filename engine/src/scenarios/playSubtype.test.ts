import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { autoPlan, computeTotalCost } from '../resources.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const text = 'When you play me or another Dragon, give me +2 [M] this turn.';
const trigger = parseCardAbilities(text)?.triggers ?? [];
const def = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;
/** `fx-ash-tank` stands in for Gentle Gemdragon; `fx-archer` is a Dragon, `fx-grunt` is not. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...def('fx-ash-tank'), triggers: trigger },
  'fx-archer': { ...def('fx-archer'), subtypes: ['Dragon'] },
};
const mightOf = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });
function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}
function playUnit(sc: Scenario, cardId: string): string {
  const id = sc.putInHand('p0', cardId);
  sc.play('p0', id, { payment: sc.exhaustPlan('p0', (cards[cardId] as CardDef).cost.energy) });
  settle(sc);
  return id;
}

describe('parser: "When you play me or another Dragon" (Gentle Gemdragon)', () => {
  it('reads as a play trigger for itself plus a subtype-filtered play trigger', () => {
    // Tests Rule 303: parsed trigger text
    expect(trigger.map((t) => t.on)).toEqual(['PLAY', 'YOU_PLAY']);
    expect(trigger[1]).toMatchObject({ playFilter: { subtype: 'Dragon', other: true } });
  });

  it('reads the plain "a Dragon" form too', () => {
    // Tests Rule 303: parsed trigger text
    const t = parseCardAbilities('When you play a Dragon, give me +2 [M] this turn.')?.triggers;
    expect(t?.map((x) => x.on)).toEqual(['YOU_PLAY']);
    expect(t?.[0]).toMatchObject({ playFilter: { subtype: 'Dragon' } });
  });
});

describe('scenario: a play trigger filtered by unit type (Dragon)', () => {
  it('fires when another Dragon is played, not for another type of unit', () => {
    // Tests Rule 303: a triggered ability fires on its event
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 8);
    const watcher = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const before = mightOf(sc, watcher);
    playUnit(sc, 'fx-grunt');
    expect(mightOf(sc, watcher)).toBe(before);
    playUnit(sc, 'fx-archer');
    expect(mightOf(sc, watcher)).toBe(before + 2);
  });

  it('fires when the card itself is played', () => {
    // Tests Rule 303: "When you play me" is the source entering
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 8);
    const me = playUnit(sc, 'fx-ash-tank');
    expect(mightOf(sc, me)).toBe(((cards['fx-ash-tank'] as CardDef).stats.might ?? 0) + 2);
  });
});

describe('scenario: "When you play a card from anywhere other than your hand, empower me" (Heart of the Tempest)', () => {
  const text = 'When you play a card from anywhere other than your hand, empower me.';
  const triggers = parseCardAbilities(text)?.triggers ?? [];

  it('reads a play trigger for cards that did not come from the hand', () => {
    // Tests Rule 303: parsed trigger text
    expect(triggers).toMatchObject([
      { on: 'YOU_PLAY', playFilter: { fromElsewhere: true }, effects: [{ op: 'EMPOWER_SELF' }] },
    ]);
  });

  it('fires for a unit played from the Trash by an effect, not for a card played from the hand', () => {
    // Tests Rule 303: a triggered ability fires on its event
    const playFromTrash = parseSpellText('Play a unit from your trash, ignoring its cost.') ?? [];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': { ...def('fx-ash-tank'), triggers },
      'fx-flare': { ...def('fx-flare'), supportLevel: 'partial', effects: playFromTrash },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 8);
    const watcher = sc.putUnit('p0', 'fx-ash-tank', 'base');
    expect(sc.obj(watcher).empowered).toBeFalsy();
    playUnit(sc, 'fx-grunt'); // from the hand
    expect(sc.obj(watcher).empowered).toBeFalsy();

    // put a unit into the Trash and play it back with the spell
    const dead = sc.putInHand('p0', 'fx-archer');
    const ps = sc.state.players[0] as { hand: string[]; trash: string[] };
    ps.hand = ps.hand.filter((x) => x !== dead);
    ps.trash.push(dead);
    (sc.state.objects[dead] as { zone: unknown }).zone = { kind: 'trash', player: 'p0' };
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: dead }],
    });
    settle(sc);
    expect(sc.obj(watcher).empowered).toBe(true);
  });
});

describe('scenario: "When you play a unit with Might greater than each other unit on the board, exhaust me to draw 1" (Titanic Shrine)', () => {
  const text =
    'When you play a unit with Might greater than each other unit on the board, exhaust me to draw 1.';
  const triggers = parseCardAbilities(text)?.triggers ?? [];

  it('reads an optional exhaust-to-draw gated on the played unit being the mightiest', () => {
    // Tests Rule 303: parsed trigger text
    expect(triggers).toMatchObject([
      {
        on: 'YOU_PLAY',
        playFilter: { type: 'UNIT', mightiest: true },
        optional: { exhaustSelf: true },
        effects: [{ op: 'DRAW', amount: 1 }],
      },
    ]);
  });

  /** p0 has the Shrine (a gear stand-in) out, plays `cardId`; returns whether the draw offer came up. */
  function offered(cardId: string, other?: string): boolean {
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ember-totem': { ...def('fx-ember-totem'), triggers },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 8);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    if (other) sc.putUnit('p1', other, 'base');
    const id = sc.putInHand('p0', cardId);
    const plan = autoPlan(sc.state, cards, 'p0', computeTotalCost(cards[cardId] as CardDef)) ?? [];
    sc.play('p0', id, { payment: plan });
    for (let i = 0; i < 10 && sc.state.flow.chain.length > 0 && !sc.state.flow.pendingChoice; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    return sc.state.flow.pendingChoice?.kind === 'OPTIONAL_EFFECT';
  }

  it('is offered only when the played unit out-Mights every unit on the board', () => {
    // Tests Rule 303: a triggered ability fires on its event
    expect(offered('fx-grunt')).toBe(true); // alone on the board
    expect(offered('fx-grunt', 'fx-order-titan')).toBe(false); // a 7-Might unit is out
    expect(offered('fx-ash-tank', 'fx-tide-grunt')).toBe(true); // 3 Might beats 2
  });
});
