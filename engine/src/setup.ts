/**
 * Game setup (Rules 104-118) for a 1v1 Duel.
 *
 * Conventions:
 * - Object ids are 'o1', 'o2', ... allocated from `state.nextObjectId` (next id to hand out). Deck
 *   cards get their ids in shuffled order and the deck is shuffled again, so ids reveal neither
 *   card identity (copies are not adjacent) nor deck position.
 * - Battlefield ids are 'bf0' (owned by p0) and 'bf1' (owned by p1).
 * - The first player is chosen by the RNG (115) and is ALWAYS seat p0: if the RNG picks the player who
 *   supplied `decks[1]`, the decklists are swapped, so `decks[0]`'s owner is not necessarily p0.
 * - Event `seq` starts at 1. `turn.number` is 0 during the MULLIGAN phase and becomes 1 when it ends.
 */
import { seedRng, rngInt, rngShuffle } from './rng.js';
import { validateDeck } from './deckValidation.js';
import { HAND_SIZE, PLAYER_IDS, VICTORY_SCORE, playerIndex } from './types/constants.js';
import { ENGINE_VERSION } from './types/state.js';
import type {
  CardDatabase,
  CardInstance,
  DeckList,
  GameEvent,
  GameEventInput,
  GameState,
  PlayerId,
  PlayerState,
  ZoneRef,
} from './types/index.js';

/** Allocate a new object id on a working state (mutates `nextObjectId`). */
export function allocObjectId(state: GameState): string {
  return `o${state.nextObjectId++}`;
}

/** Stamp `seq` on events and advance `nextEventSeq` (mutates the working state). */
export function stampEvents(state: GameState, inputs: GameEventInput[]): GameEvent[] {
  return inputs.map((e) => ({ ...e, seq: state.nextEventSeq++ }) as GameEvent);
}

/**
 * Draw up to `n` cards from the top of `player`'s main deck into their hand (mutates the working
 * state). Returns CARD_DRAWN event inputs (visible only to the drawer) for the cards actually drawn.
 */
export function drawFromTop(state: GameState, player: PlayerId, n: number): GameEventInput[] {
  const ps = state.players[playerIndex(player)];
  const out: GameEventInput[] = [];
  for (let i = 0; i < n; i++) {
    const id = ps.mainDeck.shift();
    if (id === undefined) break;
    ps.hand.push(id);
    const obj = state.objects[id] as CardInstance;
    obj.zone = { kind: 'hand', player };
    out.push({ type: 'CARD_DRAWN', player, cardInstanceId: id, visibleTo: [player] });
  }
  return out;
}

function emptyPlayer(id: PlayerId): PlayerState {
  return {
    id,
    hand: [],
    mainDeck: [],
    runeDeck: [],
    trash: [],
    banishment: [],
    base: [],
    legend: null,
    championZone: [],
    runePool: { energy: 0, power: {} },
    points: 0,
  };
}

/** Create a game and also return the setup events (the opening draws). Throws if a deck is illegal. */
export function createGameWithEvents(
  cards: CardDatabase,
  decks: [DeckList, DeckList],
  seed: string,
): { state: GameState; events: GameEvent[] } {
  const { state, events } = createGameWithSeating(cards, decks, seed);
  return { state, events };
}

/**
 * Like `createGameWithEvents`, but also reports which seat each input deck ended up in (the first
 * player is always p0, so the decklists may be swapped): `seatOfDeck[i]` is the seat of `decks[i]`.
 */
export function createGameWithSeating(
  cards: CardDatabase,
  decks: [DeckList, DeckList],
  seed: string,
): { state: GameState; events: GameEvent[]; seatOfDeck: [PlayerId, PlayerId] } {
  decks.forEach((deck, i) => {
    const res = validateDeck(cards, deck);
    if (!res.ok) throw new Error(`Deck ${i} is illegal: ${res.errors.join(' ')}`);
  });

  const state: GameState = {
    engineVersion: ENGINE_VERSION,
    mode: 'DUEL',
    victoryScore: VICTORY_SCORE,
    players: [emptyPlayer('p0'), emptyPlayer('p1')],
    objects: {},
    battlefields: [],
    seed: { seed },
    rng: seedRng(seed),
    turn: { number: 0, activePlayer: 'p0', phase: 'MULLIGAN', step: 'NONE' },
    turnState: { kind: 'NEUTRAL', open: true },
    flow: {
      priority: null,
      focus: null,
      chain: [],
      stagedShowdowns: [],
      stagedCombats: [],
      cleanupIterations: 0,
    },
    mulligan: { order: ['p0', 'p1'], current: 0, done: [] },
    gameStatus: 'IN_PROGRESS',
    nextObjectId: 1,
    nextEventSeq: 1,
  };

  // 115: choose the first player at random; the first player is always seat p0.
  const swapped = rngInt(state, 2) !== 0;
  const ordered: [DeckList, DeckList] = swapped ? [decks[1], decks[0]] : [decks[0], decks[1]];
  const seatOfDeck: [PlayerId, PlayerId] = swapped ? ['p1', 'p0'] : ['p0', 'p1'];

  const create = (cardId: string, owner: PlayerId, zone: ZoneRef): string => {
    const id = allocObjectId(state);
    state.objects[id] = {
      id,
      cardId,
      owner,
      controller: owner,
      zone,
      ready: true,
      damage: 0,
      mightBonus: 0,
    };
    return id;
  };

  PLAYER_IDS.forEach((pid, i) => {
    const deck = ordered[i] as DeckList;
    const ps = state.players[i] as PlayerState;
    ps.legend = create(deck.legendId, pid, { kind: 'legend', player: pid }); // 111
    ps.championZone.push(create(deck.championId, pid, { kind: 'champion', player: pid })); // 112
    // Hidden-information hygiene: object ids must carry no information about card identity or
    // deck order. The decklist order is shuffled BEFORE ids are allocated (so identical cards do not
    // get adjacent ids) and the id list is shuffled again afterwards (so id order is not deck order).
    const main = rngShuffle([...deck.mainDeck], state).map((c) =>
      create(c, pid, { kind: 'mainDeck', player: pid }),
    );
    const runes = rngShuffle([...deck.runeDeck], state).map((c) =>
      create(c, pid, { kind: 'runeDeck', player: pid }),
    );
    ps.mainDeck = rngShuffle(main, state); // 114
    ps.runeDeck = rngShuffle(runes, state);
    // 487.4 / 487.5: one of the player's three battlefields, chosen at random.
    const bfCard = deck.battlefields[rngInt(state, deck.battlefields.length)] as string;
    state.battlefields.push({
      id: `bf${i}`,
      cardId: bfCard,
      owner: pid,
      controller: null,
      contestedBy: null,
      facedownSlotId: null,
      scoredThisTurnBy: [],
    });
  });

  // Aspirant's Climb: a Battlefield card in the game raises the points needed to win.
  for (const bf of state.battlefields) {
    for (const s of cards[bf.cardId]?.statics ?? []) state.victoryScore += s.victoryBonus ?? 0;
  }

  // 116: each player draws HAND_SIZE cards.
  const inputs: GameEventInput[] = [];
  for (const pid of PLAYER_IDS) inputs.push(...drawFromTop(state, pid, HAND_SIZE));
  const events = stampEvents(state, inputs);
  return { state, events, seatOfDeck };
}

/** Create a game in the MULLIGAN phase. See file header for conventions. */
export function createGame(
  cards: CardDatabase,
  decks: [DeckList, DeckList],
  seed: string,
): GameState {
  return createGameWithEvents(cards, decks, seed).state;
}
