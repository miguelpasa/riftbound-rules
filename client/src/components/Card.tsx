import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEventHandler,
  type KeyboardEvent,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import type { CardDef, Domain, PlayerId } from '@riftbound/engine';
import { useCardImages } from './CardImages';
import {
  COLORLESS,
  SIZE_CLASSES,
  SYMBOL_INFO,
  domainColor,
  frameStyle,
  keywordLabel,
  tokenizeRulesText,
  typeLine,
  type CardSize,
} from './cardStyles';

export interface CardInstanceView {
  ready: boolean;
  damage: number;
  mightBonus: number;
  attachedTo?: string;
  facedown?: boolean;
}

export interface CardProps {
  def: CardDef;
  instance?: CardInstanceView;
  size?: CardSize;
  selected?: boolean;
  highlighted?: boolean;
  disabled?: boolean;
  showImages?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLElement>;
  onDragEnd?: DragEventHandler<HTMLElement>;
  onMouseEnter?: MouseEventHandler<HTMLElement>;
  onMouseLeave?: MouseEventHandler<HTMLElement>;
  className?: string;
  /** Overrides the accessible name (e.g. 'Target: Name'). */
  ariaLabel?: string;
  /** Native tooltip text. */
  title?: string;
}

export const PARTIAL_LABEL = 'Effect not implemented';
export const PARTIAL_TOOLTIP = `${PARTIAL_LABEL}: this card's rules text is not executed in this version`;
const IMAGE_TIMEOUT_MS = 6000;

type SymbolKind = 'E' | 'M' | 'C' | 'A' | 'N';

const SYMBOL_CLASS: Record<SymbolKind, string> = {
  N: 'bg-slate-200 text-slate-900',
  E: 'bg-slate-600 text-slate-100',
  M: 'bg-red-700 text-white',
  C: 'bg-indigo-600 text-white',
  A: 'bg-gray-400 text-slate-900',
};

function GlyphChip({ symbol, value }: { symbol: SymbolKind; value?: string }) {
  const label = SYMBOL_INFO[symbol];
  const glyph = symbol === 'N' ? (value ?? '') : symbol;
  return (
    <span
      data-symbol={symbol}
      role="img"
      aria-label={symbol === 'N' ? `${value} energy` : label}
      title={label}
      className={`mx-px inline-flex h-[1.4em] min-w-[1.4em] items-center justify-center rounded-full px-[0.2em] align-middle text-[0.85em] leading-none font-bold ${SYMBOL_CLASS[symbol]}`}
    >
      {glyph}
    </span>
  );
}

export function RulesText({ text }: { text: string }) {
  const render = (t: string, keyPrefix: string): ReactNode[] =>
    tokenizeRulesText(t).map((tok, i) => {
      const key = `${keyPrefix}${i}`;
      switch (tok.kind) {
        case 'text':
          return <span key={key}>{tok.text}</span>;
        case 'keyword':
          return (
            <strong key={key} className="font-semibold text-slate-100">
              {tok.text}
            </strong>
          );
        case 'symbol':
          return <GlyphChip key={key} symbol={tok.symbol} value={tok.value} />;
        case 'reminder':
          return (
            <em key={key} data-reminder className="text-slate-400 italic">
              ({render(tok.text, key + '-')})
            </em>
          );
      }
    });
  return <>{render(text, 't')}</>;
}

function CostDisplay({ def }: { def: CardDef }) {
  const pips: { key: string; domain?: Domain }[] = [];
  let domainTotal = 0;
  for (const [i, d] of (def.cost.domain ?? []).entries()) {
    for (let n = 0; n < d.amount; n++) pips.push({ key: `d${i}-${n}`, domain: d.element });
    domainTotal += d.amount;
  }
  const generic = Math.max(0, (def.cost.power ?? 0) - domainTotal);
  for (let n = 0; n < generic; n++) pips.push({ key: `a${n}` });
  return (
    <div
      className="flex items-center gap-0.5"
      aria-label={`Cost ${def.cost.energy} energy${pips.length ? `, ${pips.length} power` : ''}`}
    >
      <span
        data-testid="cost-energy"
        className="inline-flex h-[1.9em] w-[1.9em] items-center justify-center rounded-full bg-slate-100 font-bold text-slate-900"
      >
        {def.cost.energy}
      </span>
      {pips.map((p) => {
        const c = p.domain ? domainColor(p.domain) : COLORLESS;
        return (
          <span
            key={p.key}
            data-pip={p.domain ?? 'any'}
            title={p.domain ? `${p.domain} power` : 'Any power'}
            className="inline-block h-[1.1em] w-[1.1em] rounded-full border border-black/40"
            style={{ backgroundColor: c.base }}
          />
        );
      })}
    </div>
  );
}

