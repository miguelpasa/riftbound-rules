import { describe, expect, it } from 'vitest';
import { endTurn } from './phases.js';
import { standardMove } from './movement.js';
import { validateDeck } from './deckValidation.js';
import { playCard } from './play.js';
import { sanitizeEvents, sanitizeFor } from './sanitize.js';
import {
  KEYWORD_IMPLEMENTED,
  attachedMightBonus,
  deflectExtraCost,
  equip,
  hasKeyword,
  hideCard,
  keywordValue,
  makePlayHooks,
  playHiddenCard,
  quickDrawAttach,
  removeOrphanedFacedown,
  temporaryOnBeginning,
} from './keywords.js';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  getObjectByCardId,
  makeTestGame,
} from './testing/fixtures.js';
import { findLeaks } from './testing/leakCheck.js';
import { DEFERRED_KEYWORDS, MVP_KEYWORDS } from './types/index.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  GameState,
  PaymentPlan,
  PlayerId,
  ReduceResult,
  ZoneRef,
} from './types/index.js';

const idx = (p: PlayerId): 0 | 1 => (p === 'p0' ? 0 : 1);

function ok(r: ReduceResult): Extract<ReduceResult, { ok: true }> {
  if (!r.ok) throw new Error(r.message);
  return r;
}
function code(r: ReduceResult): string {
  if (r.ok) throw new Error('expected an error');
  return r.code;
}

const CARDS: CardDatabase = {
  ...FIXTURE_CARDS,
  'kx-hidden-unit': {
    cardId: 'kx-hidden-unit',
    name: 'Lurking Secret',
    type: 'UNIT',
    subtypes: [],
    cost: { energy: 3 },
    domains: ['Fury'],
    stats: { might: 3 },
    keywords: [{ name: 'Hidden' }],
    text: '[Hidden]',
    supportLevel: 'full',
  },
  'kx-hidden-unit2': {
    cardId: 'kx-hidden-unit2',
    name: 'Second Secret',
    type: 'UNIT',
    subtypes: [],
    cost: { energy: 3 },
    domains: ['Fury'],
    stats: { might: 2 },
    keywords: [{ name: 'Hidden' }],
    text: '[Hidden]',
    supportLevel: 'full',
  },
  'kx-temp': {
    cardId: 'kx-temp',
    name: 'Fleeting Spark',
    type: 'UNIT',
    subtypes: [],
    cost: { energy: 1 },
    domains: ['Mind'],
    stats: { might: 1 },
    keywords: [{ name: 'Temporary' }],
    text: '[Temporary]',
    supportLevel: 'full',
  },
  'kx-deflector': {
    cardId: 'kx-deflector',
    name: 'Mirror Guard',
    type: 'UNIT',
    subtypes: [],
    cost: { energy: 2 },
    domains: ['Mind'],
    stats: { might: 2 },
    keywords: [{ name: 'Deflect', value: 1 }],
    text: '[Deflect 1]',
    supportLevel: 'full',
  },
  'kx-deflector3': {
    cardId: 'kx-deflector3',
    name: 'Twin Mirror',
    type: 'UNIT',
    subtypes: [],
    cost: { energy: 2 },
    domains: ['Mind'],
    stats: { might: 2 },
    keywords: [
      { name: 'Deflect', value: 1 },
      { name: 'Deflect', value: 2 },
    ],
    text: '',
    supportLevel: 'full',
  },
  'kx-sword': {
    cardId: 'kx-sword',
    name: 'Keen Sword',
    type: 'GEAR',
    subtypes: ['Equipment'],
    cost: { energy: 1 },
    domains: [],
    stats: { might: 2 },
    keywords: [{ name: 'Equip', value: 1 }],
    text: '[Equip 1]',
    supportLevel: 'full',
  },
  'kx-quick': {
    cardId: 'kx-quick',
    name: 'Snap Holster',
    type: 'GEAR',
    subtypes: ['Equipment'],
    cost: { energy: 1 },
    domains: [],
    stats: { might: 1 },
    keywords: [{ name: 'QuickDraw' }, { name: 'Reaction' }],
    text: '[Quick-Draw]',
    supportLevel: 'full',
  },
};

