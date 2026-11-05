import { isHiddenCard } from '@riftbound/engine';
import { Card, CardBack } from '../components/Card';
import type { CardSize } from '../components/cardStyles';
import { deflectPower, equipVariants } from './interaction';
import type { BoardUi } from './useBoardUi';

export interface ObjectCardProps {
  id: string;
  ui: BoardUi;
  size?: CardSize;
  /** Extra classes (spacing). */
  className?: string;
  /** Treat as an in-hand card (click = play). */
  inHand?: boolean;
}

/**
 * Renders one game object. Hidden placeholders are ALWAYS drawn as a CardBack: this component never
 * reads a name for a HiddenCard. Interactivity is derived from `ui` (which is derived from api.legal).
 */
export function ObjectCard({
  id,
  ui,
  size = 'board',
  className = '',
  inHand = false,
}: ObjectCardProps) {
  const { api } = ui;
  const obj = api.view.objects[id];
  if (!obj) return null;
  if (isHiddenCard(obj)) return <CardBack owner={obj.owner} size={size} className={className} />;
  const def = api.cards[obj.cardId];
  if (!def) return null;

  const mine = obj.controller === api.seat;
  const inPlay = obj.zone.kind === 'base' || obj.zone.kind === 'battlefield';
  const isUnit = def.type === 'UNIT' || (def.type === 'TOKEN' && def.stats.might !== undefined);
  const isGear = def.type === 'GEAR';
  const common = {
    def,
    instance: obj,
    size,
    onMouseEnter: () => ui.setHovered(id),
    onMouseLeave: () => ui.setHovered(null),
  };

  if (ui.targeting?.candidates.has(id)) {
    const deflect = deflectPower(id, api.view, api.cards);
    const hint = deflect > 0 ? `Deflect: extra cost applies (+${deflect} Power)` : undefined;
    return (
      <Card
        {...common}
        highlighted
        ariaLabel={`Target: ${def.name}${hint ? `. ${hint}` : ''}`}
        {...(hint ? { title: hint } : {})}
        className={`ring-rose-400! ${className}`}
        onClick={(e) => {
          e.stopPropagation();
          ui.pickTarget(id);
        }}
      />
    );
  }

  if (inHand) {
    const playable = ui.playable.has(id);
    return (
      <Card
        {...common}
        highlighted={playable}
        className={`${playable ? '' : 'brightness-75'} ${className}`}
        onClick={(e) => {
          e.stopPropagation();
          ui.clickHandCard(id, e.currentTarget);
        }}
        onContextMenu={(e) => ui.contextMenu(e, id)}
      />
    );
  }

  if (mine && inPlay && isUnit) {
    const selected = ui.selected.includes(id);
    const exhaustedGap = !obj.ready && size === 'board' ? 'mx-6' : '';
    return (
      <Card
        {...common}
        selected={selected}
        highlighted={!selected && ui.movable.has(id)}
        className={`${exhaustedGap} ${className}`}
        onClick={(e) => {
          e.stopPropagation();
          ui.clickUnit(id, e.shiftKey || e.ctrlKey || e.metaKey);
        }}
        onContextMenu={(e) => ui.contextMenu(e, id)}
        draggable
        onDragStart={(e) => {
          const ids = ui.startDrag(id);
          e.dataTransfer.setData('text/plain', ids.join(','));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={ui.endDrag}
      />
    );
  }

  if (mine && inPlay && isGear) {
    const equippable = equipVariants(api.legal, { equipmentId: id }).length > 0;
    return (
      <Card
        {...common}
        highlighted={equippable}
        className={className}
        onClick={
          equippable
            ? (e) => {
                e.stopPropagation();
                ui.contextMenu(e, id);
              }
            : undefined
        }
        onContextMenu={(e) => ui.contextMenu(e, id)}
      />
    );
  }

  // Facedown card I control (playable as a Reaction) or any plain public card.
  if (mine && obj.zone.kind === 'facedown') {
    const playable = ui.playable.has(id);
    return (
      <Card
        {...common}
        highlighted={playable}
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          ui.clickHandCard(id, e.currentTarget);
        }}
        onContextMenu={(e) => ui.contextMenu(e, id)}
      />
    );
  }

  if (mine && obj.zone.kind === 'champion') {
    const playable = ui.playable.has(id);
    return (
      <Card
        {...common}
        highlighted={playable}
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          ui.clickHandCard(id, e.currentTarget);
        }}
        onContextMenu={(e) => ui.contextMenu(e, id)}
      />
    );
  }

  return <Card {...common} className={className} />;
}
