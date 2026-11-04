import { describe, expect, it, vi } from 'vitest';
import { defaultShowdownDeps, needsCleanup, runCleanup } from './cleanup.js';
import type { CleanupDeps } from './cleanup.js';
import { FIXTURE_CARDS, makeTestGame } from './testing/fixtures.js';
import { MAX_CLEANUP_ITERATIONS } from './types/index.js';
import type { ChainItem, GameEvent, GameState, PlayerId, ReduceResult } from './types/index.js';

function ok(r: ReduceResult): { state: GameState; events: GameEvent[] } {
  if (!r.ok) throw new Error(r.message);
  return r;
}

/** Move a deck object of `cardId` owned by `owner` to `zone`; returns its id. */
function place(
  s: GameState,
  cardId: string,
  owner: PlayerId,
  where: { bf: string } | 'base',
): string {
  const o = Object.values(s.objects).find(
    (x) =>
      (cardId === 'unit'
        ? FIXTURE_CARDS[x.cardId]?.type === 'UNIT' &&
          FIXTURE_CARDS[x.cardId]?.keywords.length === 0 &&
          FIXTURE_CARDS[x.cardId]?.stats.might === 2
        : x.cardId === cardId) &&
      x.owner === owner &&
      x.zone.kind === 'mainDeck',
  );
  if (!o) throw new Error(`no ${cardId}`);
  const p = s.players[owner === 'p0' ? 0 : 1];
  p.mainDeck = p.mainDeck.filter((i) => i !== o.id);
  if (where === 'base') {
    o.zone = { kind: 'base', player: owner };
    p.base.push(o.id);
  } else {
    o.zone = { kind: 'battlefield', player: owner, battlefieldId: where.bf };
  }
  return o.id;
}

function game(): GameState {
  const s = makeTestGame('cleanup');
  s.flow.priority = 'p0';
  return s;
}
const bfId = (s: GameState, i = 0): string => (s.battlefields[i] as { id: string }).id;
const types = (evs: GameEvent[]): string[] => evs.map((e) => e.type);
const run = (s: GameState, deps?: CleanupDeps) => ok(runCleanup(s, FIXTURE_CARDS, deps));

