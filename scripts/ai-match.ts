/**
 * Bot-vs-bot strength match on REAL card data (decks are never committed; needs client/public/cards.json).
 *
 *   npx tsx scripts/ai-match.ts [--games 24] [--a '{"difficulty":"normal"}'] [--b '{"difficulty":"easy"}']
 *                               [--budget 150] [--maxTurns 12] [--seed m]
 *
 * --a / --b are JSON overrides of AIControllerOptions (weights, difficulty, maxCandidates, ...). Every
 * pairing of two preset decks is played twice with the seats swapped, so deck and first-player luck
 * cancel. A game that is still running at --maxTurns goes to the player with more points (tie = draw).
 * Prints A's wins / losses / draws and a rough 95% interval.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AIController } from '../engine/src/ai/bot';
import type { AIControllerOptions } from '../engine/src/ai/bot';
import { getLegalActions } from '../engine/src/legalActions';
import { actorToAct, reduce } from '../engine/src/reducer';
import { sanitizeFor } from '../engine/src/sanitize';
import { createGame } from '../engine/src/setup';
import type { CardDatabase, DeckList, GameState, PlayerId } from '../engine/src/types/index';
import { buildPresetDecks } from '../client/src/decks/presets';

const argv = process.argv.slice(2);
const arg = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : def;
};
const GAMES = Number(arg('games', '24'));
const BUDGET = Number(arg('budget', '150'));
const MAX_TURNS = Number(arg('maxTurns', '12'));
const SEED = arg('seed', 'm');
const optsA = JSON.parse(arg('a', '{}')) as Partial<AIControllerOptions>;
const rawB = arg('b', '{}');
// --b random: a uniformly random legal mover (never concedes), the weakest sensible opponent.
const RANDOM_B = rawB === 'random';
const optsB = (RANDOM_B ? {} : JSON.parse(rawB)) as Partial<AIControllerOptions>;
let rngState = 12345;
const rnd = (n: number): number => {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState % n;
};

const cardsPath = fileURLToPath(new URL('../client/public/cards.json', import.meta.url));
if (!existsSync(cardsPath))
  throw new Error('client/public/cards.json missing: run `npm run cards`');
const cards = JSON.parse(readFileSync(cardsPath, 'utf8')) as CardDatabase;
const decks = buildPresetDecks(cards, { count: 6 }).map((p) => ({ name: p.name, deck: p.deck }));

function deckFor(state: GameState, seat: PlayerId, d0: DeckList, d1: DeckList): DeckList {
  const legend = state.objects[state.players[seat === 'p0' ? 0 : 1].legend as string]?.cardId;
  if (d0.legendId === d1.legendId) return seat === 'p0' ? d0 : d1;
  return legend === d0.legendId ? d0 : d1;
}

let wins = 0;
let losses = 0;
let draws = 0;
for (let g = 0; g < GAMES; g++) {
  const pair = Math.floor(g / 2);
  const da = decks[pair % decks.length]!;
  const db = decks[(pair + 1 + Math.floor(pair / decks.length)) % decks.length]!;
  const aSeat: PlayerId = g % 2 === 0 ? 'p0' : 'p1';
  let state = createGame(cards, [da.deck, db.deck], `${SEED}-${pair}`);
  const bots: Partial<Record<PlayerId, AIController>> = {};
  const botFor = (seat: PlayerId): AIController =>
    (bots[seat] ??= new AIController(seat, {
      cards,
      deck: deckFor(state, seat, da.deck, db.deck),
      seed: `${SEED}${seat}${g}`,
      budgetMs: BUDGET,
      now: () => performance.now(),
      ...(seat === aSeat ? optsA : optsB),
    }));
  for (let steps = 0; steps < 6000 && state.gameStatus === 'IN_PROGRESS'; steps++) {
    if (state.turn.number > MAX_TURNS) break;
    const seat = actorToAct(state);
    let intent;
    if (RANDOM_B && seat !== aSeat) {
      const legal = getLegalActions(state, cards, seat).filter((i) => i.type !== 'CONCEDE');
      intent = legal[rnd(legal.length)] ?? null;
    } else intent = botFor(seat).decide(sanitizeFor(state, seat));
    if (!intent) break;
    const r = reduce(state, cards, intent);
    if (!r.ok) throw new Error(`bot ${seat} produced an illegal intent: ${JSON.stringify(intent)}`);
    state = r.state;
  }
  const pts = (s: PlayerId): number => state.players[s === 'p0' ? 0 : 1].points;
  const bSeat: PlayerId = aSeat === 'p0' ? 'p1' : 'p0';
  const winner =
    state.gameStatus === 'FINISHED'
      ? state.winner
      : pts(aSeat) === pts(bSeat)
        ? null
        : pts(aSeat) > pts(bSeat)
          ? aSeat
          : bSeat;
  if (winner === aSeat) wins++;
  else if (winner === bSeat) losses++;
  else draws++;
  console.error(
    `game ${g}: ${da.name} vs ${db.name}, A=${aSeat}, turn ${state.turn.number}, ${pts('p0')}-${pts('p1')}, ${winner ?? 'draw'}`,
  );
}
const n = wins + losses + draws;
const p = (wins + draws / 2) / n;
const se = Math.sqrt((p * (1 - p)) / n);
console.log(
  `A ${wins} W / ${losses} L / ${draws} D of ${n}; score ${(p * 100).toFixed(1)}% (95% ±${(196 * se).toFixed(1)})`,
);
