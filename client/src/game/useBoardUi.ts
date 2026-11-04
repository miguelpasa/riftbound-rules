import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { CardInstance, Intent } from '@riftbound/engine';
import { isHiddenCard } from '@riftbound/engine';
import type { GameApi } from '../app/gameApi';
import { toastFromRuleError } from '../components/Toasts';
import {
  attemptMove,
  equipVariants,
  hideVariants,
  locationName,
  moveOptions,
  movableUnitIds,
  playVariants,
  playableIds,
  variantLabel,
  cardNameOf,
  type DestKey,
  type MoveOption,
} from './interaction';

export interface PopoverItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface PopoverState {
  title: string;
  items: PopoverItem[];
  x: number;
  y: number;
}

/** Everything the board components need to be interactive; derived from `api.legal`. */
export interface BoardUi {
  api: GameApi;
  /** Hand/champion/facedown card ids with at least one legal PLAY_CARD. */
  playable: Set<string>;
  /** Unit ids that appear in at least one legal STANDARD_MOVE. */
  movable: Set<string>;
  selected: string[];
  /** Legal destinations for the current selection (or the unit being dragged). */
  destOptions: Map<DestKey, MoveOption>;
  hovered: string | null;
  setHovered: (id: string | null) => void;
  popover: PopoverState | null;
  closePopover: () => void;
  /** Sends an intent; shows the engine's rule error as a toast when rejected. Resolves true when accepted. */
  submit: (intent: Intent) => Promise<boolean>;
  clickUnit: (id: string, additive: boolean) => void;
  clearSelection: () => void;
  clickHandCard: (id: string, anchor: Element | null) => void;
  /** Click on a destination zone (battlefield id or 'base'). */
  moveTo: (dest: DestKey) => Promise<void>;
  contextMenu: (e: ReactMouseEvent, id: string) => void;
  dragIds: string[] | null;
  startDrag: (id: string) => string[];
  endDrag: () => void;
  dropOn: (dest: DestKey) => Promise<void>;
}

