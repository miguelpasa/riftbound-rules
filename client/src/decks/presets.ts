import { validateDeck } from '@riftbound/engine';
import type { CardDatabase, CardDef, DeckList, Domain } from '@riftbound/engine';

export interface PresetDeck {
  id: string;
  name: string;
  legendId: string;
  deck: DeckList;
  stats: { fullSupportCount: number; partialCount: number; avgEnergy: number };
}

export interface BuildPresetOptions {
  seed?: string;
  count?: number;
  /** Receives skipped-legend reasons and notes. */
  diagnostics?: string[];
}

const DECK_SIZE = 40;
const RUNES = 12;
const MAX_COPIES = 3;
const NON_TAG = new Set(['champion', 'signature', 'legend', 'equipment']);
/** Curve target: energy above this is penalised. */
const CURVE_CAP = 5;

const tagsOf = (c: CardDef): string[] =>
  c.subtypes.filter((s) => !NON_TAG.has(s.toLowerCase())).map((s) => s.toLowerCase());
const hasSub = (c: CardDef, s: string): boolean =>
  c.subtypes.some((x) => x.toLowerCase() === s.toLowerCase());
const isUnique = (c: CardDef): boolean => c.keywords.some((k) => k.name === 'Unique');
const inIdentity = (c: CardDef, identity: Domain[]): boolean =>
  c.domains.every((d) => identity.includes(d));

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** Deterministic pseudo-random in [0,1) from a string key (stateless). */
function jitter(seed: string, key: string): number {
  let a = hashSeed(`${seed}|${key}`) + 0x6d2b79f5;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/** Lower is better: full support first, then low complexity, sane curve, tiny seeded jitter. */
function score(c: CardDef, seed: string): number {
  const support = c.supportLevel === 'full' ? 0 : 1000;
  const energy = c.cost.energy;
  const curve = energy > CURVE_CAP ? 400 + (energy - CURVE_CAP) * 50 : energy === 0 ? 20 : 0;
  const complexity = Math.min(c.text.length, 400) / 2 + c.keywords.length;
  return support + curve + complexity + jitter(seed, c.cardId) * 8;
}

function dedupeByName(list: CardDef[], seed: string): CardDef[] {
  const best = new Map<string, CardDef>();
  for (const c of list) {
    const cur = best.get(c.name);
    if (!cur || c.cardId < cur.cardId) best.set(c.name, c);
  }
  void seed;
  return [...best.values()].sort((a, b) => (a.cardId < b.cardId ? -1 : 1));
}

function domainLabel(domains: Domain[]): string {
  return domains.length === 0 ? 'Colorless' : domains.join('/');
}

function buildForLegend(
  cards: CardDatabase,
  legend: CardDef,
  pool: CardDef[],
  runesByDomain: Map<Domain, CardDef>,
  battlefields: CardDef[],
  seed: string,
): { preset: PresetDeck } | { reason: string } {
  const identity = legend.domains;
  const legendTags = tagsOf(legend);
  if (identity.length === 0) return { reason: 'legend has no domains' };
  if (legendTags.length === 0) return { reason: 'legend has no tag' };

  // Champion
  const champions = pool
    .filter(
      (c) =>
        c.type === 'UNIT' &&
        hasSub(c, 'Champion') &&
        inIdentity(c, identity) &&
        tagsOf(c).some((t) => legendTags.includes(t)),
    )
    .sort((a, b) => score(a, seed) - score(b, seed));
  const champion = champions[0];
  if (!champion)
    return { reason: `no Champion unit sharing tag(s) [${legendTags.join(', ')}] within identity` };
  const champTags = tagsOf(champion);

  // Signature cards matching the champion (max 3 copies total, 1 each)
  const sigs = pool
    .filter(
      (c) =>
        hasSub(c, 'Signature') &&
        inIdentity(c, identity) &&
        c.type !== 'LEGEND' &&
        tagsOf(c).some((t) => champTags.includes(t)),
    )
    .sort((a, b) => score(a, seed) - score(b, seed))
    .slice(0, 3);

  // General pool: non-Signature UNIT/SPELL/GEAR in identity.
  const general = pool
    .filter(
      (c) =>
        (c.type === 'UNIT' || c.type === 'SPELL' || c.type === 'GEAR') &&
        !hasSub(c, 'Signature') &&
        inIdentity(c, identity),
    )
    .sort((a, b) => score(a, seed) - score(b, seed));

  const copiesOf = (c: CardDef): number => (isUnique(c) ? 1 : MAX_COPIES);
  const main: CardDef[] = [];
  const count = new Map<string, number>();
  const used = (c: CardDef): number => count.get(c.name) ?? 0;
  const add = (c: CardDef): void => {
    main.push(c);
    count.set(c.name, used(c) + 1);
  };
  count.set(champion.name, 1);
  for (const s of sigs) add(s);

  const target = DECK_SIZE - 1; // champion is counted separately
  const quotas: Record<string, number> = { UNIT: 18, SPELL: 10, GEAR: 5 };
  const taken: Record<string, number> = { UNIT: 1, SPELL: 0, GEAR: 0 }; // champion is a unit
  for (const s of sigs) taken[s.type] = (taken[s.type] ?? 0) + 1;

  // Pass 1: respect category quotas. Pass 2: fill from everything else.
  for (const pass of [1, 2]) {
    for (const c of general) {
      if (main.length >= target) break;
      const q = quotas[c.type] ?? 0;
      while (
        main.length < target &&
        used(c) < copiesOf(c) &&
        (pass === 2 || (taken[c.type] ?? 0) < q)
      ) {
        add(c);
        taken[c.type] = (taken[c.type] ?? 0) + 1;
      }
    }
  }
  if (main.length < target) {
    return {
      reason: `only ${main.length + 1}/${DECK_SIZE} eligible cards within identity ${domainLabel(identity)}`,
    };
  }

  // Runes: split evenly across identity domains.
  const runeDeck: string[] = [];
  const per = Math.floor(RUNES / identity.length);
  for (let i = 0; i < identity.length; i++) {
    const d = identity[i] as Domain;
    const rune = runesByDomain.get(d);
    if (!rune) return { reason: `no basic Rune for domain ${d}` };
    const n = i === identity.length - 1 ? RUNES - per * (identity.length - 1) : per;
    for (let k = 0; k < n; k++) runeDeck.push(rune.cardId);
  }

  // Battlefields: prefer identity-fitting, supported, low-text.
  const bfs = battlefields
    .filter((b) => inIdentity(b, identity))
    .sort((a, b) => score(a, seed) - score(b, seed))
    .slice(0, 3);
  if (bfs.length < 3) return { reason: `only ${bfs.length} usable battlefields` };

  const deck: DeckList = {
    legendId: legend.cardId,
    championId: champion.cardId,
    mainDeck: main.map((c) => c.cardId),
    runeDeck,
    battlefields: bfs.map((b) => b.cardId),
  };
  const verdict = validateDeck(cards, deck);
  if (!verdict.ok) return { reason: `validateDeck failed: ${verdict.errors.join('; ')}` };

  const all = [champion, ...main];
  const fullSupportCount = all.filter((c) => c.supportLevel === 'full').length;
  const avgEnergy = all.reduce((s, c) => s + c.cost.energy, 0) / all.length;
  return {
    preset: {
      id: `preset-${legend.cardId}`,
      name: `${legend.name} (${domainLabel(identity)})`,
      legendId: legend.cardId,
      deck,
      stats: {
        fullSupportCount,
        partialCount: all.length - fullSupportCount,
        avgEnergy: Math.round(avgEnergy * 100) / 100,
      },
    },
  };
}

/**
 * Build legal preset decks from a card database, favouring cards the engine fully supports.
 * Deterministic for a given seed. Skipped legends are reported in `opts.diagnostics`.
 */
export function buildPresetDecks(cards: CardDatabase, opts: BuildPresetOptions = {}): PresetDeck[] {
  const seed = opts.seed ?? 'presets';
  const limit = opts.count ?? 8;
  const diagnostics = opts.diagnostics ?? [];
  const all = Object.values(cards);

  const runesByDomain = new Map<Domain, CardDef>();
  for (const c of all) {
    const dom = c.domains[0] as Domain | undefined;
    if (c.type === 'RUNE' && c.domains.length === 1 && dom && !runesByDomain.has(dom)) {
      runesByDomain.set(dom, c);
    }
  }
  const pool = dedupeByName(
    all.filter((c) => c.type === 'UNIT' || c.type === 'SPELL' || c.type === 'GEAR'),
    seed,
  );
  const battlefields = dedupeByName(
    all.filter((c) => c.type === 'BATTLEFIELD'),
    seed,
  );
  const legends = dedupeByName(
    all.filter((c) => c.type === 'LEGEND'),
    seed,
  );

  const presets: PresetDeck[] = [];
  for (const legend of legends) {
    const res = buildForLegend(cards, legend, pool, runesByDomain, battlefields, seed);
    if ('preset' in res) presets.push(res.preset);
    else diagnostics.push(`Skipped legend "${legend.name}" (${legend.cardId}): ${res.reason}`);
  }
  presets.sort(
    (a, b) =>
      b.stats.fullSupportCount - a.stats.fullSupportCount ||
      jitter(seed, a.id) - jitter(seed, b.id),
  );
  return presets.slice(0, limit);
}
