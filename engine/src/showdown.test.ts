import { describe, expect, it, vi } from 'vitest';
import { passPriority } from './chain.js';
import {
  closeShowdown,
  establishControl,
  playersWithUnitsAt,
  showdownAfterPass,
  stageableCombats,
  stageableContests,
  startShowdown,
  unitsAt,
} from './showdown.js';
import type { ShowdownDeps } from './showdown.js';
import { FIXTURE_CARDS, makeTestGame } from './testing/fixtures.js';
import type { GameState, PlayerId, ReduceResult } from './types/index.js';

function ok(r: ReduceResult): Extract<ReduceResult, { ok: true }> {
  if (!r.ok) throw new Error(r.message);
  return r;
}

/** Place a unit of `cardId` owned by `owner` at `bfId`; returns its id. */
function placeAt(s: GameState, cardId: string, owner: PlayerId, bfId: string): string {
  const o = Object.values(s.objects).find(
    (x) => x.cardId === cardId && x.owner === owner && x.zone.kind === 'mainDeck',
  );
  if (!o) throw new Error(`no ${cardId}`);
  const p = s.players[owner === 'p0' ? 0 : 1];
  p.mainDeck = p.mainDeck.filter((i) => i !== o.id);
  o.zone = { kind: 'battlefield', player: owner, battlefieldId: bfId };
  return o.id;
}

function game(): GameState {
  const s = makeTestGame('sd');
  s.flow.priority = 'p0';
  return s;
}

function spyDeps() {
  const onConquer = vi.fn((state: GameState) => ({ state, events: [] }));
  const startCombat = vi.fn((state: GameState, cards: unknown, bfId: string) => ({
    state,
    events: [],
    cards,
    bfId,
  }));
  const continueCombat = vi.fn((state: GameState) => ({ state, events: [] }));
  const deps: ShowdownDeps = { onConquer, startCombat, continueCombat };
  return { deps, onConquer, startCombat, continueCombat };
}

/** Both players pass in sequence on an empty chain, then showdownAfterPass. */
function allPass(s: GameState, deps: ShowdownDeps): ReduceResult {
  let cur = s;
  for (let i = 0; i < 2; i++) {
    const p = cur.flow.priority as PlayerId;
    cur = ok(passPriority(cur, FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: p })).state;
  }
  return showdownAfterPass(cur, FIXTURE_CARDS, deps);
}

describe('startShowdown', () => {
  it('opens a Showdown and gives Focus and Priority to the applier', () => {
    // Tests Rule 345: the player who applied Contested gets Focus and Priority
    const r = ok(startShowdown(game(), 'bf1', 'p1', false));
    expect(r.state.flow.showdown).toEqual({
      battlefieldId: 'bf1',
      isCombat: false,
      passesInRow: 0,
    });
    expect(r.state.flow.focus).toBe('p1');
    expect(r.state.flow.priority).toBe('p1');
    expect(r.state.turnState).toEqual({ kind: 'SHOWDOWN', open: true });
    expect(r.events).toMatchObject([
      { type: 'SHOWDOWN_STARTED', battlefieldId: 'bf1', isCombat: false },
    ]);
  });

  it('records attacker and defender for a combat showdown and unstages the battlefield', () => {
    // Tests Rule 462: a combat Showdown has an attacker and a defender
    const s = game();
    s.flow.stagedCombats = ['bf0', 'bf1'];
    s.flow.stagedShowdowns = ['bf0'];
    const r = ok(startShowdown(s, 'bf0', 'p0', true));
    expect(r.state.flow.showdown).toMatchObject({ isCombat: true, attacker: 'p0', defender: 'p1' });
    expect(r.state.flow.stagedCombats).toEqual(['bf1']);
    expect(r.state.flow.stagedShowdowns).toEqual([]);
  });

  it('rejects unknown battlefields and a second concurrent showdown', () => {
    // Tests Rule 341: one Showdown at a time
    const s = game();
    expect(startShowdown(s, 'nope', 'p0', false).ok).toBe(false);
    const r = ok(startShowdown(s, 'bf0', 'p0', false));
    expect(startShowdown(r.state, 'bf1', 'p0', false).ok).toBe(false);
  });

  it('does not mutate its input', () => {
    // Tests Rule 341: pure
    const s = game();
    const before = structuredClone(s);
    startShowdown(s, 'bf0', 'p0', false);
    expect(s).toEqual(before);
  });
});

