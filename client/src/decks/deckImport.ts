import { validateDeck } from '@riftbound/engine';
import type { CardDatabase, DeckList } from '@riftbound/engine';

/** Metadata carried over from the external "riftbound-deck" format (all optional). */
export interface DeckMeta {
  description?: string;
  source?: 'META' | 'USER';
  eventName?: string;
  placement?: string;
  sourceUrl?: string;
}

export interface DeckImportEntry {
  /** 0-based position in the imported file. */
  index: number;
  name: string;
  ok: boolean;
  /** Present only when `ok`. */
  deck?: DeckList;
  meta: DeckMeta;
  errors: string[];
  warnings: string[];
}

export interface DeckImportReport {
  /** Fatal, file-level problems (bad JSON, unrecognised shape). Empty when entries were produced. */
  fatal: string[];
  entries: DeckImportEntry[];
}

export const SHARE_ZONES = [
  'LEGEND',
  'CHAMPION',
  'MAIN',
  'RUNE',
  'BATTLEFIELD',
  'SIDEBOARD',
] as const;
type ShareZone = (typeof SHARE_ZONES)[number];

const CODE_RE = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,4})([A-Za-z*]?)$/;

/** Parses `OGN-042` / `ven-7a` into { set: 'ogn', num: '042', letter: '' }. */
export function parseCode(code: string): { set: string; num: string; letter: string } | null {
  const m = CODE_RE.exec(code.trim());
  if (!m) return null;
  return { set: m[1]!.toLowerCase(), num: m[2]!.padStart(3, '0'), letter: m[3]!.toLowerCase() };
}

// Our ids: set-number[letter]-printedTotal, e.g. "ogn-029-298" or "sfd-054a-221".
const ID_RE = /^([a-z][a-z0-9]*)-(\d{1,4})([a-z*]?)(?:-\d+)?$/;

interface Candidate {
  /** Canonical card id (aliases already resolved). */
  id: string;
  letter: string;
  /** True when the lookup key is the canonical id itself (a base printing, not an alias). */
  base: boolean;
}

export interface CardResolver {
  resolve(code: string, nameHint?: string): ResolveOutcome;
}

export type ResolveOutcome =
  { ok: true; id: string; warning?: string } | { ok: false; error: string };

const normName = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Our dataset often splits "Akali, Rogue Assassin" into name "Akali" or title "Rogue Assassin". */
function namesMatch(a: string, b: string): boolean {
  const x = normName(a);
  const y = normName(b);
  if (x === '' || y === '') return false;
  return (
    x === y ||
    x.startsWith(y + ' ') ||
    y.startsWith(x + ' ') ||
    x.endsWith(' ' + y) ||
    y.endsWith(' ' + x)
  );
}

/**
 * Maps public card codes (set + collector number) to our card ids. Alias keys are attached to the
 * database as non-enumerable properties by loadCards, so `getOwnPropertyNames` sees them too.
 */
export function makeCardResolver(cards: CardDatabase): CardResolver {
  const index = new Map<string, Candidate[]>();
  for (const key of Object.getOwnPropertyNames(cards)) {
    const def = cards[key];
    const m = ID_RE.exec(key);
    if (!def || !m) continue;
    const k = `${m[1]}-${m[2]!.padStart(3, '0')}`;
    const list = index.get(k) ?? [];
    list.push({ id: def.cardId, letter: m[3]!, base: def.cardId === key });
    index.set(k, list);
  }

  return {
    resolve(code, nameHint) {
      const p = parseCode(code);
      if (!p) return { ok: false, error: `"${code}" is not a card code like OGN-042.` };
      let cands = index.get(`${p.set}-${p.num}`) ?? [];
      if (cands.length === 0) return { ok: false, error: `Unknown card ${code.toUpperCase()}.` };
      // Narrow: exact letter, else letterless, else everything.
      const exact = p.letter ? cands.filter((c) => c.letter === p.letter) : [];
      const plain = cands.filter((c) => c.letter === '');
      cands = exact.length > 0 ? exact : plain.length > 0 ? plain : cands;
      // Prefer base printings, then a stable order.
      const byId = new Map<string, Candidate>();
      for (const c of cands) {
        const prev = byId.get(c.id);
        if (!prev || (c.base && !prev.base)) byId.set(c.id, c);
      }
      const uniq = [...byId.values()].sort(
        (a, b) =>
          Number(b.base) - Number(a.base) ||
          Number(a.letter !== '') - Number(b.letter !== '') ||
          a.id.localeCompare(b.id),
      );
      let chosen = uniq[0]!;
      const hint = nameHint ?? '';
      if (hint && uniq.length > 1) {
        const named =
          uniq.find((c) => normName(cards[c.id]?.name ?? '') === normName(hint)) ??
          uniq.find((c) => namesMatch(cards[c.id]?.name ?? '', hint));
        if (named) chosen = named;
      }
      const actual = cards[chosen.id]?.name ?? '';
      if (hint && !namesMatch(actual, hint)) {
        return {
          ok: true,
          id: chosen.id,
          warning: `${code.toUpperCase()}: expected "${nameHint}" but our database has "${actual}".`,
        };
      }
      return { ok: true, id: chosen.id };
    },
  };
}

