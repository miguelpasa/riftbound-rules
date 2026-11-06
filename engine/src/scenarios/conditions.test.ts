/** R43: conditions on triggers / entering, the MOVE trigger, and temporary keyword grants. */
import { describe, it, expect } from 'vitest';
import { AIController } from '../ai/bot.js';
import { SCENARIO_CARDS, SCENARIO_DECK_A, Scenario } from '../testing/scenario.js';
import { evalCondition } from '../conditions.js';
import { parseCardAbilities, parseCondition, parseSpellText } from '../cardText.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeFor } from '../sanitize.js';
import { effectiveMight } from '../combat.js';
import type {
  CardDatabase,
  CardDef,
  CardEffect,
  CardTrigger,
  Condition,
  Intent,
} from '../types/index.js';

const withGrunt = (patch: Partial<CardDef>): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), ...patch },
});
const toBf = (bfId: string) => ({ kind: 'battlefield' as const, battlefieldId: bfId });
const DRAW1: CardEffect = { op: 'DRAW', amount: 1 };

const ONE_OTHER_HERE: Condition = {
  kind: 'COUNT',
  what: 'unit',
  where: 'here',
  who: 'friendly',
  other: true,
  cmp: 'EQ',
  n: 1,
};

describe('parseCondition (R43)', () => {
  it('parses the supported shapes', () => {
    // Tests Rule 355.10: never half-execute a card; unknown conditions return null
    expect(parseCondition('there is exactly one other unit you control here')).toEqual(
      ONE_OTHER_HERE,
    );
    expect(parseCondition('you control no other units')).toEqual({
      kind: 'COUNT',
      what: 'unit',
      where: 'board',
      who: 'friendly',
      other: true,
      cmp: 'EQ',
      n: 0,
    });
    expect(parseCondition('you control two or more other gear')).toMatchObject({
      what: 'gear',
      cmp: 'GTE',
      n: 2,
      other: true,
    });
    expect(parseCondition('you control three or fewer runes')).toMatchObject({
      what: 'rune',
      cmp: 'LTE',
      n: 3,
    });
    expect(parseCondition('you have one or fewer cards in your hand')).toMatchObject({
      what: 'card',
      where: 'hand',
      cmp: 'LTE',
      n: 1,
    });
    expect(parseCondition('you have two or more other units in your base')).toMatchObject({
      where: 'base',
      cmp: 'GTE',
      n: 2,
    });
    expect(parseCondition('you control another Dragon')).toEqual({
      kind: 'CONTROL_SUBTYPE',
      subtype: 'Dragon',
      other: true,
    });
    expect(parseCondition("I'm at a battlefield")).toEqual({ kind: 'AT_BATTLEFIELD' });
    expect(parseCondition('you control a battlefield')).toBeNull();
    expect(parseCondition('the moon is full')).toBeNull();
  });

  it('puts a condition on a trigger and on the enter-ready flag, else stays partial', () => {
    // Tests Rule 355.10: all-or-nothing parsing; an unknown condition keeps the card partial
    expect(
      parseCardAbilities(
        'When I hold, if there is exactly one other unit you control here, draw 1.',
      )?.triggers,
    ).toEqual([{ on: 'HOLD', effects: [DRAW1], when: ONE_OTHER_HERE }]);
    expect(
      parseCardAbilities('When you play me, draw 1 if you control a Poro.')?.triggers[0]?.when,
    ).toEqual({ kind: 'CONTROL_SUBTYPE', subtype: 'Poro' });
    expect(parseCardAbilities('I enter ready if you control no other units.')).toMatchObject({
      entersReadyWhen: { kind: 'COUNT', cmp: 'EQ', n: 0 },
    });
    expect(parseCardAbilities('When I hold, if the moon is full, draw 1.')).toBeNull();
    expect(parseCardAbilities('When I move, draw 1.')?.triggers).toEqual([
      { on: 'MOVE', effects: [DRAW1] },
    ]);
  });
});

