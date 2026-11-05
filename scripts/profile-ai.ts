/**
 * AI profiler on REAL card data.
 *
 *   npx tsx scripts/profile-ai.ts [--games N] [--mode bvb|bvf] [--budget 500] [--max 60]
 *                                 [--decks presets|meta|both] [--seed s] [--maxTurns 14] [--json out.json]
 *
 * Plays N games with production AIController settings (budgetMs 500, maxCandidates 60) and records per
 * decision: wall time, legal actions, candidates scored, whether the budget expired, and the split
 * hash / determinize / getLegalActions / search time. Prints p50/p90/p99/max tables per game phase,
 * structuredClone counts (--clones off disables the counter, e.g. for CPU profiles) (with the hottest call sites) and a standalone getLegalActions timing.
 *   bvb = bot vs bot, bvf = bot (p0) vs first-legal-action opponent.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIController } from '../engine/src/ai/bot';
import type { DecisionProfile } from '../engine/src/ai/bot';
import { getLegalActions } from '../engine/src/legalActions';
import { actorToAct, reduce } from '../engine/src/reducer';
import { sanitizeFor } from '../engine/src/sanitize';
import { createGame } from '../engine/src/setup';
import type {
  CardDatabase,
  DeckList,
  GameState,
  Intent,
  PlayerId,
} from '../engine/src/types/index';
import { buildPresetDecks } from '../client/src/decks/presets';
import { importDecks } from '../client/src/decks/deckImport';

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : def;
};
const GAMES = Number(arg('games', '4'));
const MODE = arg('mode', 'bvb');
const BUDGET = Number(arg('budget', '500'));
const MAXC = Number(arg('max', '60'));
const DECKS = arg('decks', 'both');
const COUNT_CLONES = arg('clones', 'on') === 'on';
const SEED = arg('seed', 'prof');
const MAX_TURNS = Number(arg('maxTurns', '14'));
const JSON_OUT = arg('json', '');
const META_DIR = arg('metaDir', 'C:/Users/pasam/Documents/projects/deckbuilder/data/meta-decks');

// ---------------------------------------------------------------- structuredClone counting
const sc = { count: 0, sites: new Map<string, number>() };
const realClone = globalThis.structuredClone;
if (COUNT_CLONES)
  globalThis.structuredClone = ((v: unknown, o?: StructuredSerializeOptions) => {
    sc.count++;
    if (sc.count % 97 === 0) {
      const st = (new Error().stack ?? '').split('\n').slice(2, 4);
      const key = st
        .map((l) =>
          l
            .trim()
            .replace(/^at /, '')
            .replace(/\(.*[\\/]/, '('),
        )
        .join(' < ');
      sc.sites.set(key, (sc.sites.get(key) ?? 0) + 1);
    }
    return realClone(v, o);
  }) as typeof structuredClone;

// ---------------------------------------------------------------- data
const cardsPath = fileURLToPath(new URL('../client/public/cards.json', import.meta.url));
if (!existsSync(cardsPath))
  throw new Error('client/public/cards.json missing: run `npm run cards`');
const cards = JSON.parse(readFileSync(cardsPath, 'utf8')) as CardDatabase;

const decks: { name: string; deck: DeckList }[] = [];
if (DECKS === 'presets' || DECKS === 'both') {
  for (const p of buildPresetDecks(cards, { count: 6 })) decks.push({ name: p.name, deck: p.deck });
}
if ((DECKS === 'meta' || DECKS === 'both') && existsSync(META_DIR)) {
  const raw = readdirSync(META_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(META_DIR, f), 'utf8')) as unknown);
  const rep = importDecks(raw, cards);
  for (const e of rep.entries) if (e.ok && e.deck) decks.push({ name: e.name, deck: e.deck });
}
if (decks.length < 2) throw new Error(`need >= 2 decks, got ${decks.length}`);

// ---------------------------------------------------------------- stats helpers
const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
};
const f = (n: number): string => n.toFixed(1);
const row = (label: string, xs: number[]): string =>
  `| ${label} | ${xs.length} | ${f(pct(xs, 50))} | ${f(pct(xs, 90))} | ${f(pct(xs, 99))} | ${f(Math.max(0, ...xs))} |`;

interface Rec extends DecisionProfile {
  turn: number;
  bucket: string;
  wall: number;
  clones: number;
  mem: number;
}
const bucketOf = (state: GameState): string => {
  if (state.turn.phase === 'MULLIGAN') return 'mulligan';
  const t = state.turn.number;
  return t <= 3 ? 'early(T1-3)' : t <= 7 ? 'mid(T4-7)' : 'late(T8+)';
};

// ---------------------------------------------------------------- play
const recs: Rec[] = [];
const legalSamples: { bucket: string; ms: number; n: number }[] = [];
let peakHeap = 0;
let violations = 0;
const gameSummaries: string[] = [];

function deckFor(state: GameState, seat: PlayerId, a: DeckList, b: DeckList): DeckList {
  const legend = state.objects[state.players[seat === 'p0' ? 0 : 1].legend as string]?.cardId;
  if (a.legendId === b.legendId) return seat === 'p0' ? a : b;
  return legend === a.legendId ? a : b;
}

for (let g = 0; g < GAMES; g++) {
  const da = decks[g % decks.length] as (typeof decks)[number];
  const db = decks[(g + 1 + Math.floor(g / decks.length)) % decks.length] as (typeof decks)[number];
  let state = createGame(cards, [da.deck, db.deck], `${SEED}-${g}`);
  const bots: Partial<Record<PlayerId, AIController>> = {};
  let current: Rec | null = null;
  let cloneBase = 0;
  const botFor = (seat: PlayerId): AIController => {
    let b = bots[seat];
    if (!b) {
      b = new AIController(seat, {
        cards,
        deck: deckFor(state, seat, da.deck, db.deck),
        seed: `${SEED}${seat}`,
        budgetMs: BUDGET,
        maxCandidates: MAXC,
        now: () => performance.now(),
        onProfile: (p) => {
          current = {
            ...p,
            turn: state.turn.number,
            bucket: bucketOf(state),
            wall: 0,
            clones: sc.count - cloneBase,
            mem: 0,
          };
        },
      });
      bots[seat] = b;
    }
    return b;
  };
  const t0 = performance.now();
  let steps = 0;
  for (
    ;
    steps < 6000 && state.gameStatus === 'IN_PROGRESS' && state.turn.number <= MAX_TURNS;
    steps++
  ) {
    const seat = actorToAct(state);
    let intent: Intent | null;
    if (MODE === 'bvf' && seat === 'p1') {
      intent = getLegalActions(state, cards, seat).find((i) => i.type !== 'CONCEDE') ?? null;
    } else {
      const view = sanitizeFor(state, seat);
      current = null;
      cloneBase = sc.count;
      const w0 = performance.now();
      intent = botFor(seat).decide(view);
      const w = performance.now() - w0;
      const cur = current as Rec | null;
      if (cur) {
        cur.wall = w;
        cur.mem = process.memoryUsage().heapUsed;
        peakHeap = Math.max(peakHeap, cur.mem);
        recs.push(cur);
      }
      // standalone getLegalActions timing on mid/late states (every 7th decision)
      if (state.turn.number >= 4 && steps % 7 === 0) {
        const times: number[] = [];
        let n = 0;
        for (let k = 0; k < 5; k++) {
          const l0 = performance.now();
          n = getLegalActions(state, cards, seat).length;
          times.push(performance.now() - l0);
        }
        legalSamples.push({ bucket: bucketOf(state), ms: pct(times, 50), n });
      }
    }
    if (!intent) break;
    const r = reduce(state, cards, intent);
    if (!r.ok) {
      violations++;
      break;
    }
    state = r.state;
  }
  gameSummaries.push(
    `game ${g}: ${da.name} vs ${db.name}: ${steps} steps, turn ${state.turn.number}, ${state.gameStatus}${state.winner ? ' winner ' + state.winner : ''}, ${f(performance.now() - t0)} ms`,
  );
  console.error(gameSummaries[gameSummaries.length - 1]);
}

// ---------------------------------------------------------------- report
const out: string[] = [];
out.push(
  `## AI profile (mode ${MODE}, budget ${BUDGET} ms, maxCandidates ${MAXC}, ${GAMES} games, ${decks.length} decks)\n`,
);
out.push(...gameSummaries.map((s) => `- ${s}`), '');
out.push(`Rejected bot intents: ${violations}\n`);
const search = recs.filter((r) => r.kind === 'search');
out.push('### Decision wall time (ms), search decisions by phase\n');
out.push('| bucket | n | p50 | p90 | p99 | max |', '|---|---|---|---|---|---|');
for (const b of ['early(T1-3)', 'mid(T4-7)', 'late(T8+)']) {
  out.push(
    row(
      b,
      search.filter((r) => r.bucket === b).map((r) => r.wall),
    ),
  );
}
out.push(
  row(
    'ALL search',
    search.map((r) => r.wall),
  ),
);
out.push(
  row(
    'ALL decisions',
    recs.map((r) => r.wall),
  ),
  '',
);
out.push('### Component time (ms) over search decisions\n');
out.push('| component | n | p50 | p90 | p99 | max |', '|---|---|---|---|---|---|');
out.push(
  row(
    'hash (JSON.stringify view)',
    search.map((r) => r.hashMs),
  ),
);
out.push(
  row(
    'determinize',
    search.map((r) => r.determinizeMs),
  ),
);
out.push(
  row(
    'getLegalActions (in decision)',
    search.map((r) => r.legalMs),
  ),
);
out.push(
  row(
    'search (candidates+score)',
    search.map((r) => r.searchMs),
  ),
  '',
);
out.push('### Sizes over search decisions\n');
out.push('| metric | n | p50 | p90 | p99 | max |', '|---|---|---|---|---|---|');
out.push(
  row(
    'legal actions',
    search.map((r) => r.legalCount),
  ),
);
out.push(
  row(
    'candidates',
    search.map((r) => r.candidateCount),
  ),
);
out.push(
  row(
    'scored',
    search.map((r) => r.scored),
  ),
);
out.push(
  row(
    'reduce calls',
    search.map((r) => r.reduceCalls),
  ),
);
out.push(
  row(
    'structuredClone calls / decision',
    search.map((r) => r.clones),
  ),
  '',
);
const over = recs.filter((r) => r.wall > BUDGET * 1.1);
out.push(
  `Budget: expired in ${search.filter((r) => r.budgetExpired).length}/${search.length} search decisions; ` +
    `fallback (nothing scored) ${search.filter((r) => r.fallback).length}; ` +
    `over budget +10%: ${over.length}/${recs.length} (worst ${f(Math.max(0, ...recs.map((r) => r.wall)))} ms)\n`,
);
out.push('### Standalone getLegalActions on T4+ states (ms, median of 5)\n');
out.push('| bucket | n | p50 | p90 | p99 | max |', '|---|---|---|---|---|---|');
for (const b of ['mid(T4-7)', 'late(T8+)']) {
  out.push(
    row(
      b,
      legalSamples.filter((s) => s.bucket === b).map((s) => s.ms),
    ),
  );
}
out.push(
  row(
    'actions returned',
    legalSamples.map((s) => s.n),
  ),
  '',
);
out.push(`### Memory / cloning\n`);
out.push(
  `- structuredClone calls total: ${sc.count}; peak heapUsed ${(peakHeap / 1048576).toFixed(0)} MiB`,
);
const sites = [...sc.sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
out.push('- hottest structuredClone call sites (sampled 1/97):');
for (const [k, v] of sites) out.push(`  - ${v}x ${k}`);
console.log(out.join('\n'));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ recs, legalSamples }, null, 1));
