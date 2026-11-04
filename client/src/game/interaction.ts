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
    const key = `${i.location ? destKey(i.location) : '-'}|${i.additionalCosts?.accelerate ? 'acc' : ''}`;
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
  return parts.join(' - ');
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
