/**
 * Resources: Energy, Power, the Rune Pool and runes (Core Rules 163-168, 356-357, 417).
 *
 * All functions are pure and isomorphic: they never mutate their inputs. State-changing
 * functions structuredClone the state, mutate the clone and return it.
 *
 * Assumptions / notes:
 * - Pool events: the event contract has no rune-pool event, so no events are emitted.
 * - EXHAUST needs a ready rune (UNIT_EXHAUSTED otherwise). RECYCLE has no readiness
 *   requirement (164.2.b: the cost is "Recycle"), so an exhausted rune can still be recycled.
 * - A recycled rune goes to the bottom (end of array) of its owner's runeDeck, is removed
 *   from the base and is set ready again (it is a fresh card in the deck).
 * - A rune produces Power of its first listed domain (`domains[0]`).
 * - Universal Power [A] lives in `RunePool.universal` and pays toward any Power demand (135.2.e.5,
 *   163.2.b); `addUniversalPower` is the entry point for effects that Add [A]. Specific-domain
 *   pool Power is spent first.
 */
import { fork } from './workingCopy.js';
import type {
  ActivateRuneIntent,
  CardDatabase,
  CardDef,
  CardInstance,
  Domain,
  GameState,
  PaymentPlan,
  PlayerId,
  ReduceResult,
  RuleError,
  RuneAction,
} from './types/index.js';
import { DOMAINS, ruleError } from './types/index.js';

/** A modification to a cost (increase or discount). Missing fields mean 0. */
export interface CostMod {
  energy?: number;
  /** Generic Power (any of the card's domains). */
  power?: number;
  /** Power payable with any single domain (e.g. Deflect surcharge). */
  anyPower?: number;
}

/**
 * One Power requirement of a cost.
 * - `domain: Domain`: must be paid with Power of exactly that domain.
 * - `domain: 'ANY'`: may be paid with Power of any domain, restricted to `of` when given
 *   (e.g. [C] on a multi-domain card: `of` = the card's domains).
 */
export interface PowerRequirement {
  domain: Domain | 'ANY';
  amount: number;
  of?: readonly Domain[];
}

/** Total cost of playing something: Energy plus a list of Power requirements. Never negative. */
export interface TotalCost {
  energy: number;
  power: PowerRequirement[];
}

export interface ComputeCostOptions {
  /** Pay the Accelerate additional cost: +1 Energy and +1 Power of one of the unit's domains. */
  accelerate?: boolean;
  increases?: CostMod[];
  discounts?: CostMod[];
}

function genericPower(card: CardDef, amount: number): PowerRequirement {
  const d = card.domains;
  if (d.length === 1) return { domain: d[0] as Domain, amount };
  if (d.length === 0) return { domain: 'ANY', amount };
  return { domain: 'ANY', amount, of: [...d] };
}

function sameReq(a: PowerRequirement, b: PowerRequirement): boolean {
  return a.domain === b.domain && (a.of ?? []).join(',') === (b.of ?? []).join(',');
}

function addReq(list: PowerRequirement[], r: PowerRequirement): void {
  if (r.amount <= 0) return;
  const found = list.find((x) => sameReq(x, r));
  if (found) found.amount += r.amount;
  else list.push({ ...r, ...(r.of ? { of: [...r.of] } : {}) });
}

/**
 * Total cost determination (Rule 356): base cost, additional costs (Accelerate, 356.2.b),
 * cost increases, then discounts, then clamp every component at >= 0 (356.6).
 */
export function computeTotalCost(card: CardDef, opts: ComputeCostOptions = {}): TotalCost {
  let energy = card.cost.energy;
  const power: PowerRequirement[] = [];
  for (const d of card.cost.domain ?? []) addReq(power, { domain: d.element, amount: d.amount });
  // `domain` is a breakdown of `power` (card data carries both); only the uncovered remainder is generic.
  const covered = (card.cost.domain ?? []).reduce((n, d) => n + d.amount, 0);
  const genericRemainder = (card.cost.power ?? 0) - covered;
  if (genericRemainder > 0) addReq(power, genericPower(card, genericRemainder));

  if (opts.accelerate) {
    energy += 1;
    addReq(power, genericPower(card, 1));
  }
  for (const inc of opts.increases ?? []) {
    energy += inc.energy ?? 0;
    if (inc.power) addReq(power, genericPower(card, inc.power));
    if (inc.anyPower) addReq(power, { domain: 'ANY', amount: inc.anyPower });
  }
  for (const dis of opts.discounts ?? []) {
    energy = Math.max(0, energy - (dis.energy ?? 0));
    let left = dis.power ?? 0;
    // Discount generic ('ANY') requirements first, then domain-specific ones from the end.
    const order = [
      ...power.filter((p) => p.domain === 'ANY'),
      ...power.filter((p) => p.domain !== 'ANY').reverse(),
    ];
    for (const p of order) {
      const take = Math.min(left, p.amount);
      p.amount -= take;
      left -= take;
    }
  }
  return { energy: Math.max(0, energy), power: power.filter((p) => p.amount > 0) };
}

