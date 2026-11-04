/**
 * Scenario builder for end-to-end rule tests.
 *
 * A Scenario is created through the REAL setup path (createGame with the synthetic fixtures, then
 * both mulligan decisions through `reduce`), after which a test may surgically rearrange the board
 * (`giveRunes`, `putInHand`, `putUnit`, `setPoints`, `setDeckSize`, `setMainPhase`, ...) and then
 * drive the game ONLY through `reduce` (`do`, `tryDo`, `reject`). Surgery keeps zone arrays and
 * ZoneRefs consistent; `verify()` (also run after every accepted `do`) asserts `checkInvariants`.
 *
 * Seating: the engine picks the first player at random (Rule 115), so `Scenario.start` tries
 * `${seed}-0`, `${seed}-1`, ... until the requested deck (default A) is seated as p0. The result is
 * therefore deterministic: p0 plays DECK A (Fury/Calm), p1 plays DECK B (Mind/Order).
 *
 * Isomorphic: no Node or DOM APIs.
 */
import { checkInvariants } from '../invariants.js';
import { reduce } from '../reducer.js';
import { createGame } from '../setup.js';
import { stateHash } from '../replay.js';
import { opponentOf, playerIndex } from '../types/constants.js';
import type {
  BattlefieldState,
  CardDatabase,
  CardDef,
  CardInstance,
  DeckList,
  Domain,
  GameEvent,
  GameState,
  Intent,
  PaymentPlan,
  PlayerId,
  ReduceResult,
  RuleError,
} from '../types/index.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from './fixtures.js';

/** Hidden units (the plain fixtures have none): one per deck so their cardId is unambiguous. */
export const SC_LURKER_A = 'sc-lurker-a';
export const SC_LURKER_B = 'sc-lurker-b';

const lurker = (cardId: string, name: string, domain: Domain): CardDef => ({
  cardId,
  name,
  type: 'UNIT',
  subtypes: [],
  cost: { energy: 2 },
  domains: [domain],
  stats: { might: 2 },
  keywords: [{ name: 'Hidden' }],
  text: '[Hidden]',
  supportLevel: 'full',
});

/** FIXTURE_CARDS plus the two Hidden lurkers. */
export const SCENARIO_CARDS: CardDatabase = {
  ...FIXTURE_CARDS,
  [SC_LURKER_A]: lurker(SC_LURKER_A, 'Lurker A', 'Fury'),
  [SC_LURKER_B]: lurker(SC_LURKER_B, 'Lurker B', 'Mind'),
};

function swapFirst(deck: DeckList, from: string, to: string): DeckList {
  const i = deck.mainDeck.indexOf(from);
  if (i < 0) throw new Error(`deck has no ${from}`);
  const mainDeck = [...deck.mainDeck];
  mainDeck[i] = to;
  return { ...deck, mainDeck };
}

/** Fixture decks with one fx-wisp swapped for the deck's own Hidden lurker. */
export const SCENARIO_DECK_A: DeckList = swapFirst(FIXTURE_DECK_A, 'fx-wisp', SC_LURKER_A);
export const SCENARIO_DECK_B: DeckList = swapFirst(FIXTURE_DECK_B, 'fx-wisp', SC_LURKER_B);

/** Card ids per seat, so scenarios do not hard-code which deck a player has. */
export interface Kit {
  grunt: string;
  tank: string;
  archer: string;
  shielder: string;
  ganker: string;
  wisp: string;
  titan: string;
  action: string;
  reaction: string;
  lurker: string;
  rune: string;
}

export const KIT_A: Kit = {
  grunt: 'fx-grunt',
  tank: 'fx-ash-tank',
  archer: 'fx-archer',
  shielder: 'fx-shielder',
  ganker: 'fx-ganker',
  wisp: 'fx-wisp',
  titan: 'fx-titan',
  action: 'fx-flare',
  reaction: 'fx-ward',
  lurker: SC_LURKER_A,
  rune: 'fx-rune-fury',
};

