import { TOKEN_CARDS } from '@riftbound/engine';
import type { CardDatabase } from '@riftbound/engine';

export type LoadCardsResult = { ok: true; cards: CardDatabase } | { ok: false; message: string };

const CARDS_URL = '/cards.json';
const ALIASES_URL = '/card-aliases.json';
const MISSING_MESSAGE = 'cards.json not found. Run `npm run cards` first.';

function isCardDatabase(value: unknown): value is CardDatabase {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (card) =>
      typeof card === 'object' &&
      card !== null &&
      typeof (card as { cardId?: unknown }).cardId === 'string',
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  // The Vite dev server answers unknown paths with index.html (status 200),
  // so a body that is not JSON is treated as a missing file.
  return JSON.parse(await res.text()) as unknown;
}

/**
 * Loads the generated card database from /cards.json. Alias ids from the
 * optional /card-aliases.json are attached as non-enumerable keys, so lookups
 * by alias work while iterating the database does not double count cards.
 */
export async function loadCards(): Promise<LoadCardsResult> {
  let cards: unknown;
  try {
    cards = await fetchJson(CARDS_URL);
  } catch {
    return { ok: false, message: MISSING_MESSAGE };
  }

  if (!isCardDatabase(cards)) {
    return {
      ok: false,
      message: 'cards.json is invalid. Run `npm run cards` again to regenerate it.',
    };
  }

  // Token definitions are built into the engine; an older cards.json may lack them.
  for (const [id, def] of Object.entries(TOKEN_CARDS)) if (!(id in cards)) cards[id] = def;

  try {
    const aliases = await fetchJson(ALIASES_URL);
    if (typeof aliases === 'object' && aliases !== null && !Array.isArray(aliases)) {
      for (const [alias, canonical] of Object.entries(aliases)) {
        const target = typeof canonical === 'string' ? cards[canonical] : undefined;
        if (target !== undefined && !(alias in cards)) {
          Object.defineProperty(cards, alias, { value: target, enumerable: false });
        }
      }
    }
  } catch {
    // Aliases are optional; the card database is usable without them.
  }

  return { ok: true, cards };
}
