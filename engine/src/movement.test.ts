import { describe, expect, it } from 'vitest';
import { standardMove, canStandardMove } from './movement.js';
import { FIXTURE_CARDS, makeTestGame } from './testing/fixtures.js';
import type { GameState, PlayerId, ReduceResult, StandardMoveIntent } from './types/index.js';

const idx = (p: PlayerId): 0 | 1 => (p === 'p0' ? 0 : 1);

function ok(r: ReduceResult): Extract<ReduceResult, { ok: true }> {
  if (!r.ok) throw new Error(r.message);
  return r;
}

/** Put a unit of `cardId` owned by `owner` into its base (ready) and return its id. */
function toBase(s: GameState, cardId: string, owner: PlayerId): string {
  const o = Object.values(s.objects).find(
    (x) => x.cardId === cardId && x.owner === owner && x.zone.kind === 'mainDeck',
  );
  if (!o) throw new Error(`no ${cardId}`);
  const p = s.players[idx(owner)];
  p.mainDeck = p.mainDeck.filter((i) => i !== o.id);
  p.base.push(o.id);
  o.zone = { kind: 'base', player: owner };
  o.ready = true;
  return o.id;
}

function toBf(s: GameState, id: string, bfId: string): void {
  const o = s.objects[id]!;
  const p = s.players[idx(o.controller)];
  p.base = p.base.filter((i) => i !== id);
  o.zone = { kind: 'battlefield', player: o.controller, battlefieldId: bfId };
}

function setup(): { s: GameState; grunt: string; ganker: string; enemy: string } {
  const s = makeTestGame('mv');
  s.flow.priority = 'p0';
  const grunt = toBase(s, 'fx-grunt', 'p0');
  const ganker = toBase(s, 'fx-ganker', 'p0');
  const enemy = toBase(s, 'fx-tide-grunt', 'p1');
  return { s, grunt, ganker, enemy };
}

const mv = (
  unitIds: string[],
  destination: StandardMoveIntent['destination'],
  playerId: PlayerId = 'p0',
): StandardMoveIntent => ({ type: 'STANDARD_MOVE', playerId, unitIds, destination });
const BF = (battlefieldId: string): StandardMoveIntent['destination'] => ({
  kind: 'battlefield',
  battlefieldId,
});

describe('standardMove legal moves', () => {
  it('moves a ready unit from base to a battlefield and exhausts it', () => {
    // Tests Rule 144.4.a: Base -> Battlefield; 144.2 exhaust as cost
    const { s, grunt } = setup();
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], BF('bf0'))));
    const o = r.state.objects[grunt]!;
    expect(o.ready).toBe(false);
    expect(o.zone).toEqual({ kind: 'battlefield', player: 'p0', battlefieldId: 'bf0' });
    expect(r.state.players[0].base).not.toContain(grunt);
    expect(r.events).toMatchObject([
      { type: 'UNIT_MOVED', unitId: grunt, from: 'base', to: 'bf0' },
    ]);
    expect(r.events[0]!.seq).toBe(s.nextEventSeq);
  });

  it('moves a unit from a battlefield back to its own base', () => {
    // Tests Rule 144.4.b: Battlefield -> own Base
    const { s, grunt } = setup();
    toBf(s, grunt, 'bf1');
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], { kind: 'base' })));
    expect(r.state.objects[grunt]!.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(r.state.players[0].base).toContain(grunt);
    expect(r.events).toMatchObject([{ type: 'UNIT_MOVED', from: 'bf1', to: 'base' }]);
  });

  it('lets a Ganking unit move battlefield to battlefield', () => {
    // Tests Rule 144.4.c.1: Ganking allows Battlefield -> Battlefield
    const { s, ganker } = setup();
    toBf(s, ganker, 'bf0');
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([ganker], BF('bf1'))));
    expect(r.state.objects[ganker]!.zone).toMatchObject({ battlefieldId: 'bf1' });
    expect(r.state.objects[ganker]!.ready).toBe(false);
  });

  it('moves several units together from mixed origins', () => {
    // Tests Rule 144.3.a: multiple units may move together to one destination
    const { s, grunt, ganker } = setup();
    toBf(s, ganker, 'bf0');
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([grunt, ganker], BF('bf1'))));
    expect(r.events).toHaveLength(2);
    for (const id of [grunt, ganker]) {
      expect(r.state.objects[id]!.zone).toMatchObject({ battlefieldId: 'bf1' });
      expect(r.state.objects[id]!.ready).toBe(false);
    }
  });
});

