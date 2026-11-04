import { isHiddenCard } from '@riftbound/engine';
import type { CardDatabase, ClientGameState, GameEvent, PlayerId } from '@riftbound/engine';

const PHASE_LABELS: Record<string, string> = {
  MULLIGAN: 'Mulligan',
  AWAKEN: 'Awaken',
  BEGINNING: 'Beginning',
  CHANNEL: 'Channel',
  DRAW: 'Draw',
  MAIN: 'Main',
  ENDING: 'Ending',
};

function who(player: PlayerId, view: ClientGameState): string {
  return player === view.viewer ? 'You' : 'Opponent';
}

/** Name of a (visible) object, or a generic fallback. Never reads hidden placeholders. */
function objectName(
  id: string,
  view: ClientGameState,
  cards: CardDatabase,
  fallback = 'a card',
): string {
  const o = view.objects[id];
  if (!o || isHiddenCard(o)) return fallback;
  return cards[o.cardId]?.name ?? fallback;
}

function battlefieldName(id: string, view: ClientGameState, cards: CardDatabase): string {
  if (id === 'base') return 'base';
  const bf = view.battlefields.find((b) => b.id === id);
  if (!bf) return 'a battlefield';
  return cards[bf.cardId]?.name ?? 'a battlefield';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Events worth a screen-reader announcement (the game log lists everything but cleanup noise). */
export function isImportantEvent(event: GameEvent): boolean {
  switch (event.type) {
    case 'POINT_GAINED':
    case 'UNIT_KILLED':
    case 'PHASE_CHANGED':
    case 'GAME_ENDED':
    case 'GAME_ABORTED':
    case 'BURN_OUT':
    case 'FINAL_POINT_DENIED_DREW_CARD':
    case 'SHOWDOWN_STARTED':
    case 'BATTLEFIELD_CONTROL_CHANGED':
    case 'CARD_PLAYED':
      return true;
    default:
      return false;
  }
}

/** Events shown in the game log (everything except per-iteration cleanup bookkeeping). */
export function isLoggedEvent(event: GameEvent): boolean {
  return event.type !== 'CLEANUP_ITERATION';
}

function assertNever(x: never): never {
  throw new Error(`Unhandled event: ${JSON.stringify(x)}`);
}

/** Plain-English description of an event from the viewer's perspective. Pure. */
export function describeEvent(
  event: GameEvent,
  view: ClientGameState,
  cards: CardDatabase,
): string {
  switch (event.type) {
    case 'CARD_DRAWN': {
      if (event.player !== view.viewer) return 'Opponent drew a card.';
      return `You drew ${objectName(event.cardInstanceId, view, cards)}.`;
    }
    case 'RUNE_CHANNELED':
      return `${who(event.player, view)} channeled a rune.`;
    case 'PHASE_CHANGED': {
      const phase = PHASE_LABELS[event.phase] ?? event.phase;
      if (event.phase === 'MULLIGAN') return 'Mulligan phase.';
      return `Turn ${event.turn}: ${event.player === view.viewer ? 'your' : "opponent's"} ${phase} phase.`;
    }
    case 'CARD_PLAYED': {
      const name = cards[event.cardId]?.name ?? 'a card';
      return `${who(event.player, view)} played ${name}.`;
    }
    case 'CARD_HIDDEN':
      return `${who(event.player, view)} hid a card at ${battlefieldName(event.battlefieldId, view, cards)}.`;
    case 'FACEDOWN_REMOVED':
      return `A facedown card at ${battlefieldName(event.battlefieldId, view, cards)} was revealed: ${cards[event.cardId]?.name ?? 'a card'}.`;
    case 'EQUIPPED':
      return `${objectName(event.equipmentId, view, cards, 'Equipment')} was attached to ${objectName(event.unitId, view, cards, 'a unit')}.`;
    case 'CHAIN_ITEM_ADDED':
      return `${who(event.controller, view)} added an item to the chain.`;
    case 'CHAIN_ITEM_RESOLVED':
      return 'A chain item resolved.';
    case 'EFFECT_UNIMPLEMENTED':
      return `The effect of ${cards[event.cardId]?.name ?? 'a card'} is not implemented and did nothing.`;
    case 'UNIT_MOVED':
      return `${objectName(event.unitId, view, cards, 'A unit')} moved from ${battlefieldName(event.from, view, cards)} to ${battlefieldName(event.to, view, cards)}.`;
    case 'SHOWDOWN_STARTED':
      return `${event.isCombat ? 'Combat showdown' : 'Showdown'} started at ${battlefieldName(event.battlefieldId, view, cards)}.`;
    case 'COMBAT_DAMAGE_ASSIGNED':
      return `${who(event.player, view)} assigned ${event.amount} damage to ${objectName(event.unitId, view, cards, 'a unit')}.`;
    case 'UNIT_KILLED':
      return `${objectName(event.unitId, view, cards, 'A unit')} was killed.`;
    case 'POINT_GAINED': {
      const src: Record<typeof event.source, string> = {
        HOLD: 'holding a battlefield',
        CONQUER: 'conquering a battlefield',
        BURN_OUT: 'burn out',
        EFFECT: 'an effect',
      };
      return `${who(event.player, view)} gained ${plural(event.amount, 'point')} from ${src[event.source]}.`;
    }
    case 'FINAL_POINT_DENIED_DREW_CARD':
      return `${who(event.player, view)} could not take the final point this way and drew a card instead.`;
    case 'BURN_OUT':
      return `${who(event.player, view)} burned out: the deck is empty.`;
    case 'BATTLEFIELD_CONTROL_CHANGED': {
      const name = battlefieldName(event.battlefieldId, view, cards);
      if (event.controller === null) return `${name} is now uncontrolled.`;
      return `${who(event.controller, view)} now control${event.controller === view.viewer ? '' : 's'} ${name}.`;
    }
    case 'GAME_ENDED':
      return `Game over: ${event.winner === view.viewer ? 'you win' : 'the opponent wins'}.`;
    case 'GAME_ABORTED':
      return `The game was aborted: ${event.reason}.`;
    case 'CLEANUP_ITERATION':
      return `Cleanup pass ${event.iteration}.`;
    default:
      return assertNever(event);
  }
}
