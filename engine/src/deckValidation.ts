import { MAX_COPIES, MIN_MAIN_DECK, RUNE_DECK_SIZE } from './types/constants.js';
import type { CardDatabase, CardDef, DeckList, Domain } from './types/index.js';

export type DeckValidationResult =
  { ok: true } | { ok: false; errors: string[]; code: 'DECK_ILLEGAL' };

/** Subtypes that are category labels rather than lineage "tags". */
const NON_TAG_SUBTYPES = new Set(['champion', 'signature', 'legend', 'equipment']);

function tagsOf(card: CardDef): string[] {
  return card.subtypes
    .filter((s) => !NON_TAG_SUBTYPES.has(s.toLowerCase()))
    .map((s) => s.toLowerCase());
}

function hasSubtype(card: CardDef, subtype: string): boolean {
  return card.subtypes.some((s) => s.toLowerCase() === subtype.toLowerCase());
}

/**
 * Validate a deck list (Rule 103). Collects every error.
 *
 * Interpretation: the Chosen Champion (`deck.championId`) is a separate field but counts toward the
 * main-deck minimum of 40 (so `mainDeck.length + 1 >= MIN_MAIN_DECK`) and toward the 3-copy limit.
 */
export function validateDeck(cards: CardDatabase, deck: DeckList): DeckValidationResult {
  const errors: string[] = [];
  const get = (id: string, role: string): CardDef | undefined => {
    const c = cards[id];
    if (!c) errors.push(`Unknown card id "${id}" (${role}).`);
    return c;
  };

  // Legend (103.2)
  const legend = get(deck.legendId, 'legend');
  if (legend && legend.type !== 'LEGEND') {
    errors.push(`"${legend.name}" is not a LEGEND (Rule 103.2).`);
  }
  const legendOk = legend !== undefined && legend.type === 'LEGEND';
  const identity: Domain[] = legend && legendOk ? legend.domains : [];
  // Domainless cards are always allowed (103.2.b.5).
  const inIdentity = (c: CardDef): boolean => c.domains.every((d) => identity.includes(d));

  // Champion (103.3.a)
  const champion = get(deck.championId, 'champion');
  if (champion) {
    if (champion.type !== 'UNIT' || !hasSubtype(champion, 'Champion')) {
      errors.push(`Chosen Champion "${champion.name}" must be a Champion UNIT (Rule 103.3.a).`);
    } else if (legend && legendOk) {
      const legendTags = tagsOf(legend);
      if (!tagsOf(champion).some((t) => legendTags.includes(t))) {
        errors.push(
          `Chosen Champion "${champion.name}" does not match the Legend's tag (Rule 103.3.a.2).`,
        );
      }
    }
  }

  // Main deck (103.3)
  if (deck.mainDeck.length + 1 < MIN_MAIN_DECK) {
    errors.push(
      `Main deck needs at least ${MIN_MAIN_DECK} cards including the Chosen Champion; has ${deck.mainDeck.length + 1} (Rule 103.3.b).`,
    );
  }
  const copies = new Map<string, number>();
  const bump = (c: CardDef): void => void copies.set(c.name, (copies.get(c.name) ?? 0) + 1);
  const mainCards: CardDef[] = [];
  if (champion) {
    bump(champion);
    if (!inIdentity(champion)) {
      errors.push(`"${champion.name}" is outside the Legend's Domain Identity (Rule 103.2.b).`);
    }
  }
  for (const id of deck.mainDeck) {
    const c = get(id, 'main deck');
    if (!c) continue;
    mainCards.push(c);
    bump(c);
    if (
      c.type === 'RUNE' ||
      c.type === 'LEGEND' ||
      c.type === 'BATTLEFIELD' ||
      c.type === 'TOKEN'
    ) {
      errors.push(`"${c.name}" (${c.type}) cannot be in the main deck (Rule 103.3).`);
    }
    if (!inIdentity(c)) {
      errors.push(`"${c.name}" is outside the Legend's Domain Identity (Rule 103.2.b).`);
    }
  }
  for (const [name, n] of copies) {
    if (n > MAX_COPIES) {
      errors.push(`Too many copies of "${name}": ${n} > ${MAX_COPIES} (Rule 103.3.b).`);
    }
  }
  // Unique keyword: only one copy (by name).
  const seenUnique = new Set<string>();
  for (const c of mainCards) {
    const isUnique = c.keywords.some((k) => k.name === 'Unique');
    if (isUnique && (copies.get(c.name) ?? 0) > 1 && !seenUnique.has(c.name)) {
      seenUnique.add(c.name);
      errors.push(`"${c.name}" is Unique: only 1 copy allowed (Rule 103.3).`);
    }
  }
  // Signature (103.3.d)
  const sigs = mainCards.filter((c) => hasSubtype(c, 'Signature'));
  if (sigs.length > 3) {
    errors.push(`At most 3 Signature cards allowed; has ${sigs.length} (Rule 103.3.d).`);
  }
  // X14 (103.2.d.2): every Signature card carries the Champion tag of the Champion Legend (the Chosen Champion
  // must share that tag, so either one's tags are accepted when the Legend is unusable).
  const sigTags = legend && legendOk ? tagsOf(legend) : champion ? tagsOf(champion) : null;
  if (sigTags) {
    for (const s of sigs) {
      if (!tagsOf(s).some((t) => sigTags.includes(t))) {
        errors.push(
          `Signature card "${s.name}" does not match the Champion Legend's tag (Rule 103.3.d).`,
        );
      }
    }
  }

  // Runes (103.4)
  if (deck.runeDeck.length !== RUNE_DECK_SIZE) {
    errors.push(
      `Rune deck must have exactly ${RUNE_DECK_SIZE} runes; has ${deck.runeDeck.length} (Rule 103.4.a).`,
    );
  }
  for (const id of deck.runeDeck) {
    const c = get(id, 'rune deck');
    if (!c) continue;
    if (c.type !== 'RUNE') errors.push(`"${c.name}" is not a RUNE (Rule 103.4).`);
    else if (!inIdentity(c)) {
      errors.push(`Rune "${c.name}" is outside the Legend's Domain Identity (Rule 103.4.a).`);
    }
  }

  // Battlefields (103.5.c, 487.4.a)
  if (deck.battlefields.length !== 3) {
    errors.push(`Exactly 3 battlefields required; has ${deck.battlefields.length} (Rule 487.4.a).`);
  }
  const bfNames = new Set<string>();
  for (const id of deck.battlefields) {
    const c = get(id, 'battlefield');
    if (!c) continue;
    if (c.type !== 'BATTLEFIELD') errors.push(`"${c.name}" is not a BATTLEFIELD (Rule 103.5.c).`);
    else if (bfNames.has(c.name)) errors.push(`Duplicate battlefield "${c.name}" (Rule 103.5.c).`);
    bfNames.add(c.name);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors, code: 'DECK_ILLEGAL' };
}
