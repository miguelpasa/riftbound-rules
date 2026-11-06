import { isGearDef, isHiddenCard } from '@riftbound/engine';
import { Card, CardBack } from '../components/Card';
import type { CardSize } from '../components/cardStyles';
import { abilityGroups, abilityVariants, describeAbility, legionDiscount } from './abilities';
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
function ObjectCardBody({
  id,
  ui,
  size = 'board',
  className = '',
  inHand = false,
  hasAbility,
}: ObjectCardProps & { hasAbility: boolean }) {
  const { api } = ui;
  const obj = api.view.objects[id];
  if (!obj) return null;
  if (isHiddenCard(obj)) return <CardBack owner={obj.owner} size={size} className={className} />;
  const def = api.cards[obj.cardId];
  if (!def) return null;

  const mine = obj.controller === api.seat;
  const inPlay = obj.zone.kind === 'base' || obj.zone.kind === 'battlefield';
  const isUnit = def.type === 'UNIT' || (def.type === 'TOKEN' && def.stats.might !== undefined);
  const isGear = isGearDef(def);
  const discount = inPlay ? 0 : legionDiscount(api.view, api.cards, api.seat, id, obj.cardId);
  const common = {
    def,
    instance: obj,
    size,
    ...(discount > 0 ? { energyDiscount: discount } : {}),
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
        highlighted={equippable || hasAbility}
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

  return <Card {...common} highlighted={hasAbility} className={className} />;
}

/** Buttons for the legal activated abilities of one of my permanents (driven by api.legal). */
function AbilityButtons({ id, ui }: { id: string; ui: BoardUi }) {
  const { api } = ui;
  const obj = api.view.objects[id];
  if (!obj || isHiddenCard(obj)) return null;
  const def = api.cards[obj.cardId];
  const variants = abilityGroups(api.legal, id);
  if (!def || variants.length === 0) return null;
  return (
    <ul aria-label={`${def.name} abilities`} className="flex w-full max-w-[8rem] flex-col gap-0.5">
      {variants.map((g) => {
        const v = g.variants[0] as (typeof g.variants)[number];
        const ability = def.abilities?.[v.abilityIndex];
        const d = ability ? describeAbility(def, ability) : null;
        const label = variants.length > 1 ? `Activate ${v.abilityIndex + 1}` : 'Activate';
        return (
          <li key={v.abilityIndex} className="flex flex-col items-center">
            <button
              type="button"
              data-ability={`${id}:${v.abilityIndex}`}
              aria-label={`${label} ${def.name}${d ? `: ${d.summary}` : ''}`}
              title={`${d ? `${d.summary}. ` : ''}${def.text}`}
              onClick={(e) => {
                e.stopPropagation();
                ui.activateAbility(id, g.abilityIndex);
              }}
              className="w-full rounded-md bg-amber-300 px-1.5 py-0.5 text-xs font-semibold text-slate-950 hover:bg-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {label}
            </button>
            {d ? (
              <span className="text-center text-[10px] leading-tight break-words text-slate-300">
                {d.summary}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ObjectCard(props: ObjectCardProps) {
  const { api } = props.ui;
  const obj = api.view.objects[props.id];
  const usable =
    !props.inHand &&
    obj !== undefined &&
    !isHiddenCard(obj) &&
    obj.controller === api.seat &&
    (obj.zone.kind === 'base' || obj.zone.kind === 'battlefield') &&
    !props.ui.targeting?.candidates.has(props.id) &&
    abilityVariants(api.legal, props.id).length > 0;
  const body = <ObjectCardBody {...props} hasAbility={usable} />;
  if (!usable) return body;
  return (
    <div className="animate-pop flex flex-col items-center gap-1">
      {body}
      <AbilityButtons id={props.id} ui={props.ui} />
    </div>
  );
}