interface ShareCard {
  code: string;
  qty: number;
  zone: ShareZone;
  name?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const optStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

function isShareDeck(o: Record<string, unknown>): boolean {
  return o.format === 'riftbound-deck' || Array.isArray(o.cards);
}

function isOurDeckList(o: Record<string, unknown>): boolean {
  return 'legendId' in o || 'mainDeck' in o;
}

function metaOf(o: Record<string, unknown>): DeckMeta {
  const meta: DeckMeta = {};
  const description = optStr(o.description);
  if (description) meta.description = description;
  if (o.source === 'META' || o.source === 'USER') meta.source = o.source;
  const eventName = optStr(o.eventName);
  if (eventName) meta.eventName = eventName;
  const placement = optStr(o.placement);
  if (placement) meta.placement = placement;
  const sourceUrl = optStr(o.sourceUrl);
  if (sourceUrl) meta.sourceUrl = sourceUrl;
  return meta;
}

function finish(
  index: number,
  name: string,
  meta: DeckMeta,
  deck: DeckList | null,
  errors: string[],
  warnings: string[],
  cards: CardDatabase,
): DeckImportEntry {
  if (deck && errors.length === 0) {
    const verdict = validateDeck(cards, deck);
    if (!verdict.ok) errors = verdict.errors;
  }
  const ok = deck !== null && errors.length === 0;
  const entry: DeckImportEntry = { index, name, ok, meta, errors, warnings };
  if (ok && deck) entry.deck = deck;
  return entry;
}

function convertShareDeck(
  o: Record<string, unknown>,
  index: number,
  resolver: CardResolver,
  cards: CardDatabase,
): DeckImportEntry {
  const name = optStr(o.name) ?? `Deck ${index + 1}`;
  const meta = metaOf(o);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (o.format !== undefined && o.format !== 'riftbound-deck') {
    errors.push(`Unsupported format "${String(o.format)}".`);
  }
  if (o.version !== undefined && o.version !== 1) {
    errors.push(`Unsupported version ${String(o.version)}.`);
  }
  if (!Array.isArray(o.cards)) {
    errors.push('"cards" must be an array.');
    return finish(index, name, meta, null, errors, warnings, cards);
  }

  const legends: string[] = [];
  const champions: string[] = [];
  const main: string[] = [];
  const runes: string[] = [];
  const battlefields: string[] = [];

  o.cards.forEach((raw: unknown, i) => {
    if (!isObj(raw)) {
      errors.push(`cards[${i}]: must be an object.`);
      return;
    }
    const entry = raw as Partial<ShareCard> & Record<string, unknown>;
    const zone = entry.zone;
    if (typeof zone !== 'string' || !SHARE_ZONES.includes(zone as ShareZone)) {
      errors.push(`cards[${i}]: unknown zone "${String(zone)}".`);
      return;
    }
    if (zone === 'SIDEBOARD') return;
    const qty = entry.qty;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
      errors.push(`cards[${i}]: qty must be a positive integer.`);
      return;
    }
    if (typeof entry.code !== 'string') {
      errors.push(`cards[${i}]: missing card code.`);
      return;
    }
    const hint = typeof entry.name === 'string' ? entry.name : undefined;
    const res = resolver.resolve(entry.code, hint);
    if (!res.ok) {
      errors.push(`cards[${i}]: ${res.error}`);
      return;
    }
    if (res.warning) warnings.push(res.warning);
    const copies = Array<string>(qty).fill(res.id);
    switch (zone as ShareZone) {
      case 'LEGEND':
        legends.push(...copies);
        break;
      case 'CHAMPION':
        champions.push(...copies);
        break;
      case 'MAIN':
        main.push(...copies);
        break;
      case 'RUNE':
        runes.push(...copies);
        break;
      case 'BATTLEFIELD':
        battlefields.push(...copies);
        break;
    }
  });

  let legendId = legends[0];
  if (typeof o.legend === 'string' && o.legend.trim() !== '') {
    const res = resolver.resolve(o.legend);
    if (res.ok) legendId = res.id;
    else errors.push(`legend: ${res.error}`);
  }
  if (legends.length > 1 && new Set(legends).size > 1) {
    warnings.push('More than one LEGEND card listed; using the "legend" field or the first one.');
  }
  if (!legendId) errors.push('Missing legend (no LEGEND card and no "legend" field).');
  if (champions.length === 0) errors.push('Missing champion (no CHAMPION card).');
  else if (champions.length > 1) errors.push('More than one CHAMPION card listed.');