let counter = 0;
/** Create a brand new object (not part of any deck). */
function spawn(
  s: GameState,
  cardId: string,
  owner: PlayerId,
  zone: ZoneRef = { kind: 'base', player: owner },
): string {
  const id = `ox${counter++}`;
  const o: CardInstance = {
    id,
    cardId,
    owner,
    controller: owner,
    zone,
    ready: true,
    damage: 0,
    mightBonus: 0,
  };
  s.objects[id] = o;
  const p = s.players[idx(owner)];
  if (zone.kind === 'base') p.base.push(id);
  if (zone.kind === 'hand') p.hand.push(id);
  return id;
}

function giveRunes(s: GameState, owner: PlayerId, runeCardId: string, n: number): string[] {
  const p = s.players[idx(owner)];
  const ids = p.runeDeck.filter((i) => s.objects[i]?.cardId === runeCardId).slice(0, n);
  for (const id of ids) {
    p.runeDeck = p.runeDeck.filter((i) => i !== id);
    p.base.push(id);
    const o = s.objects[id] as CardInstance;
    o.zone = { kind: 'base', player: owner };
    o.ready = true;
  }
  return ids;
}

/** p0 active in MAIN with priority; p0 controls battlefield 0 and 1; 6 fury runes. */
function setup(): { s: GameState; bf: string; bf2: string } {
  const s = makeTestGame('kw');
  s.flow.priority = 'p0';
  const b0 = s.battlefields[0];
  const b1 = s.battlefields[1];
  if (!b0 || !b1) throw new Error('battlefields');
  b0.controller = 'p0';
  b1.controller = 'p0';
  giveRunes(s, 'p0', 'fx-rune-fury', 6);
  giveRunes(s, 'p1', 'fx-rune-mind', 3);
  return { s, bf: b0.id, bf2: b1.id };
}

const hide = (s: GameState, cardInstanceId: string, battlefieldId: string, p: PlayerId = 'p0') =>
  hideCard(s, CARDS, { type: 'HIDE_CARD', playerId: p, cardInstanceId, battlefieldId });

describe('keyword helpers', () => {
  it('KEYWORD_IMPLEMENTED matches MVP and deferred keyword lists', () => {
    // Tests Rule 700: keyword implementation table matches MVP_KEYWORDS
    for (const k of MVP_KEYWORDS) expect(KEYWORD_IMPLEMENTED[k]).toBe(true);
    for (const k of DEFERRED_KEYWORDS) expect(KEYWORD_IMPLEMENTED[k]).toBe(false);
  });

  it('hasKeyword and keywordValue read CardDef.keywords', () => {
    // Tests Rule 700: keyword lookup
    expect(hasKeyword(CARDS['fx-ganker'] as CardDef, 'Ganking')).toBe(true);
    expect(hasKeyword(CARDS['fx-grunt'] as CardDef, 'Ganking')).toBe(false);
    expect(keywordValue(CARDS['fx-raider'] as CardDef, 'Assault')).toBe(1);
    expect(keywordValue(CARDS['kx-deflector3'] as CardDef, 'Deflect')).toBe(3);
    expect(keywordValue(CARDS['fx-grunt'] as CardDef, 'Deflect')).toBe(0);
  });
});

describe('Existing keywords still work', () => {
  it('Ganking lets a unit move between battlefields', () => {
    // Tests Rule 144.4.c.1: Ganking allows battlefield to battlefield moves
    const { s, bf, bf2 } = setup();
    const g = spawn(s, 'fx-ganker', 'p0', { kind: 'battlefield', player: 'p0', battlefieldId: bf });
    const n = spawn(s, 'fx-grunt', 'p0', { kind: 'battlefield', player: 'p0', battlefieldId: bf });
    const mv = (u: string) =>
      standardMove(s, CARDS, {
        type: 'STANDARD_MOVE',
        playerId: 'p0',
        unitIds: [u],
        destination: { kind: 'battlefield', battlefieldId: bf2 },
      });
    expect(mv(g).ok).toBe(true);
    expect(mv(n).ok).toBe(false);
  });

  it('Unique limits a deck to one copy', () => {
    // Tests Rule 103.3: Unique cards are limited to one copy
    const cards: CardDatabase = {
      ...CARDS,
      'fx-grunt': { ...(CARDS['fx-grunt'] as CardDef), keywords: [{ name: 'Unique' }] },
    };
    expect(validateDeck(cards, FIXTURE_DECK_A).ok).toBe(false);
  });
});

