/** R43: [Ambush] (822): a Unit with Ambush may be played as a Reaction to a battlefield with your units. */
import { describe, it, expect } from 'vitest';
import { AIController } from '../ai/bot.js';
import { SCENARIO_CARDS, SCENARIO_DECK_A, Scenario } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeFor } from '../sanitize.js';
import type { CardDatabase, CardDef, Intent, PlayCardIntent } from '../types/index.js';

const withAmbush = (...ids: string[]): CardDatabase => {
  const db: CardDatabase = { ...SCENARIO_CARDS };
  for (const id of ids.length ? ids : ['fx-raider']) {
    db[id] = { ...(SCENARIO_CARDS[id] as CardDef), keywords: [{ name: 'Ambush' }] };
  }
  return db;
};

const toBf = (bfId: string) => ({ kind: 'battlefield' as const, battlefieldId: bfId });

/** p0 attacks bf1 (held by p1) with a grunt; the combat Showdown is open and p0 has Priority. */
function showdownSetup(cards: CardDatabase) {
  const sc = Scenario.start({}, cards);
  sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
  const att = sc.putUnit('p0', 'fx-grunt', 'base');
  sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [att], destination: toBf('bf1') });
  return { sc, att };
}

describe('scenario: Ambush (822)', () => {
  it('plays to a battlefield with my units during a Showdown, at an enemy-held battlefield', () => {
    // Tests Rule 822: Ambush lets the Unit be played as a Reaction to a battlefield where you have units
    const { sc } = showdownSetup(withAmbush());
    expect(sc.state.flow.showdown ?? sc.state.flow.combat).toBeTruthy();
    const ambusher = sc.putInHand('p0', 'fx-raider');
    sc.setPool('p0', 2);
    sc.play('p0', ambusher, { location: toBf('bf1'), payment: [] });
    expect(sc.state.flow.chain).toHaveLength(0); // units resolve at once (337.2)
    expect(sc.obj(ambusher).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    expect(sc.obj(ambusher).ready).toBe(false); // 359.2.c
    sc.verify();
  });

  it('the same unit without Ambush cannot be played in a Showdown', () => {
    // Tests Rule 308.1.a: only Action or Reaction cards in a Showdown State
    const { sc } = showdownSetup(SCENARIO_CARDS);
    const plain = sc.putInHand('p0', 'fx-raider');
    sc.setPool('p0', 2);
    const r = sc.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: plain,
      location: toBf('bf1'),
      payment: [],
    });
    expect(['WRONG_PHASE', 'ILLEGAL_LOCATION']).toContain(r.code);
  });

  it('is refused at a battlefield where I have no units, and at the Base, in a Showdown', () => {
    // Tests Rule 822: the Reaction permission is tied to a battlefield where you have units
    const { sc } = showdownSetup(withAmbush());
    const ambusher = sc.putInHand('p0', 'fx-raider');
    sc.setPool('p0', 2);
    const base: PlayCardIntent = {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: ambusher,
      payment: [],
    };
    // bf2 has none of my units: no Reaction speed, so the Showdown timing rule refuses it
    expect(sc.reject({ ...base, location: toBf('bf0') }).code).toBe('WRONG_PHASE');
    expect(sc.reject({ ...base, location: { kind: 'base' } }).code).toBe('WRONG_PHASE');
  });

  it('still needs Priority: the opponent cannot ambush on my turn out of order', () => {
    // Tests Rule 312.1: a card can only be played with Priority
    const { sc } = showdownSetup(withAmbush('fx-tide-grunt'));
    sc.putUnit('p1', 'fx-tide-archer', 'bf1');
    const theirs = sc.putInHand('p1', 'fx-tide-grunt');
    sc.setPool('p1', 2);
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p1',
        cardInstanceId: theirs,
        location: toBf('bf1'),
        payment: [],
      }).code,
    ).toBe('NOT_YOUR_PRIORITY');
  });

  it('is offered by getLegalActions in a Showdown and the bot answers legally', () => {
    // Tests Rule 822: legal-action enumeration agrees with the validator
    const { sc } = showdownSetup(withAmbush());
    const ambusher = sc.putInHand('p0', 'fx-raider');
    sc.setPool('p0', 2);
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(
      legal.some(
        (i) =>
          i.type === 'PLAY_CARD' &&
          i.cardInstanceId === ambusher &&
          i.location?.kind === 'battlefield' &&
          i.location.battlefieldId === 'bf1',
      ),
    ).toBe(true);
    expect(legal.some((i) => i.type === 'PLAY_CARD' && i.location?.kind === 'base')).toBe(false);
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    const pick = bot.decide(sanitizeFor(sc.state, 'p0'));
    expect(pick).not.toBeNull();
    expect(sc.tryDo(pick as Intent).ok).toBe(true);
  });
});