  const deck: DeckList = {
    legendId: legendId ?? '',
    championId: champions[0] ?? '',
    mainDeck: main,
    runeDeck: runes,
    battlefields,
  };
  return finish(index, name, meta, deck, errors, warnings, cards);
}

function convertOurDeck(
  o: Record<string, unknown>,
  index: number,
  cards: CardDatabase,
): DeckImportEntry {
  const name = optStr(o.name) ?? `Deck ${index + 1}`;
  const isStrArr = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  const errors: string[] = [];
  if (typeof o.legendId !== 'string') errors.push('"legendId" must be a string.');
  if (typeof o.championId !== 'string') errors.push('"championId" must be a string.');
  if (!isStrArr(o.mainDeck)) errors.push('"mainDeck" must be an array of card ids.');
  if (!isStrArr(o.runeDeck)) errors.push('"runeDeck" must be an array of card ids.');
  if (!isStrArr(o.battlefields)) errors.push('"battlefields" must be an array of card ids.');
  if (errors.length > 0) return finish(index, name, metaOf(o), null, errors, [], cards);
  const deck: DeckList = {
    legendId: o.legendId as string,
    championId: o.championId as string,
    mainDeck: o.mainDeck as string[],
    runeDeck: o.runeDeck as string[],
    battlefields: o.battlefields as string[],
  };
  return finish(index, name, metaOf(o), deck, [], [], cards);
}

/**
 * Imports one or many decks. `input` is a JSON string or an already parsed value, in one of:
 * a deck-builder "riftbound-deck" object, an array of them, `{ decks: [...] }`, or our own DeckList.
 * Each deck is converted and validated independently so valid decks import even if others fail.
 */
export function importDecks(input: unknown, cards: CardDatabase): DeckImportReport {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch (e) {
      return {
        fatal: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
        entries: [],
      };
    }
  }
  let list: unknown[];
  if (Array.isArray(value)) list = value;
  else if (isObj(value) && Array.isArray(value.decks)) list = value.decks;
  else if (isObj(value) && (isShareDeck(value) || isOurDeckList(value))) list = [value];
  else {
    return {
      fatal: [
        'Unrecognised format: expected a deck object, an array of decks or { "decks": [...] }.',
      ],
      entries: [],
    };
  }
  if (list.length === 0) return { fatal: ['The file contains no decks.'], entries: [] };

  const resolver = makeCardResolver(cards);
  const entries = list.map((raw, i): DeckImportEntry => {
    if (!isObj(raw)) {
      return {
        index: i,
        name: `Deck ${i + 1}`,
        ok: false,
        meta: {},
        errors: ['Deck must be a JSON object.'],
        warnings: [],
      };
    }
    if (isShareDeck(raw)) return convertShareDeck(raw, i, resolver, cards);
    if (isOurDeckList(raw)) return convertOurDeck(raw, i, cards);
    return {
      index: i,
      name: optStr(raw.name) ?? `Deck ${i + 1}`,
      ok: false,
      meta: {},
      errors: ['Unrecognised deck format.'],
      warnings: [],
    };
  });
  return { fatal: [], entries };
}

/** Every card id in a deck: legend, champion, main deck, battlefields and runes. */
export function deckCardIds(deck: DeckList): string[] {
  return [deck.legendId, deck.championId, ...deck.mainDeck, ...deck.battlefields, ...deck.runeDeck];
}

/**
 * Counts of fully supported / partial cards across ALL cards of a deck (legend, champion, main
 * deck, battlefields and runes), so the picker agrees with the per-card "Effect not implemented"
 * badge shown in game.
 */
export function deckSupportStats(
  deck: DeckList,
  cards: CardDatabase,
): { total: number; full: number; partial: number } {
  const ids = deckCardIds(deck);
  const full = ids.filter((id) => cards[id]?.supportLevel === 'full').length;
  return { total: ids.length, full, partial: ids.length - full };
}

/** Below this share of fully implemented cards a deck gets a "many cards have no effect" warning. */
export const LOW_SUPPORT_THRESHOLD = 0.6;

export function isLowSupport(stats: { total: number; full: number }): boolean {
  return stats.total > 0 && stats.full / stats.total < LOW_SUPPORT_THRESHOLD;
}

/**
 * Stable content key of a deck: identical legend + champion + battlefields + (order-insensitive)
 * main and rune lists give the same key. Used to detect re-imports of the same deck.
 */
export function deckContentKey(deck: DeckList): string {
  const canon = JSON.stringify([
    deck.legendId,
    deck.championId,
    [...deck.mainDeck].sort(),
    [...deck.runeDeck].sort(),
    [...deck.battlefields].sort(),
  ]);
  // FNV-1a 32-bit, hex; the canonical length is appended to make collisions very unlikely.
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}-${canon.length.toString(16)}`;
}
