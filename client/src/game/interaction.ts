/**
 * Pure helpers that turn the host-computed `legal` intent list into UI affordances.
 * Nothing here invents an action: every returned intent is an element of `legal`
 * (except `attemptMove`, which is explicitly a "let the engine explain" fallback).
 */
import { isHiddenCard } from '@riftbound/engine';
import type {
  CardDatabase,
  ClientGameState,
  Intent,
  PlayLocation,
  PlayerId,
  StandardMoveIntent,
} from '@riftbound/engine';

export type PlayIntent = Extract<Intent, { type: 'PLAY_CARD' }>;
export type MoveIntent = Extract<Intent, { type: 'STANDARD_MOVE' }>;
export type HideIntent = Extract<Intent, { type: 'HIDE_CARD' }>;
export type EquipIntent = Extract<Intent, { type: 'EQUIP' }>;

/** 'base' or a battlefield id. */
export type DestKey = string;

export function destKey(loc: PlayLocation | undefined): DestKey {
  return !loc || loc.kind === 'base' ? 'base' : loc.battlefieldId;
}

export function destLocation(key: DestKey): PlayLocation {
  return key === 'base' ? { kind: 'base' } : { kind: 'battlefield', battlefieldId: key };
}

// ------------------------------------------------------------------ PLAY_CARD

/** Distinct legal play variants for one card instance (one per location x accelerate). */
export function playVariants(legal: readonly Intent[], cardInstanceId: string): PlayIntent[] {
  const seen = new Set<string>();
  const out: PlayIntent[] = [];
  for (const i of legal) {
    if (i.type !== 'PLAY_CARD' || i.cardInstanceId !== cardInstanceId) continue;
    const tgt = (i.targets ?? []).map((t) => (t.kind === 'object' ? t.id : '')).join(',');
    const key = `${i.location ? destKey(i.location) : '-'}|${i.additionalCosts?.accelerate ? 'acc' : ''}|${tgt}`;
    if (seen.has(key)) continue; // first matching payment wins
    seen.add(key);
    out.push(i);
  }
  return out;
}

export function playableIds(legal: readonly Intent[]): Set<string> {
  const s = new Set<string>();
  for (const i of legal) if (i.type === 'PLAY_CARD') s.add(i.cardInstanceId);
  return s;
}

export function hideVariants(legal: readonly Intent[], cardInstanceId: string): HideIntent[] {
  return legal.filter(
    (i): i is HideIntent => i.type === 'HIDE_CARD' && i.cardInstanceId === cardInstanceId,
  );
}

export function equipVariants(
  legal: readonly Intent[],
  match: { equipmentId?: string; unitId?: string },
): EquipIntent[] {
  return legal.filter(
    (i): i is EquipIntent =>
      i.type === 'EQUIP' &&
      (match.equipmentId === undefined || i.equipmentId === match.equipmentId) &&
      (match.unitId === undefined || i.unitId === match.unitId),
  );
}

export function locationName(
  loc: PlayLocation | undefined,
  view: ClientGameState,
  cards: CardDatabase,
): string {
  if (!loc || loc.kind === 'base') return 'Base';
  const bf = view.battlefields.find((b) => b.id === loc.battlefieldId);
  return (bf && cards[bf.cardId]?.name) || 'Battlefield';
}

export function variantLabel(
  intent: PlayIntent,
  view: ClientGameState,
  cards: CardDatabase,
): string {
  const parts: string[] = [];
  if (intent.location) parts.push(`Play to ${locationName(intent.location, view, cards)}`);
  else parts.push('Play');
  if (intent.additionalCosts?.accelerate) parts.push('Accelerate (+1 energy +1 power)');
  for (const t of intent.targets ?? []) {
    if (t.kind !== 'object') continue;
    const o = view.objects[t.id];
    if (!o || isHiddenCard(o)) {
      parts.push('target a unit');
      continue;
    }
    const name = cards[o.cardId]?.name ?? 'a unit';
    parts.push(`target ${name}${o.controller !== view.viewer ? ' (opponent)' : ' (yours)'}`);
  }
  return parts.join(' - ');
}

// ------------------------------------------------------------------ click-to-target

const objectTargetIds = (i: PlayIntent): string[] =>
  (i.targets ?? []).flatMap((t) => (t.kind === 'object' ? [t.id] : []));

/**
 * All legal PLAY_CARD variants of a card IF it is a targeted spell the board can drive: every legal
 * variant carries at least one target and all targets are public objects in play (base/battlefield).
 * Returns [] otherwise (no targets, hidden/offboard/player/battlefield targets): the caller then
 * keeps the popover flow.
 */
export function targetedVariants(
  legal: readonly Intent[],
  cardInstanceId: string,
  view: ClientGameState,
): PlayIntent[] {
  const all = legal.filter(
    (i): i is PlayIntent => i.type === 'PLAY_CARD' && i.cardInstanceId === cardInstanceId,
  );
  if (all.length === 0) return [];
  for (const v of all) {
    const targets = v.targets ?? [];
    if (targets.length === 0 || targets.some((t) => t.kind !== 'object')) return [];
    for (const id of objectTargetIds(v)) {
      const o = view.objects[id];
      if (!o || isHiddenCard(o)) return [];
      if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') return [];
    }
  }
  return all;
}

export interface TargetStep {
  /** Largest number of targets any variant takes. */
  total: number;
  /** Units that can be picked next: they follow `chosen` as a prefix in some variant. */
  candidates: Set<string>;
  /** Distinct (location x accelerate) variants whose targets are exactly `chosen`. */
  exact: PlayIntent[];
}

