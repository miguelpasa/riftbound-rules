import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { runEffects } from '../effects.js';
import { liveTargets, trackTargetGens } from '../targetGens.js';
import type { CardDatabase, CardDef, CardInstance, ChainItem, GameState } from '../types/index.js';

const itemFor = (id: string): ChainItem =>
  ({
    id: 'c1',
    kind: 'CARD',
    sourceObjectId: 'o0',
    controller: 'p0',
    status: 'FINALIZED',
    targets: [{ kind: 'object', id }],
    choices: {},
  }) as unknown as ChainItem;

function withItem(s: GameState, id: string): GameState {
  const w = structuredClone(s);
  w.flow.chain = [itemFor(id)];
  return w;
}

const moved = (s: GameState, id: string, zone: CardInstance['zone']): GameState => {
  const w = structuredClone(s);
  (w.objects[id] as CardInstance).zone = zone;
  return w;
};

describe('scenario: targets that change zones are new objects (X3)', () => {
  it('a target that leaves the Board and returns is no longer a legal target', () => {
    // Tests Rule 563.2.c.4: returning to its original zone does not make it the same object
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const a = withItem(sc.state, u);
    const b = trackTargetGens(a, moved(a, u, { kind: 'hand', player: 'p0' }));
    expect((b.objects[u] as CardInstance).gen).toBe(1);
    const c = trackTargetGens(b, moved(b, u, { kind: 'base', player: 'p0' }));
    expect(liveTargets(c, c.flow.chain[0] as ChainItem)).toEqual([{ kind: 'object', id: '#gone' }]);
  });

  it('moving between the base and a battlefield keeps it the same object', () => {
    // Tests Rule 563.2.c.3: ceasing to meet the requirements and meeting them again is still legal
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const a = withItem(sc.state, u);
    const b = trackTargetGens(
      a,
      moved(a, u, { kind: 'battlefield', player: 'p0', battlefieldId: 'bf0' }),
    );
    expect((b.objects[u] as CardInstance).gen).toBeUndefined();
    expect(liveTargets(b, b.flow.chain[0] as ChainItem)).toEqual([{ kind: 'object', id: u }]);
  });

  it('an item created after the object already changed zones records its generation', () => {
    // Tests Rule 563.2.c.4: only a change after the target was chosen invalidates it
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const before = structuredClone(sc.state);
    (before.objects[u] as CardInstance).gen = 2;
    const after = withItem(before, u);
    const out = trackTargetGens(before, after);
    const item = out.flow.chain[0] as ChainItem;
    expect(item.targetGens).toEqual({ [u]: 2 });
    expect(liveTargets(out, item)).toEqual([{ kind: 'object', id: u }]);
  });

  it('a stale target takes no damage but the spell still resolves its other instructions', () => {
    // Tests Rule 563.2.c.5: unaffected targets, the rest of the spell still happens
    const sc = Scenario.start();
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const s = structuredClone(sc.state);
    const item = itemFor(u);
    item.targetGens = { [u]: 0 };
    (s.objects[u] as CardInstance).gen = 1;
    const handBefore = s.players[0].hand.length;
    runEffects(
      s,
      'p0',
      [
        { op: 'DAMAGE_TARGET', amount: 2 },
        { op: 'DRAW', amount: 1 },
      ],
      sc.cards,
      liveTargets(s, item),
    );
    expect((s.objects[u] as CardInstance).damage).toBe(0);
    expect(s.players[0].hand.length).toBe(handBefore + 1);
  });

  it('information about a target that left the Board reads zero (563.2.c.8)', () => {
    // Tests Rule 563.2.c.8: a unit that is no longer on the board is treated as having 0 Might
    const sc = Scenario.start();
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const theirs = sc.putUnit('p1', 'fx-order-tank', 'base');
    const effects = [
      {
        op: 'DAMAGE_TARGET' as const,
        amount: 0,
        amountFrom: 'SLOT_MIGHT' as const,
        amountSlot: 0,
        slot: 1,
      },
    ];
    const targets = [
      { kind: 'object' as const, id: mine },
      { kind: 'object' as const, id: theirs },
    ];
    const alive = structuredClone(sc.state);
    runEffects(alive, 'p0', effects, sc.cards, targets);
    expect((alive.objects[theirs] as CardInstance).damage).toBe(3);
    const gone = moved(sc.state, mine, { kind: 'trash', player: 'p0' });
    runEffects(gone, 'p0', effects, sc.cards, targets);
    expect((gone.objects[theirs] as CardInstance).damage).toBe(0);
  });
});

describe('scenario: a bounced and replayed target through reduce (X3)', () => {
  it('the original spell does nothing to a unit that left and came back', () => {
    // Tests Rule 563.2.c.4: a target that changes zones and returns is not treated as the same object
    const cards: CardDatabase = {
      ...TOKEN_CARDS,
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        effects: [{ op: 'DAMAGE_TARGET', amount: 2, side: 'enemy' }],
      },
      'fx-tide-guard': {
        ...(SCENARIO_CARDS['fx-tide-guard'] as CardDef),
        effects: [{ op: 'RETURN_TARGET', side: 'friendly' }],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 4);
    sc.giveRunes('p1', 4);
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    const guard = sc.putInHand('p1', 'fx-tide-guard');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: u }],
    });
    sc.play('p1', guard, {
      payment: sc.exhaustPlan('p1', 1),
      targets: [{ kind: 'object', id: u }],
    });
    sc.pass('p0'); // p0 passes: the Tidal Guard resolves and returns the unit to p1's hand
    sc.pass('p1');
    expect((sc.state.objects[u] as CardInstance).zone.kind).toBe('hand');
    expect((sc.state.objects[u] as CardInstance).gen).toBe(1);
    // p1 replays the unit (set up directly: nothing else may be played while the Chain is open)
    const o = sc.state.objects[u] as CardInstance;
    o.zone = { kind: 'base', player: 'p1' };
    sc.state.players[1].hand = sc.state.players[1].hand.filter((x) => x !== u);
    sc.state.players[1].base.push(u);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.state.flow.chain).toHaveLength(0);
    expect((sc.state.objects[u] as CardInstance).damage).toBe(0);
  });

  it('control: without the bounce the same spell deals its damage', () => {
    // Tests Rule 563.2.c.5: a legal target is affected
    const cards: CardDatabase = {
      ...TOKEN_CARDS,
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        effects: [{ op: 'DAMAGE_TARGET', amount: 2, side: 'enemy' }],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 4);
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: u }],
    });
    sc.pass('p1');
    sc.pass('p0');
    expect((sc.state.objects[u] as CardInstance).damage).toBe(2);
  });
});