export function useBoardUi(api: GameApi): BoardUi {
  const { cards, view, legal, seat } = api;
  const [selected, setSelected] = useState<string[]>([]);
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);

  // Drop selections that are no longer movable (a unit died or the state moved on).
  const liveSelected = useMemo(
    () =>
      selected.filter((id) => {
        const o = view.objects[id];
        return o !== undefined && !isHiddenCard(o) && o.controller === seat;
      }),
    [selected, view.objects, seat],
  );

  const playable = useMemo(() => playableIds(legal), [legal]);
  const movable = useMemo(() => movableUnitIds(legal), [legal]);
  const activeIds = dragIds ?? liveSelected;
  const destOptions = useMemo(() => {
    const map = new Map<DestKey, MoveOption>();
    for (const o of moveOptions(legal, activeIds)) map.set(o.dest, o);
    return map;
  }, [legal, activeIds]);

  const submit = useCallback(
    async (intent: Intent): Promise<boolean> => {
      const r = await api.send(intent);
      if (r.ok) return true;
      toastFromRuleError(r);
      return false;
    },
    [api],
  );

  const closePopover = useCallback(() => setPopover(null), []);

  const runMove = useCallback(
    async (ids: string[], dest: DestKey): Promise<void> => {
      if (ids.length === 0) return;
      const option = moveOptions(legal, ids).find((o) => o.dest === dest);
      // Not derivable from `legal`: let the engine explain why with its exact rule error.
      const intents: Intent[] = option ? option.intents : [attemptMove(seat, ids, dest)];
      for (const intent of intents) {
        if (!(await submit(intent))) return;
      }
      setSelected([]);
    },
    [legal, seat, submit],
  );

  const clickUnit = useCallback((id: string, additive: boolean) => {
    setPopover(null);
    setSelected((cur) => {
      if (additive) return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      return cur.length === 1 && cur[0] === id ? [] : [id];
    });
  }, []);

  const clearSelection = useCallback(() => setSelected([]), []);

  const clickHandCard = useCallback(
    (id: string, anchor: Element | null) => {
      const obj = view.objects[id];
      if (!obj || isHiddenCard(obj)) return;
      const variants = playVariants(legal, id);
      if (variants.length === 0) {
        // Illegal: attempt anyway so the player sees the engine's exact [Rule Error].
        const def = cards[obj.cardId];
        void submit({
          type: 'PLAY_CARD',
          playerId: seat,
          cardInstanceId: id,
          ...(def?.type === 'UNIT' && obj.zone.kind !== 'facedown'
            ? { location: { kind: 'base' as const } }
            : {}),
          payment: [],
        });
        return;
      }
      const [only] = variants;
      if (variants.length === 1 && only) {
        void submit(only);
        return;
      }
      const rect = anchor?.getBoundingClientRect();
      setPopover({
        title: `Play ${cardNameOf(id, view, cards)}`,
        x: rect ? rect.left : 200,
        y: rect ? rect.top : 200,
        items: variants.map((v) => ({
          label: variantLabel(v, view, cards),
          onSelect: () => {
            setPopover(null);
            void submit(v);
          },
        })),
      });
    },
    [view, legal, cards, seat, submit],
  );

  const moveTo = useCallback(
    (dest: DestKey) => runMove(liveSelected, dest),
    [runMove, liveSelected],
  );

  const contextMenu = useCallback(
    (e: ReactMouseEvent, id: string) => {
      const obj = view.objects[id] as CardInstance | undefined;
      if (!obj || isHiddenCard(obj)) return;
      e.preventDefault();
      const items: PopoverItem[] = [];
      for (const v of playVariants(legal, id)) {
        items.push({
          label: variantLabel(v, view, cards),
          onSelect: () => {
            setPopover(null);
            void submit(v);
          },
        });
      }
      for (const h of hideVariants(legal, id)) {
        items.push({
          label: `Hide at ${locationName({ kind: 'battlefield', battlefieldId: h.battlefieldId }, view, cards)} (Hidden)`,
          onSelect: () => {
            setPopover(null);
            void submit(h);
          },
        });
      }
      for (const q of equipVariants(legal, { equipmentId: id })) {
        items.push({
          label: `Equip to ${cardNameOf(q.unitId, view, cards)}`,
          onSelect: () => {
            setPopover(null);
            void submit(q);
          },
        });
      }
      for (const q of equipVariants(legal, { unitId: id })) {
        items.push({
          label: `Attach ${cardNameOf(q.equipmentId, view, cards)}`,
          onSelect: () => {
            setPopover(null);
            void submit(q);
          },
        });
      }
      if (items.length === 0) {
        items.push({
          label: 'No legal actions for this card',
          onSelect: () => undefined,
          disabled: true,
        });
      }
      setPopover({ title: cardNameOf(id, view, cards), items, x: e.clientX, y: e.clientY });
    },
    [view, legal, cards, submit],
  );

  const startDrag = useCallback(
    (id: string): string[] => {
      const ids = liveSelected.includes(id) ? liveSelected : [id];
      setSelected(ids);
      setDragIds(ids);
      return ids;
    },
    [liveSelected],
  );
  const endDrag = useCallback(() => setDragIds(null), []);
  const dropOn = useCallback(
    async (dest: DestKey): Promise<void> => {
      const ids = dragIds;
      setDragIds(null);
      if (ids) await runMove(ids, dest);
    },
    [dragIds, runMove],
  );

  return {
    api,
    playable,
    movable,
    selected: liveSelected,
    destOptions,
    hovered,
    setHovered,
    popover,
    closePopover,
    submit,
    clickUnit,
    clearSelection,
    clickHandCard,
    moveTo,
    contextMenu,
    dragIds,
    startDrag,
    endDrag,
    dropOn,
  };
}