describe('Temporary', () => {
  it('kills the active player Temporary units to the trash and detaches equipment', () => {
    // Tests Rule 701: Temporary units die at the start of the controller's Beginning Phase
    const { s } = setup();
    s.turn.activePlayer = 'p1';
    const t = spawn(s, 'kx-temp', 'p1');
    const keep = spawn(s, 'fx-grunt', 'p1');
    const mine = spawn(s, 'kx-temp', 'p0');
    const sw = spawn(s, 'kx-sword', 'p1');
    (s.objects[sw] as CardInstance).attachedTo = t;
    const r = temporaryOnBeginning(s, CARDS);
    expect(r.events).toEqual([{ type: 'UNIT_KILLED', unitId: t }]);
    expect(r.state.objects[t]?.zone).toEqual({ kind: 'trash', player: 'p1' });
    expect(r.state.players[1].trash).toContain(t);
    expect(r.state.players[1].base).not.toContain(t);
    expect(r.state.objects[sw]?.attachedTo).toBeUndefined();
    expect(r.state.objects[keep]?.zone.kind).toBe('base');
    expect(r.state.objects[mine]?.zone.kind).toBe('base'); // not the active player's
    expect(s.objects[t]?.zone.kind).toBe('base'); // input untouched
  });

  it('dies before the Scoring step', () => {
    // Tests Rule 315.2: Beginning effects happen before scoring
    const { s } = setup();
    const t = spawn(s, 'kx-temp', 'p1');
    let seen: string | null = null;
    const r = ok(
      endTurn(
        s,
        CARDS,
        { type: 'END_TURN', playerId: 'p0' },
        {
          onBeginning: temporaryOnBeginning,
          onScoringStep: (st) => {
            seen = st.objects[t]?.zone.kind ?? null;
            return { state: st, events: [] };
          },
        },
      ),
    );
    expect(seen).toBe('trash');
    expect(r.state.objects[t]?.zone.kind).toBe('trash');
    expect(r.events.some((e) => e.type === 'UNIT_KILLED')).toBe(true);
  });
});

