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