export const KIT_B: Kit = {
  grunt: 'fx-tide-grunt',
  tank: 'fx-order-tank',
  archer: 'fx-tide-archer',
  shielder: 'fx-order-shielder',
  ganker: 'fx-tide-ganker',
  wisp: 'fx-wisp',
  titan: 'fx-order-titan',
  action: 'fx-tide-surge',
  reaction: 'fx-tide-guard',
  lurker: SC_LURKER_B,
  rune: 'fx-rune-mind',
};

export interface StartOptions {
  /** Base seed; a numeric suffix is appended until the requested deck sits in seat p0. */
  seed?: string;
  /** Which deck should be seated as p0 (default 'A'). */
  p0Deck?: 'A' | 'B';
}

export interface PutUnitOptions {
  /** Default true. */
  ready?: boolean;
  damage?: number;
  mightBonus?: number;
  /** For battlefield placement: also make `player` the battlefield's controller (clears Contested). */
  control?: boolean;
}

const objNum = (id: string): number => Number(id.slice(1));

export class Scenario {
  state: GameState;
  readonly cards: CardDatabase;
  /** Every event emitted by accepted intents since the scenario started (setup draws excluded). */
  readonly events: GameEvent[] = [];
  /** Every accepted intent, in order. */
  readonly intents: Intent[] = [];
  /** Seed actually used (after the seating search). */
  readonly seed: string;

  private constructor(state: GameState, cards: CardDatabase, seed: string) {
    this.state = state;
    this.cards = cards;
    this.seed = seed;
  }

  // ------------------------------------------------------------------ construction

  /** A game in the MULLIGAN phase (real setup). */
  static begin(opts: StartOptions = {}, cards: CardDatabase = SCENARIO_CARDS): Scenario {
    const base = opts.seed ?? 'scenario';
    const wantLegend = (opts.p0Deck ?? 'A') === 'A' ? 'fx-legend-ember' : 'fx-legend-tide';
    for (let i = 0; i < 64; i++) {
      const seed = `${base}-${i}`;
      const state = createGame(cards, [SCENARIO_DECK_A, SCENARIO_DECK_B], seed);
      const legend = state.objects[state.players[0].legend as string] as CardInstance;
      if (legend.cardId === wantLegend) return new Scenario(state, cards, seed);
    }
    throw new Error('could not seat the requested deck as p0');
  }

  /** Real setup plus both players keeping their hands: MAIN phase, turn 1, p0 to act. */
  static start(opts: StartOptions = {}, cards: CardDatabase = SCENARIO_CARDS): Scenario {
    const sc = Scenario.begin(opts, cards);
    sc.do({ type: 'MULLIGAN', playerId: 'p0', cardIds: [] });
    sc.do({ type: 'MULLIGAN', playerId: 'p1', cardIds: [] });
    return sc;
  }

  /** Card ids of the deck seated at `player`. */
  kit(player: PlayerId): Kit {
    return player === 'p0' ? KIT_A : KIT_B;
  }

  // ------------------------------------------------------------------ driving the game

  /** Apply an intent through `reduce`; throws with the rule error if it is rejected. */
  do(intent: Intent): Extract<ReduceResult, { ok: true }> {
    const r = reduce(this.state, this.cards, intent);
    if (!r.ok) throw new Error(`${intent.type} by ${intent.playerId} rejected: ${r.message}`);
    this.state = r.state;
    this.events.push(...r.events);
    this.intents.push(intent);
    this.verify();
    return r;
  }

  /** Apply an intent if legal; either way return the raw result. */
  tryDo(intent: Intent): ReduceResult {
    const r = reduce(this.state, this.cards, intent);
    if (r.ok) {
      this.state = r.state;
      this.events.push(...r.events);
      this.intents.push(intent);
    }
    return r;
  }

  /** Assert the intent is rejected and leaves the state untouched; returns the error. */
  reject(intent: Intent): RuleError {
    const before = stateHash(this.state);
    const r = reduce(this.state, this.cards, intent);
    if (r.ok) throw new Error(`${intent.type} by ${intent.playerId} was unexpectedly accepted`);
    if (stateHash(this.state) !== before) throw new Error('a rejected intent changed the state');
    return r;
  }

