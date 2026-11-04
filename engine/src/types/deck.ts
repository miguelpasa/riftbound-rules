/** Deck list as submitted by a player. Validation is engine logic, not here. */
export interface DeckList {
  legendId: string;
  championId: string;
  /** cardIds with repeats; MIN_MAIN_DECK minimum, MAX_COPIES per name. */
  mainDeck: string[];
  /** RUNE_DECK_SIZE rune cardIds (with repeats). */
  runeDeck: string[];
  /** Battlefield cardIds. */
  battlefields: string[];
}
