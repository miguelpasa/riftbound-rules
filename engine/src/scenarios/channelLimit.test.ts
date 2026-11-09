import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const text =
  "While I'm at a battlefield, players only channel 1 rune at the start of their Channel Phase.";
const statics = parseStaticLines(text)?.statics ?? [];
const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;
/** `fx-grunt` stands in for Sandstone Chimera. */
const chimera: CardDatabase = { ...SCENARIO_CARDS, 'fx-grunt': { ...base('fx-grunt'), statics } };

const runesOf = (sc: Scenario, p: 'p0' | 'p1'): number =>
  sc.state.players[p === 'p0' ? 0 : 1]?.base.filter(
    (id) => sc.cards[sc.state.objects[id]?.cardId ?? '']?.type === 'RUNE',
  ).length ?? 0;

/** Runes `p1` has after its first turn's Channel Phase, with the Chimera at `where`. */
function p1RunesAfterTurn(cards: CardDatabase, where: 'bf1' | 'base' | null): number {
  const sc = Scenario.start({}, cards);
  if (where) sc.putUnit('p0', 'fx-grunt', where, where === 'base' ? {} : { control: true });
  const before = runesOf(sc, 'p1');
  sc.endTurn('p0');
  return runesOf(sc, 'p1') - before;
}

describe('parser: "players only channel 1 rune" (Sandstone Chimera)', () => {
  it('reads as a channel limit that holds while the unit is at a battlefield', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(statics).toEqual([
      { affects: 'SELF', restrict: 'ONE_CHANNEL', when: { kind: 'AT_BATTLEFIELD' } },
    ]);
  });
});

describe('scenario: only one rune is channeled while the Chimera is at a battlefield', () => {
  it("caps every player's Channel Phase at one rune, even the second player's extra one", () => {
    // Tests Rule 487.7: the second player channels extra on their first turn, unless a card limits it
    expect(p1RunesAfterTurn(SCENARIO_CARDS, null)).toBe(3);
    expect(p1RunesAfterTurn(chimera, 'bf1')).toBe(1);
  });

  it('does nothing while it waits in the Base', () => {
    // Tests Rule 584: the static condition ("at a battlefield") must hold
    expect(p1RunesAfterTurn(chimera, 'base')).toBe(3);
  });
});