  pass(player: PlayerId): Extract<ReduceResult, { ok: true }> {
    return this.do({ type: 'PASS_PRIORITY', playerId: player });
  }

  endTurn(player?: PlayerId): Extract<ReduceResult, { ok: true }> {
    return this.do({ type: 'END_TURN', playerId: player ?? this.state.turn.activePlayer });
  }

  /** PLAY_CARD through `do`; pass `payment` (see `exhaustPlan`) when the card costs something. */
  play(
    player: PlayerId,
    cardInstanceId: string,
    extra: Partial<
      Omit<Extract<Intent, { type: 'PLAY_CARD' }>, 'type' | 'playerId' | 'cardInstanceId'>
    > = {},
  ): Extract<ReduceResult, { ok: true }> {
    return this.do({ type: 'PLAY_CARD', playerId: player, cardInstanceId, payment: [], ...extra });
  }

  /** Payment plan exhausting the first `n` ready runes of `player`. */
  exhaustPlan(player: PlayerId, n: number): PaymentPlan {
    const ready = this.runes(player).filter((r) => r.ready);
    if (ready.length < n) throw new Error(`${player} has only ${ready.length} ready runes`);
    return ready.slice(0, n).map((r) => ({ runeId: r.id, mode: 'EXHAUST' as const }));
  }

  /** Throws if any structural invariant is violated. */
  verify(): this {
    const bad = checkInvariants(this.state, this.cards);
    if (bad.length > 0) throw new Error(`invariant violations:\n  - ${bad.join('\n  - ')}`);
    return this;
  }

  // ------------------------------------------------------------------ queries

  player(p: PlayerId): GameState['players'][number] {
    return this.state.players[playerIndex(p)] as GameState['players'][number];
  }

  obj(id: string): CardInstance {
    const o = this.state.objects[id];
    if (!o) throw new Error(`no object ${id}`);
    return o;
  }

  bf(id: string): BattlefieldState {
    const b = this.state.battlefields.find((x) => x.id === id);
    if (!b) throw new Error(`no battlefield ${id}`);
    return b;
  }

  /** Runes in `player`'s base in base order. */
  runes(player: PlayerId): CardInstance[] {
    return this.player(player)
      .base.map((id) => this.obj(id))
      .filter((o) => this.cards[o.cardId]?.type === 'RUNE');
  }

  /** Objects of `player` that are units located at battlefield `bfId`. */
  unitsAt(bfId: string, player?: PlayerId): CardInstance[] {
    return Object.values(this.state.objects)
      .filter(
        (o) =>
          o.zone.kind === 'battlefield' &&
          o.zone.battlefieldId === bfId &&
          (player === undefined || o.controller === player),
      )
      .sort((a, b) => objNum(a.id) - objNum(b.id));
  }

  eventsOfType<T extends GameEvent['type']>(
    type: T,
    from: GameEvent[] = this.events,
  ): Extract<GameEvent, { type: T }>[] {
    return from.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
  }

  // ------------------------------------------------------------------ surgery

  private edit(fn: (s: GameState) => void): this {
    const s = structuredClone(this.state);
    fn(s);
    this.state = s;
    return this;
  }