describe('runCleanup', () => {
  it('kills units with lethal damage', () => {
    // Tests Rule 323.4: units with lethal damage are killed during Cleanup
    const s = game();
    const id = place(s, 'unit', 'p0', 'base');
    (s.objects[id] as { damage: number }).damage = 2;
    const r = run(s);
    expect(r.events.map((e) => e.type)).toContain('UNIT_KILLED');
    expect(r.state.objects[id]?.zone.kind).toBe('trash');
    expect(r.state.flow.cleanupIterations).toBe(0);
  });

  it('keeps units with non-lethal damage', () => {
    // Tests Rule 323.4: only lethal damage kills
    const s = game();
    const id = place(s, 'unit', 'p0', 'base');
    (s.objects[id] as { damage: number }).damage = 1;
    expect(run(s).state.objects[id]?.zone.kind).toBe('base');
  });

  it('removes control when the controller has no units there', () => {
    // Tests Rule 323.5: a battlefield without its controller's units becomes uncontrolled
    const s = game();
    (s.battlefields[0] as { controller: PlayerId | null }).controller = 'p0';
    const r = run(s);
    expect(r.state.battlefields[0]?.controller).toBeNull();
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'BATTLEFIELD_CONTROL_CHANGED', controller: null }),
    );
  });

  it('keeps control while the controller has a unit there', () => {
    // Tests Rule 323.5: control stays while units remain
    const s = game();
    const b = bfId(s);
    (s.battlefields[0] as { controller: PlayerId | null }).controller = 'p0';
    place(s, 'unit', 'p0', { bf: b });
    expect(run(s).state.battlefields[0]?.controller).toBe('p0');
  });

  it('starts a staged Showdown for a contested battlefield; the applier gets Focus', () => {
    // Tests Rule 323.11: the turn player starts the staged Showdown; applier gets Focus (345)
    const s = game();
    const b = bfId(s);
    place(s, 'unit', 'p1', { bf: b });
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p1';
    const r = run(s);
    expect(r.state.flow.showdown).toMatchObject({ battlefieldId: b, isCombat: false });
    expect(r.state.flow.focus).toBe('p1');
    expect(r.state.flow.priority).toBe('p1');
    expect(r.state.flow.stagedShowdowns).toEqual([]);
    expect(r.state.turnState.kind).toBe('SHOWDOWN');
    expect(types(r.events)).toContain('SHOWDOWN_STARTED');
  });

  it('starts a combat when both players have units; attacker is contestedBy', () => {
    // Tests Rule 323.12: a staged Combat starts in a Neutral Open state
    const s = game();
    const b = bfId(s);
    place(s, 'unit', 'p0', { bf: b });
    place(s, 'unit', 'p1', { bf: b });
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
    const r = run(s);
    expect(r.state.flow.combat).toMatchObject({ battlefieldId: b, attacker: 'p0', defender: 'p1' });
    expect(r.state.flow.showdown).toMatchObject({ isCombat: true });
    expect(r.state.flow.stagedCombats).toEqual([]);
    expect(r.state.flow.stagedShowdowns).toEqual([]);
  });

  it('a staged Combat takes precedence over a staged Showdown at the same battlefield', () => {
    // Tests Rule 323.13: the Showdown there becomes a Combat Showdown
    const s = game();
    const b = bfId(s);
    place(s, 'unit', 'p0', { bf: b });
    place(s, 'unit', 'p1', { bf: b });
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p1';
    const r = run(s);
    expect(r.state.flow.showdown?.isCombat).toBe(true);
    expect(r.state.flow.combat?.attacker).toBe('p1');
  });

  it('starts the Showdown on the lowest-index battlefield first', () => {
    // Tests Rule 323.11: deterministic choice among several staged Showdowns
    const s = game();
    for (const i of [1, 0]) {
      place(s, 'unit', 'p0', { bf: bfId(s, i) });
      (s.battlefields[i] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
    }
    const r = run(s);
    expect(r.state.flow.showdown?.battlefieldId).toBe(bfId(s, 0));
    expect(r.state.flow.stagedShowdowns).toEqual([bfId(s, 1)]);
  });

  it('does not start a Showdown in a Closed state', () => {
    // Tests Rule 323.11: only in a Neutral Open state
    const s = game();
    place(s, 'unit', 'p0', { bf: bfId(s) });
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
    s.flow.chain.push({ id: 'c1', kind: 'CARD', controller: 'p0' } as ChainItem);
    const r = run(s);
    expect(r.state.flow.showdown).toBeUndefined();
    expect(r.state.flow.stagedShowdowns).toEqual([bfId(s)]);
  });

  it('does not start a second Showdown while one is running', () => {
    // Tests Rule 341: one Showdown at a time
    const s = game();
    const [b0, b1] = [bfId(s, 0), bfId(s, 1)];
    s.flow.showdown = { battlefieldId: b0, isCombat: false, passesInRow: 0 };
    place(s, 'unit', 'p0', { bf: b1 });
    (s.battlefields[1] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
    const r = run(s);
    expect(r.state.flow.showdown?.battlefieldId).toBe(b0);
    expect(r.state.flow.stagedShowdowns).toEqual([b1]);
  });

  it('cancels staged combats whose opposing units left', () => {
    // Tests Rule 323.9: staged Combats are removed when they no longer apply
    const s = game();
    const b = bfId(s);
    s.flow.stagedCombats = [b];
    place(s, 'unit', 'p0', { bf: b });
    const r = run(s);
    expect(r.state.flow.stagedCombats).toEqual([]);
  });

  it('removes Contested where the contester has no units', () => {
    // Tests Rule 323.10: Contested no longer applies without the contester's units
    const s = game();
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p1';
    s.flow.stagedShowdowns = [bfId(s)];
    const r = run(s);
    expect(r.state.battlefields[0]?.contestedBy).toBeNull();
    expect(r.state.flow.stagedShowdowns).toEqual([]);
  });

  it('triggers Combat Resolution from the RESOLUTION step (after killing lethal units)', () => {
    // Tests Rule 468: combat resolves after lethal units are killed; the survivor conquers
    const s = game();
    const b = bfId(s);
    const a = place(s, 'unit', 'p0', { bf: b });
    const d = place(s, 'unit', 'p1', { bf: b });
    (s.objects[d] as { damage: number }).damage = 2;
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
    s.flow.combat = { battlefieldId: b, attacker: 'p0', defender: 'p1', step: 'RESOLUTION' };
    s.flow.priority = null;
    const r = run(s);
    expect(r.state.objects[d]?.zone.kind).toBe('trash');
    expect(r.state.flow.combat).toBeUndefined();
    expect(r.state.battlefields[0]?.controller).toBe('p0');
    expect(r.state.players[0].points).toBe(1);
    expect(r.state.objects[a]?.zone.kind).toBe('battlefield');
    expect(r.state.flow.priority).toBe('p0');
    expect(r.state.turnState.kind).toBe('NEUTRAL');
  });

  it('a win at 8 points ends the game and stops later steps', () => {
    // Tests Rule 194.2: the win check is Cleanup step 1; nothing after it runs
    const s = game();
    s.players[0].points = 8;
    const id = place(s, 'unit', 'p1', 'base');
    (s.objects[id] as { damage: number }).damage = 2;
    const r = run(s);
    expect(r.state.gameStatus).toBe('FINISHED');
    expect(r.state.winner).toBe('p0');
    expect(types(r.events)).toEqual(['GAME_ENDED']);
    expect(r.state.objects[id]?.zone.kind).toBe('base');
  });

  it('a conquer that reaches 8 points ends the game within the same Cleanup', () => {
    // Tests Rule 323.1: the win check repeats on every pass
    const s = game();
    const b = bfId(s);
    s.players[0].points = 7;
    place(s, 'unit', 'p0', { bf: b });
    (s.battlefields[0] as { scoredThisTurnBy: PlayerId[] }).scoredThisTurnBy = [];
    // score all other battlefields so the Final Point is allowed
    for (const bf of s.battlefields.slice(1)) bf.scoredThisTurnBy = ['p0'];
    s.flow.combat = { battlefieldId: b, attacker: 'p0', defender: 'p1', step: 'RESOLUTION' };
    const r = run(s);
    expect(r.state.gameStatus).toBe('FINISHED');
    expect(r.state.winner).toBe('p0');
  });

  it('removes facedown cards at battlefields their controller does not control', () => {
    // Tests Rule 323.6.a: orphaned facedown cards go to the trash
    const s = game();
    const o = s.objects[place(s, 'unit', 'p0', 'base')];
    if (!o) throw new Error('no object');
    s.players[0].base = s.players[0].base.filter((i) => i !== o.id);
    s.players[0].mainDeck = s.players[0].mainDeck.filter((i) => i !== o.id);
    o.zone = { kind: 'facedown', player: 'p0', battlefieldId: bfId(s) };
    o.facedown = true;
    (s.battlefields[0] as { facedownSlotId: string | null }).facedownSlotId = o.id;
    const r = run(s);
    expect(r.state.objects[o.id]?.zone.kind).toBe('trash');
    expect(r.state.battlefields[0]?.facedownSlotId).toBeNull();
  });

  it("recalls gear located at a battlefield to its controller's base", () => {
    // Tests Rule 323.6: non-unit permanents at a battlefield are Recalled
    const s = game();
    const g = place(s, 'fx-blade', 'p0', { bf: bfId(s) });
    const r = run(s);
    expect(r.state.objects[g]?.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(r.state.players[0].base).toContain(g);
  });

  it("recalls a permanent in another player's base to its controller's base", () => {
    // Tests Rule 323.6: permanents in another player's base are Recalled
    const s = game();
    const u = place(s, 'unit', 'p0', 'base');
    const o = s.objects[u] as { zone: unknown; controller: PlayerId };
    s.players[0].base = s.players[0].base.filter((i) => i !== u);
    s.players[1].base.push(u);
    o.zone = { kind: 'base', player: 'p1' };
    const r = run(s);
    expect(r.state.objects[u]?.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(r.state.players[1].base).not.toContain(u);
    expect(r.state.players[0].base).toContain(u);
  });

  it('aborts the game at the circuit breaker when the state never stabilises', () => {
    // Tests Rule 322: the loop is bounded by MAX_CLEANUP_ITERATIONS
    const s = game();
    const hook = vi.fn((st: GameState) => {
      st.players[0].runePool.energy += 1;
    });
    const r = run(s, { ...defaultShowdownDeps, __afterPass: hook });
    expect(hook).toHaveBeenCalledTimes(MAX_CLEANUP_ITERATIONS);
    expect(r.state.gameStatus).toBe('ABORTED');
    const aborted = r.events.filter((e) => e.type === 'GAME_ABORTED');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ reason: 'cleanup did not stabilise after 25 iterations' });
    expect(r.events.filter((e) => e.type === 'CLEANUP_ITERATION')).toHaveLength(25);
    expect(r.state.flow.cleanupIterations).toBe(MAX_CLEANUP_ITERATIONS);
  });

  it('aborts when a startCombat hook keeps changing state', () => {
    // Tests Rule 322: a pathological startCombat hook cannot loop forever
    const s = game();
    const b = bfId(s);
    place(s, 'unit', 'p0', { bf: b });
    place(s, 'unit', 'p1', { bf: b });
    const startCombat = vi.fn((st: GameState) => {
      const n = structuredClone(st);
      n.players[1].runePool.energy += 1; // never actually starts combat, re-stages every pass
      return { state: n, events: [] };
    });
    const r = run(s, { ...defaultShowdownDeps, startCombat });
    expect(startCombat).toHaveBeenCalledTimes(MAX_CLEANUP_ITERATIONS);
    expect(r.state.gameStatus).toBe('ABORTED');
    expect(types(r.events)).toContain('GAME_ABORTED');
  });

  it('does not abort a run that stabilises exactly on a later pass', () => {
    // Tests Rule 322: the loop ends as soon as a pass changes nothing
    const s = game();
    let n = 0;
    const r = run(s, {
      ...defaultShowdownDeps,
      __afterPass: (st) => {
        if (n++ < 3) st.players[0].runePool.energy += 1;
      },
    });
    expect(r.state.gameStatus).toBe('IN_PROGRESS');
    expect(r.events.filter((e) => e.type === 'CLEANUP_ITERATION')).toHaveLength(3);
    expect(r.state.flow.cleanupIterations).toBe(0);
  });

  it('does nothing once the game is over', () => {
    // Tests Rule 473.1: no Cleanup after the game ended
    const s = game();
    s.gameStatus = 'FINISHED';
    const id = place(s, 'unit', 'p0', 'base');
    (s.objects[id] as { damage: number }).damage = 5;
    const r = run(s);
    expect(r.events).toEqual([]);
    expect(r.state.objects[id]?.zone.kind).toBe('base');
  });

  it('is idempotent: running twice yields the same state and no extra events', () => {
    // Tests Rule 322: a stable state is a fixed point of Cleanup
    const s = game();
    place(s, 'unit', 'p0', { bf: bfId(s) });
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p0';
    const first = run(s);
    const second = run(first.state);
    expect(second.state).toEqual(first.state);
    expect(second.events).toEqual([]);
  });

  it('does not mutate its input', () => {
    // Tests Rule 322: pure function
    const s = game();
    const id = place(s, 'unit', 'p0', 'base');
    (s.objects[id] as { damage: number }).damage = 2;
    place(s, 'unit', 'p1', { bf: bfId(s) });
    (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p1';
    const frozen = structuredClone(s);
    run(s);
    expect(s).toEqual(frozen);
  });

  it('is deterministic and stamps consecutive event seqs', () => {
    // Tests Rule 322: same input, same output; events carry monotonic seq
    const build = (): GameState => {
      const s = game();
      const id = place(s, 'unit', 'p0', 'base');
      (s.objects[id] as { damage: number }).damage = 2;
      place(s, 'unit', 'p1', { bf: bfId(s) });
      (s.battlefields[0] as { contestedBy: PlayerId | null }).contestedBy = 'p1';
      return s;
    };
    const a = run(build());
    const b = run(build());
    expect(a).toEqual(b);
    const start = build().nextEventSeq;
    expect(a.events.map((e) => e.seq)).toEqual(a.events.map((_, i) => start + i));
    expect(a.state.nextEventSeq).toBe(start + a.events.length);
  });
});

describe('needsCleanup', () => {
  it('is false for a quiet state and true when something is pending', () => {
    // Tests Rule 319: a Cleanup is Outstanding after relevant state changes
    const s = game();
    expect(needsCleanup(s)).toBe(false);
    s.flow.stagedCombats = ['x'];
    expect(needsCleanup(s)).toBe(true);
    s.gameStatus = 'FINISHED';
    expect(needsCleanup(s)).toBe(false);
  });
});
