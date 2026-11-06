import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type {
  ActivateAbilityIntent,
  CardInstance,
  CostCardChoice,
  Intent,
} from '@riftbound/engine';
import { isHiddenCard, itemSourceId } from '@riftbound/engine';
import type { GameApi } from '../app/gameApi';
import { toastFromRuleError } from '../components/Toasts';
import { abilityGroups, describeAbilityAt } from './abilities';
import {
  abilityTargetedVariants,
  triggerTargetVariants,
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
  type TargetedIntent,
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

/** What a click-to-target flow chooses targets for (R41 adds abilities and triggers). */
export type TargetSource =
  | { kind: 'play'; cardId: string; costCards?: string[] }
  | { kind: 'ability'; sourceId: string; abilityIndex: number; costCards?: string[] }
  | { kind: 'trigger'; chainItemId: string; sourceId: string };

/** Active click-to-target flow for a spell, ability or trigger (derived from `legal`; never invented). */
export interface TargetingState {
  source: TargetSource;
  /** A pending trigger choice is mandatory: no Cancel. */
  cancelable: boolean;
  /** Object id of the card, ability source or trigger source being targeted for. */
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

/** R46: an activated ability with a card-choice cost is waiting for the player to pick the cards. */
export interface CostPickState {
  sourceId: string;
  abilityIndex: number;
  cost: CostCardChoice;
  /**
   * R47: the cost is an additional cost of PLAYING the card `sourceId` (`abilityIndex` is -1). The picker
   * opens before the targets; `variant` is a play already chosen (Repeat's "Discard 1"), else the rest of
   * the play flow (targets, location) follows with the chosen cards.
   */
  play?: boolean;
  variant?: PlayIntent;
  at?: { x: number; y: number };
}

/** R47: the legal plays of `cardId` with the chosen cost cards swapped in (the engine lists a capped set). */
function withCostCards(legal: readonly Intent[], cardId: string, chosen: string[]): Intent[] {
  return legal.map((i) =>
    i.type === 'PLAY_CARD' && i.cardInstanceId === cardId && i.costCards !== undefined
      ? { ...i, costCards: chosen }
      : i,
  );
}

const sameCards = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  (a ?? []).length === b.length && b.every((x) => (a ?? []).includes(x));

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
  /** Start choosing the targets of a targeted activated ability (R41). */
  startAbilityTargeting: (sourceId: string, abilityIndex: number) => void;
  /**
   * Activate an ability the way its shape needs (R46): a card-choice cost opens the cost picker first,
   * then the targets (if any) are clicked on the board, otherwise the first legal variant is sent.
   */
  activateAbility: (sourceId: string, abilityIndex: number) => void;
  costPick: CostPickState | null;
  confirmCostPick: (cards: string[]) => void;
  cancelCostPick: () => void;
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

export interface BoardUiOptions {
  /** Every plain unit click adds to / removes from the selection (tutorial). */
  additiveSelection?: boolean;
}

export function useBoardUi(api: GameApi, opts: BoardUiOptions = {}): BoardUi {
  const alwaysAdditive = opts.additiveSelection === true;
  const { cards, view, legal, seat } = api;
  const [selected, setSelected] = useState<string[]>([]);
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [costPick, setCostPick] = useState<CostPickState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [targetingRaw, setTargetingRaw] = useState<{
    source: Exclude<TargetSource, { kind: 'trigger' }>;
    chosen: string[];
  } | null>(null);
  // R41: a trigger-target choice is dictated by the engine (flow.pendingChoice), not by a click.
  const [triggerChosen, setTriggerChosen] = useState<{ itemId: string; chosen: string[] } | null>(
    null,
  );
  const pendingTrigger =
    view.flow.pendingChoice?.kind === 'TRIGGER_TARGET' && view.flow.pendingChoice.player === seat
      ? view.flow.pendingChoice
      : null;

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

  const startAbilityTargeting = useCallback((sourceId: string, abilityIndex: number) => {
    setPopover(null);
    setTargetingRaw({ source: { kind: 'ability', sourceId, abilityIndex }, chosen: [] });
  }, []);

  const activateAbility = useCallback(
    (sourceId: string, abilityIndex: number) => {
      setPopover(null);
      const obj = view.objects[sourceId];
      const def = obj && !isHiddenCard(obj) ? cards[obj.cardId] : undefined;
      const cost = def?.abilities?.[abilityIndex]?.cost.card;
      if (cost) {
        setTargetingRaw(null);
        setCostPick({ sourceId, abilityIndex, cost });
        return;
      }
      if (abilityTargetedVariants(legal, sourceId, abilityIndex, view).length > 0) {
        setTargetingRaw({ source: { kind: 'ability', sourceId, abilityIndex }, chosen: [] });
        return;
      }
      const first = legal.find(
        (i): i is ActivateAbilityIntent =>
          i.type === 'ACTIVATE_ABILITY' &&
          i.sourceId === sourceId &&
          i.abilityIndex === abilityIndex,
      );
      if (first) void submit(first);
    },
    [view, cards, legal, submit],
  );

  /** A chosen play variant: one that still needs cost cards (Repeat's "Discard 1") opens the picker first. */
  const choosePlay = useCallback(
    (v: PlayIntent, at: { x: number; y: number }, paid = false): void => {
      setPopover(null);
      const obj = view.objects[v.cardInstanceId];
      const def = obj && !isHiddenCard(obj) ? cards[obj.cardId] : undefined;
      const cost =
        def?.additionalCost?.card ??
        (v.additionalCosts?.repeat ? def?.repeatCost?.card : undefined);
      if (!paid && v.costCards !== undefined && cost) {
        setCostPick({
          sourceId: v.cardInstanceId,
          abilityIndex: -1,
          cost,
          play: true,
          variant: v,
          at,
        });
        return;
      }
      void submit(v);
    },
    [view, cards, submit],
  );

  /** The play flow of a hand card on `list` (the legal intents, with cost cards already chosen if any). */
  const startPlay = useCallback(
    (
      id: string,
      list: readonly Intent[],
      at: { x: number; y: number },
      costCards?: string[],
    ): void => {
      const obj = view.objects[id];
      if (!obj || isHiddenCard(obj)) return;
      if (targetedVariants(list, id, view).length > 0) {
        setPopover(null);
        setTargetingRaw({
          source: { kind: 'play', cardId: id, ...(costCards ? { costCards } : {}) },
          chosen: [],
        });
        return;
      }
      const variants = playVariants(list, id);
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
        choosePlay(only, at, costCards !== undefined);
        return;
      }
      setPopover({
        title: `Play ${cardNameOf(id, view, cards)}`,
        x: at.x,
        y: at.y,
        items: variants.map((v) => ({
          label: variantLabel(v, view, cards),
          onSelect: () => choosePlay(v, at, costCards !== undefined),
        })),
      });
    },
    [view, cards, seat, submit, choosePlay],
  );

  const cancelCostPick = useCallback(() => setCostPick(null), []);

  const confirmCostPick = useCallback(
    (chosen: string[]) => {
      const pick = costPick;
      if (!pick) return;
      setCostPick(null);
      if (pick.play) {
        // R47: a play whose variant is already chosen is sent with the cards; otherwise the rest of the
        // play flow (targets, location) follows on the legal plays with these cards swapped in.
        if (pick.variant) void submit({ ...pick.variant, costCards: chosen });
        else
          startPlay(
            pick.sourceId,
            withCostCards(legal, pick.sourceId, chosen),
            pick.at ?? { x: 200, y: 200 },
            chosen,
          );
        return;
      }
      const mine = legal.filter(
        (i): i is ActivateAbilityIntent =>
          i.type === 'ACTIVATE_ABILITY' &&
          i.sourceId === pick.sourceId &&
          i.abilityIndex === pick.abilityIndex,
      );
      const matching = mine.filter((i) => sameCards(i.costCards, chosen));
      const scoped = legal.filter(
        (i) =>
          !mine.includes(i as ActivateAbilityIntent) ||
          matching.includes(i as ActivateAbilityIntent),
      );
      if (abilityTargetedVariants(scoped, pick.sourceId, pick.abilityIndex, view).length > 0) {
        setTargetingRaw({
          source: {
            kind: 'ability',
            sourceId: pick.sourceId,
            abilityIndex: pick.abilityIndex,
            costCards: chosen,
          },
          chosen: [],
        });
        return;
      }
      // The engine lists a capped set of card choices; any legal choice is sent with the cards swapped in.
      const template = matching[0] ?? mine[0];
      if (template) void submit({ ...template, costCards: chosen });
    },
    [costPick, legal, view, submit, startPlay],
  );

  const submitTargeted = useCallback(
    async (intent: TargetedIntent): Promise<void> => {
      if (await submit(intent)) {
        setTargetingRaw(null);
        setTriggerChosen(null);
      }
    },
    [submit],
  );

  /** The source being targeted for and the targets picked so far. */
  const activeSource = useMemo((): { source: TargetSource; chosen: string[] } | null => {
    if (pendingTrigger) {
      const item = view.flow.chain.find((i) => i.id === pendingTrigger.chainItemId);
      const chosen =
        triggerChosen?.itemId === pendingTrigger.chainItemId ? triggerChosen.chosen : [];
      return {
        source: {
          kind: 'trigger',
          chainItemId: pendingTrigger.chainItemId,
          sourceId: item ? itemSourceId(item) : '',
        },
        chosen,
      };
    }
    return targetingRaw;
  }, [pendingTrigger, view.flow.chain, triggerChosen, targetingRaw]);

  const variantsOf = useCallback(
    (source: TargetSource): TargetedIntent[] => {
      switch (source.kind) {
        case 'play':
          return targetedVariants(
            source.costCards ? withCostCards(legal, source.cardId, source.costCards) : legal,
            source.cardId,
            view,
          );
        case 'ability': {
          // R46: only the variants that pay with the cards already chosen.
          const cc = source.costCards;
          const scoped = cc
            ? legal.filter(
                (i) =>
                  !(
                    i.type === 'ACTIVATE_ABILITY' &&
                    i.sourceId === source.sourceId &&
                    i.abilityIndex === source.abilityIndex
                  ) ||
                  (i.type === 'ACTIVATE_ABILITY' && sameCards(i.costCards, cc)),
              )
            : legal;
          return abilityTargetedVariants(scoped, source.sourceId, source.abilityIndex, view);
        }
        case 'trigger':
          return triggerTargetVariants(legal, source.chainItemId, view);
      }
    },
    [legal, view],
  );

  const setChosen = useCallback((source: TargetSource, chosen: string[]) => {
    if (source.kind === 'trigger') setTriggerChosen({ itemId: source.chainItemId, chosen });
    else setTargetingRaw({ source, chosen });
  }, []);

  const targeting = useMemo<TargetingState | null>(() => {
    if (!activeSource) return null;
    const { source, chosen } = activeSource;
    const variants = variantsOf(source);
    if (variants.length === 0) return null;
    const step = targetStep(variants, chosen);
    if (step.candidates.size === 0 && step.exact.length === 0) return null;
    const sourceId = source.kind === 'play' ? source.cardId : source.sourceId;
    const name = cardNameOf(sourceId, view, cards);
    return {
      source,
      cancelable: source.kind !== 'trigger',
      cardId: sourceId,
      cardName:
        source.kind === 'play'
          ? name
          : source.kind === 'ability'
            ? `${name} (ability)`
            : `${name} (triggered ability)`,
      slot: Math.min(chosen.length + 1, step.total),
      total: step.total,
      chosen,
      candidates: step.candidates,
      confirmOptions: step.exact.map((v) => ({
        label:
          step.exact.length > 1 && v.type === 'PLAY_CARD'
            ? `Confirm: ${variantLabel(v, view, cards)}`
            : 'Confirm targets',
        onSelect: () => void submitTargeted(v),
      })),
    };
  }, [activeSource, variantsOf, view, cards, submitTargeted]);

  const pickTarget = useCallback(
    (id: string) => {
      if (!targeting || !targeting.candidates.has(id)) return;
      const chosen = [...targeting.chosen, id];
      const step = targetStep(variantsOf(targeting.source), chosen);
      const [only] = step.exact;
      setChosen(targeting.source, chosen);
      if (step.candidates.size === 0 && step.exact.length === 1 && only) {
        void submitTargeted(only);
      }
    },
    [targeting, variantsOf, setChosen, submitTargeted],
  );

  useEffect(() => {
    if (!costPick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCostPick(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [costPick]);

  const targetingActive = targeting !== null && targeting.cancelable;
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

  const clickUnit = useCallback(
    (id: string, additive: boolean) => {
      setPopover(null);
      setSelected((cur) => {
        if (additive || alwaysAdditive)
          return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        return cur.length === 1 && cur[0] === id ? [] : [id];
      });
    },
    [alwaysAdditive],
  );

  const clearSelection = useCallback(() => setSelected([]), []);

  const clickHandCard = useCallback(
    (id: string, anchor: Element | null) => {
      const obj = view.objects[id];
      if (!obj || isHiddenCard(obj)) return;
      setTargetingRaw(null);
      const rect = anchor?.getBoundingClientRect();
      const at = { x: rect ? rect.left : 200, y: rect ? rect.top : 200 };
      // R47: a required card-choice additional cost is paid first, before targets and location.
      const cost = cards[obj.cardId]?.additionalCost?.card;
      if (cost && playVariants(legal, id).length > 0) {
        setPopover(null);
        setCostPick({ sourceId: id, abilityIndex: -1, cost, play: true, at });
        return;
      }
      startPlay(id, legal, at);
    },
    [view, legal, cards, startPlay],
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
          onSelect: () => choosePlay(v, { x: e.clientX, y: e.clientY }),
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
      for (const g of abilityGroups(legal, id)) {
        const d = describeAbilityAt(cards[obj.cardId], g.abilityIndex);
        const targeted = abilityTargetedVariants(legal, id, g.abilityIndex, view).length > 0;
        const paid = cards[obj.cardId]?.abilities?.[g.abilityIndex]?.cost.card !== undefined;
        items.push({
          label: `Activate: ${d?.summary ?? `ability ${g.abilityIndex + 1}`}${paid ? ' (choose cards)' : targeted ? ' (choose target)' : ''}`,
          onSelect: () => activateAbility(id, g.abilityIndex),
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
    [view, legal, cards, submit, activateAbility],
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
    startAbilityTargeting,
    activateAbility,
    costPick,
    confirmCostPick,
    cancelCostPick,
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