  /** Remove `id` from whichever zone array currently lists it (objects in battlefield zones have none). */
  private static detach(s: GameState, o: CardInstance): void {
    const ps = s.players[playerIndex(o.zone.player)] as GameState['players'][number];
    const drop = (arr: string[]): string[] => arr.filter((x) => x !== o.id);
    switch (o.zone.kind) {
      case 'hand':
        ps.hand = drop(ps.hand);
        break;
      case 'mainDeck':
        ps.mainDeck = drop(ps.mainDeck);
        break;
      case 'runeDeck':
        ps.runeDeck = drop(ps.runeDeck);
        break;
      case 'trash':
        ps.trash = drop(ps.trash);
        break;
      case 'banishment':
        ps.banishment = drop(ps.banishment);
        break;
      case 'base':
        ps.base = drop(ps.base);
        break;
      case 'champion':
        ps.championZone = drop(ps.championZone);
        break;
      case 'facedown': {
        const bfId = o.zone.battlefieldId;
        const bf = s.battlefields.find((b) => b.id === bfId);
        if (bf && bf.facedownSlotId === o.id) bf.facedownSlotId = null;
        break;
      }
      default:
        throw new Error(`cannot detach ${o.id} from ${o.zone.kind}`);
    }
  }

  private static findSource(
    s: GameState,
    player: PlayerId,
    cardId: string,
    zones: string[],
    avoid: Set<string> = new Set(),
  ): CardInstance {
    const found = Object.values(s.objects)
      .filter(
        (o) =>
          o.owner === player &&
          o.cardId === cardId &&
          zones.includes(o.zone.kind) &&
          !avoid.has(o.id),
      )
      .sort((a, b) => objNum(a.id) - objNum(b.id))[0];
    if (!found) throw new Error(`${player} has no spare ${cardId} in ${zones.join('/')}`);
    return found;
  }

  /** Move a spare copy of `cardId` (from deck, trash or champion zone) into `player`'s hand. */
  putInHand(player: PlayerId, cardId: string): string {
    let id = '';
    this.edit((s) => {
      const o = Scenario.findSource(s, player, cardId, ['mainDeck', 'trash', 'champion']);
      Scenario.detach(s, o);
      o.zone = { kind: 'hand', player };
      (s.players[playerIndex(player)] as GameState['players'][number]).hand.push(o.id);
      id = o.id;
    });
    return id;
  }

  /**
   * Put a unit of `cardId` into play for `player`, in the base or at battlefield `where`.
   * Surgical: no cost, no chain, no Cleanup. Returns the object id.
   */
  putUnit(
    player: PlayerId,
    cardId: string,
    where: 'base' | string,
    opts: PutUnitOptions = {},
  ): string {
    let id = '';
    this.edit((s) => {
      const o = Scenario.findSource(s, player, cardId, ['mainDeck', 'hand', 'trash', 'champion']);
      Scenario.detach(s, o);
      if (where === 'base') {
        o.zone = { kind: 'base', player };
        (s.players[playerIndex(player)] as GameState['players'][number]).base.push(o.id);
      } else {
        const bf = s.battlefields.find((b) => b.id === where);
        if (!bf) throw new Error(`no battlefield ${where}`);
        o.zone = { kind: 'battlefield', player, battlefieldId: where };
        if (opts.control) {
          bf.controller = player;
          bf.contestedBy = null;
        }
      }
      o.controller = player;
      o.ready = opts.ready ?? true;
      o.damage = opts.damage ?? 0;
      o.mightBonus = opts.mightBonus ?? 0;
      o.enteredTurn = s.turn.number;
      id = o.id;
    });
    return id;
  }

  /** Set a player's points. */
  setPoints(player: PlayerId, points: number): this {
    return this.edit((s) => {
      (s.players[playerIndex(player)] as GameState['players'][number]).points = points;
    });
  }

  /**
   * Resize the main deck to `n` cards. Excess cards (from the top) go to the Trash by default, or to
   * Banishment (`to: 'banishment'`, keeps the Trash empty). If the deck is smaller than `n`, cards come
   * back from the Trash.
   */
  setDeckSize(player: PlayerId, n: number, to: 'trash' | 'banishment' = 'trash'): this {
    return this.edit((s) => {
      const ps = s.players[playerIndex(player)] as GameState['players'][number];
      while (ps.mainDeck.length > n) {
        const id = ps.mainDeck.shift() as string;
        const o = s.objects[id] as CardInstance;
        if (to === 'trash') {
          ps.trash.push(id);
          o.zone = { kind: 'trash', player };
        } else {
          ps.banishment.push(id);
          o.zone = { kind: 'banishment', player };
        }
      }
      while (ps.mainDeck.length < n) {
        const id = ps.trash.pop();
        if (id === undefined) throw new Error('not enough cards in the trash to grow the deck');
        ps.mainDeck.push(id);
        (s.objects[id] as CardInstance).zone = { kind: 'mainDeck', player };
      }
    });
  }

