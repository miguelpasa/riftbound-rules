import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

const withTrigger = (id: string, t: CardTrigger): CardDatabase => ({
  ...SCENARIO_CARDS,
  [id]: { ...(SCENARIO_CARDS[id] as CardDef), triggers: [t] },
});
const BUFF2: CardTrigger['effects'] = [{ op: 'BUFF_SELF', amount: 2 }];
const mightOf = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

function settle(sc: Scenario): void {
  for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('scenario: "When I become exhausted / ready / Empowered" (R78)', () => {
  it('fires when the unit pays [E] to exhaust itself', () => {
    // Tests Rule 303: a permanent becoming exhausted is an event abilities can trigger on
    const cards = withTrigger('fx-grunt', { on: 'BECOME_EXHAUSTED', effects: BUFF2 });
    cards['fx-grunt'] = {
      ...(cards['fx-grunt'] as CardDef),
      abilities: [{ cost: { exhaust: true }, effects: [{ op: 'DRAW', amount: 1 }] }],
    };
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setReady(u, true);
    const before = mightOf(sc, u);
    sc.do({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: u,
      abilityIndex: 0,
      payment: [],
    });
    settle(sc);
    expect(mightOf(sc, u)).toBe(before + 2);
    sc.verify();
  });

  it('fires at the Awaken step when an exhausted unit becomes ready', () => {
    // Tests Rule 315.1: the Awaken step readies the active player's permanents
    const sc = Scenario.start({}, withTrigger('fx-grunt', { on: 'BECOME_READY', effects: BUFF2 }));
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setReady(u, false);
    sc.endTurn('p0');
    sc.endTurn('p1'); // p0's turn begins: the unit readies
    settle(sc);
    expect(sc.obj(u).ready).toBe(true);
    expect(sc.obj(u).mightBonus).toBe(2);
  });

  it('does not fire when nothing changes', () => {
    // Tests Rule 303: no state change, no event
    const sc = Scenario.start({}, withTrigger('fx-grunt', { on: 'BECOME_READY', effects: BUFF2 }));
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setReady(u, true);
    const before = mightOf(sc, u);
    sc.endTurn('p0');
    sc.endTurn('p1');
    settle(sc);
    expect(mightOf(sc, u)).toBe(before);
  });

  it('"When I become Empowered" fires for the Empower effect', () => {
    // Tests Rule 303: a permanent becoming Empowered triggers
    const cards = withTrigger('fx-grunt', { on: 'BECOME_EMPOWERED', effects: BUFF2 });
    cards['fx-grunt'] = {
      ...(cards['fx-grunt'] as CardDef),
      abilities: [{ cost: { exhaust: true }, effects: [{ op: 'EMPOWER_SELF' }] }],
    };
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setReady(u, true);
    const before = mightOf(sc, u);
    sc.do({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: u,
      abilityIndex: 0,
      payment: [],
    });
    settle(sc);
    expect(sc.obj(u).empowered).toBe(true);
    expect(mightOf(sc, u)).toBe(before + 2);
  });
});

describe('parser: become triggers (R78)', () => {
  it('reads the heads', () => {
    // Tests Rule 303: parsed trigger text
    const t = (s: string) => parseCardAbilities(s)?.triggers.map((x) => x.on);
    expect(t('When I become exhausted, [Predict].')).toEqual(['BECOME_EXHAUSTED']);
    expect(t('When I become ready, give me +2 [M] this turn.')).toEqual(['BECOME_READY']);
    expect(t('When I become [Empowered], [Predict 2].')).toEqual(['BECOME_EMPOWERED']);
    expect(
      t(
        'When you play me or when I become exhausted, play a 1 [M] Recruit unit token to your base.',
      ),
    ).toEqual(['PLAY', 'BECOME_EXHAUSTED']);
  });
});
