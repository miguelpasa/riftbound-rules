/**
 * Information hiding (Core Rules 107-108, 128 Privacy).
 *
 * Visibility model (Rule 128):
 *  - Hand: contents Private (owner only), count public.
 *  - Main Deck / Rune Deck: contents AND order Secret (nobody, not even the owner), count public.
 *  - Facedown zone at a battlefield: the zone is public, the card is Private to its controller.
 *  - Trash, Banishment, Base (units, gear, channeled runes), Battlefields, Legend, Champion zone,
 *    Chain: Public.
 *
 * Opaque ids: every object the viewer may not see is replaced by a HiddenCard stored under an
 * opaque, position-derived token `hidden:<owner>:<zone>:<index>` (zone is hand | mainDeck |
 * runeDeck | facedown | other). The index is the zone position (facedown/other: a per-owner
 * counter) and is recomputed on every sanitize call, so a token never correlates to a card
 * identity across states (shuffles/draws do not carry tokens along). The real object id is never
 * exposed for a hidden object. The viewer's own hand keeps REAL ids (intents reference them).
 * Hidden placeholders are listed after all public objects so key order reveals nothing.
 */
import type { ChainItem, FlowState, Target } from './types/chain.js';
import type { GameEvent } from './types/event.js';
import type {
  BattlefieldState,
  CardInstance,
  GameState,
  PlayerId,
  PlayerState,
} from './types/state.js';
import type { ClientGameState, ClientPlayerState, HiddenCard } from './types/view.js';

type HiddenZoneName = 'hand' | 'mainDeck' | 'runeDeck' | 'facedown' | 'other';

function hiddenToken(owner: PlayerId, zone: HiddenZoneName, index: number): string {
  return `hidden:${owner}:${zone}:${index}`;
}

/** Whether `viewer` may see the face of `obj` given where it currently is (Rule 128). */
export function canViewerSeeObject(obj: CardInstance, viewer: PlayerId): boolean {
  switch (obj.zone.kind) {
    case 'hand':
      return obj.zone.player === viewer;
    case 'mainDeck':
    case 'runeDeck':
      return false;
    case 'facedown':
      return obj.controller === viewer;
    default:
      return true;
  }
}

/** Opaque token for every object hidden from `viewer` (real id -> token). */
function buildHiddenMap(state: GameState, viewer: PlayerId): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of state.players) {
    const zones: [HiddenZoneName, string[]][] = [
      ['hand', p.hand],
      ['mainDeck', p.mainDeck],
      ['runeDeck', p.runeDeck],
    ];
    for (const [zone, ids] of zones) {
      if (zone === 'hand' && p.id === viewer) continue;
      ids.forEach((id, i) => map.set(id, hiddenToken(p.id, zone, i)));
    }
  }
  const counters: Record<PlayerId, { facedown: number; other: number }> = {
    p0: { facedown: 0, other: 0 },
    p1: { facedown: 0, other: 0 },
  };
  const take = (owner: PlayerId, zone: 'facedown' | 'other'): string =>
    hiddenToken(owner, zone, counters[owner][zone]++);
  // X11 (597.4): when the game ends, every face-down card is revealed to all players.
  const over = state.gameStatus === 'FINISHED';
  const seen = (o: CardInstance): boolean =>
    canViewerSeeObject(o, viewer) || (over && o.zone.kind === 'facedown');
  for (const bf of state.battlefields) {
    const obj = bf.facedownSlotId === null ? undefined : state.objects[bf.facedownSlotId];
    if (obj && !map.has(obj.id) && !seen(obj)) {
      map.set(obj.id, take(obj.controller, 'facedown'));
    }
  }
  // Stragglers: hidden objects not referenced by any zone array / facedown slot.
  for (const [id, obj] of Object.entries(state.objects)) {
    if (map.has(id) || seen(obj)) continue;
    map.set(
      id,
      obj.zone.kind === 'facedown' ? take(obj.controller, 'facedown') : take(obj.owner, 'other'),
    );
  }
  return map;
}

/**
 * Replace every string equal to a hidden object id (anywhere inside `value`) by its opaque token.
 * Choices are free-form today and carry no object ids; this prepares for effects that will.
 */
function redactChoices(value: unknown, rid: (id: string) => string): unknown {
  if (typeof value === 'string') return rid(value);
  if (Array.isArray(value)) return value.map((v) => redactChoices(v, rid));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactChoices(v, rid)]));
  }
  return value;
}