describe('Hidden', () => {
  it('hides a Hidden card facedown for 1 Power', () => {
    // Tests Rule 811: pay 1 Power to hide a card at a battlefield you control
    const { s, bf } = setup();
    const id = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const r = ok(hide(s, id, bf));
    const o = r.state.objects[id] as CardInstance;
    expect(o.zone).toEqual({ kind: 'facedown', player: 'p0', battlefieldId: bf });
    expect(o.facedown).toBe(true);
    expect(o.hidden).toBe(true);
    expect(r.state.players[0].hand).not.toContain(id);
    expect(r.state.battlefields[0]?.facedownSlotId).toBe(id);
    // one rune was recycled for the Power
    expect(r.state.players[0].base.length).toBe(s.players[0].base.length - 1);
    expect(s.objects[id]?.zone.kind).toBe('hand'); // input untouched
  });

  it('allows only one facedown card per battlefield', () => {
    // Tests Rule 811: at most one facedown card per battlefield
    const { s, bf, bf2 } = setup();
    const a = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const b = spawn(s, 'kx-hidden-unit2', 'p0', { kind: 'hand', player: 'p0' });
    const r1 = ok(hide(s, a, bf));
    expect(code(hide(r1.state, b, bf))).toBe('HIDDEN_NOT_ALLOWED');
    expect(hide(r1.state, b, bf2).ok).toBe(true);
  });

  it('only on a battlefield you control, only Hidden cards, only from hand', () => {
    // Tests Rule 811: Hidden can only target controlled battlefields
    const { s, bf } = setup();
    const a = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const plain = spawn(s, 'fx-grunt', 'p0', { kind: 'hand', player: 'p0' });
    const lost = structuredClone(s);
    (lost.battlefields[0] as { controller: PlayerId | null }).controller = 'p1';
    expect(code(hide(lost, a, bf))).toBe('HIDDEN_NOT_ALLOWED');
    expect(code(hide(s, plain, bf))).toBe('HIDDEN_NOT_ALLOWED');
    const onBoard = spawn(s, 'kx-hidden-unit2', 'p0');
    expect(code(hide(s, onBoard, bf))).toBe('NOT_IN_HAND');
    expect(code(hide(s, a, 'nope'))).toBe('HIDDEN_NOT_ALLOWED');
  });

  it('needs 1 Power, your turn, Main phase and an Open state', () => {
    // Tests Rule 422.2.a: hide only on your turn in an Open state
    const { s, bf } = setup();
    const a = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const broke = structuredClone(s);
    broke.players[0].base = broke.players[0].base.filter(
      (i) => broke.objects[i]?.cardId !== 'fx-rune-fury',
    );
    expect(code(hide(broke, a, bf))).toBe('INSUFFICIENT_RESOURCES');
    const theirs = structuredClone(s);
    theirs.turn.activePlayer = 'p1';
    expect(code(hide(theirs, a, bf))).toBe('NOT_YOUR_TURN');
    const closed = structuredClone(s);
    closed.flow.chain.push({
      id: 'c1',
      kind: 'CARD',
      sourceObjectId: a,
      controller: 'p1',
      status: 'FINALIZED',
      targets: [],
      choices: {},
    });
    expect(hide(closed, a, bf).ok).toBe(false);
    const wrongPhase = structuredClone(s);
    wrongPhase.turn.phase = 'DRAW';
    expect(code(hide(wrongPhase, a, bf))).toBe('WRONG_PHASE');
  });

  it('cannot be played on the turn it was hidden', () => {
    // Tests Rule 811: a hidden card is usable from the next turn
    const { s, bf } = setup();
    const id = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const h = ok(hide(s, id, bf));
    const r = playHiddenCard(h.state, CARDS, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: id,
      payment: [],
    });
    expect(code(r)).toBe('HIDDEN_NOT_ALLOWED');
  });

  it('plays for 0 on your next turn, entering at its battlefield', () => {
    // Tests Rule 811: a hidden card costs 0 and units enter at that battlefield
    const { s, bf } = setup();
    const id = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const h = ok(hide(s, id, bf)).state;
    h.turn.number = 3;
    h.turn.activePlayer = 'p0';
    h.flow.priority = 'p0';
    const r = ok(
      playHiddenCard(h, CARDS, {
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: id,
        payment: [],
      }),
    );
    const o = r.state.objects[id] as CardInstance;
    expect(o.zone).toEqual({ kind: 'battlefield', player: 'p0', battlefieldId: bf });
    expect(o.facedown).toBeUndefined();
    expect(r.state.battlefields[0]?.facedownSlotId).toBeNull();
    // no resources spent
    expect(r.state.players[0].runePool).toEqual({ energy: 0, power: {} });
  });

  it('gains Reaction: playable on the opponent turn and in a Closed state', () => {
    // Tests Rule 811: a hidden card gains Reaction
    const { s, bf } = setup();
    const id = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const h = ok(hide(s, id, bf)).state;
    h.turn.number = 2;
    h.turn.activePlayer = 'p1';
    h.flow.priority = 'p0';
    const r = playHiddenCard(h, CARDS, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: id,
      payment: [],
    });
    expect(r.ok).toBe(true);
    // The opponent cannot play my facedown card.
    const bad = playHiddenCard(h, CARDS, {
      type: 'PLAY_CARD',
      playerId: 'p1',
      cardInstanceId: id,
      payment: [],
    });
    expect(code(bad)).toBe('NOT_OWNED');
  });

  it('removes a facedown card when its battlefield is no longer controlled (cleanup)', () => {
    // Tests Rule 318: orphaned facedown cards go to the trash at cleanup
    const { s, bf } = setup();
    const id = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const h = ok(hide(s, id, bf)).state;
    const w = structuredClone(h);
    expect(removeOrphanedFacedown(w, CARDS)).toEqual([]);
    expect(w.objects[id]?.zone.kind).toBe('facedown'); // still controlled
    (w.battlefields[0] as { controller: PlayerId | null }).controller = null;
    removeOrphanedFacedown(w, CARDS);
    expect(w.objects[id]?.zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(w.players[0].trash).toContain(id);
    expect(w.battlefields[0]?.facedownSlotId).toBeNull();
  });

  it('does not leak the hidden card to the opponent (state and events)', () => {
    // Tests Rule 128: a facedown card is private to its controller
    const { s, bf } = setup();
    const id = spawn(s, 'kx-hidden-unit', 'p0', { kind: 'hand', player: 'p0' });
    const r = ok(hide(s, id, bf));
    const names: Record<string, string> = { 'kx-hidden-unit': 'Lurking Secret' };
    const view = sanitizeFor(r.state, 'p1');
    expect(findLeaks(view, r.state, 'p1', { cardNames: names })).toEqual([]);
    const evs = sanitizeEvents(r.events, 'p1');
    expect(evs).toEqual([]);
    expect(findLeaks(evs, r.state, 'p1', { cardNames: names })).toEqual([]);
    // The controller does see it.
    expect(sanitizeEvents(r.events, 'p0')).toHaveLength(1);
    expect(findLeaks(sanitizeFor(r.state, 'p0'), r.state, 'p0')).toEqual([]);
  });
});

