import { validateDeck } from '@riftbound/engine';
import type { CardDatabase, DeckList } from '@riftbound/engine';

const KEY_SELECTED = 'riftbound.selectedDeckId';
const KEY_CUSTOM = 'riftbound.customDeck';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(s?: StorageLike): StorageLike | null {
  try {
    return s ?? (typeof localStorage === 'undefined' ? null : localStorage);
  } catch {
    return null;
  }
}

export function saveSelectedDeckId(id: string, storage?: StorageLike): void {
  try {
    store(storage)?.setItem(KEY_SELECTED, id);
  } catch {
    /* storage unavailable */
  }
}

export function loadSelectedDeckId(storage?: StorageLike): string | null {
  try {
    return store(storage)?.getItem(KEY_SELECTED) ?? null;
  } catch {
    return null;
  }
}

export function saveCustomDeck(deck: DeckList, storage?: StorageLike): void {
  try {
    store(storage)?.setItem(KEY_CUSTOM, JSON.stringify(deck));
  } catch {
    /* storage unavailable */
  }
}

/** Returns the stored custom deck if it has a DeckList shape (legality is NOT re-checked). */
export function loadCustomDeck(storage?: StorageLike): DeckList | null {
  try {
    const raw = store(storage)?.getItem(KEY_CUSTOM);
    if (!raw) return null;
    const parsed = parseShape(JSON.parse(raw) as unknown);
    return 'deck' in parsed ? parsed.deck : null;
  } catch {
    return null;
  }
}

export function clearCustomDeck(storage?: StorageLike): void {
  try {
    store(storage)?.removeItem(KEY_CUSTOM);
  } catch {
    /* storage unavailable */
  }
}

const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

function parseShape(v: unknown): { deck: DeckList } | { errors: string[] } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { errors: ['Deck must be a JSON object.'] };
  }
  const o = v as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof o.legendId !== 'string') errors.push('"legendId" must be a string.');
  if (typeof o.championId !== 'string') errors.push('"championId" must be a string.');
  if (!isStrArr(o.mainDeck)) errors.push('"mainDeck" must be an array of card ids.');
  if (!isStrArr(o.runeDeck)) errors.push('"runeDeck" must be an array of card ids.');
  if (!isStrArr(o.battlefields)) errors.push('"battlefields" must be an array of card ids.');
  if (errors.length > 0) return { errors };
  return {
    deck: {
      legendId: o.legendId as string,
      championId: o.championId as string,
      mainDeck: o.mainDeck as string[],
      runeDeck: o.runeDeck as string[],
      battlefields: o.battlefields as string[],
    },
  };
}

export type ImportResult = { ok: true; deck: DeckList } | { ok: false; errors: string[] };

/** Parse (JSON string or already-parsed value) and validate a deck list for import. */
export function importDeckList(json: unknown, cards: CardDatabase): ImportResult {
  let value = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json) as unknown;
    } catch (e) {
      return { ok: false, errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  const shaped = parseShape(value);
  if ('errors' in shaped) return { ok: false, errors: shaped.errors };
  const verdict = validateDeck(cards, shaped.deck);
  return verdict.ok ? { ok: true, deck: shaped.deck } : { ok: false, errors: verdict.errors };
}

// ---- Multiple imported decks ------------------------------------------------------------------

const KEY_DECKS = 'riftbound.importedDecks';
/** Selection id the single-slot custom deck used before multi-deck storage existed. */
export const LEGACY_CUSTOM_ID = 'custom';

export interface StoredDeckMeta {
  description?: string;
  source?: 'META' | 'USER';
  eventName?: string;
  placement?: string;
  sourceUrl?: string;
}

export interface StoredDeck {
  id: string;
  name: string;
  deck: DeckList;
  meta: StoredDeckMeta;
}

function readDecks(storage?: StorageLike): StoredDeck[] {
  try {
    const raw = store(storage)?.getItem(KEY_DECKS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: StoredDeck[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const shaped = parseShape(o.deck);
      if (typeof o.id !== 'string' || typeof o.name !== 'string' || !('deck' in shaped)) continue;
      const meta = typeof o.meta === 'object' && o.meta !== null ? (o.meta as StoredDeckMeta) : {};
      out.push({ id: o.id, name: o.name, deck: shaped.deck, meta });
    }
    return out;
  } catch {
    return [];
  }
}

function writeDecks(decks: StoredDeck[], storage?: StorageLike): void {
  try {
    store(storage)?.setItem(KEY_DECKS, JSON.stringify(decks));
  } catch {
    /* storage unavailable */
  }
}

/**
 * All imported decks. A deck saved in the old single custom slot is migrated once: it becomes the
 * first list entry (id `LEGACY_CUSTOM_ID`, so a remembered selection keeps working) and the old
 * key is cleared.
 */
export function listImportedDecks(storage?: StorageLike): StoredDeck[] {
  const decks = readDecks(storage);
  const legacy = loadCustomDeck(storage);
  if (legacy) {
    if (!decks.some((d) => d.id === LEGACY_CUSTOM_ID)) {
      decks.unshift({ id: LEGACY_CUSTOM_ID, name: 'Imported deck', deck: legacy, meta: {} });
      writeDecks(decks, storage);
    }
    clearCustomDeck(storage);
  }
  return decks;
}

let idCounter = 0;
function newDeckId(existing: StoredDeck[]): string {
  let id: string;
  do {
    idCounter += 1;
    id = `imp-${Date.now().toString(36)}-${idCounter.toString(36)}`;
  } while (existing.some((d) => d.id === id));
  return id;
}

/** Saves a new imported deck and returns it (with its generated id). */
export function saveImportedDeck(
  input: { name: string; deck: DeckList; meta?: StoredDeckMeta },
  storage?: StorageLike,
): StoredDeck {
  const decks = listImportedDecks(storage);
  const saved: StoredDeck = {
    id: newDeckId(decks),
    name: input.name,
    deck: input.deck,
    meta: input.meta ?? {},
  };
  writeDecks([...decks, saved], storage);
  return saved;
}

export function renameImportedDeck(id: string, name: string, storage?: StorageLike): boolean {
  const trimmed = name.trim();
  if (trimmed === '') return false;
  const decks = listImportedDecks(storage);
  const target = decks.find((d) => d.id === id);
  if (!target) return false;
  target.name = trimmed;
  writeDecks(decks, storage);
  return true;
}

export function deleteImportedDeck(id: string, storage?: StorageLike): boolean {
  const decks = listImportedDecks(storage);
  const next = decks.filter((d) => d.id !== id);
  if (next.length === decks.length) return false;
  writeDecks(next, storage);
  return true;
}