function sanitizeFlow(flow: FlowState, rid: (id: string) => string): FlowState {
  const out = structuredClone(flow);
  out.chain = out.chain.map((item: ChainItem) => ({
    ...item,
    sourceObjectId: rid(item.sourceObjectId),
    targets: item.targets.map((t: Target): Target =>
      t.kind === 'object' ? { kind: 'object', id: rid(t.id) } : t,
    ),
    choices: redactChoices(item.choices, rid) as ChainItem['choices'],
  }));
  if (out.combat?.damageAssignment) {
    for (const key of Object.keys(out.combat.damageAssignment) as PlayerId[]) {
      const list = out.combat.damageAssignment[key];
      if (list) {
        out.combat.damageAssignment[key] = list.map((a) => ({ ...a, unitId: rid(a.unitId) }));
      }
    }
  }
  return out;
}

function sanitizePlayer(
  p: PlayerState,
  viewer: PlayerId,
  map: Map<string, string>,
): ClientPlayerState {
  const { hand, mainDeck, runeDeck, ...rest } = p;
  const tok = (id: string): string => map.get(id) ?? id;
  return {
    ...structuredClone(rest),
    hand: p.id === viewer ? [...hand] : hand.map(tok),
    mainDeck: mainDeck.map(tok),
    runeDeck: runeDeck.map(tok),
    handCount: hand.length,
    mainDeckCount: mainDeck.length,
    runeDeckCount: runeDeck.length,
  };
}

/** Strip everything `viewer` must not see. Pure; the result shares no references with `state`. */
export function sanitizeFor(state: GameState, viewer: PlayerId): ClientGameState {
  const map = buildHiddenMap(state, viewer);
  const rid = (id: string): string => map.get(id) ?? id;

  const objects: ClientGameState['objects'] = {};
  for (const [id, obj] of Object.entries(state.objects)) {
    if (map.has(id)) continue;
    const copy = structuredClone(obj);
    if (copy.attachedTo !== undefined) copy.attachedTo = rid(copy.attachedTo);
    objects[id] = copy;
  }
  // Hidden placeholders last, ordered by token (position), never by creation order.
  const hidden = new Map<string, HiddenCard>();
  for (const [id, token] of map) {
    const obj = state.objects[id];
    const owner: PlayerId = obj ? obj.owner : (token.split(':')[1] as PlayerId);
    hidden.set(token, { hidden: true, owner });
  }
  for (const token of [...hidden.keys()].sort()) objects[token] = hidden.get(token) as HiddenCard;

  const battlefields: BattlefieldState[] = state.battlefields.map((bf) => ({
    ...structuredClone(bf),
    facedownSlotId: bf.facedownSlotId === null ? null : rid(bf.facedownSlotId),
  }));

  const view: ClientGameState = {
    viewer,
    engineVersion: state.engineVersion,
    mode: state.mode,
    victoryScore: state.victoryScore,
    players: [
      sanitizePlayer(state.players[0], viewer, map),
      sanitizePlayer(state.players[1], viewer, map),
    ],
    objects,
    battlefields,
    turn: structuredClone(state.turn),
    turnState: structuredClone(state.turnState),
    flow: sanitizeFlow(state.flow, rid),
    mulligan: structuredClone(state.mulligan),
    gameStatus: state.gameStatus,
  };
  if (state.winner !== undefined) view.winner = state.winner;
  return view;
}

/** Placeholder id used in events whose real card id the viewer must not learn. */
export function redactedDrawId(player: PlayerId): string {
  return `hidden:${player}:drawn`;
}

/**
 * Per-viewer event filter: drops events whose `visibleTo` excludes the viewer and redacts the
 * card id of a public CARD_DRAWN for the non-drawing player. Input is not mutated.
 */
export function sanitizeEvents(events: GameEvent[], viewer: PlayerId): GameEvent[] {
  const out: GameEvent[] = [];
  for (const ev of events) {
    if (ev.visibleTo && !ev.visibleTo.includes(viewer)) continue;
    const copy = structuredClone(ev);
    if (copy.type === 'CARD_DRAWN' && copy.player !== viewer) {
      copy.cardInstanceId = redactedDrawId(copy.player);
    }
    out.push(copy);
  }
  return out;
}
