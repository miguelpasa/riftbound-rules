import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, SCENARIO_DECK_A, Scenario } from '../testing/scenario.js';
import { AIController } from '../ai/bot.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeFor } from '../sanitize.js';
import type { CardDatabase, CardDef, CardTrigger, Intent } from '../types/index.js';

/** R44: Battlefield cards have triggers. bf0 is p0's battlefield, bf1 is p1's (fx-bf-1..3 / fx-bf-4..6). */
const BF_IDS = ['fx-bf-1', 'fx-bf-2', 'fx-bf-3', 'fx-bf-4', 'fx-bf-5', 'fx-bf-6'];
const withBattlefieldTriggers = (
  triggers: CardTrigger[],
  extra: CardDatabase = {},
): CardDatabase => {
  const cards: CardDatabase = { ...SCENARIO_CARDS, ...extra };
  for (const id of BF_IDS) {
    cards[id] = { ...(SCENARIO_CARDS[id] as CardDef), supportLevel: 'full', triggers };
  }
  return cards;
};

const toBf = (bfId: string) => ({ kind: 'battlefield' as const, battlefieldId: bfId });

/** p0 moves a ready unit onto the empty bf1 and both pass: p0 Conquers bf1. */
function conquerBf1(sc: Scenario) {
  const unit = sc.putUnit('p0', 'fx-grunt', 'base');
  sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [unit], destination: toBf('bf1') });
  sc.pass('p0');
  return sc.pass('p1');
}

