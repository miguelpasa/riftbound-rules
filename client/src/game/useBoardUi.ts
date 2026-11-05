import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
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
  targetStep,
  targetedVariants,
  playableIds,
  variantLabel,
  cardNameOf,
  type DestKey,
  type MoveOption,
  type PlayIntent,
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

/** Active click-to-target flow for a targeted spell (derived from `legal`; never invented). */
export interface TargetingState {
  cardId: string;
  cardName: string;
  /** 1-based slot being chosen now. */
  slot: number;
  total: number;
  chosen: string[];
  /** Board units that can be picked next. */
  candidates: Set<string>;
  /** Ready-to-submit choices for the targets picked so far (empty until a full variant matches). */
  confirmOptions: { label: string; onSelect: () => void }[];
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
  targeting: TargetingState | null;
  pickTarget: (id: string) => void;
  cancelTargeting: () => void;
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
  const [targetingRaw, setTargetingRaw] = useState<{ cardId: string; chosen: string[] } | null>(
    null,
  );

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

  const cancelTargeting = useCallback(() => setTargetingRaw(null), []);

  const submitTargeted = useCallback(
    async (intent: PlayIntent): Promise<void> => {
      if (await submit(intent)) setTargetingRaw(null);
    },
    [submit],
  );

  const targeting = useMemo<TargetingState | null>(() => {
    if (!targetingRaw) return null;
    const variants = targetedVariants(legal, targetingRaw.cardId, view);
    if (variants.length === 0) return null;
    const step = targetStep(variants, targetingRaw.chosen);
    if (step.candidates.size === 0 && step.exact.length === 0) return null;
    const chosen = targetingRaw.chosen;
    return {
      cardId: targetingRaw.cardId,
      cardName: cardNameOf(targetingRaw.cardId, view, cards),
      slot: Math.min(chosen.length + 1, step.total),
      total: step.total,
      chosen,
      candidates: step.candidates,
      confirmOptions: step.exact.map((v) => ({
        label:
          step.exact.length > 1 ? `Confirm: ${variantLabel(v, view, cards)}` : 'Confirm targets',
        onSelect: () => void submitTargeted(v),
      })),
    };
  }, [targetingRaw, legal, view, cards, submitTargeted]);

  const pickTarget = useCallback(
    (id: string) => {
      if (!targeting || !targeting.candidates.has(id)) return;
      const chosen = [...targeting.chosen, id];
      const step = targetStep(targetedVariants(legal, targeting.cardId, view), chosen);
      const [only] = step.exact;
      if (step.candidates.size === 0 && step.exact.length === 1 && only) {
        setTargetingRaw({ cardId: targeting.cardId, chosen });
        void submitTargeted(only);
        return;
      }
      setTargetingRaw({ cardId: targeting.cardId, chosen });
    },
    [targeting, legal, view, submitTargeted],
  );

  const targetingActive = targeting !== null;
  useEffect(() => {
    if (!targetingActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTargetingRaw(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [targetingActive]);

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
      setTargetingRaw(null);
      if (targetedVariants(legal, id, view).length > 0) {
        setPopover(null);
        setTargetingRaw({ cardId: id, chosen: [] });
        return;
      }
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
    targeting,
    pickTarget,
    cancelTargeting,
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
