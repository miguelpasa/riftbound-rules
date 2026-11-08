/** X10-X12 from the 2025-06-02 Core Rules cross-check. */
import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { runCleanup } from '../cleanup.js';
import { runEffects } from '../effects.js';
import { sanitizeFor } from '../sanitize.js';
import { TOKEN_CARDS } from '../tokens.js';
import type { CardDatabase, CardInstance } from '../types/index.js';

describe('scenario: zone changes clear temporary state (X12)', () => {
  it('a unit killed with a Buff, a Might bonus and a granted keyword keeps none of them in the Trash', () => {
    // Tests Rule 109: temporary modifications stop being tracked when an object leaves the Board
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const s = structuredClone(sc.state);
    const o = s.objects[u] as CardInstance;
    o.buffed = true;
    o.tempMight = 3;
    o.tempKeywords = [{ name: 'Tank' }];
    o.stunned = true;
    runEffects(s, 'p0', [{ op: 'KILL_ALL_UNITS' }], sc.cards);
    const cl = runCleanup(s, sc.cards);
    if (!cl.ok) throw new Error(cl.message);
    const dead = cl.state.objects[u] as CardInstance;
    expect(dead.zone.kind).toBe('trash');
    expect(dead.buffed).toBeUndefined();
    expect(dead.tempMight).toBeUndefined();
    expect(dead.tempKeywords).toBeUndefined();
    expect(dead.stunned).toBeUndefined();
    expect(dead.damage).toBe(0);
  });
});

describe('scenario: face-down cards are revealed when the game ends (X11)', () => {
  it('the opponent cannot see a facedown card during play but can after the game', () => {
    // Tests Rule 597.4: a facedown card is revealed to all players if the game ends
    const sc = Scenario.start();
    sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const hidden = sc.putInHand('p0', sc.kit('p0').lurker);
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: hidden, battlefieldId: 'bf0' });
    const during = sanitizeFor(sc.state, 'p1');
    expect(during.objects[hidden]).toBeUndefined();
    const over = structuredClone(sc.state);
    over.gameStatus = 'FINISHED';
    over.winner = 'p0';
    const after = sanitizeFor(over, 'p1');
    expect((after.objects[hidden] as CardInstance).cardId).toBe(sc.kit('p0').lurker);
  });
});

describe('scenario: Reaction [Add] abilities during a Closed state (X10)', () => {
  it('a Gold token can be used in response to a spell and adds Power at once', () => {
    // Tests Rule 605.3: Reaction abilities that Add resources can be activated while a chain exists
    const cards: CardDatabase = { ...SCENARIO_CARDS, ...TOKEN_CARDS };
    const sc = Scenario.start({}, cards);
    const s = structuredClone(sc.state);
    const before = new Set(Object.keys(s.objects));
    runEffects(s, 'p1', [{ op: 'PLAY_TOKEN', token: 'tok-gold', count: 1, ready: true }], cards);
    sc.state = s;
    const gold = Object.keys(s.objects).find((id) => !before.has(id)) as string;
    sc.giveRunes('p0', 2);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
    expect(sc.state.flow.chain.length).toBeGreaterThan(0);
    sc.do({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p1',
      sourceId: gold,
      abilityIndex: 0,
      payment: [],
    });
    expect(sc.player('p1').runePool.universal).toBe(1);
  });
});