describe('scenario: conditional triggers (R43)', () => {
  const holdCards = (when: Condition) =>
    withGrunt({ triggers: [{ on: 'HOLD', effects: [DRAW1], when } satisfies CardTrigger] });

  it('does not trigger when the condition is false and triggers when it is true', () => {
    // Tests Rule 315.2.b: Hold at the Beginning Phase; the "if" gates the ability
    const run = (extra: boolean) => {
      const sc = Scenario.start({}, holdCards(ONE_OTHER_HERE));
      const bf = sc.state.battlefields[0]!.id;
      sc.putUnit('p0', 'fx-grunt', bf, { control: true });
      if (extra) sc.putUnit('p0', 'fx-ash-tank', bf);
      sc.endTurn('p0');
      sc.endTurn('p1');
      return sc;
    };
    expect(run(false).state.flow.chain.some((i) => i.triggered)).toBe(false);
    const yes = run(true);
    expect(yes.state.flow.chain.filter((i) => i.triggered)).toHaveLength(1);
    yes.verify();
  });

  it('re-checks the condition as the ability resolves (intervening if)', () => {
    // Tests Rule 315.2.b: the Hold trigger resolves with the condition re-evaluated
    const sc = Scenario.start({}, holdCards(ONE_OTHER_HERE));
    const bf = sc.state.battlefields[0]!.id;
    sc.putUnit('p0', 'fx-grunt', bf, { control: true });
    const other = sc.putUnit('p0', 'fx-ash-tank', bf);
    sc.endTurn('p0');
    sc.endTurn('p1');
    expect(sc.state.flow.chain.some((i) => i.triggered)).toBe(true);
    const hand = sc.player('p0').hand.length;
    sc.sendToBase(other);
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.player('p0').hand.length).toBe(hand); // the draw did not happen
  });

  it('"I enter ready if you control no other units" is decided as the unit enters', () => {
    // Tests Rule 359.2.c: Units enter exhausted unless an effect says otherwise
    const none: Condition = { ...ONE_OTHER_HERE, where: 'board', n: 0 };
    const cards = withGrunt({ entersReadyWhen: none });
    const a = Scenario.start({}, cards);
    const lone = a.putInHand('p0', 'fx-grunt');
    a.play('p0', lone, { payment: a.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(a.obj(lone).ready).toBe(true);
    const b = Scenario.start({}, cards);
    b.putUnit('p0', 'fx-ash-tank', 'base');
    const second = b.putInHand('p0', 'fx-grunt');
    b.play('p0', second, { payment: b.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(b.obj(second).ready).toBe(false);
  });

  it('evalCondition counts only public zones and the hand size', () => {
    // Tests Rule 355.10: conditions read no hidden information
    const sc = Scenario.start({}, SCENARIO_CARDS);
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const hand = sc.player('p0').hand.length;
    const cond: Condition = {
      kind: 'COUNT',
      what: 'card',
      where: 'hand',
      who: 'friendly',
      cmp: 'EQ',
      n: hand,
    };
    expect(evalCondition(sc.state, sc.cards, cond, 'p0', u)).toBe(true);
    // The opponent's sanitised view gives the same answer for the hand size.
    const view = sanitizeFor(sc.state, 'p1') as unknown as typeof sc.state;
    expect(evalCondition(view, sc.cards, { ...cond, who: 'enemy' }, 'p1', u)).toBe(true);
    expect(evalCondition(sc.state, sc.cards, { kind: 'AT_BATTLEFIELD' }, 'p0', u)).toBe(false);
  });
});

describe('scenario: "When I move" (R43)', () => {
  it('fires for a unit that moves to a battlefield', () => {
    // Tests Rule 447: a standard move; the trigger comes from the UNIT_MOVED event
    const sc = Scenario.start({}, withGrunt({ triggers: [{ on: 'MOVE', effects: [DRAW1] }] }));
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const hand = sc.player('p0').hand.length;
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [u], destination: toBf('bf0') });
    expect(sc.state.flow.chain.filter((i) => i.triggered)).toHaveLength(1);
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
  });
});

describe('scenario: temporary keyword grants (R43)', () => {
  const GIVE_TANK: CardEffect = {
    op: 'GRANT_KEYWORD_TARGET',
    keywords: [{ name: 'Tank' }],
    side: 'friendly',
  };

  it('parses grants for spells, abilities and groups', () => {
    // Tests Rule 355.10: all-or-nothing parsing of keyword grants
    expect(parseSpellText('Give a friendly unit [Tank] this turn.')).toEqual([GIVE_TANK]);
    expect(parseSpellText('Give a unit [Assault 2] and [Ganking] this turn.')).toEqual([
      {
        op: 'GRANT_KEYWORD_TARGET',
        keywords: [{ name: 'Assault', value: 2 }, { name: 'Ganking' }],
      },
    ]);
    expect(
      parseCardAbilities('When you play me, give your other units here [Shield] this turn.')
        ?.triggers[0]?.effects,
    ).toEqual([{ op: 'GRANT_KEYWORDS', keywords: [{ name: 'Shield' }], to: 'OTHERS_HERE' }]);
    expect(parseSpellText('Give a unit [Flow] this turn.')).toBeNull();
  });

  it('Assault granted this turn adds Might to an attacker and expires in the Ending step', () => {
    // Tests Rule 467: Assault (+N Might as an attacker), granted until end of turn
    const sc = Scenario.start({}, SCENARIO_CARDS);
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setTempKeywords(u, [{ name: 'Assault', value: 2 }]);
    expect(effectiveMight(sc.state, sc.cards, u, { role: 'ATTACKER' })).toBe(4);
    expect(effectiveMight(sc.state, sc.cards, u, { role: 'DEFENDER' })).toBe(2);
    sc.endTurn('p0');
    expect(sc.obj(u).tempKeywords).toBeUndefined();
    sc.verify();
  });

  it('Ganking granted this turn lets a unit move battlefield to battlefield', () => {
    // Tests Rule 144.4.c.1: only Ganking units may move between battlefields
    const sc = Scenario.start({}, SCENARIO_CARDS);
    const u = sc.putUnit('p0', 'fx-grunt', 'bf1');
    const move: Intent = {
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [u],
      destination: toBf('bf0'),
    };
    expect(sc.reject(move).code).toBe('ILLEGAL_MOVE_DESTINATION');
    sc.setTempKeywords(u, [{ name: 'Ganking' }]);
    sc.do(move);
    sc.verify();
  });

  it('a granting trigger gives keywords to the other units here, and the bot copes', () => {
    // Tests Rule 355.10: the group grant needs no choice, so the bot just plays on
    const cards = withGrunt({
      triggers: [
        {
          on: 'PLAY',
          effects: [{ op: 'GRANT_KEYWORDS', keywords: [{ name: 'Shield' }], to: 'OTHERS_HERE' }],
        },
      ],
    });
    const sc = Scenario.start({}, cards);
    const mate = sc.putUnit('p0', 'fx-ash-tank', 'bf1', { control: true });
    const far = sc.putUnit('p0', 'fx-archer', 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: toBf('bf1') });
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(mate).tempKeywords).toEqual([{ name: 'Shield' }]);
    expect(sc.obj(far).tempKeywords).toBeUndefined();
    expect(sc.obj(unit).tempKeywords).toBeUndefined();
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    const pick = bot.decide(sanitizeFor(sc.state, 'p0'));
    expect(pick === null || sc.tryDo(pick).ok).toBe(true);
    expect(getLegalActions(sc.state, sc.cards, 'p0').length).toBeGreaterThan(0);
  });

  it('a targeted grant spell is offered once per friendly unit and applies the keyword', () => {
    // Tests Rule 355.10: a targeted effect needs a legal target; getLegalActions agrees with reduce
    const cards: CardDatabase = { ...SCENARIO_CARDS };
    cards['fx-flare'] = {
      ...(SCENARIO_CARDS['fx-flare'] as CardDef),
      effects: [GIVE_TANK],
    };
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.setPool('p0', 5);
    const legal = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell,
    );
    expect(legal.length).toBe(1); // only friendly units qualify
    sc.do(legal[0]!);
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(a).tempKeywords).toEqual([{ name: 'Tank' }]);
  });
});
