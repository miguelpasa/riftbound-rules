import { fork } from './workingCopy.js';
import type { ChainItem, GameState, Target } from './types/index.js';

/**
 * X3 (563.2.c.2-4): an object that leaves the Board for a non-Board zone (or the other way round) and comes
 * back is a NEW object, so a spell or ability that targeted it must not affect it. Object ids stay the same
 * in this engine, so a Chain item records the generation of each targeted object (`targetGens`, only when
 * non-zero) when it is created, and `trackTargetGens` bumps `CardInstance.gen` whenever a targeted object changes
 * zone class (base and battlefield are both "Board"; moving between them keeps the object). Resolution then
 * treats a target whose generation changed as gone (`liveTargets`). Nothing is stored for objects that no
 * Chain item targets, so games without targeted effects are unchanged.
 */
const klass = (o: { zone: { kind: string } }): string =>
  o.zone.kind === 'base' || o.zone.kind === 'battlefield' ? 'board' : o.zone.kind;

const objectTargets = (item: ChainItem): string[] =>
  item.targets.flatMap((t) => (t.kind === 'object' ? [t.id] : []));

/** Compare `before` and `after` (one reduced step) and update generations; returns the state to use. */
export function trackTargetGens(before: GameState, after: GameState): GameState {
  const bump = new Set<string>();
  for (const item of after.flow.chain) {
    for (const id of objectTargets(item)) {
      const b = before.objects[id];
      const a = after.objects[id];
      if (b && a && klass(b) !== klass(a)) bump.add(id);
    }
  }
  // A Chain item that appeared in this step records the (non-zero) generations of its targets.
  // (a triggered ability gets its targets in a later step than the one that creates its item)
  const had = new Map(before.flow.chain.map((i) => [i.id, objectTargets(i).length]));
  const isFresh = (i: ChainItem): boolean =>
    (had.get(i.id) ?? 0) === 0 && objectTargets(i).length > 0;
  const fresh = after.flow.chain.filter(isFresh);
  const needsGens = fresh.some((i) =>
    objectTargets(i).some((id) => (after.objects[id]?.gen ?? 0) > 0),
  );
  if (bump.size === 0 && !needsGens) return after;
  const w = fork(after);
  for (const id of bump) {
    const o = w.objects[id];
    if (o) o.gen = (o.gen ?? 0) + 1;
  }
  for (const item of w.flow.chain) {
    if (!isFresh(item) || item.targetGens) continue;
    const gens: Record<string, number> = {};
    for (const id of objectTargets(item)) {
      const g = w.objects[id]?.gen ?? 0;
      if (g > 0) gens[id] = g;
    }
    if (Object.keys(gens).length > 0) item.targetGens = gens;
  }
  return w;
}

/** The item's targets with every object that changed zones since they were chosen replaced by a gone one. */
export function liveTargets(state: GameState, item: ChainItem): Target[] {
  const gens = item.targetGens ?? {};
  return item.targets.map((t): Target => {
    if (t.kind !== 'object') return t;
    const recorded = gens[t.id] ?? 0;
    const now = state.objects[t.id]?.gen ?? 0;
    return recorded !== now ? { kind: 'object', id: '#gone' } : t;
  });
}