// ---------------------------------------------------------------------------------------
// Rune board helpers
// ---------------------------------------------------------------------------------------

function idx(p: PlayerId): 0 | 1 {
  return p === 'p0' ? 0 : 1;
}

/** Runes (type RUNE) in the player's base controlled by them, in base order. */
export function getPlayerRunes(
  state: GameState,
  cards: CardDatabase,
  player: PlayerId,
  opts: { ready?: boolean } = {},
): CardInstance[] {
  const out: CardInstance[] = [];
  for (const id of state.players[idx(player)].base) {
    const o = state.objects[id];
    if (!o || o.controller !== player || cards[o.cardId]?.type !== 'RUNE') continue;
    if (opts.ready !== undefined && o.ready !== opts.ready) continue;
    out.push(o);
  }
  return out;
}

function runeDomain(cards: CardDatabase, rune: CardInstance): Domain | undefined {
  return cards[rune.cardId]?.domains[0];
}

/** Validate that `runeId` may take `mode` for `playerId`. Returns the rune or a RuleError. */
function checkRune(
  state: GameState,
  cards: CardDatabase,
  playerId: PlayerId,
  runeId: string,
  mode: RuneAction['mode'],
): { rune: CardInstance; domain?: Domain } | RuleError {
  const rune = state.objects[runeId];
  if (!rune) return ruleError('NOT_FOUND', `rune ${runeId}`);
  if (rune.controller !== playerId) return ruleError('NOT_OWNED', `rune ${runeId}`);
  if (cards[rune.cardId]?.type !== 'RUNE') {
    return ruleError('WRONG_CARD_TYPE', `${runeId} is not a rune`);
  }
  if (rune.zone.kind !== 'base' || rune.zone.player !== playerId) {
    return ruleError('ABILITY_NOT_AVAILABLE', `rune ${runeId} is not in your base`);
  }
  if (mode === 'EXHAUST') {
    if (!rune.ready) return ruleError('UNIT_EXHAUSTED', `rune ${runeId} is exhausted`);
    return { rune };
  }
  const domain = runeDomain(cards, rune);
  if (!domain) return ruleError('ABILITY_NOT_AVAILABLE', `rune ${runeId} has no domain`);
  return { rune, domain };
}

/** Apply an already-validated rune action to a (cloned) state. */
function applyRune(
  state: GameState,
  playerId: PlayerId,
  runeId: string,
  mode: RuneAction['mode'],
  domain?: Domain,
): void {
  const player = state.players[idx(playerId)];
  const rune = state.objects[runeId] as CardInstance;
  if (mode === 'EXHAUST') {
    rune.ready = false;
    player.runePool.energy += 1;
    return;
  }
  const d = domain as Domain;
  player.base = player.base.filter((id) => id !== runeId);
  state.players[idx(rune.owner)].runeDeck.push(runeId);
  rune.zone = { kind: 'runeDeck', player: rune.owner };
  rune.ready = true;
  player.runePool.power[d] = (player.runePool.power[d] ?? 0) + 1;
}

/** Activate a rune ability (Rule 164.2): EXHAUST adds 1 Energy, RECYCLE adds 1 Power. */
export function activateRune(
  state: GameState,
  cards: CardDatabase,
  intent: ActivateRuneIntent,
): ReduceResult {
  const checked = checkRune(state, cards, intent.playerId, intent.runeId, intent.mode);
  if ('ok' in checked) return checked;
  const next = fork(state);
  applyRune(next, intent.playerId, intent.runeId, intent.mode, checked.domain);
  return { ok: true, state: next, events: [] };
}

// ---------------------------------------------------------------------------------------
// Power allocation (min-cost flow over a tiny graph)
// ---------------------------------------------------------------------------------------

