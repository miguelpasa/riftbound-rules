/**
 * Micro-benchmark of `reduce` and `getLegalActions` on mid-game states from real decks (R37).
 *
 *   npx tsx scripts/bench-reduce.ts [--games 8] [--maxTurns 14] [--seed r37] [--reps 3]
 *
 * Plays seeded random games (uniform choice among getLegalActions, no AI) on client/public/cards.json
 * with the preset decks, records every (state, intent) pair from turn 4 on, then times `reduce` on each
 * pair (median of --reps runs) and `getLegalActions` on every 5th state. Also prints a digest of all
 * resulting state hashes, which must be identical before and after an engine optimisation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getLegalActions } from '../engine/src/legalActions';
import { actorToAct, reduce } from '../engine/src/reducer';
import { stateHash, hashString } from '../engine/src/replay';
import { createGame } from '../engine/src/setup';
import type { CardDatabase, GameState, Intent } from '../engine/src/types/index';
import { buildPresetDecks } from '../client/src/decks/presets';

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : d;
};
const GAMES = Number(arg('games', '8'));
const MAX_TURNS = Number(arg('maxTurns', '14'));
const SEED = arg('seed', 'r37');
const REPS = Number(arg('reps', '3'));

let cloneCount = 0;
const realClone = globalThis.structuredClone;
globalThis.structuredClone = ((v: unknown, o?: StructuredSerializeOptions) => {
  cloneCount++;
  return realClone(v, o);
}) as typeof structuredClone;

const cardsPath = fileURLToPath(new URL('../client/public/cards.json', import.meta.url));
if (!existsSync(cardsPath)) throw new Error('run `npm run cards` first');
const cards = JSON.parse(readFileSync(cardsPath, 'utf8')) as CardDatabase;
const decks = buildPresetDecks(cards, { count: 6 });

function rngFor(seed: string): () => number {
  let a = Number.parseInt(hashString(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number);
};

const samples: { state: GameState; intent: Intent }[] = [];
const digest: string[] = [];
for (let g = 0; g < GAMES; g++) {
  const a = decks[g % decks.length]!;
  const b = decks[(g + 1) % decks.length]!;
  let state = createGame(cards, [a.deck, b.deck], `${SEED}-${g}`);
  const rnd = rngFor(`${SEED}-${g}`);
  for (let step = 0; step < 4000 && state.gameStatus === 'IN_PROGRESS'; step++) {
    if (state.turn.number > MAX_TURNS) break;
    const seat = actorToAct(state);
    const legal = getLegalActions(state, cards, seat).filter((i) => i.type !== 'CONCEDE');
    if (legal.length === 0) break;
    // prefer progress over passing forever: weight non-terminal actions a bit
    const intent = legal[Math.floor(rnd() * legal.length)] as Intent;
    if (state.turn.number >= 4) samples.push({ state, intent });
    const r = reduce(state, cards, intent);
    if (!r.ok) throw new Error(`rejected legal intent ${JSON.stringify(intent)}: ${r.error.code}`);
    state = r.state;
    digest.push(stateHash(state));
  }
}

const times: number[] = [];
const clones: number[] = [];
for (const s of samples) {
  const ts: number[] = [];
  let c = 0;
  for (let k = 0; k < REPS; k++) {
    const c0 = cloneCount;
    const t0 = performance.now();
    reduce(s.state, cards, s.intent);
    ts.push(performance.now() - t0);
    c = cloneCount - c0;
  }
  times.push(pct(ts, 50));
  clones.push(c);
}
const legalTimes: number[] = [];
const legalClones: number[] = [];
for (let i = 0; i < samples.length; i += 5) {
  const s = samples[i]!;
  const ts: number[] = [];
  let c = 0;
  for (let k = 0; k < REPS; k++) {
    const c0 = cloneCount;
    const t0 = performance.now();
    getLegalActions(s.state, cards, actorToAct(s.state));
    ts.push(performance.now() - t0);
    c = cloneCount - c0;
  }
  legalTimes.push(pct(ts, 50));
  legalClones.push(c);
}
const f = (n: number): string => n.toFixed(3);
console.log(`samples: ${samples.length} reduce calls from ${GAMES} games (turn >= 4)`);
console.log(`digest: ${hashString(digest.join(','))} over ${digest.length} states`);
console.log('| metric | n | p50 | p90 | p99 | max |\n|---|---|---|---|---|---|');
const row = (l: string, xs: number[]): void =>
  console.log(
    `| ${l} | ${xs.length} | ${f(pct(xs, 50))} | ${f(pct(xs, 90))} | ${f(pct(xs, 99))} | ${f(Math.max(0, ...xs))} |`,
  );
row('reduce ms', times);
row('reduce structuredClone calls', clones);
row('getLegalActions ms', legalTimes);
row('getLegalActions structuredClone calls', legalClones);