describe('standardMove illegal moves', () => {
  const fails = (s: GameState, i: StandardMoveIntent, code: string): void => {
    const r = standardMove(s, FIXTURE_CARDS, i);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  };

  it('rejects an exhausted unit', () => {
    // Tests Rule 144.2: moving exhausts, so the unit must be ready
    const { s, grunt } = setup();
    s.objects[grunt]!.ready = false;
    fails(s, mv([grunt], BF('bf0')), 'UNIT_EXHAUSTED');
  });

  it('rejects battlefield to battlefield without Ganking', () => {
    // Tests Rule 144.4.c.1: only Ganking units move between battlefields
    const { s, grunt } = setup();
    toBf(s, grunt, 'bf0');
    fails(s, mv([grunt], BF('bf1')), 'ILLEGAL_MOVE_DESTINATION');
  });

  it('rejects wrong destinations', () => {
    // Tests Rule 144.4: base->base, same battlefield, unknown battlefield
    const { s, grunt, ganker } = setup();
    fails(s, mv([grunt], { kind: 'base' }), 'ILLEGAL_MOVE_DESTINATION');
    fails(s, mv([grunt], BF('nope')), 'ILLEGAL_MOVE_DESTINATION');
    toBf(s, ganker, 'bf0');
    fails(s, mv([ganker], BF('bf0')), 'ILLEGAL_MOVE_DESTINATION');
  });

  it('rejects moves during a chain, a showdown or combat', () => {
    // Tests Rule 144.1.b: not in a Closed state; 144.1.c: not during a Showdown
    const { s, grunt } = setup();
    const closed = structuredClone(s);
    closed.flow.chain.push({
      id: 'c1',
      kind: 'CARD',
      sourceObjectId: grunt,
      controller: 'p0',
      status: 'FINALIZED',
      targets: [],
      choices: {},
    });
    fails(closed, mv([grunt], BF('bf0')), 'CLOSED_STATE_REACTION_ONLY');
    const sd = structuredClone(s);
    sd.flow.showdown = { battlefieldId: 'bf0', isCombat: false, passesInRow: 0 };
    fails(sd, mv([grunt], BF('bf0')), 'MOVE_NOT_ALLOWED_IN_SHOWDOWN');
    const cb = structuredClone(s);
    cb.flow.combat = { step: 'DAMAGE' };
    fails(cb, mv([grunt], BF('bf0')), 'MOVE_NOT_ALLOWED_IN_SHOWDOWN');
  });

  it('rejects moves in the wrong phase, on the opponent turn or without priority', () => {
    // Tests Rule 144.1.a: only the turn player in the Main Phase with Priority
    const { s, grunt, enemy } = setup();
    const draw = structuredClone(s);
    draw.turn.phase = 'DRAW';
    fails(draw, mv([grunt], BF('bf0')), 'WRONG_PHASE');
    fails(s, mv([enemy], BF('bf0'), 'p1'), 'NOT_YOUR_TURN');
    const np = structuredClone(s);
    np.flow.priority = 'p1';
    fails(np, mv([grunt], BF('bf0')), 'NOT_YOUR_PRIORITY');
  });

  it('rejects units the mover does not control, non-units and off-board units', () => {
    // Tests Rule 144: only your own units on the board may move
    const { s, grunt, enemy } = setup();
    fails(s, mv([enemy], BF('bf0')), 'NOT_OWNED');
    fails(s, mv(['zzz'], BF('bf0')), 'NOT_FOUND');
    fails(s, mv([], BF('bf0')), 'NOT_FOUND');
    fails(s, mv([grunt, grunt], BF('bf0')), 'ILLEGAL_TARGET');
    const rune = s.players[0].runeDeck[0]!;
    fails(s, mv([rune], BF('bf0')), 'WRONG_CARD_TYPE');
    const offBoard = toBase(s, 'fx-archer', 'p0');
    s.players[0].base = s.players[0].base.filter((i) => i !== offBoard);
    s.objects[offBoard]!.zone = { kind: 'trash', player: 'p0' };
    fails(s, mv([offBoard], BF('bf0')), 'ILLEGAL_LOCATION');
  });

  it('rejects the whole move if any unit is illegal and leaves state untouched', () => {
    // Tests Rule 144.3.a: all units must be able to move
    const { s, grunt, ganker } = setup();
    s.objects[ganker]!.ready = false;
    const before = structuredClone(s);
    fails(s, mv([grunt, ganker], BF('bf0')), 'UNIT_EXHAUSTED');
    expect(s).toEqual(before);
  });

  it('rejects after the game is over', () => {
    // Tests Rule 473.1: no actions once the game has ended
    const { s, grunt } = setup();
    s.gameStatus = 'FINISHED';
    fails(s, mv([grunt], BF('bf0')), 'GAME_OVER');
  });
});