  /** Move `n` runes (of `domain` if given) from the top of the Rune Deck into the base, ready. */
  giveRunes(player: PlayerId, n: number, domain?: Domain): this {
    return this.edit((s) => {
      const ps = s.players[playerIndex(player)] as GameState['players'][number];
      for (let i = 0; i < n; i++) {
        const idx = ps.runeDeck.findIndex(
          (id) =>
            domain === undefined ||
            this.cards[(s.objects[id] as CardInstance).cardId]?.domains[0] === domain,
        );
        if (idx < 0) throw new Error(`${player} has no ${domain ?? 'more'} rune in the Rune Deck`);
        const [id] = ps.runeDeck.splice(idx, 1) as [string];
        const o = s.objects[id] as CardInstance;
        o.zone = { kind: 'base', player };
        o.ready = true;
        o.enteredTurn = s.turn.number;
        ps.base.push(id);
      }
    });
  }

  /** Replace the player's runes in play by exactly these domains (extra runes return to the Rune Deck). */
  setRunes(player: PlayerId, domains: Domain[]): this {
    this.edit((s) => {
      const ps = s.players[playerIndex(player)] as GameState['players'][number];
      for (const id of [...ps.base]) {
        const o = s.objects[id] as CardInstance;
        if (this.cards[o.cardId]?.type !== 'RUNE') continue;
        ps.base = ps.base.filter((x) => x !== id);
        ps.runeDeck.push(id);
        o.zone = { kind: 'runeDeck', player };
        o.ready = true;
      }
    });
    for (const d of domains) this.giveRunes(player, 1, d);
    return this;
  }

  /** Overwrite the player's Rune Pool. */
  setPool(player: PlayerId, energy: number, power: Partial<Record<Domain, number>> = {}): this {
    return this.edit((s) => {
      (s.players[playerIndex(player)] as GameState['players'][number]).runePool = {
        energy,
        power: { ...power },
      };
    });
  }

  /** Patch a battlefield's control / contested marks. */
  setBattlefield(
    bfId: string,
    patch: Partial<Pick<BattlefieldState, 'controller' | 'contestedBy' | 'scoredThisTurnBy'>>,
  ): this {
    return this.edit((s) => {
      const bf = s.battlefields.find((b) => b.id === bfId);
      if (!bf) throw new Error(`no battlefield ${bfId}`);
      Object.assign(bf, patch);
    });
  }

  /** Set the Might modifier of one object. */
  setMightBonus(id: string, bonus: number): this {
    return this.edit((s) => {
      (s.objects[id] as CardInstance).mightBonus = bonus;
    });
  }

  /** Ready or exhaust one object. */
  setReady(id: string, ready: boolean): this {
    return this.edit((s) => {
      (s.objects[id] as CardInstance).ready = ready;
    });
  }

  /**
   * Normalise the flow to a plain Main Phase of `player`'s turn (default: the current turn player):
   * Neutral Open, priority to `player`, no Focus, chain, Showdown or Combat.
   */
  setMainPhase(player?: PlayerId): this {
    return this.edit((s) => {
      const p = player ?? s.turn.activePlayer;
      s.mulligan = null;
      s.turn.activePlayer = p;
      s.turn.phase = 'MAIN';
      s.turn.step = 'NONE';
      s.flow = {
        priority: p,
        focus: null,
        chain: [],
        stagedShowdowns: [],
        stagedCombats: [],
        cleanupIterations: 0,
      };
      s.turnState = { kind: 'NEUTRAL', open: true };
    });
  }

  /** The other seat. */
  static other(p: PlayerId): PlayerId {
    return opponentOf(p);
  }
}
