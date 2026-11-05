/**
 * Production-safe "state surgery" helpers for sandboxes (the interactive tutorial, demos).
 *
 * Adapted from `testing/scenario.ts` but with no dependency on the test fixtures: pass in the card
 * database and decks. A `Sandbox` owns a GameState and rearranges it WITHOUT going through the
 * reducer (no cost, no chain, no Cleanup) while keeping zone arrays and ZoneRefs consistent, so
 * `checkInvariants` still passes. After surgery, drive the game only through `reduce`.
 *
 *   const sb = Sandbox.create(cards, [deckA, deckB], { seed: 'lesson1' });   // learner = p0, MAIN phase
 *   sb.giveRunes('p0', 3).putInHand('p0', 'fx-grunt');
 *   sb.verify();           // throws on any invariant violation
 *   sb.state               // plain GameState
 *
 * Isomorphic: no Node or DOM APIs.
 */
import { checkInvariants } from './invariants.js';
import { reduce } from './reducer.js';
import { createGame } from './setup.js';
import { playerIndex } from './types/constants.js';
import type {
  BattlefieldState,
  CardDatabase,
  CardInstance,
  DeckList,
  Domain,
  GameState,
  PlayerId,
} from './types/index.js';

export interface PutUnitOptions {
  /** Default true. */
  ready?: boolean;
  damage?: number;
  mightBonus?: number;
  /** For battlefield placement: also make the player the battlefield's controller (clears Contested). */
  control?: boolean;
}

export interface SandboxOptions {
  /** Base seed; a numeric suffix is tried until the first deck is seated as p0. */
  seed?: string;
  /** Leave both players in the MULLIGAN phase instead of keeping hands and entering MAIN. */
  keepMulligan?: boolean;
}

const objNum = (id: string): number => Number(id.slice(1));

type PS = GameState['players'][number];

export class Sandbox {
  state: GameState;
  readonly cards: CardDatabase;

  constructor(state: GameState, cards: CardDatabase) {
    this.state = state;
    this.cards = cards;
  }

  /**
   * A real game (real setup) in which decks[0] is seated as p0. Unless keepMulligan, both
   * players keep their hands through the real reducer: MAIN phase, turn 1, p0 to act.
   */
  static create(
    cards: CardDatabase,
    decks: [DeckList, DeckList],
    opts: SandboxOptions = {},
  ): Sandbox {
    const base = opts.seed ?? 'sandbox';
    let state: GameState | null = null;
    for (let i = 0; i < 64 && !state; i++) {
      const s = createGame(cards, decks, `${base}-${i}`);
      const legend = s.objects[s.players[0].legend as string] as CardInstance;
      if (legend.cardId === decks[0].legendId) state = s;
    }
    if (!state) throw new Error('could not seat the first deck as p0');
    if (!opts.keepMulligan) {
      for (const p of ['p0', 'p1'] as const) {
        const r = reduce(state, cards, { type: 'MULLIGAN', playerId: p, cardIds: [] });
        if (!r.ok) throw new Error(`sandbox mulligan rejected: ${r.message}`);
        state = r.state;
      }
    }
    return new Sandbox(state, cards);
  }

  // ------------------------------------------------------------------ queries

  player(p: PlayerId): PS {
    return this.state.players[playerIndex(p)] as PS;
  }

  obj(id: string): CardInstance {
    const o = this.state.objects[id];
    if (!o) throw new Error(`no object ${id}`);
    return o;
  }

  /** Lowest-numbered object of cardId owned by player (optionally restricted to zone kinds). */
  find(player: PlayerId, cardId: string, zones?: string[]): CardInstance | undefined {
    return Object.values(this.state.objects)
      .filter(
        (o) => o.owner === player && o.cardId === cardId && (!zones || zones.includes(o.zone.kind)),
      )
      .sort((a, b) => objNum(a.id) - objNum(b.id))[0];
  }

  /** Throws if any structural invariant is violated. */
  verify(): this {
    const bad = checkInvariants(this.state, this.cards);
    if (bad.length > 0) throw new Error(`invariant violations:\n  - ${bad.join('\n  - ')}`);
    return this;
  }

  // ------------------------------------------------------------------ surgery

  private edit(fn: (s: GameState) => void): this {
    const s = structuredClone(this.state);
    fn(s);
    this.state = s;
    return this;
  }

  private static detach(s: GameState, o: CardInstance): void {
    const ps = s.players[playerIndex(o.zone.player)] as PS;
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
  ): CardInstance {
    const found = Object.values(s.objects)
      .filter((o) => o.owner === player && o.cardId === cardId && zones.includes(o.zone.kind))
      .sort((a, b) => objNum(a.id) - objNum(b.id))[0];
    if (!found) throw new Error(`${player} has no spare ${cardId} in ${zones.join('/')}`);
    return found;
  }

  /** Move a spare copy of cardId (from deck, trash or champion zone) into the player's hand. Returns its id. */
  putInHand(player: PlayerId, cardId: string): string {
    let id = '';
    this.edit((s) => {
      const o = Sandbox.findSource(s, player, cardId, ['mainDeck', 'trash', 'champion']);
      Sandbox.detach(s, o);
      o.zone = { kind: 'hand', player };
      (s.players[playerIndex(player)] as PS).hand.push(o.id);
      id = o.id;
    });
    return id;
  }

  /** Return every card of the player's hand to the top of their deck. */
  clearHand(player: PlayerId): this {
    return this.edit((s) => {
      const ps = s.players[playerIndex(player)] as PS;
      for (const id of [...ps.hand].reverse()) {
        const o = s.objects[id] as CardInstance;
        ps.mainDeck.unshift(id);
        o.zone = { kind: 'mainDeck', player };
      }
      ps.hand = [];
    });
  }

  /**
   * Put a unit of cardId into play for the player, in the base or at battlefield `where`.
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
      const o = Sandbox.findSource(s, player, cardId, ['mainDeck', 'hand', 'trash', 'champion']);
      Sandbox.detach(s, o);
      if (where === 'base') {
        o.zone = { kind: 'base', player };
        (s.players[playerIndex(player)] as PS).base.push(o.id);
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
      (s.players[playerIndex(player)] as PS).points = points;
    });
  }

  /** Resize the main deck to n cards (excess to the Trash/Banishment, or refill from the Trash). */
  setDeckSize(player: PlayerId, n: number, to: 'trash' | 'banishment' = 'trash'): this {
    return this.edit((s) => {
      const ps = s.players[playerIndex(player)] as PS;
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

  /** Move n runes (of `domain` if given) from the top of the Rune Deck into the base, ready. */
  giveRunes(player: PlayerId, n: number, domain?: Domain): this {
    return this.edit((s) => {
      const ps = s.players[playerIndex(player)] as PS;
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

  /** Replace the player's runes in play by exactly these domains (extras return to the Rune Deck). */
  setRunes(player: PlayerId, domains: Domain[]): this {
    this.edit((s) => {
      const ps = s.players[playerIndex(player)] as PS;
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
      (s.players[playerIndex(player)] as PS).runePool = { energy, power: { ...power } };
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
   * Normalise the flow to a plain Main Phase of the player's turn (default: the current turn player):
   * Neutral Open, priority to the player, no Focus, chain, Showdown or Combat.
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
}