describe('standardMove contested marking', () => {
  it('marks an uncontrolled battlefield contested by the mover', () => {
    // Tests Rule 190.3: moving to a battlefield you do not control contests it
    const { s, grunt } = setup();
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], BF('bf1'))));
    expect(r.state.battlefields[1]!.contestedBy).toBe('p0');
  });

  it('marks an enemy-controlled battlefield contested', () => {
    // Tests Rule 452: moving into an enemy-controlled battlefield contests it
    const { s, grunt } = setup();
    s.battlefields[1]!.controller = 'p1';
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], BF('bf1'))));
    expect(r.state.battlefields[1]!.contestedBy).toBe('p0');
  });

  it('does not contest a battlefield the mover already controls', () => {
    // Tests Rule 190.3: no contest on your own controlled battlefield
    const { s, grunt } = setup();
    s.battlefields[0]!.controller = 'p0';
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], BF('bf0'))));
    expect(r.state.battlefields[0]!.contestedBy).toBeNull();
  });

  it('keeps Contested when retreating to the base', () => {
    // Tests Rule 190.3.b: Contested persists until control is established
    const { s, grunt } = setup();
    toBf(s, grunt, 'bf1');
    s.battlefields[1]!.contestedBy = 'p0';
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], { kind: 'base' })));
    expect(r.state.battlefields[1]!.contestedBy).toBe('p0');
  });

  it('does not start a showdown or stage anything', () => {
    // Tests Rule 455: the cleanup loop, not the move, stages showdowns
    const { s, grunt } = setup();
    const r = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], BF('bf1'))));
    expect(r.state.flow.showdown).toBeUndefined();
    expect(r.state.flow.stagedShowdowns).toEqual([]);
    expect(r.state.flow.priority).toBe('p0');
  });
});

describe('standardMove purity', () => {
  it('does not mutate the input and is deterministic', () => {
    // Tests Rule 144: pure reducer step
    const { s, grunt } = setup();
    const before = structuredClone(s);
    const a = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], BF('bf0'))));
    const b = ok(standardMove(s, FIXTURE_CARDS, mv([grunt], BF('bf0'))));
    expect(s).toEqual(before);
    expect(a).toEqual(b);
  });

  it('canStandardMove agrees with standardMove', () => {
    // Tests Rule 144: legality check is side-effect free
    const { s, grunt } = setup();
    expect(canStandardMove(s, FIXTURE_CARDS, mv([grunt], BF('bf0'))).ok).toBe(true);
    expect(canStandardMove(s, FIXTURE_CARDS, mv([grunt], { kind: 'base' })).ok).toBe(false);
  });
});
