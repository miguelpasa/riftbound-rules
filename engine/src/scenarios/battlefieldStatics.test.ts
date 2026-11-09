import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseStaticLines } from '../cardText.js';
import { scoreBattlefield } from '../scoring.js';
import { reduce } from '../reducer.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;
const statics = (text: string) => parseStaticLines(text)?.statics ?? [];

describe('scenario: Battlefield cards with rule-changing statics', () => {
  it('reads the four static lines', () => {
    // Tests Rule 175: Battlefield cards have standing abilities
    expect(statics("Units can't be played here.")[0]).toMatchObject({ restrict: 'NO_PLAY_HERE' });
    expect(statics("Players can't score here until their third turn.")[0]).toMatchObject({
      restrict: 'NO_EARLY_SCORE',
    });
    expect(statics('Increase the points needed to win the game by 1.')[0]).toMatchObject({
      victoryBonus: 1,
    });
    expect(statics('While a unit here is defending alone, it has -2 [M].')[0]).toMatchObject({
      affects: 'UNITS_HERE',
      onlyDefendingAlone: true,
      might: -2,
    });
  });

  it('refuses to score a battlefield before the third turn (Forgotten Monument)', () => {
    // Tests Rule 472: scoring a battlefield
    const sc0 = Scenario.start({});
    const bf = sc0.state.battlefields[0];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      [bf?.cardId ?? '']: {
        ...base(bf?.cardId ?? ''),
        statics: statics("Players can't score here until their third turn."),
      },
    };
    const early = scoreBattlefield(structuredClone(sc0.state), cards, 'p0', bf?.id ?? '', 'HOLD');
    expect(early.state.players[0]?.points).toBe(0);
    const s5 = structuredClone(sc0.state);
    s5.turn.number = 5;
    const late = scoreBattlefield(s5, cards, 'p0', bf?.id ?? '', 'HOLD');
    expect(late.state.players[0]?.points).toBe(1);
  });

  it('refuses to play a unit to the battlefield (Rockfall Path)', () => {
    // Tests Rule 355.2: the location of a played card
    const sc0 = Scenario.start({});
    const bf =
      sc0.state.battlefields.find((b) => b.controller === 'p0') ?? sc0.state.battlefields[0];
    expect(bf).toBeDefined();
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      [bf?.cardId ?? '']: {
        ...base(bf?.cardId ?? ''),
        statics: statics("Units can't be played here."),
      },
    };
    const sc = Scenario.start({}, cards);
    const mine = sc.state.battlefields.find((b) => b.cardId === bf?.cardId);
    sc.setBattlefield(mine?.id ?? '', { controller: 'p0' });
    const grunt = sc.putInHand('p0', 'fx-grunt');
    const r = reduce(sc.state, cards, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: grunt,
      payment: sc.exhaustPlan('p0', 2),
      location: { kind: 'battlefield', battlefieldId: mine?.id ?? '' },
    });
    expect(r.ok).toBe(false);
  });
});