describe('showdownAfterPass and closing', () => {
  it('is a no-op until everyone has passed', () => {
    // Tests Rule 347.2.a: the Showdown ends only after all players pass in sequence
    const s = ok(startShowdown(game(), 'bf0', 'p0', false)).state;
    const one = ok(passPriority(s, FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: 'p0' })).state;
    const r = ok(showdownAfterPass(one, FIXTURE_CARDS));
    expect(r.state).toBe(one);
    expect(r.events).toEqual([]);
    expect(r.state.flow.showdown).toBeDefined();
  });

  it('closes after both players pass and restores Neutral Open for the turn player', () => {
    // Tests Rule 348: all pass -> Showdown ends; 335: priority returns to the turn player
    const s = ok(startShowdown(game(), 'bf0', 'p1', false)).state;
    const r = ok(allPass(s, {}));
    expect(r.state.flow.showdown).toBeUndefined();
    expect(r.state.flow.focus).toBeNull();
    expect(r.state.flow.priority).toBe('p0');
    expect(r.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
  });

  it('establishes control and calls onConquer once when one player is alone', () => {
    // Tests Rule 348.2.a.1: sole presence establishes control, which is a Conquer
    const s = game();
    const u = placeAt(s, 'fx-grunt', 'p0', 'bf1');
    s.battlefields[1]!.contestedBy = 'p0';
    const { deps, onConquer, startCombat } = spyDeps();
    const sd = ok(startShowdown(s, 'bf1', 'p0', false)).state;
    const r = ok(allPass(sd, deps));
    expect(r.state.battlefields[1]).toMatchObject({ controller: 'p0', contestedBy: null });
    expect(r.events).toMatchObject([
      { type: 'BATTLEFIELD_CONTROL_CHANGED', battlefieldId: 'bf1', controller: 'p0' },
    ]);
    expect(onConquer).toHaveBeenCalledTimes(1);
    expect(onConquer.mock.calls[0]!.slice(1, 3)).toEqual(['p0', 'bf1']);
    expect(startCombat).not.toHaveBeenCalled();
    expect(unitsAt(r.state, 'bf1').map((o) => o.id)).toEqual([u]);
  });

  it('establishes control without Conquer if the battlefield was already scored this turn', () => {
    // Tests Rule 348.2.a.1: no Conquer for a battlefield already scored this turn
    const s = game();
    placeAt(s, 'fx-grunt', 'p0', 'bf1');
    s.battlefields[1]!.contestedBy = 'p0';
    s.battlefields[1]!.scoredThisTurnBy = ['p0'];
    const { deps, onConquer } = spyDeps();
    const r = ok(allPass(ok(startShowdown(s, 'bf1', 'p0', false)).state, deps));
    expect(r.state.battlefields[1]!.controller).toBe('p0');
    expect(onConquer).not.toHaveBeenCalled();
  });

  it('does not Conquer when the sole player already controls the battlefield', () => {
    // Tests Rule 348.2.a: nothing changes hands, so no Conquer
    const s = game();
    placeAt(s, 'fx-grunt', 'p0', 'bf0');
    s.battlefields[0]!.controller = 'p0';
    const { deps, onConquer } = spyDeps();
    const r = ok(allPass(ok(startShowdown(s, 'bf0', 'p0', false)).state, deps));
    expect(onConquer).not.toHaveBeenCalled();
    expect(r.events).toEqual([]);
  });

  it('clears Contested when no units remain', () => {
    // Tests Rule 190.3: nobody left to contest
    const s = game();
    s.battlefields[1]!.contestedBy = 'p0';
    const r = ok(allPass(ok(startShowdown(s, 'bf1', 'p0', false)).state, spyDeps().deps));
    expect(r.state.battlefields[1]!.contestedBy).toBeNull();
    expect(r.state.battlefields[1]!.controller).toBeNull();
  });

  it('hands off to startCombat when both players have units', () => {
    // Tests Rule 348.2: both players present -> combat
    const s = game();
    placeAt(s, 'fx-grunt', 'p0', 'bf1');
    placeAt(s, 'fx-tide-grunt', 'p1', 'bf1');
    const { deps, startCombat, onConquer } = spyDeps();
    const r = ok(allPass(ok(startShowdown(s, 'bf1', 'p0', false)).state, deps));
    expect(startCombat).toHaveBeenCalledTimes(1);
    expect(startCombat.mock.calls[0]![2]).toBe('bf1');
    expect(onConquer).not.toHaveBeenCalled();
    expect(r.state.flow.showdown).toBeUndefined();
    expect(r.state.battlefields[1]!.controller).toBeNull();
  });

  it('calls continueCombat for a combat showdown', () => {
    // Tests Rule 348.1: a combat Showdown continues into combat
    const { deps, continueCombat, onConquer } = spyDeps();
    const r = ok(allPass(ok(startShowdown(game(), 'bf0', 'p0', true)).state, deps));
    expect(continueCombat).toHaveBeenCalledTimes(1);
    expect(onConquer).not.toHaveBeenCalled();
    expect(r.state.flow.showdown).toBeUndefined();
  });

  it('lets a combat hook keep ownership of flow when it sets flow.combat', () => {
    // Tests Rule 348.1: combat continues after its Showdown
    const deps: ShowdownDeps = {
      continueCombat: (st) => {
        const n = structuredClone(st);
        n.flow.combat = { step: 'DAMAGE', battlefieldId: 'bf0', attacker: 'p0', defender: 'p1' };
        n.flow.priority = 'p1';
        return { state: n, events: [] };
      },
    };
    const r = ok(allPass(ok(startShowdown(game(), 'bf0', 'p0', true)).state, deps));
    expect(r.state.flow.combat).toBeDefined();
    expect(r.state.flow.priority).toBe('p1');
    expect(r.state.turnState.kind).toBe('SHOWDOWN');
  });

  it('errors without a showdown to close; default deps are safe no-ops', () => {
    // Tests Rule 348: nothing to close
    const s = game();
    expect(closeShowdown(s, FIXTURE_CARDS).ok).toBe(false);
    placeAt(s, 'fx-grunt', 'p0', 'bf1');
    const r = ok(allPass(ok(startShowdown(s, 'bf1', 'p0', false)).state, {}));
    expect(r.state.battlefields[1]!.controller).toBe('p0');
  });

  it('is deterministic and does not mutate its input', () => {
    // Tests Rule 348: pure
    const s = game();
    placeAt(s, 'fx-grunt', 'p0', 'bf1');
    const sd = ok(startShowdown(s, 'bf1', 'p0', false)).state;
    sd.flow.showdown!.passesInRow = 2;
    const before = structuredClone(sd);
    const a = ok(closeShowdown(sd, FIXTURE_CARDS, {}));
    const b = ok(closeShowdown(sd, FIXTURE_CARDS, {}));
    expect(sd).toEqual(before);
    expect(a).toEqual(b);
  });
});

