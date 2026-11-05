import { describe, it, expect } from 'vitest';
import { endTurn, runStartOfTurn, assertPhase, startGameAfterMulligan } from './phases.js';
import type { PhaseHooks } from './phases.js';
import { FIXTURE_CARDS, makeTestGame } from './testing/fixtures.js';
import type { GameEvent, GameState, ReduceResult } from './types/index.js';

function awakenGame(seed = 'ph'): GameState {
  const s = makeTestGame(seed);
  s.turn = { number: 1, activePlayer: 'p0', phase: 'AWAKEN', step: 'NONE' };
  return s;
}

function ok(r: ReduceResult): { state: GameState; events: GameEvent[] } {
  if (!r.ok) throw new Error(r.message);
  return r;
}

function mainGame(seed = 'ph'): GameState {
  return ok(runStartOfTurn(awakenGame(seed), FIXTURE_CARDS)).state;
}

const phasesOf = (events: GameEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'PHASE_CHANGED' ? [e.phase] : []));

describe('runStartOfTurn', () => {
  it('runs the injected Cleanup after Beginning, Scoring, Channel and Draw, and stops if it ends the game', () => {
    // Tests Rule 319: a Cleanup is outstanding after the phase changes and runs between phases
    const log: string[] = [];
    const hooks: PhaseHooks = {
      onBeginning: (st) => (log.push('beginning'), { state: st, events: [] }),
      onScoringStep: (st) => (log.push('scoring'), { state: st, events: [] }),
      runCleanup: (st) => (
        log.push(`cleanup@${st.turn.phase}/${st.turn.step}`),
        { state: st, events: [] }
      ),
    };
    ok(runStartOfTurn(awakenGame(), FIXTURE_CARDS, hooks));
    expect(log).toEqual([
      'beginning',
      'cleanup@BEGINNING/NONE',
      'scoring',
      'cleanup@BEGINNING/NONE',
      'cleanup@CHANNEL/NONE',
      'cleanup@DRAW/NONE',
    ]);
    const log2: string[] = [];
    const r = ok(
      runStartOfTurn(awakenGame(), FIXTURE_CARDS, {
        runCleanup: (st) => {
          log2.push(st.turn.phase);
          const next = structuredClone(st);
          next.gameStatus = 'FINISHED';
          next.winner = 'p0';
          return { state: next, events: [] };
        },
      }),
    );
    expect(log2).toEqual(['BEGINNING']);
    expect(r.state.turn.phase).toBe('BEGINNING');
  });

  it('runs the phases in order and lands in MAIN', () => {
    // Tests Rule 315: turn phase order
    const s0 = awakenGame();
    const r = ok(runStartOfTurn(s0, FIXTURE_CARDS));
    expect(phasesOf(r.events)).toEqual(['AWAKEN', 'BEGINNING', 'CHANNEL', 'DRAW', 'MAIN']);
    expect(r.state.turn).toEqual({ number: 1, activePlayer: 'p0', phase: 'MAIN', step: 'NONE' });
    expect(r.state.flow.priority).toBe('p0');
    expect(r.state.flow.focus).toBeNull();
    expect(r.state.flow.chain).toEqual([]);
    expect(r.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    r.events.forEach((e, i) => expect(e.seq).toBe(s0.nextEventSeq + i));
  });

  it('startGameAfterMulligan is the same entry point', () => {
    // Tests Rule 315: start of game turn structure
    expect(startGameAfterMulligan).toBe(runStartOfTurn);
  });

  it('channels 2 runes ready on the first turn and draws 1 card', () => {
    // Tests Rule 315.3: channel 2 runes, ready; Rule 315.4: draw 1
    const s0 = awakenGame();
    const r = ok(runStartOfTurn(s0, FIXTURE_CARDS));
    const p = r.state.players[0];
    expect(p.base).toHaveLength(2);
    expect(p.runeDeck).toHaveLength(10);
    for (const id of p.base) {
      expect(r.state.objects[id]!.ready).toBe(true);
      expect(r.state.objects[id]!.zone).toEqual({ kind: 'base', player: 'p0' });
    }
    expect(r.events.filter((e) => e.type === 'RUNE_CHANNELED')).toHaveLength(2);
    expect(p.hand).toHaveLength(5);
    expect(p.mainDeck).toHaveLength(s0.players[0].mainDeck.length - 1);
    expect(r.events.filter((e) => e.type === 'CARD_DRAWN')).toHaveLength(1);
  });

  it('channels 3 runes on the second player first turn, then 2', () => {
    // Tests Rule 487.7: second player channels an extra rune in their first Channel Phase
    const t1 = mainGame();
    const t2 = ok(endTurn(t1, FIXTURE_CARDS, { type: 'END_TURN', playerId: 'p0' })).state;
    expect(t2.turn.activePlayer).toBe('p1');
    expect(t2.players[1].base).toHaveLength(3);
    const t3 = ok(endTurn(t2, FIXTURE_CARDS, { type: 'END_TURN', playerId: 'p1' })).state;
    expect(t3.players[0].base).toHaveLength(4);
    const t4 = ok(endTurn(t3, FIXTURE_CARDS, { type: 'END_TURN', playerId: 'p0' })).state;
    expect(t4.players[1].base).toHaveLength(5);
  });

  it('channels only as many runes as are available', () => {
    // Tests Rule 431.3: channel as many as available
    const s = awakenGame();
    const p = s.players[0];
    const keep = p.runeDeck.splice(1);
    keep.forEach((id) => delete s.objects[id]);
    const r = ok(runStartOfTurn(s, FIXTURE_CARDS));
    expect(r.state.players[0].base).toHaveLength(1);
    expect(r.state.players[0].runeDeck).toHaveLength(0);
  });

  it('readies the turn player objects during Awaken', () => {
    // Tests Rule 315.1: active player readies their objects
    const s = awakenGame();
    const legend = s.objects[s.players[0].legend!]!;
    legend.ready = false;
    const unit = s.objects[s.players[0].hand[0]!]!;
    unit.zone = { kind: 'base', player: 'p0' };
    unit.ready = false;
    s.players[0].base.push(unit.id);
    const opp = s.objects[s.players[1].hand[0]!]!;
    opp.zone = { kind: 'base', player: 'p1' };
    opp.ready = false;
    s.players[1].base.push(opp.id);
    const r = ok(runStartOfTurn(s, FIXTURE_CARDS)).state;
    expect(r.objects[legend.id]!.ready).toBe(true);
    expect(r.objects[unit.id]!.ready).toBe(true);
    expect(r.objects[opp.id]!.ready).toBe(false);
  });

  it('empties all Rune Pools at the start of Main', () => {
    // Tests Rule 316.3: Rune Pools empty at start of Main
    const s = awakenGame();
    s.players[0].runePool = { energy: 3, power: { Fury: 2 } };
    s.players[1].runePool = { energy: 1, power: {} };
    const r = ok(runStartOfTurn(s, FIXTURE_CARDS)).state;
    expect(r.players[0].runePool).toEqual({ energy: 0, power: {} });
    expect(r.players[1].runePool).toEqual({ energy: 0, power: {} });
  });

  it('clears scoredThisTurnBy at the start of the turn', () => {
    // Tests Rule 315.2.b: score memory resets each turn
    const s = awakenGame();
    s.battlefields[0]!.scoredThisTurnBy = ['p0'];
    s.battlefields[1]!.scoredThisTurnBy = ['p1'];
    const r = ok(runStartOfTurn(s, FIXTURE_CARDS)).state;
    expect(r.battlefields.map((b) => b.scoredThisTurnBy)).toEqual([[], []]);
  });

  it('resets stale flow state when entering Main', () => {
    // Tests Rule 316: Main begins with neutral open state and turn player priority
    const s = awakenGame();
    s.flow.focus = 'p1';
    s.flow.priority = null;
    const r = ok(runStartOfTurn(s, FIXTURE_CARDS)).state;
    expect(r.flow.priority).toBe('p0');
    expect(r.flow.focus).toBeNull();
  });

  it('rejects when not in the AWAKEN phase', () => {
    // Tests Rule 315: start-of-turn only from Awaken
    const r = runStartOfTurn(makeTestGame(), FIXTURE_CARDS);
    expect(r).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });

  it('is deterministic by seed and does not mutate its input', () => {
    // Tests Rule 315: pure and deterministic
    const s = awakenGame('same');
    const snap = JSON.stringify(s);
    const a = ok(runStartOfTurn(s, FIXTURE_CARDS));
    expect(JSON.stringify(s)).toBe(snap);
    const b = ok(runStartOfTurn(awakenGame('same'), FIXTURE_CARDS));
    expect(a).toEqual(b);
  });
});

describe('burn out in the Draw phase', () => {
  function emptyDeck(trash: number): GameState {
    const s = awakenGame();
    const p = s.players[0];
    const ids = p.mainDeck.splice(0, p.mainDeck.length);
    for (const id of ids.slice(0, trash)) {
      p.trash.push(id);
      s.objects[id]!.zone = { kind: 'trash', player: 'p0' };
    }
    return s;
  }

  it('recycles the trash, gives the opponent a point, then draws', () => {
    // Tests Rule 414.4: empty deck at draw burns out, then draws
    const r = ok(runStartOfTurn(emptyDeck(6), FIXTURE_CARDS));
    expect(r.state.players[1].points).toBe(1);
    expect(r.state.players[0].trash).toEqual([]);
    expect(r.state.players[0].hand).toHaveLength(5);
    expect(r.state.players[0].mainDeck).toHaveLength(5);
    expect(r.state.turn.phase).toBe('MAIN');
    const types = r.events.map((e) => e.type);
    expect(types.indexOf('BURN_OUT')).toBeLessThan(types.indexOf('CARD_DRAWN'));
  });

  it('ends the game on a winning burn out and stops the phases', () => {
    // Tests Rule 432.3.c: burn out at 7 points wins the game
    const s = emptyDeck(0);
    s.players[1].points = 7;
    const r = ok(runStartOfTurn(s, FIXTURE_CARDS));
    expect(r.state.gameStatus).toBe('FINISHED');
    expect(r.state.winner).toBe('p1');
    expect(r.state.turn.phase).toBe('DRAW');
    expect(r.events[r.events.length - 1]).toMatchObject({ type: 'GAME_ENDED', winner: 'p1' });
    expect(phasesOf(r.events)).not.toContain('MAIN');
  });
});

describe('hooks', () => {
  function spy(log: string[], over?: (name: string, s: GameState) => void): PhaseHooks {
    const h = (name: string) => (state: GameState) => {
      log.push(`${name}:${state.turn.phase}/${state.turn.step}`);
      over?.(name, state);
      return { state, events: [] };
    };
    return {
      onBeginning: h('beginning'),
      onScoringStep: h('scoring'),
      onMainStart: h('main'),
      onEndingStep: h('ending'),
      onExpiration: h('expiration'),
    };
  }

  it('invokes start-of-turn hooks in order with the right phase/step', () => {
    // Tests Rule 315.2: beginning effects, then Scoring step
    const log: string[] = [];
    ok(runStartOfTurn(awakenGame(), FIXTURE_CARDS, spy(log)));
    expect(log).toEqual([
      'beginning:BEGINNING/NONE',
      'scoring:BEGINNING/SCORING',
      'main:MAIN/NONE',
    ]);
  });

  it('invokes ending hooks around the turn change', () => {
    // Tests Rule 317: ending step, expiration, then next turn
    const s = mainGame();
    const log: string[] = [];
    ok(endTurn(s, FIXTURE_CARDS, { type: 'END_TURN', playerId: 'p0' }, spy(log)));
    expect(log).toEqual([
      'ending:ENDING/NONE',
      'expiration:ENDING/NONE',
      'beginning:BEGINNING/NONE',
      'scoring:BEGINNING/SCORING',
      'main:MAIN/NONE',
    ]);
  });

  it('uses hook results: events are included and a hook can end the game', () => {
    // Tests Rule 315.2.b: Scoring step may end the game
    const r = ok(
      runStartOfTurn(awakenGame(), FIXTURE_CARDS, {
        onScoringStep: (state) => {
          const next = structuredClone(state);
          next.gameStatus = 'FINISHED';
          next.winner = 'p0';
          return { state: next, events: [{ type: 'GAME_ENDED', winner: 'p0' }] };
        },
      }),
    );
    expect(r.state.turn.phase).toBe('BEGINNING');
    expect(phasesOf(r.events)).toEqual(['AWAKEN', 'BEGINNING']);
    expect(r.events[r.events.length - 1]!.type).toBe('GAME_ENDED');
    expect(r.state.players[0].base).toHaveLength(0);
  });
});

describe('endTurn', () => {
  const end = (s: GameState, p: 'p0' | 'p1' = 'p0'): ReduceResult =>
    endTurn(s, FIXTURE_CARDS, { type: 'END_TURN', playerId: p });

  it('emits Ending then the next player start of turn', () => {
    // Tests Rule 317: ending phase, then the next turn
    const r = ok(end(mainGame()));
    expect(phasesOf(r.events)).toEqual([
      'ENDING',
      'AWAKEN',
      'BEGINNING',
      'CHANNEL',
      'DRAW',
      'MAIN',
    ]);
    expect(r.state.turn).toMatchObject({ number: 2, activePlayer: 'p1', phase: 'MAIN' });
    expect(r.state.flow.priority).toBe('p1');
    expect(r.state.players[1].hand).toHaveLength(5);
  });

  it('heals all units and empties Rune Pools at end of turn', () => {
    // Tests Rule 317.2: heal units, empty Rune Pools
    const s = mainGame();
    const u = s.objects[s.players[0].hand[0]!]!;
    u.zone = { kind: 'base', player: 'p0' };
    u.damage = 4;
    const o = s.objects[s.players[1].hand[0]!]!;
    o.zone = { kind: 'base', player: 'p1' };
    o.damage = 3;
    s.players[0].runePool = { energy: 2, power: { Calm: 1 } };
    const r = ok(end(s)).state;
    expect(r.objects[u.id]!.damage).toBe(0);
    expect(r.objects[o.id]!.damage).toBe(0);
    expect(r.players[0].runePool).toEqual({ energy: 0, power: {} });
  });

  it('resets scoredThisTurnBy for the new turn', () => {
    // Tests Rule 315.2.b: scoring memory resets each turn
    const s = mainGame();
    s.battlefields[0]!.scoredThisTurnBy = ['p0'];
    const r = ok(end(s)).state;
    expect(r.battlefields[0]!.scoredThisTurnBy).toEqual([]);
  });

  it('rejects in the wrong phase', () => {
    // Tests Rule 313: END_TURN only in Main
    const r = end(awakenGame());
    expect(r).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });

  it('rejects when it is not your turn', () => {
    // Tests Rule 307: only the turn player ends the turn
    expect(end(mainGame(), 'p1')).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
  });

  it('rejects with a non-empty chain', () => {
    // Tests Rule 309.1.a: closed state
    const s = mainGame();
    s.flow.chain.push({
      id: 'c1',
      kind: 'CARD',
      sourceObjectId: s.players[0].hand[0]!,
      controller: 'p0',
      status: 'FINALIZED',
      targets: [],
      choices: {},
    });
    expect(end(s)).toMatchObject({ ok: false, code: 'CLOSED_STATE_REACTION_ONLY' });
  });

  it('rejects during a Showdown or Combat', () => {
    // Tests Rule 308: no ending the turn inside a Showdown
    const s = mainGame();
    s.flow.showdown = { battlefieldId: 'bf0', isCombat: false, passesInRow: 0 };
    expect(end(s)).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });

  it('rejects after the game is over', () => {
    // Tests Rule 473.1: no actions once the game ended
    const s = mainGame();
    s.gameStatus = 'FINISHED';
    expect(end(s)).toMatchObject({ ok: false, code: 'GAME_OVER' });
  });

  it('does not mutate its input and is deterministic', () => {
    // Tests Rule 317: pure transition
    const s = mainGame('det');
    const snap = JSON.stringify(s);
    const a = ok(end(s));
    expect(JSON.stringify(s)).toBe(snap);
    expect(ok(end(mainGame('det')))).toEqual(a);
  });

  it('stops after a burn-out win in the next turn Draw phase', () => {
    // Tests Rule 432.3.c: game over stops further phases
    const s = mainGame();
    const p1 = s.players[1];
    p1.mainDeck.splice(0, p1.mainDeck.length);
    s.players[0].points = 7;
    const r = ok(end(s));
    expect(r.state.gameStatus).toBe('FINISHED');
    expect(r.state.winner).toBe('p0');
    expect(r.state.turn).toMatchObject({ number: 2, phase: 'DRAW' });
  });
});

describe('assertPhase', () => {
  it('returns null in the right phase and an error otherwise', () => {
    // Tests Rule 313: phase gating helper
    const s = mainGame();
    expect(assertPhase(s, 'MAIN')).toBeNull();
    expect(assertPhase(s, 'DRAW')?.code).toBe('WRONG_PHASE');
    s.gameStatus = 'FINISHED';
    expect(assertPhase(s, 'MAIN')?.code).toBe('GAME_OVER');
  });
});