interface Source {
  /** 'ANY' = Universal Power [A], payable toward a Power demand of any Domain. */
  domain: Domain | 'ANY';
  capacity: number;
  cost: number;
  /** Rune id for rune sources; undefined for the pool. */
  runeId?: string;
}

interface Edge {
  to: number;
  cap: number;
  cost: number;
}

function allowedDomains(r: PowerRequirement): readonly Domain[] {
  if (r.domain !== 'ANY') return [r.domain];
  return r.of && r.of.length > 0 ? r.of : DOMAINS;
}

/**
 * Assign each unit of Power demand to a source (pool Power or a rune), minimising total cost.
 * Returns the flow used per source (same order as `sources`) or null if demand cannot be met.
 */
function allocate(demand: PowerRequirement[], sources: Source[]): number[] | null {
  const units: (readonly Domain[])[] = [];
  for (const r of demand) for (let i = 0; i < r.amount; i++) units.push(allowedDomains(r));
  const U = units.length;
  if (U === 0) return sources.map(() => 0);
  const S = 0;
  const domNode = (d: Domain): number => 1 + U + DOMAINS.indexOf(d);
  const T = 1 + U + DOMAINS.length;
  const UN = T + 1; // hub for Universal Power sources
  const N = T + 2;
  const edges: Edge[] = [];
  const adj: number[][] = Array.from({ length: N }, () => []);
  const add = (a: number, b: number, cap: number, cost: number): number => {
    (adj[a] as number[]).push(edges.length);
    edges.push({ to: b, cap, cost });
    (adj[b] as number[]).push(edges.length);
    edges.push({ to: a, cap: 0, cost: -cost });
    return edges.length - 2;
  };
  units.forEach((allowed, i) => {
    add(S, 1 + i, 1, 0);
    for (const d of allowed) add(1 + i, domNode(d), 1, 0);
  });
  for (const d of DOMAINS) add(domNode(d), UN, U, 0);
  const srcEdge = sources.map((s) =>
    s.domain === 'ANY'
      ? add(UN, T, s.capacity, s.cost)
      : add(domNode(s.domain), T, s.capacity, s.cost),
  );

  let flow = 0;
  while (flow < U) {
    const dist = new Array<number>(N).fill(Infinity);
    const prev = new Array<number>(N).fill(-1);
    dist[S] = 0;
    for (let iter = 0; iter < N; iter++) {
      let changed = false;
      for (let u = 0; u < N; u++) {
        const du = dist[u] as number;
        if (du === Infinity) continue;
        for (const ei of adj[u] as number[]) {
          const e = edges[ei] as Edge;
          if (e.cap > 0 && du + e.cost < (dist[e.to] as number)) {
            dist[e.to] = du + e.cost;
            prev[e.to] = ei;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    if (dist[T] === Infinity) return null;
    let v = T;
    while (v !== S) {
      const ei = prev[v] as number;
      (edges[ei] as Edge).cap -= 1;
      (edges[ei ^ 1] as Edge).cap += 1;
      v = (edges[ei ^ 1] as Edge).to;
    }
    flow += 1;
  }
  return srcEdge.map((ei, i) => (sources[i] as Source).capacity - (edges[ei] as Edge).cap);
}

function poolSources(power: Partial<Record<Domain, number>>, universal = 0): Source[] {
  const out: Source[] = [];
  // Spend specific Power before Universal Power (cost 1 vs 0 only matters for tie-breaks).
  if (universal > 0) out.push({ domain: 'ANY', capacity: universal, cost: 1 });
  for (const d of DOMAINS) {
    const c = power[d] ?? 0;
    if (c > 0) out.push({ domain: d, capacity: c, cost: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Paying costs
// ---------------------------------------------------------------------------------------

/**
 * Pay `cost` (Rule 357.1.a): apply the plan's rune activations in order into the Rune Pool,
 * then deduct the cost from the pool. Power requirements are matched to pool Power by an
 * optimal assignment (specific domains, restricted `ANY`, free `ANY`), so a payable cost is
 * never rejected because of an unlucky greedy choice. Surplus stays in the pool.
 * Errors: INVALID_PAYMENT (bad/duplicate/unready rune entries), INSUFFICIENT_RESOURCES.
 * The input state is never modified and is returned untouched in effect (errors carry no state).
 */
export function payCost(
  state: GameState,
  cards: CardDatabase,
  playerId: PlayerId,
  cost: TotalCost,
  payment: PaymentPlan,
): ReduceResult {
  const seen = new Set<string>();
  for (const a of payment) {
    if (seen.has(a.runeId)) return ruleError('INVALID_PAYMENT', `duplicate rune ${a.runeId}`);
    seen.add(a.runeId);
  }
  const next = fork(state);
  for (const a of payment) {
    const checked = checkRune(next, cards, playerId, a.runeId, a.mode);
    if ('ok' in checked) {
      return ruleError('INVALID_PAYMENT', checked.message.replace(/^\[Rule Error\] /, ''));
    }
    applyRune(next, playerId, a.runeId, a.mode, checked.domain);
  }
  const pool = next.players[idx(playerId)].runePool;
  if (pool.energy < cost.energy) return ruleError('INSUFFICIENT_RESOURCES', 'not enough Energy');
  const sources = poolSources(pool.power, pool.universal);
  const flows = allocate(cost.power, sources);
  if (!flows) return ruleError('INSUFFICIENT_RESOURCES', 'not enough Power');
  pool.energy -= cost.energy;
  sources.forEach((s, i) => {
    if (s.domain === 'ANY') {
      const left = (pool.universal ?? 0) - (flows[i] as number);
      if (left > 0) pool.universal = left;
      else delete pool.universal;
      return;
    }
    const left = (pool.power[s.domain] ?? 0) - (flows[i] as number);
    if (left > 0) pool.power[s.domain] = left;
    else delete pool.power[s.domain];
  });
  return { ok: true, state: next, events: [] };
}

/**
 * Find a minimal payment plan from the player's runes (existing pool counted first):
 * Power by recycling as few runes as possible (exhausted runes are recycled before ready ones),
 * Energy by exhausting ready runes that are not recycled. Returns null if unaffordable.
 * Never returns a plan that `payCost` rejects.
 */
export function autoPlan(
  state: GameState,
  cards: CardDatabase,
  playerId: PlayerId,
  cost: TotalCost,
): PaymentPlan | null {
  const pool = state.players[idx(playerId)].runePool;
  const runes = getPlayerRunes(state, cards, playerId).filter(
    (r) => r.zone.kind === 'base' && r.zone.player === playerId,
  );
  const sources = poolSources(pool.power, pool.universal);
  const poolCount = sources.length;
  const recyclable: CardInstance[] = [];
  for (const r of runes) {
    const d = runeDomain(cards, r);
    if (!d) continue;
    recyclable.push(r);
    sources.push({ domain: d, capacity: 1, cost: 1000 + (r.ready ? 1 : 0), runeId: r.id });
  }
  const flows = allocate(cost.power, sources);
  if (!flows) return null;
  const recycled = new Set<string>();
  for (let i = poolCount; i < sources.length; i++) {
    if (flows[i]) recycled.add((sources[i] as Source).runeId as string);
  }
  const needEnergy = Math.max(0, cost.energy - pool.energy);
  const exhaustable = runes.filter((r) => r.ready && !recycled.has(r.id));
  if (exhaustable.length < needEnergy) return null;
  const plan: PaymentPlan = exhaustable
    .slice(0, needEnergy)
    .map((r) => ({ runeId: r.id, mode: 'EXHAUST' as const }));
  for (const r of recyclable) if (recycled.has(r.id)) plan.push({ runeId: r.id, mode: 'RECYCLE' });
  return plan;
}

/** True when `cost` can be paid from the pool plus the player's runes. */
export function canAfford(
  state: GameState,
  cards: CardDatabase,
  playerId: PlayerId,
  cost: TotalCost,
): boolean {
  return autoPlan(state, cards, playerId, cost) !== null;
}

// ---------------------------------------------------------------------------------------
// Rune Pool emptying (Rules 167, 316.3, 317.2)
// ---------------------------------------------------------------------------------------

/** Return a new state where `player`'s Rune Pool is empty. */
export function emptyRunePool(state: GameState, player: PlayerId): GameState {
  const next = fork(state);
  next.players[idx(player)].runePool = { energy: 0, power: {} };
  return next;
}

/** Return a new state where both players' Rune Pools are empty. */
export function emptyAllRunePools(state: GameState): GameState {
  const next = fork(state);
  for (const p of next.players) p.runePool = { energy: 0, power: {} };
  return next;
}

/** Add Universal Power [A] to a player's Rune Pool (135.2.e.5.b). */
export function addUniversalPower(state: GameState, player: PlayerId, amount: number): GameState {
  const next = fork(state);
  const pool = next.players[idx(player)].runePool;
  pool.universal = (pool.universal ?? 0) + amount;
  return next;
}