function CardImage({ url, enabled }: { url?: string; enabled: boolean }) {
  // Failure is tracked per-URL so a changed URL gets a fresh attempt without an effect reset.
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  const [loadedUrl, setLoadedUrl] = useState<string | undefined>(undefined);
  const failed = failedUrl === url;
  const loaded = loadedUrl === url;
  useEffect(() => {
    if (!url || !enabled || loaded || failed) return;
    const t = setTimeout(() => setFailedUrl(url), IMAGE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [url, enabled, loaded, failed]);
  if (!url || !enabled || failed) return null;
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => setLoadedUrl(url)}
      onError={() => setFailedUrl(url)}
      className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-30"
    />
  );
}

export function Card({
  def,
  instance,
  size = 'hand',
  selected,
  highlighted,
  disabled,
  showImages,
  onClick,
  onContextMenu,
  draggable,
  onDragStart,
  onDragEnd,
  onMouseEnter,
  onMouseLeave,
  className = '',
  ariaLabel,
  title,
}: CardProps) {
  const ctx = useCardImages();
  const imagesOn = showImages ?? ctx.showImages;
  const exhausted = instance ? !instance.ready : false;
  const damage = instance?.damage ?? 0;
  const bonus = instance?.mightBonus ?? 0;
  const isUnit = def.stats.might !== undefined || def.stats.health !== undefined;
  const effMight = def.stats.might !== undefined ? def.stats.might + bonus : undefined;
  const interactive = !!onClick && !disabled;
  const compact = size === 'board' || size === 'chain';
  const textRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Compact cards have little room: when the rules text does not fit, offer a "More" affordance.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!compact || !el) {
      setClipped(false);
      return;
    }
    setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [compact, def.text, def.keywords.length, size]);

  const state = [
    exhausted ? 'exhausted' : null,
    damage > 0 ? `${damage} damage` : null,
    instance?.facedown ? 'facedown' : null,
    selected ? 'selected' : null,
    disabled ? 'disabled' : null,
  ].filter(Boolean);
  const label = `${def.name}${state.length ? ` (${state.join(', ')})` : ''}`;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.(e as unknown as MouseEvent<HTMLElement>);
    }
  };

  const rotate = exhausted && size === 'board' ? 'rotate-90' : exhausted ? '-rotate-3' : '';

  return (
    <div
      role={onClick ? 'button' : 'group'}
      aria-label={ariaLabel ?? label}
      title={title}
      aria-disabled={onClick && disabled ? true : undefined}
      aria-pressed={onClick && selected !== undefined ? selected : undefined}
      tabIndex={interactive ? 0 : undefined}
      data-card-id={def.cardId}
      data-exhausted={exhausted || undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      draggable={draggable && !disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={frameStyle(def.domains)}
      className={[
        'relative flex shrink-0 flex-col overflow-hidden rounded-lg border-2 p-1.5 text-slate-100 shadow-md select-none',
        'motion-safe:transition-transform motion-safe:duration-150',
        SIZE_CLASSES[size],
        rotate,
        exhausted ? 'opacity-70 saturate-50' : '',
        interactive
          ? 'cursor-pointer hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'
          : '',
        disabled ? 'cursor-not-allowed opacity-50' : '',
        selected ? 'ring-4 ring-sky-400' : '',
        highlighted ? 'ring-4 ring-amber-300' : '',
        className,
      ].join(' ')}
    >
      <CardImage url={def.imageUrl} enabled={imagesOn} />
      <div className="relative z-10 flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="truncate leading-tight font-bold" title={def.name}>
            {def.name}
          </div>
          {def.subtitle && !compact ? (
            <div className="truncate text-[0.85em] text-slate-300">{def.subtitle}</div>
          ) : null}
        </div>
        <CostDisplay def={def} />
      </div>
      <div className="relative z-10 truncate text-[0.85em] text-slate-300">{typeLine(def)}</div>
      {def.keywords.length > 0 ? (
        <ul className="relative z-10 mt-0.5 flex flex-wrap gap-0.5" aria-label="Keywords">
          {def.keywords.map((k) => (
            <li
              key={k.name}
              className="rounded bg-black/50 px-1 text-[0.85em] leading-snug font-semibold text-slate-100"
            >
              {keywordLabel(k)}
            </li>
          ))}
        </ul>
      ) : null}
      <div
        ref={textRef}
        className="relative z-10 mt-1 min-h-0 flex-1 overflow-hidden leading-snug text-slate-200"
      >
        <RulesText text={def.text} />
      </div>
      {compact && clipped ? (
        <button
          type="button"
          data-testid="card-more"
          aria-label="Show full card text"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="relative z-10 -mt-0.5 self-start rounded bg-black/60 px-1.5 py-0.5 text-[1em] font-semibold text-sky-300 underline focus-visible:outline-2 focus-visible:outline-white"
        >
          ... More
        </button>
      ) : null}
      {compact && expanded ? (
        <div
          data-testid="card-full-text"
          role="group"
          aria-label="Full card text"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setExpanded(false);
          }}
          className="absolute inset-0 z-20 flex flex-col gap-1 overflow-y-auto bg-slate-950/95 p-1.5 text-[1.1em] leading-snug text-slate-100"
        >
          <div className="font-bold">{def.name}</div>
          <div className="text-slate-300">{typeLine(def)}</div>
          <RulesText text={def.text} />
          <button
            type="button"
            autoFocus
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
            className="mt-auto self-start rounded bg-slate-700 px-2 py-1 font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-white"
          >
            Close
          </button>
        </div>
      ) : null}
      <div className="relative z-10 mt-1 flex items-end justify-between gap-1">
        <div className="flex flex-col items-start gap-0.5">
          {def.supportLevel === 'partial' ? (
            <span
              data-testid="partial-badge"
              title={PARTIAL_TOOLTIP}
              className="rounded bg-amber-900/80 px-1 text-[0.8em] font-semibold text-amber-200"
            >
              {PARTIAL_LABEL}
            </span>
          ) : null}
          {exhausted ? (
            <span
              data-testid="exhausted-label"
              className="rounded bg-black/60 px-1 text-[0.8em] font-semibold uppercase"
            >
              Exhausted
            </span>
          ) : null}
          {damage > 0 ? (
            <span
              data-testid="damage-badge"
              className="rounded bg-red-700 px-1 text-[0.85em] font-bold text-white"
            >
              {damage} damage
            </span>
          ) : null}
        </div>
        {isUnit ? (
          <div className="flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 font-bold">
            {effMight !== undefined ? (
              <span
                data-testid="might"
                title="Might"
                className={bonus > 0 ? 'text-green-400' : bonus < 0 ? 'text-red-400' : ''}
              >
                {effMight}
              </span>
            ) : null}
            {def.stats.health !== undefined ? (
              <>
                <span aria-hidden="true">/</span>
                <span data-testid="health" title="Health">
                  {def.stats.health}
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface CardBackProps {
  owner?: PlayerId;
  count?: number;
  size?: CardSize;
  className?: string;
}

/** Face-down card (HiddenCard or deck pile top). Never carries card identity. */
export function CardBack({ owner, count, size = 'hand', className = '' }: CardBackProps) {
  const label = `Face-down card${owner !== undefined ? ` (player ${owner})` : ''}${count !== undefined ? `, ${count} cards` : ''}`;
  return (
    <div
      role="img"
      aria-label={label}
      data-card-back
      className={[
        'relative flex shrink-0 items-center justify-center rounded-lg border-2 border-slate-500 bg-[repeating-linear-gradient(45deg,#1e293b,#1e293b_6px,#0f172a_6px,#0f172a_12px)] shadow-md',
        SIZE_CLASSES[size],
        className,
      ].join(' ')}
    >
      {count !== undefined ? (
        <span className="rounded-full bg-black/70 px-2 py-0.5 text-lg font-bold text-slate-100">
          {count}
        </span>
      ) : null}
    </div>
  );
}

export function CardPile({
  label,
  count,
  size = 'board',
}: {
  label: string;
  count: number;
  size?: CardSize;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <CardBack count={count} size={size} />
      <span className="text-xs text-slate-300">{label}</span>
    </div>
  );
}