describe('Deflect', () => {
  function withDeflector(cardId: string): { s: GameState; target: string; flare: string } {
    const { s } = setup();
    const target = spawn(s, cardId, 'p1');
    const flare = spawn(s, 'fx-flare', 'p0', { kind: 'hand', player: 'p0' });
    return { s, target, flare };
  }

  it('adds N Power for an opponent targeting the unit, stacking instances and targets', () => {
    // Tests Rule 809: Deflect N costs N additional Power per targeting
    const { s, target } = withDeflector('kx-deflector');
    const t3 = spawn(s, 'kx-deflector3', 'p1');
    const mine = spawn(s, 'kx-deflector', 'p0');
    const plain = spawn(s, 'fx-grunt', 'p1');
    const obj = (id: string) => ({ kind: 'object' as const, id });
    expect(deflectExtraCost(s, CARDS, 'p0', [obj(target)])).toEqual({ anyPower: 1 });
    expect(deflectExtraCost(s, CARDS, 'p0', [obj(t3)])).toEqual({ anyPower: 3 });
    expect(deflectExtraCost(s, CARDS, 'p0', [obj(target), obj(t3), obj(target)])).toEqual({
      anyPower: 4,
    });
    expect(deflectExtraCost(s, CARDS, 'p0', [obj(mine)])).toBeNull(); // own unit
    expect(deflectExtraCost(s, CARDS, 'p0', [obj(plain)])).toBeNull();
    expect(deflectExtraCost(s, CARDS, 'p0', [{ kind: 'player', playerId: 'p1' }])).toBeNull();
  });

  it('playCard fails without the extra Power and succeeds with it', () => {
    // Tests Rule 356.2.a.2: Deflect is a mandatory additional cost
    const { s, target, flare } = withDeflector('kx-deflector');
    const runes = s.players[0].base.filter((i) => s.objects[i]?.cardId === 'fx-rune-fury');
    const exhaust = (ids: string[]): PaymentPlan =>
      ids.map((runeId) => ({ runeId, mode: 'EXHAUST' }));
    const base = {
      type: 'PLAY_CARD' as const,
      playerId: 'p0' as const,
      cardInstanceId: flare,
      targets: [{ kind: 'object' as const, id: target }],
    };
    const hooks = makePlayHooks();
    const bad = playCard(
      s,
      CARDS,
      { ...base, payment: exhaust(runes.slice(0, 1)) },
      undefined,
      hooks,
    );
    expect(code(bad)).toBe('INSUFFICIENT_RESOURCES');
    // Without the hooks the same play is legal (Deflect is only applied through the hooks).
    expect(playCard(s, CARDS, { ...base, payment: exhaust(runes.slice(0, 1)) }).ok).toBe(true);
    const good = playCard(
      s,
      CARDS,
      {
        ...base,
        payment: [
          { runeId: runes[0] as string, mode: 'EXHAUST' },
          { runeId: runes[1] as string, mode: 'RECYCLE' },
        ],
      },
      undefined,
      hooks,
    );
    expect(good.ok).toBe(true);
  });

  it('makePlayHooks combines with base hooks', () => {
    // Tests Rule 356.2.a.2: hook composition keeps other surcharges
    const { s, target, flare } = withDeflector('kx-deflector');
    const hooks = makePlayHooks({
      extraCosts: () => ({ energy: 1, power: 1 }),
      onEnter: () => [{ type: 'EFFECT_UNIMPLEMENTED', cardId: 'x' }],
    });
    const def = CARDS['fx-flare'] as CardDef;
    const mod = hooks.extraCosts?.(s, CARDS, 'p0', def, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: flare,
      targets: [{ kind: 'object', id: target }],
      payment: [],
    });
    expect(mod).toEqual({ energy: 1, power: 1, anyPower: 1 });
    expect(hooks.onEnter?.(s, CARDS, target)).toHaveLength(1);
  });
});

