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
  if (!o) {
    // R44: the source of a Battlefield card's ability is a battlefield id; show the card's name.
    const bf = view.battlefields.find((b) => b.id === id);
    return (bf && cards[bf.cardId]?.name) || fallback;
  }
  if (isHiddenCard(o)) return fallback;
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
    case 'CHAIN_ITEM_ADDED': {
      // R44: name the Battlefield card whose ability was put on the Chain.
      const item = view.flow.chain.find((i) => i.id === event.chainItemId);
      if (item?.sourceBattlefieldId !== undefined) {
        return `${objectName(item.sourceBattlefieldId, view, cards, 'A battlefield')} triggered and its ability was added to the chain.`;
      }
      return `${who(event.controller, view)} added an item to the chain.`;
    }
    case 'CHAIN_ITEM_RESOLVED':
      return 'A chain item resolved.';
    case 'EFFECT_DAMAGE':
      return `${event.amount} damage was dealt to a unit.`;
    case 'EFFECT_BUFF':
      return event.amount < 0
        ? `A unit got ${event.amount} Might.`
        : `A unit got +${event.amount} Might.`;
    case 'EFFECT_STUNNED':
      return `${objectName(event.unitId, view, cards, 'A unit')} was stunned and deals no combat damage this turn.`;
    case 'EFFECT_KEYWORD_GRANTED':
      return `${objectName(event.unitId, view, cards, 'A unit')} gained a keyword until the end of the turn.`;
    case 'EFFECT_COUNTERED':
      return `${cards[event.cardId]?.name ?? 'A spell'} was countered.`;
    case 'GEAR_KILLED':
      return `${objectName(event.gearId, view, cards, 'A gear')} was killed.`;
    case 'BATTLEFIELD_SCORED':
      return `${who(event.player, view)} ${event.method === 'HOLD' ? 'held' : 'conquered'} ${battlefieldName(event.battlefieldId, view, cards)}.`;
    case 'XP_SPENT':
      return `${who(event.player, view)} spent ${event.amount} XP.`;
    case 'XP_GAINED':
      return `${who(event.player, view)} gained ${event.amount} XP.`;
    case 'EFFECT_EMPOWERED':
      return `A unit became Empowered.`;
    case 'EFFECT_READIED':
      return `A unit was readied.`;
    case 'EFFECT_FIZZLED':
      return `A spell's target was gone, so it did nothing.`;
    case 'EFFECT_UNIMPLEMENTED':
      return `The effect of ${cards[event.cardId]?.name ?? 'a card'} is not implemented and did nothing.`;
    case 'UNIT_MOVED':
      return `${objectName(event.unitId, view, cards, 'A unit')} moved from ${battlefieldName(event.from, view, cards)} to ${battlefieldName(event.to, view, cards)}.`;
    case 'SHOWDOWN_STARTED':
      return `${event.isCombat ? 'Combat showdown' : 'Showdown'} started at ${battlefieldName(event.battlefieldId, view, cards)}.`;
    case 'STAGED_ORDER_CHOSEN':
      return `${who(event.player, view)} chose ${battlefieldName(event.battlefieldId, view, cards)} to ${event.stage === 'SHOWDOWN' ? 'Showdown' : 'fight'} first.`;
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
    case 'TOKEN_PLAYED':
      return `${who(event.player, view)} played ${cards[event.cardId]?.name ?? 'a token'}.`;
    case 'UNIT_RETURNED':
      return `${cards[event.cardId]?.name ?? 'A unit'} was returned to ${event.player === view.viewer ? 'your' : "its owner's"} hand.`;
    case 'CARDS_LOOKED_AT':
      return `${who(event.player, view)} looked at the top ${plural(event.count, 'card')} of ${event.player === view.viewer ? 'your' : 'their'} Main Deck.`;
    case 'CARDS_RECYCLED':
      return `${who(event.player, view)} recycled ${plural(event.count, 'card')}.`;
    case 'CARDS_BURNED':
      return `${who(event.player, view)} put the top ${plural(event.count, 'card')} of ${event.player === view.viewer ? 'your' : 'their'} Main Deck into the Trash.`;
    case 'CARD_REVEALED':
      return `${who(event.player, view)} revealed ${cards[event.cardId]?.name ?? 'a card'}.`;
    case 'ABILITY_ACTIVATED':
      return `${who(event.player, view)} activated ${objectName(event.sourceId, view, cards, 'an ability')}.`;
    case 'RESOURCES_ADDED': {
      const parts = [
        event.energy > 0 ? `${event.energy} Energy` : '',
        event.power > 0 ? `${event.power} Power` : '',
      ].filter(Boolean);
      return `${who(event.player, view)} added ${parts.join(' and ') || 'nothing'} to the Rune Pool.`;
    }
    case 'TRIGGER_TARGETED':
      return `${objectName(event.sourceId, view, cards, 'An ability')} targeted ${
        event.targets
          .map((t) => (t.kind === 'object' ? objectName(t.id, view, cards, 'a unit') : 'a target'))
          .join(' and ') || 'nothing'
      }.`;
    case 'OPTIONAL_EFFECT_DECIDED':
      return `${objectName(event.sourceId, view, cards, 'An ability')} ${
        event.accepted ? 'was used' : 'was not used (optional effect declined)'
      }.`;
    case 'COST_CARDS_PAID': {
      const verb = {
        DISCARD: 'discarded',
        KILL: 'killed',
        EXHAUST: 'exhausted',
        RETURN: 'returned to hand',
        RECYCLE: 'recycled from their Trash:',
      }[event.kind];
      const names = event.cardNames.join(' and ') || 'cards';
      return `${who(event.player, view)} ${verb} ${names} to pay for ${objectName(event.sourceId, view, cards, 'an ability')}.`;
    }
    case 'TRIGGER_NO_TARGET':
      return `${objectName(event.sourceId, view, cards, 'An ability')} had no legal target and did nothing.`;
    case 'BECAME_EXHAUSTED':
    case 'BECAME_MIGHTY':
      return `${objectName(event.objectId, view, cards, 'A unit')} became Mighty.`;
    case 'BECAME_READY':
      return `${objectName(event.objectId, view, cards, 'A permanent')} became ${event.type === 'BECAME_READY' ? 'ready' : 'exhausted'}.`;
    case 'COMBAT_ENDED':
      return event.winner === null
        ? 'The combat ended with no winner.'
        : `${who(event.winner, view)} won the combat.`;
    case 'CLEANUP_ITERATION':
      return `Cleanup pass ${event.iteration}.`;
    default:
      return assertNever(event);
  }
}
