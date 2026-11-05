/**
 * Card-text parser (R3, R5). Maps rules text to executable effects / triggered abilities.
 *
 * All-or-nothing: returns `null` unless EVERY sentence is understood, so a card is never
 * half-executed. Reminder text in parentheses and implemented keyword tokens are ignored (the
 * keyword system handles them). Recognised sentence shapes:
 *  - "Draw N."
 *  - "Deal N to a [friendly|enemy] unit [at a battlefield]."
 *  - "Give a [friendly|enemy] unit +N [M] this turn.", "Give friendly units +N [M] this turn."
 *  - "Kill a [friendly|enemy] unit [at a battlefield] [with N [M] or less].", "Ready a unit."
 * Units and gear (`parseTriggerText`): "When you play me, <effect>.", "When I hold, <effect>.",
 * "When I conquer, <effect>.", "[Deathknell][>] <effect>." with target-free effects only.
 */
import type { CardEffect, CardTrigger, TargetSide } from './types/card.js';

const side = (w: string | undefined): TargetSide | undefined =>
  w === 'friendly' ? 'friendly' : w === 'enemy' ? 'enemy' : undefined;

const TARGETED = new Set(['DAMAGE_TARGET', 'BUFF_TARGET', 'KILL_TARGET', 'READY_TARGET']);

/** Parse one sentence (no trailing period) into an effect, or null. */
export function parseSentence(sen: string): CardEffect | null {
  let m = /^Draw (\d+)$/i.exec(sen);
  if (m) return { op: 'DRAW', amount: Number(m[1]) };
  m = /^Deal (\d+) to an? (?:(friendly|enemy) )?unit( at a battlefield)?$/i.exec(sen);
  if (m) {
    const s = side(m[2]);
    return {
      op: 'DAMAGE_TARGET',
      amount: Number(m[1]),
      ...(s ? { side: s } : {}),
      ...(m[3] ? { atBattlefield: true } : {}),
    };
  }
  m = /^Give an? (?:(friendly|enemy) )?unit \+(\d+) \[M\] this turn$/i.exec(sen);
  if (m) {
    const s = side(m[1]);
    return { op: 'BUFF_TARGET', amount: Number(m[2]), duration: 'TURN', ...(s ? { side: s } : {}) };
  }
  m =
    /^Kill an? (?:(friendly|enemy) )?unit( at a battlefield)?(?: with (\d+) \[M\] or less)?$/i.exec(
      sen,
    );
  if (m) {
    const s = side(m[1]);
    return {
      op: 'KILL_TARGET',
      ...(s ? { side: s } : {}),
      ...(m[2] ? { atBattlefield: true } : {}),
      ...(m[3] ? { maxMight: Number(m[3]) } : {}),
    };
  }
  m = /^Ready an? (?:(friendly|enemy) )?unit$/i.exec(sen);
  if (m) {
    const s = side(m[1]);
    return { op: 'READY_TARGET', ...(s ? { side: s } : {}) };
  }
  m = /^Give (friendly|enemy) units \+(\d+) \[M\] this turn$/i.exec(sen);
  if (m) {
    return {
      op: 'BUFF_ALL',
      amount: Number(m[2]),
      side: (m[1] ?? 'friendly').toLowerCase() as TargetSide,
      duration: 'TURN',
    };
  }
  return null;
}

function sentences(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseSpellText(text: string): CardEffect[] | null {
  const cleaned = text.replace(/\[(Action|Reaction|Hidden)\]/gi, ' ');
  const sens = sentences(cleaned);
  if (sens.length === 0) return null;
  const out: CardEffect[] = [];
  for (const sen of sens) {
    const e = parseSentence(sen);
    if (!e) return null;
    out.push(e);
  }
  // The engine supports one target per spell.
  if (out.filter((e) => TARGETED.has(e.op)).length > 1) return null;
  return out;
}

const KEYWORD_TOKENS =
  /\[(Tank|Backline|Assault(?: \d+)?|Shield(?: \d+)?|Ganking|Accelerate|Temporary|Hidden|Deflect(?: \d+)?|Action|Reaction)\]/gi;

/**
 * Parse the triggered abilities of a unit or gear. Returns null unless the whole text is made of
 * implemented keywords plus recognised triggers, and there is at least one trigger.
 */
export function parseTriggerText(text: string): CardTrigger[] | null {
  const cleaned = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(KEYWORD_TOKENS, ' ')
    .replace(/\[Deathknell\]\s*\[>\]/gi, ' Deathknell: ')
    .replace(/\s+/g, ' ')
    .trim();
  const out: CardTrigger[] = [];
  for (const sen of cleaned
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const m = /^(?:When you play me|When I hold|When I conquer|Deathknell:)\s*,?\s*(.+)$/i.exec(
      sen,
    );
    if (!m) return null;
    const head = sen.toLowerCase();
    const on = head.startsWith('when you play me')
      ? 'PLAY'
      : head.startsWith('when i hold')
        ? 'HOLD'
        : head.startsWith('when i conquer')
          ? 'CONQUER'
          : 'DEATH';
    const e = parseSentence((m[1] ?? '').trim());
    if (!e || TARGETED.has(e.op)) return null;
    out.push({ on, effects: [e] });
  }
  return out.length > 0 ? out : null;
}
