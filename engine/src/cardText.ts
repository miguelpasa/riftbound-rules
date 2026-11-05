/**
 * Card-text parser (R3). Maps the rules text of a SPELL to executable `CardEffect`s.
 *
 * All-or-nothing: returns `null` unless EVERY sentence is understood, so a card is never
 * half-executed. Reminder text in parentheses and the Action/Reaction/Hidden keyword tokens are
 * ignored (the keyword system handles them). Recognised sentence shapes:
 *  - "Draw N."
 *  - "Deal N to a [friendly|enemy] unit [at a battlefield]."
 *  - "Give a [friendly|enemy] unit +N [M] this turn."
 */
import type { CardEffect, TargetSide } from './types/card.js';

const side = (w: string | undefined): TargetSide | undefined =>
  w === 'friendly' ? 'friendly' : w === 'enemy' ? 'enemy' : undefined;

export function parseSpellText(text: string): CardEffect[] | null {
  const cleaned = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[(Action|Reaction|Hidden)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const sentences = cleaned
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean);
  const out: CardEffect[] = [];
  for (const sen of sentences) {
    let m = /^Draw (\d+)$/i.exec(sen);
    if (m) {
      out.push({ op: 'DRAW', amount: Number(m[1]) });
      continue;
    }
    m = /^Deal (\d+) to an? (?:(friendly|enemy) )?unit( at a battlefield)?$/i.exec(sen);
    if (m) {
      const s = side(m[2]);
      out.push({
        op: 'DAMAGE_TARGET',
        amount: Number(m[1]),
        ...(s ? { side: s } : {}),
        ...(m[3] ? { atBattlefield: true } : {}),
      });
      continue;
    }
    m = /^Give an? (?:(friendly|enemy) )?unit \+(\d+) \[M\] this turn$/i.exec(sen);
    if (m) {
      const s = side(m[1]);
      out.push({
        op: 'BUFF_TARGET',
        amount: Number(m[2]),
        duration: 'TURN',
        ...(s ? { side: s } : {}),
      });
      continue;
    }
    return null;
  }
  // The engine supports one target per spell: more than one targeted effect needs R2 follow-ups.
  if (out.filter((e) => e.op === 'DAMAGE_TARGET' || e.op === 'BUFF_TARGET').length > 1) return null;
  return out;
}