export function targetStep(variants: readonly PlayIntent[], chosen: readonly string[]): TargetStep {
  let total = 0;
  const candidates = new Set<string>();
  const exact: PlayIntent[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    const ids = objectTargetIds(v);
    total = Math.max(total, ids.length);
    if (ids.length < chosen.length || !chosen.every((c, k) => ids[k] === c)) continue;
    if (ids.length === chosen.length) {
      const key = `${v.location ? destKey(v.location) : '-'}|${v.additionalCosts?.accelerate ? 'acc' : ''}`;
      if (chosen.length > 0 && !seen.has(key)) {
        seen.add(key);
        exact.push(v);
      }
    } else {
      const next = ids[chosen.length];
      if (next !== undefined) candidates.add(next);
    }
  }
  return { total, candidates, exact };
}

/** Extra Deflect cost (Power) for targeting this opposing unit; 0 for own units or no Deflect. */
export function deflectPower(id: string, view: ClientGameState, cards: CardDatabase): number {
  const o = view.objects[id];
  if (!o || isHiddenCard(o) || o.controller === view.viewer) return 0;
  let total = 0;
  for (const k of cards[o.cardId]?.keywords ?? []) if (k.name === 'Deflect') total += k.value ?? 1;
  return total;
}

// ------------------------------------------------------------------ STANDARD_MOVE

/** A way to reach a destination: one exact intent, or a sequence of single-unit intents. */
export interface MoveOption {
  dest: DestKey;
  intents: MoveIntent[];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/** Every unit id that appears in some legal STANDARD_MOVE. */
export function movableUnitIds(legal: readonly Intent[]): Set<string> {
  const s = new Set<string>();
  for (const i of legal) if (i.type === 'STANDARD_MOVE') for (const u of i.unitIds) s.add(u);
  return s;
}

/**
 * Legal destinations for the selected units. Exact set matches win; otherwise, destinations that
 * every selected unit can reach individually (executed as one single-unit move per unit).
 */
export function moveOptions(legal: readonly Intent[], selected: readonly string[]): MoveOption[] {
  if (selected.length === 0) return [];
  const moves = legal.filter((i): i is MoveIntent => i.type === 'STANDARD_MOVE');
  const exact = new Map<DestKey, MoveIntent>();
  for (const m of moves) {
    if (sameSet(m.unitIds, selected) && !exact.has(destKey(m.destination))) {
      exact.set(destKey(m.destination), m);
    }
  }
  if (exact.size > 0) return [...exact].map(([dest, m]) => ({ dest, intents: [m] }));
  if (selected.length === 1) return [];
  // No exact match: destinations reachable by every selected unit via single-unit moves.
  const perUnit = selected.map((u) => {
    const byDest = new Map<DestKey, MoveIntent>();
    for (const m of moves) {
      if (m.unitIds.length === 1 && m.unitIds[0] === u && !byDest.has(destKey(m.destination))) {
        byDest.set(destKey(m.destination), m);
      }
    }
    return byDest;
  });
  const first = perUnit[0];
  if (!first) return [];
  const out: MoveOption[] = [];
  for (const dest of first.keys()) {
    if (perUnit.every((m) => m.has(dest))) {
      out.push({ dest, intents: perUnit.map((m) => m.get(dest) as MoveIntent) });
    }
  }
  return out;
}

/** An unvetted move used when the player clicks a destination that is not in `legal`: the engine explains why. */
export function attemptMove(
  playerId: PlayerId,
  selected: readonly string[],
  dest: DestKey,
): StandardMoveIntent {
  return {
    type: 'STANDARD_MOVE',
    playerId,
    unitIds: [...selected],
    destination: destLocation(dest),
  };
}

// ------------------------------------------------------------------ pass / end turn

export interface PrimaryAction {
  intent: Intent;
  label: string;
}

/** The "advance the game" button: End turn (neutral main phase) or Pass (priority-holding states). */
export function primaryAction(
  view: ClientGameState,
  legal: readonly Intent[],
): PrimaryAction | null {
  const end = legal.find((i) => i.type === 'END_TURN');
  if (end) return { intent: end, label: 'End turn' };
  const pass = legal.find((i) => i.type === 'PASS_PRIORITY');
  if (!pass) return null;
  let label = 'Pass';
  if (view.flow.chain.length > 0) label = 'Pass (let it resolve)';
  else if (view.flow.showdown) label = 'Pass focus';
  return { intent: pass, label };
}

// ------------------------------------------------------------------ mulligan

/** Finds the legal MULLIGAN intent with exactly these card ids (order-insensitive). */
export function findMulligan(legal: readonly Intent[], cardIds: readonly string[]): Intent | null {
  for (const i of legal) {
    if (i.type === 'MULLIGAN' && sameSet(i.cardIds, cardIds)) return i;
  }
  return null;
}

// ------------------------------------------------------------------ misc

export function cardNameOf(id: string, view: ClientGameState, cards: CardDatabase): string {
  const o = view.objects[id];
  if (!o || isHiddenCard(o)) return 'Face-down card';
  return cards[o.cardId]?.name ?? 'Card';
}

/** Whether keyboard focus is somewhere the global Space/Enter shortcut must not hijack. */
export function isTypingOrInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target === document.body) return false;
  const tag = target.tagName;
  if (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    tag === 'A'
  ) {
    return true;
  }
  const role = target.getAttribute('role');
  return role === 'button' || role === 'menuitem' || role === 'checkbox' || role === 'textbox';
}
