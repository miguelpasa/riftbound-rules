/**
 * Smoke test for fully supported cards: plays seeded bot-vs-bot games whose main decks are built from
 * random fully supported cards (restricted to the Legend's Domains) and fails on any engine exception,
 * illegal bot intent, "internal error", or state-hash mismatch on replay of the same intents.
 *
 *   npx tsx scripts/smoke-cards.ts [--games 40] [--seed s] [--turns 10]
 *
 * It does not check game balance: it only proves that no supported card text can crash the engine,
 * stall the game, or make `reduce` impure (the same intent log replays to the same final hash).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AIController } from '../engine/src/ai/bot';
import { getLegalActions } from '../engine/src/legalActions';
import { actorToAct, reduce } from '../engine/src/reducer';
import { createGame } from '../engine/src/setup';
import { sanitizeFor } from '../engine/src/sanitize';
import { stateHash } from '../engine/src/replay';
import type {
  CardDatabase,
  DeckList,
  GameState,
  Intent,
  PlayerId,
} from '../engine/src/types/index';
import { buildPresetDecks } from '../client/src/decks/presets';

const argv = process.argv.slice(2);
const arg = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : def;
};
const GAMES = Number(arg('games', '40'));
const SEED = arg('seed', 'smoke');
const MAX_TURNS = Number(arg('turns', '10'));

const cardsPath = fileURLToPath(new URL('../client/public/cards.json', import.meta.url));
if (!existsSync(cardsPath))
  throw new Error('client/public/cards.json missing: run `npm run cards`');
const cards = JSON.parse(readFileSync(cardsPath, 'utf8')) as CardDatabase;
const presets = buildPresetDecks(cards, { count: 6 }).map((p) => p.deck);

let rng = 987654321;
const rnd = (n: number): number => {
  rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
  return rng % n;
};

const playable = Object.values(cards).filter(
  (d) =>
    d.supportLevel === 'full' &&
    (d.type === 'UNIT' || d.type === 'SPELL' || d.type === 'GEAR') &&
    !d.subtypes.includes('Signature') &&
    // interesting text only: something beyond bare keywords
    (d.effects ||
      d.triggers ||
      d.abilities ||
      d.statics ||
      d.modes ||
      d.playTo ||
      d.entersReadyWhen),
);

function randomDeck(base: DeckList): DeckList {
  const legend = cards[base.legendId];
  const domains = new Set(legend?.domains ?? []);
  const pool = playable.filter(
    (d) => d.domains.every((x) => domains.has(x)) || d.domains.length === 0,
  );
  const main: string[] = [];
  const copies = new Map<string, number>();
  // The Chosen Champion counts towards the three copies of its name (103.3.b).
  const champion = cards[base.championId]?.name;
  if (champion) copies.set(champion, 1);
  while (main.length < 40 && pool.length > 0) {
    const d = pool[rnd(pool.length)]!;
    const n = copies.get(d.name) ?? 0;
    if (n >= 3) continue;
    copies.set(d.name, n + 1);
    main.push(d.cardId);
  }
  return { ...base, mainDeck: main };
}

let failures = 0;
const covered = new Set<string>();
for (let g = 0; g < GAMES; g++) {
  const a = presets[g % presets.length]!;
  const b = presets[(g + 1 + Math.floor(g / presets.length)) % presets.length]!;
  const decks: [DeckList, DeckList] = [randomDeck(a), randomDeck(b)];
  let state: GameState;
  try {
    state = createGame(cards, decks, `${SEED}-${g}`);
  } catch (e) {
    console.error(`game ${g}: could not create the game: ${(e as Error).message}`);
    failures++;
    continue;
  }
  const initial = state;
  const log: Intent[] = [];
  const bots: Partial<Record<PlayerId, AIController>> = {};
  const deckOf = (seat: PlayerId): DeckList => {
    const legend = state.objects[state.players[seat === 'p0' ? 0 : 1].legend as string]?.cardId;
    return legend === decks[0].legendId ? decks[0] : decks[1];
  };
  let error: string | null = null;
  for (let steps = 0; steps < 6000 && state.gameStatus === 'IN_PROGRESS'; steps++) {
    if (state.turn.number > MAX_TURNS) break;
    const seat = actorToAct(state);
    // Alternate the bot and a random legal mover, so odd lines (declines, odd targets) are exercised too.
    let intent: Intent | null;
    if (g % 2 === 0 || steps % 3 === 0) {
      const legal = getLegalActions(state, cards, seat).filter((i) => i.type !== 'CONCEDE');
      intent = legal[rnd(legal.length)] ?? null;
    } else {
      bots[seat] ??= new AIController(seat, {
        cards,
        deck: deckOf(seat),
        seed: `${SEED}${seat}${g}`,
        budgetMs: 40,
        now: () => performance.now(),
      });
      intent = bots[seat]!.decide(sanitizeFor(state, seat));
    }
    if (!intent) break;
    const r = reduce(state, cards, intent);
    if (!r.ok) {
      error = `illegal intent from ${seat}: ${JSON.stringify(intent)} -> ${JSON.stringify(r)}`;
      break;
    }
    for (const e of r.events) {
      if (e.type === 'CARD_PLAYED') covered.add(e.cardId);
    }
    log.push(intent);
    state = r.state;
  }
  if (!error) {
    // Replay the log from the initial state: the final hash must match (reduce is pure).
    let replay = initial;
    for (const i of log) {
      const r = reduce(replay, cards, i);
      if (!r.ok) {
        error = `replay rejected ${JSON.stringify(i)}`;
        break;
      }
      replay = r.state;
    }
    if (!error && stateHash(replay) !== stateHash(state)) error = 'replay hash mismatch';
  }
  if (error) {
    failures++;
    console.error(`game ${g}: FAIL ${error}`);
  }
}
console.log(
  `${GAMES} games, ${failures} failure(s); ${covered.size} distinct supported cards were played of ${playable.length}`,
);
process.exit(failures > 0 ? 1 : 0);