describe('Equip', () => {
  function board(): { s: GameState; sw: string; u1: string; u2: string; opp: string } {
    const { s } = setup();
    return {
      s,
      sw: spawn(s, 'kx-sword', 'p0'),
      u1: spawn(s, 'fx-grunt', 'p0'),
      u2: spawn(s, 'fx-wisp', 'p0'),
      opp: spawn(s, 'fx-tide-grunt', 'p1'),
    };
  }
  const eq = (s: GameState, equipmentId: string, unitId: string, p: PlayerId = 'p0') =>
    equip(s, CARDS, { type: 'EQUIP', playerId: p, equipmentId, unitId });

  it('attaches, pays the Equip energy cost, and grants a Might bonus', () => {
    // Tests Rule 818: Equip attaches Equipment to a unit you control
    const { s, sw, u1 } = board();
    const r = ok(eq(s, sw, u1));
    expect(r.state.objects[sw]?.attachedTo).toBe(u1);
    expect(r.state.players[0].runePool.energy).toBe(0);
    expect(r.state.players[0].base.filter((i) => r.state.objects[i]?.ready === false)).toHaveLength(
      1,
    );
    expect(attachedMightBonus(r.state, CARDS, u1)).toBe(2); // Rule 137.3
    expect(attachedMightBonus(s, CARDS, u1)).toBe(0);
  });

  it('reattaching moves the Equipment', () => {
    // Tests Rule 818: Equip may move attached Equipment to another unit
    const { s, sw, u1, u2 } = board();
    const a = ok(eq(s, sw, u1)).state;
    const b = ok(eq(a, sw, u2)).state;
    expect(b.objects[sw]?.attachedTo).toBe(u2);
    expect(attachedMightBonus(b, CARDS, u1)).toBe(0);
    expect(attachedMightBonus(b, CARDS, u2)).toBe(2);
  });

  it('rejects illegal timings, targets and payments', () => {
    // Tests Rule 145.2: Equip is an activated ability usable on your turn in a Neutral Open state
    const { s, sw, u1, opp } = board();
    expect(code(eq(s, sw, opp))).toBe('EQUIP_ILLEGAL'); // not my unit
    const hand = spawn(s, 'kx-sword', 'p0', { kind: 'hand', player: 'p0' });
    expect(code(eq(s, hand, u1))).toBe('EQUIP_ILLEGAL'); // equipment not on board
    const notUnit = spawn(s, 'fx-ember-totem', 'p0');
    expect(code(eq(s, sw, notUnit))).toBe('EQUIP_ILLEGAL');
    expect(code(eq(s, notUnit, u1))).toBe('EQUIP_ILLEGAL'); // not Equipment
    const theirs = structuredClone(s);
    theirs.turn.activePlayer = 'p1';
    expect(code(eq(theirs, sw, u1))).toBe('NOT_YOUR_TURN');
    const closed = structuredClone(s);
    closed.flow.chain.push({
      id: 'c1',
      kind: 'CARD',
      sourceObjectId: sw,
      controller: 'p1',
      status: 'FINALIZED',
      targets: [],
      choices: {},
    });
    expect(eq(closed, sw, u1).ok).toBe(false);
    const wrongPhase = structuredClone(s);
    wrongPhase.turn.phase = 'ENDING';
    expect(code(eq(wrongPhase, sw, u1))).toBe('WRONG_PHASE');
    const broke = structuredClone(s);
    broke.players[0].base = broke.players[0].base.filter(
      (i) => broke.objects[i]?.cardId !== 'fx-rune-fury',
    );
    expect(code(eq(broke, sw, u1))).toBe('INSUFFICIENT_RESOURCES');
  });

  it('Quick-Draw gear attaches to a unit you control for free', () => {
    // Tests Rule 819: Quick-Draw attaches when the gear enters play
    const { s, u1, opp } = board();
    const qd = spawn(s, 'kx-quick', 'p0');
    const r = ok(quickDrawAttach(s, CARDS, qd, u1));
    expect(r.state.objects[qd]?.attachedTo).toBe(u1);
    expect(attachedMightBonus(r.state, CARDS, u1)).toBe(1);
    expect(code(quickDrawAttach(s, CARDS, qd, opp))).toBe('EQUIP_ILLEGAL');
    const plain = spawn(s, 'kx-sword', 'p0');
    expect(code(quickDrawAttach(s, CARDS, plain, u1))).toBe('EQUIP_ILLEGAL');
  });

  it('exports sane lookup for the fixture blade (valueless Equip is free)', () => {
    // Tests Rule 818: Equip without a value costs no Energy
    const { s } = setup();
    const blade = getObjectByCardId(s, 'fx-blade', 'p0');
    const u = spawn(s, 'fx-grunt', 'p0');
    s.players[0].base = s.players[0].base.filter((i) => s.objects[i]?.cardId !== 'fx-rune-fury');
    const b = spawn(s, 'fx-blade', 'p0');
    expect(blade).toBeDefined();
    expect(eq(s, b, u).ok).toBe(true);
  });
});