describe('scenario: Battlefield card triggers (R44)', () => {
  it('"When you conquer here" puts one item with the battlefield as source on the Chain, controlled by the conqueror', () => {
    // Tests Rule 473.2: Conquer triggers; the Battlefield card is not an object
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([{ on: 'CONQUER', effects: [{ op: 'DRAW', amount: 1 }] }]),
    );
    conquerBf1(sc);
    expect(sc.state.flow.chain).toHaveLength(1);
    expect(sc.state.flow.chain[0]).toMatchObject({
      kind: 'ABILITY',
      triggered: true,
      sourceBattlefieldId: 'bf1',
      sourceObjectId: '',
      controller: 'p0',
      status: 'FINALIZED',
    });
    expect(sc.state.flow.priority).toBe('p1'); // the controller has implicitly passed
    const hand = sc.player('p0').hand.length;
    const handOpp = sc.player('p1').hand.length;
    sc.pass('p1');
    const r = sc.pass('p0');
    expect(sc.eventsOfType('CARD_DRAWN', r.events)).toHaveLength(1);
    expect(sc.player('p0').hand).toHaveLength(hand + 1);
    expect(sc.player('p1').hand).toHaveLength(handOpp);
    expect(sc.state.flow.chain).toHaveLength(0);
    sc.verify();
  });

  it('fires once per Conquer: a second score of the same battlefield in a turn does not trigger again', () => {
    // Tests Rule 472: a battlefield is scored at most once per player per turn
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([{ on: 'CONQUER', effects: [{ op: 'DRAW', amount: 1 }] }]),
    );
    conquerBf1(sc);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.state.flow.chain).toHaveLength(0);
    // a second unit moves in and the battlefield is not conquered again (already controlled)
    const again = sc.putUnit('p0', 'fx-archer', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [again], destination: toBf('bf1') });
    expect(sc.state.flow.chain).toHaveLength(0);
  });

  it('does not fire the Hold trigger of a battlefield on Conquer, nor another battlefield', () => {
    // Tests Rule 473.2: each trigger kind fires for its own moment
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([{ on: 'HOLD', effects: [{ op: 'DRAW', amount: 1 }] }]),
    );
    conquerBf1(sc);
    expect(sc.state.flow.chain).toHaveLength(0);
  });

  it('still triggers when the Final Point rule denies the point (the Conquer happened)', () => {
    // Tests Rule 473.1.b: at 7 points a lone Conquer draws a card instead of scoring; the trigger is
    // about conquering, so it still fires (UNCLEAR, docs/ASSUMPTIONS.md R44)
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([{ on: 'CONQUER', effects: [{ op: 'DRAW', amount: 1 }] }]),
    );
    sc.setPoints('p0', 7);
    const r = conquerBf1(sc);
    expect(sc.eventsOfType('FINAL_POINT_DENIED_DREW_CARD', r.events)).toHaveLength(1);
    expect(sc.state.flow.chain).toHaveLength(1);
    expect(sc.state.flow.chain[0]).toMatchObject({ sourceBattlefieldId: 'bf1', controller: 'p0' });
  });

  it('"When you hold here" fires in the Beginning Phase for the holder only', () => {
    // Tests Rule 315.2.b: Hold scores in the Beginning Phase; Hold triggers follow
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([{ on: 'HOLD', effects: [{ op: 'GAIN_POINT', amount: 1 }] }]),
    );
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    sc.endTurn('p0');
    sc.endTurn('p1'); // p0's next Beginning Phase
    expect(sc.player('p0').points).toBe(1); // the Hold point
    expect(sc.state.flow.chain).toHaveLength(1);
    expect(sc.state.flow.chain[0]).toMatchObject({ sourceBattlefieldId: 'bf0', controller: 'p0' });
    sc.pass(sc.state.flow.priority!);
    sc.pass(sc.state.flow.priority!);
    expect(sc.player('p0').points).toBe(2);
    expect(sc.player('p1').points).toBe(0);
  });

  it('a "when" condition is read at the battlefield itself (units here, rune deck size)', () => {
    // Tests Rule 315.2.b: Hold; the trigger needs its intervening condition
    const trig: CardTrigger = {
      on: 'HOLD',
      when: { kind: 'COUNT', what: 'unit', where: 'here', who: 'friendly', cmp: 'GTE', n: 2 },
      effects: [{ op: 'GAIN_POINT', amount: 1 }],
    };
    const one = Scenario.start({}, withBattlefieldTriggers([trig]));
    one.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    one.endTurn('p0');
    one.endTurn('p1');
    expect(one.state.flow.chain).toHaveLength(0);
    const two = Scenario.start({}, withBattlefieldTriggers([trig]));
    two.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    two.putUnit('p0', 'fx-archer', 'bf0');
    two.endTurn('p0');
    two.endTurn('p1');
    expect(two.state.flow.chain).toHaveLength(1);
  });

  it('"When you defend here" is controlled by the defender; "attack here" by the attacker', () => {
    // Tests Rule 466.2.c: attacker and defender designations when a combat Showdown starts
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([
        { on: 'DEFEND', effects: [{ op: 'DRAW', amount: 1 }] },
        { on: 'ATTACK', effects: [{ op: 'GAIN_POINT', amount: 1 }] },
      ]),
    );
    sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const att = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [att], destination: toBf('bf1') });
    const items = sc.state.flow.chain.map((i) => [
      i.sourceBattlefieldId,
      i.controller,
      i.triggerIndex,
    ]);
    expect(items).toEqual([
      ['bf1', 'p0', 1], // the turn player's trigger is added first
      ['bf1', 'p1', 0], // so the defender's resolves first
    ]);
  });

  it('a targeted battlefield trigger asks its controller (TRIGGER_TARGET) and uses "here" of the battlefield', () => {
    // Tests Rule 355.10: targets of a triggered ability are chosen as it is put on the Chain
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([
        {
          on: 'DEFEND',
          effects: [
            { op: 'MOVE_BASE_TARGET', side: 'friendly', here: true, count: { min: 0, max: 1 } },
          ],
        },
      ]),
    );
    const d1 = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const d2 = sc.putUnit('p1', 'fx-tide-archer', 'bf1');
    const outsider = sc.putUnit('p1', 'fx-wisp', 'base');
    const att = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [att], destination: toBf('bf1') });
    const pc = sc.state.flow.pendingChoice;
    expect(pc).toMatchObject({ kind: 'TRIGGER_TARGET', player: 'p1' });
    const item = sc.state.flow.chain.find(
      (i) => i.id === (pc as { chainItemId: string }).chainItemId,
    );
    expect(item).toMatchObject({ sourceBattlefieldId: 'bf1', status: 'PENDING', controller: 'p1' });
    // p0 cannot answer; p1's answers are the units HERE (or none), never the unit in the base or an enemy
    const legal = getLegalActions(sc.state, sc.cards, 'p1');
    const picks = legal.flatMap((i) => (i.type === 'CHOOSE_TRIGGER_TARGET' ? [i.targets] : []));
    const ids = picks.flat().map((t) => (t.kind === 'object' ? t.id : ''));
    expect(ids).toContain(d1);
    expect(ids).toContain(d2);
    expect(ids).not.toContain(outsider);
    expect(ids).not.toContain(att);
    expect(picks.some((t) => t.length === 0)).toBe(true); // "you may": decline
    expect(getLegalActions(sc.state, sc.cards, 'p0')).toEqual([]);
    sc.do({
      type: 'CHOOSE_TRIGGER_TARGET',
      playerId: 'p1',
      chainItemId: item!.id,
      targets: [{ kind: 'object', id: d2 }],
    });
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    sc.pass(sc.state.flow.priority!);
    sc.pass(sc.state.flow.priority!);
    expect(sc.obj(d2).zone).toEqual({ kind: 'base', player: 'p1' });
    expect(sc.obj(d1).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    sc.verify();
  });

  it('the bot answers a pending battlefield trigger choice', () => {
    // Tests Rule 355.10: the bot never gets stuck on a pending trigger target
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([
        {
          on: 'DEFEND',
          effects: [
            { op: 'MOVE_BASE_TARGET', side: 'friendly', here: true, count: { min: 0, max: 1 } },
          ],
        },
      ]),
    );
    sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    sc.putUnit('p1', 'fx-tide-archer', 'bf1');
    const att = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [att], destination: toBf('bf1') });
    expect(sc.state.flow.pendingChoice).toMatchObject({ kind: 'TRIGGER_TARGET', player: 'p1' });
    const bot = new AIController('p1', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    const pick = bot.decide(sanitizeFor(sc.state, 'p1'));
    expect(pick).not.toBeNull();
    expect((pick as Intent).type).toBe('CHOOSE_TRIGGER_TARGET');
    expect(sc.tryDo(pick as Intent).ok).toBe(true);
  });

  it('is public information: the opponent sees the battlefield source and no hidden object', () => {
    // Tests Rule 106: hidden information stays hidden; the Battlefield card is public
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([{ on: 'CONQUER', effects: [{ op: 'DRAW', amount: 1 }] }]),
    );
    conquerBf1(sc);
    const view = sanitizeFor(sc.state, 'p1');
    expect(view.flow.chain[0]).toMatchObject({ sourceBattlefieldId: 'bf1', sourceObjectId: '' });
    expect(JSON.stringify(sanitizeFor(sc.state, 'p1').flow)).toBe(
      JSON.stringify(sanitizeFor(sc.state, 'p1').flow),
    );
  });

  it('[Burn N] puts the top cards into the Trash without a Burn Out; each-player Channel; draw per other battlefield', () => {
    // Tests Rule 432: Burn Out only happens when drawing from an empty deck, not when burning
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([
        {
          on: 'CONQUER',
          effects: [
            { op: 'BURN', amount: 2 },
            { op: 'CHANNEL', amount: 1, exhausted: true, eachPlayer: true },
            { op: 'DRAW', amount: 1, perOtherBattlefield: true },
          ],
        },
      ]),
    );
    sc.putUnit('p0', 'fx-archer', 'bf0', { control: true }); // p0 controls the other battlefield
    conquerBf1(sc);
    const deck = sc.player('p0').mainDeck.length;
    const trash = sc.player('p0').trash.length;
    const hand = sc.player('p0').hand.length;
    const runes0 = sc.runes('p0').length;
    const runes1 = sc.runes('p1').length;
    sc.pass('p1');
    const r = sc.pass('p0');
    expect(sc.eventsOfType('CARDS_BURNED', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', count: 2 }),
    ]);
    expect(sc.player('p0').trash).toHaveLength(trash + 2);
    expect(sc.player('p0').mainDeck).toHaveLength(deck - 2 - 1); // 2 burned + 1 drawn (one other battlefield)
    expect(sc.player('p0').hand).toHaveLength(hand + 1);
    expect(sc.eventsOfType('BURN_OUT', r.events)).toHaveLength(0);
    expect(sc.runes('p0')).toHaveLength(runes0 + 1);
    expect(sc.runes('p1')).toHaveLength(runes1 + 1);
    sc.verify();
  });

  it('"you win the game" ends the game for the controller', () => {
    // Tests Rule 194: a card effect can end the game
    const sc = Scenario.start(
      {},
      withBattlefieldTriggers([{ on: 'CONQUER', effects: [{ op: 'WIN_GAME' }] }]),
    );
    conquerBf1(sc);
    sc.pass('p1');
    const r = sc.pass('p0');
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p0');
    expect(sc.eventsOfType('GAME_ENDED', r.events)).toHaveLength(1);
  });
});