describe('helpers', () => {
  it('unitsAt and playersWithUnitsAt report units by battlefield and controller', () => {
    // Tests Rule 107: units at a battlefield are objects with a battlefield zone
    const s = game();
    const a = placeAt(s, 'fx-grunt', 'p0', 'bf0');
    const b = placeAt(s, 'fx-tide-grunt', 'p1', 'bf0');
    expect(unitsAt(s, 'bf0').map((o) => o.id)).toEqual([a, b]);
    expect(unitsAt(s, 'bf0', 'p1').map((o) => o.id)).toEqual([b]);
    expect(unitsAt(s, 'bf1')).toEqual([]);
    expect(playersWithUnitsAt(s, 'bf0')).toEqual(['p0', 'p1']);
    expect(playersWithUnitsAt(s, 'bf1')).toEqual([]);
  });

  it('establishControl sets the controller, clears Contested and reports the change', () => {
    // Tests Rule 468.5: combat resolution reuses establishing control
    const s = game();
    s.battlefields[0]!.contestedBy = 'p1';
    const ev = establishControl(s, 'bf0', 'p1');
    expect(s.battlefields[0]).toMatchObject({ controller: 'p1', contestedBy: null });
    expect(ev).toEqual([
      {
        type: 'BATTLEFIELD_CONTROL_CHANGED',
        battlefieldId: 'bf0',
        controller: 'p1',
        fromNeutral: true,
      },
    ]);
    expect(establishControl(s, 'bf0', 'p1')).toEqual([]);
  });

  it('stageableContests lists contested battlefields with the contester present', () => {
    // Tests Rule 323.7: cleanup stages Showdowns for Contested battlefields
    const s = game();
    placeAt(s, 'fx-grunt', 'p0', 'bf0');
    s.battlefields[0]!.contestedBy = 'p0';
    s.battlefields[1]!.contestedBy = 'p0'; // no units there
    expect(stageableContests(s)).toEqual(['bf0']);
    s.flow.showdown = { battlefieldId: 'bf0', isCombat: false, passesInRow: 0 };
    expect(stageableContests(s)).toEqual([]);
  });

  it('stageableCombats lists battlefields where both players have units', () => {
    // Tests Rule 323.8: cleanup stages Combat where opposing units share a battlefield
    const s = game();
    placeAt(s, 'fx-grunt', 'p0', 'bf0');
    placeAt(s, 'fx-tide-grunt', 'p1', 'bf0');
    placeAt(s, 'fx-grunt', 'p0', 'bf1');
    expect(stageableCombats(s)).toEqual(['bf0']);
    s.flow.showdown = { battlefieldId: 'bf0', isCombat: true, passesInRow: 0 };
    expect(stageableCombats(s)).toEqual([]);
  });
});
