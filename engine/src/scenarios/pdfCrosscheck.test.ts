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

describe('scenario: discount order (X5)', () => {
  it('a minimum belongs to its own discount and the player takes the cheaper order', async () => {
    // Tests Rule 560.4.c: Eager Apprentice (-1, min 1) with Sky Splitter (-7): 8 Energy costs 0, not 1
    const { bestDiscountTotal } = await import('../costReduction.js');
    expect(bestDiscountTotal(8, [{ amount: 7 }, { amount: 1, min: 1 }])).toBe(8);
    expect(bestDiscountTotal(8, [{ amount: 1, min: 1 }, { amount: 7 }])).toBe(8);
    expect(bestDiscountTotal(3, [{ amount: 5, min: 1 }])).toBe(2);
    expect(
      bestDiscountTotal(2, [
        { amount: 1, min: 1 },
        { amount: 1, min: 1 },
      ]),
    ).toBe(1);
  });
});

describe('scenario: play a unit from the Trash, ignoring its cost (X5)', () => {
  it('puts the unit on its owner Base without paying, fires CARD_PLAYED and counts for Legion', async () => {
    // Tests Rule 560.1.a: playing "ignoring its cost" sets the base Energy and Power costs to zero
    const { runEffects, spellTargetsLegal } = await import('../effects.js');
    const sc = Scenario.start();
    const titan = sc.putInHand('p0', 'fx-titan');
    const s = structuredClone(sc.state);
    const t = s.objects[titan] as CardInstance;
    s.players[0].hand = s.players[0].hand.filter((x) => x !== titan);
    s.players[0].trash.push(titan);
    t.zone = { kind: 'trash', player: 'p0' };
    const eff = [{ op: 'PLAY_FROM_TRASH' as const }];
    expect(spellTargetsLegal(s, sc.cards, 'p0', eff, [{ kind: 'object', id: titan }])).toBe(true);
    // The Titan costs 5 Energy: a limit of 3 excludes it.
    expect(
      spellTargetsLegal(
        s,
        sc.cards,
        'p0',
        [{ op: 'PLAY_FROM_TRASH', maxEnergy: 3 }],
        [{ kind: 'object', id: titan }],
      ),
    ).toBe(false);
    const ev = runEffects(s, 'p0', eff, sc.cards, [{ kind: 'object', id: titan }]);
    expect((s.objects[titan] as CardInstance).zone.kind).toBe('base');
    expect(s.players[0].trash).not.toContain(titan);
    expect(s.players[0].base).toContain(titan);
    expect(s.players[0].playedThisTurn?.objectIds).toContain(titan);
    expect(ev.some((e) => e.type === 'CARD_PLAYED')).toBe(true);
  });
});

describe('scenario: split damage (X1)', () => {
  const setup = () => {
    const sc = Scenario.start();
    const a = sc.putUnit('p1', sc.kit('p1').grunt, 'bf0');
    const b = sc.putUnit('p1', sc.kit('p1').wisp, 'bf0');
    const c = sc.putUnit('p1', sc.kit('p1').titan, 'bf1');
    return { sc, a, b, c };
  };
  const split = (n: number) => [
    {
      op: 'DAMAGE_TARGET' as const,
      amount: n,
      split: true,
      atBattlefield: true,
      sameBattlefield: true,
      count: { min: 1, max: n },
    },
  ];

  it('only accepts targets at one battlefield', async () => {
    // Tests Rule 559.3.d: each chosen unit is a target of the split
    const { spellTargetsLegal } = await import('../effects.js');
    const { sc, a, b, c } = setup();
    const ids = (...x: string[]) => x.map((id) => ({ kind: 'object' as const, id }));
    expect(spellTargetsLegal(sc.state, sc.cards, 'p0', split(5), ids(a, b))).toBe(true);
    expect(spellTargetsLegal(sc.state, sc.cards, 'p0', split(5), ids(a, c))).toBe(false);
  });

  it('gives every target at least 1, lethal first in pick order, overflow on the last', async () => {
    // Tests Rule 559.3.d.6: each target must receive a valid amount of damage (at least 1)
    const { runEffects } = await import('../effects.js');
    const { sc, a, b } = setup();
    const s = structuredClone(sc.state);
    const might = (id: string) =>
      sc.cards[(s.objects[id] as CardInstance).cardId]?.stats.might ?? 0;
    const ev = runEffects(s, 'p0', split(5), sc.cards, [
      { kind: 'object', id: a },
      { kind: 'object', id: b },
    ]);
    const dealt = ev.flatMap((e) => (e.type === 'EFFECT_DAMAGE' ? [e.amount] : []));
    expect(dealt.reduce((n, x) => n + x, 0)).toBe(5);
    expect(dealt.every((x) => x >= 1)).toBe(true);
    expect((s.objects[a] as CardInstance).damage).toBeGreaterThanOrEqual(Math.min(might(a), 4));
  });

  it('with fewer damage than targets, the later picks stop being targets', async () => {
    // Tests Rule 559.3.d.8: more targets than damage, the controller drops targets
    const { runEffects } = await import('../effects.js');
    const { sc, a, b } = setup();
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ ...split(1)[0] }] as never, sc.cards, [
      { kind: 'object', id: a },
      { kind: 'object', id: b },
    ]);
    expect((s.objects[a] as CardInstance).damage).toBe(1);
    expect((s.objects[b] as CardInstance).damage).toBe(0);
  });
});
