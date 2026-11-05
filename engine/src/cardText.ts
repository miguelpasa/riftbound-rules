/**
 * Card-text parser (R3, R5). Maps rules text to executable effects / triggered abilities.
 *
 * All-or-nothing: returns `null` unless EVERY sentence is understood, so a card is never
 * half-executed. Reminder text in parentheses and implemented keyword tokens are ignored (the
 * keyword system handles them). Recognised sentence shapes (SIDE = friendly | enemy, optional):
 *  - Target-free: "Draw N.", "Give friendly units +N [M] this turn.", "Deal N to all units at
 *    battlefields / in bases", "Deal N to all enemy units in combat", "Ready your units.",
 *    "Exhaust all friendly units.", "Kill all gear.", "[Draw N and ]channel N rune(s) exhausted.",
 *    "If you can't, draw N." (after a Channel), "You score N point(s)."
 *  - One chosen unit: "Deal N to a SIDE unit [at a battlefield].", "Give a SIDE unit +N [M] this
 *    turn.", "Give a SIDE unit -N [M] this turn[, to a minimum of M [M]].", "Kill a SIDE unit [at a
 *    battlefield] [with N [M] or less].", "Ready a SIDE unit.", "[Stun] a SIDE unit [at a battlefield]."
 *  - Gear / spells: "Kill a SIDE gear.", "Kill up to one gear.", "Counter a spell.",
 *    "Its controller draws N." (after a kill).
 *  - Several units: "Deal N to each of up to two units.", "Give two SIDE units each +N [M] this
 *    turn.", "Choose a friendly unit and an enemy unit." / "Then choose an enemy unit." followed by
 *    "They deal damage equal to their Mights to each other.", and "Give an enemy unit -N [M] this
 *    turn and a friendly unit +N [M] this turn."
 * Units and gear (`parseTriggerText`): "When you play me, <effect>.", "When I hold, <effect>.",
 * "When I conquer, <effect>.", "[Deathknell][>] <effect>." with target-free effects only.
 */
import type { CardEffect, CardTrigger, TargetSide } from './types/card.js';

const side = (w: string | undefined): TargetSide | undefined =>
  w === 'friendly' ? 'friendly' : w === 'enemy' ? 'enemy' : undefined;

const SIDE = '(?:(friendly|enemy) )?';
const DASH = '[-\\u2013\\u2212]';
const TWO = '(?:two|2)';

const sideProp = (s: TargetSide | undefined): { side?: TargetSide } => (s ? { side: s } : {});

/** A chosen-unit slot declared by an earlier sentence. */
interface SlotDecl {
  side: TargetSide;
  /** "another unit": distinct from the earlier slot even without a side. */
  another?: boolean;
}

interface ParseState {
  slots: SlotDecl[];
  /** A multi-target ("each of up to two") effect owns every target: nothing else may choose. */
  locked: boolean;
}

/** Slot-free sentences (also valid inside triggers). Returns the effects or null. */
export function parseClause(sen: string): CardEffect[] | null {
  let m = /^Draw (\d+)$/i.exec(sen);
  if (m) return [{ op: 'DRAW', amount: Number(m[1]) }];
  m = /^Draw (\d+) and channel (\d+) runes? exhausted$/i.exec(sen);
  if (m) {
    return [
      { op: 'DRAW', amount: Number(m[1]) },
      { op: 'CHANNEL', amount: Number(m[2]), exhausted: true },
    ];
  }
  m = /^Channel (\d+) runes?( exhausted)?$/i.exec(sen);
  if (m) return [{ op: 'CHANNEL', amount: Number(m[1]), ...(m[2] ? { exhausted: true } : {}) }];
  m = /^You score (\d+) points?$/i.exec(sen);
  if (m) return [{ op: 'GAIN_POINT', amount: Number(m[1]) }];
  m = new RegExp(`^Give (friendly|enemy) units \\+(\\d+) \\[M\\] this turn$`, 'i').exec(sen);
  if (m) {
    return [
      {
        op: 'BUFF_ALL',
        amount: Number(m[2]),
        side: (m[1] ?? 'friendly').toLowerCase() as TargetSide,
        duration: 'TURN',
      },
    ];
  }
  m = /^Deal (\d+) to all (?:(friendly|enemy) )?units (at battlefields|in bases|in combat)$/i.exec(
    sen,
  );
  if (m) {
    const where = (m[3] ?? '').toLowerCase();
    return [
      {
        op: 'DAMAGE_ALL',
        amount: Number(m[1]),
        side: side(m[2]) ?? 'any',
        scope: where === 'in bases' ? 'bases' : where === 'in combat' ? 'combat' : 'battlefields',
      },
    ];
  }
  if (/^Ready (?:your|all friendly) units$/i.test(sen)) {
    return [{ op: 'READY_ALL', side: 'friendly' }];
  }
  m = /^Ready your units and give them \+(\d+) \[M\] this turn$/i.exec(sen);
  if (m) {
    return [
      { op: 'READY_ALL', side: 'friendly' },
      { op: 'BUFF_ALL', amount: Number(m[1]), side: 'friendly', duration: 'TURN' },
    ];
  }
  if (/^Exhaust all friendly units$/i.test(sen)) return [{ op: 'EXHAUST_ALL', side: 'friendly' }];
  if (/^Kill all gear$/i.test(sen)) return [{ op: 'KILL_ALL_GEAR' }];
  return null;
}

/** A sentence that chooses one unit / gear / spell, or several units. */
interface Chooser {
  effect: CardEffect;
  decl: SlotDecl;
  /** Takes every target of the spell. */
  multi?: boolean;
}

function parseChooser(sen: string): Chooser | null {
  let m = new RegExp(`^Deal (\\d+) to an? ${SIDE}unit( at a battlefield)?$`, 'i').exec(sen);
  if (m) {
    const s = side(m[2]);
    return {
      effect: {
        op: 'DAMAGE_TARGET',
        amount: Number(m[1]),
        ...sideProp(s),
        ...(m[3] ? { atBattlefield: true } : {}),
      },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(
    `^Deal (\\d+) to each of up to ${TWO} ${SIDE}units( at a battlefield)?$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[2]);
    return {
      effect: {
        op: 'DAMAGE_TARGET',
        amount: Number(m[1]),
        ...sideProp(s),
        ...(m[3] ? { atBattlefield: true } : {}),
        count: { min: 0, max: 2 },
      },
      decl: { side: s ?? 'any' },
      multi: true,
    };
  }
  m = new RegExp(`^Give an? ${SIDE}unit \\+(\\d+) \\[M\\] this turn$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'BUFF_TARGET', amount: Number(m[2]), duration: 'TURN', ...sideProp(s) },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(`^Give (up to )?${TWO} ${SIDE}units each \\+(\\d+) \\[M\\] this turn$`, 'i').exec(
    sen,
  );
  if (m) {
    const s = side(m[2]);
    return {
      effect: {
        op: 'BUFF_TARGET',
        amount: Number(m[3]),
        duration: 'TURN',
        ...sideProp(s),
        count: { min: m[1] ? 0 : 2, max: 2 },
      },
      decl: { side: s ?? 'any' },
      multi: true,
    };
  }
  m = new RegExp(
    `^Give an? ${SIDE}unit ${DASH}(\\d+) \\[M\\] this turn(?:, to a minimum of (\\d+) \\[M\\])?$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'DEBUFF_TARGET',
        amount: Number(m[2]),
        ...(m[3] ? { minMight: Number(m[3]) } : {}),
        ...sideProp(s),
      },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(
    `^Kill an? ${SIDE}unit( at a battlefield)?(?: with (\\d+) \\[M\\] or less)?$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'KILL_TARGET',
        ...sideProp(s),
        ...(m[2] ? { atBattlefield: true } : {}),
        ...(m[3] ? { maxMight: Number(m[3]) } : {}),
      },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(`^Kill an? ${SIDE}gear$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return { effect: { op: 'KILL_GEAR', ...sideProp(s) }, decl: { side: s ?? 'any' } };
  }
  if (/^(?:You may )?kill up to one gear$/i.test(sen)) {
    return {
      effect: { op: 'KILL_GEAR', count: { min: 0, max: 1 } },
      decl: { side: 'any' },
      multi: true,
    };
  }
  m = new RegExp(`^Ready an? ${SIDE}unit$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return { effect: { op: 'READY_TARGET', ...sideProp(s) }, decl: { side: s ?? 'any' } };
  }
  m = new RegExp(`^Stun an? ${SIDE}unit( at a battlefield)?$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'STUN_TARGET', ...sideProp(s), ...(m[2] ? { atBattlefield: true } : {}) },
      decl: { side: s ?? 'any' },
    };
  }
  if (/^Counter a spell$/i.test(sen)) {
    return { effect: { op: 'COUNTER_SPELL' }, decl: { side: 'any' } };
  }
  return null;
}

/** May `add` join the slots already chosen? Several slots must be provably different units. */
function canAdd(st: ParseState, add: SlotDecl[]): boolean {
  if (st.locked) return false;
  const all = [...st.slots, ...add];
  if (all.length <= 1) return true;
  if (all.length > 2) return false;
  const [a, b] = all as [SlotDecl, SlotDecl];
  if (b.another) return true;
  return a.side !== 'any' && b.side !== 'any' && a.side !== b.side;
}

const CHOOSE = new RegExp(`^Choose an? ${SIDE}unit(?: and (an? )?(another )?${SIDE}unit)?$`, 'i');

/** "Give a SIDE unit +N [M] this turn and another / a SIDE unit -M [M] this turn" (two slots). */
const GIVE_PAIR = new RegExp(
  `^Give an? ${SIDE}unit ([+-])(\\d+) \\[M\\] this turn and (?:(another) |an? )${SIDE}unit ([+-])(\\d+) \\[M\\] this turn$`,
  'i',
);

function giveEffect(
  sign: string | undefined,
  n: number,
  s: TargetSide | undefined,
  slot: number,
): CardEffect {
  const at = slot > 0 ? { slot } : {};
  return sign === '-'
    ? { op: 'DEBUFF_TARGET', amount: n, ...sideProp(s), ...at }
    : { op: 'BUFF_TARGET', amount: n, duration: 'TURN', ...sideProp(s), ...at };
}

function parseSpellSentence(sen: string, st: ParseState, out: CardEffect[]): boolean {
  let m = CHOOSE.exec(sen);
  if (m) {
    const first: SlotDecl = { side: side(m[1]) ?? 'any' };
    const adds: SlotDecl[] = [first];
    if (/ and /i.test(sen)) {
      adds.push({ side: side(m[4]) ?? 'any', ...(m[3] ? { another: true } : {}) });
    }
    if (!canAdd(st, adds)) return false;
    st.slots.push(...adds);
    return true;
  }
  if (/^They deal damage equal to their Mights to each other$/i.test(sen)) {
    if (st.slots.length !== 2 || st.locked) return false;
    const [a, b] = st.slots as [SlotDecl, SlotDecl];
    out.push({ op: 'MUTUAL_DAMAGE', slots: [0, 1], sides: [a.side, b.side] });
    st.locked = true;
    return true;
  }
  m = /^Its controller draws (\d+)$/i.exec(sen);
  if (m) {
    const prev = out[out.length - 1];
    if (!prev || (prev.op !== 'KILL_TARGET' && prev.op !== 'KILL_GEAR') || 'count' in prev) {
      return false;
    }
    out.push({
      op: 'TARGET_CONTROLLER_DRAW',
      amount: Number(m[1]),
      ...(prev.slot ? { slot: prev.slot } : {}),
    });
    return true;
  }
  m = GIVE_PAIR.exec(sen);
  if (m) {
    const s1 = side(m[1]);
    const s2 = side(m[5]);
    const adds: SlotDecl[] = [
      { side: s1 ?? 'any' },
      { side: s2 ?? 'any', ...(m[4] ? { another: true } : {}) },
    ];
    if (st.slots.length > 0 || !canAdd(st, adds)) return false;
    st.slots.push(...adds);
    out.push(giveEffect(m[2], Number(m[3]), s1, 0), giveEffect(m[6], Number(m[7]), s2, 1));
    return true;
  }
  m = /^If you (?:can't|couldn't channel \d+ runes? this way), draw (\d+)$/i.exec(sen);
  if (m) {
    const prev = out[out.length - 1];
    if (prev?.op !== 'CHANNEL' || prev.elseDraw !== undefined) return false;
    prev.elseDraw = Number(m[1]);
    return true;
  }
  const ch = parseChooser(sen);
  if (ch) {
    if (!canAdd(st, [ch.decl]) || (ch.multi && st.slots.length > 0)) return false;
    const slot = st.slots.length;
    st.slots.push(ch.decl);
    if (ch.multi) st.locked = true;
    out.push(slot > 0 ? ({ ...ch.effect, slot } as CardEffect) : ch.effect);
    return true;
  }
  const clause = parseClause(sen);
  if (!clause) return false;
  out.push(...clause);
  return true;
}

/** Parse one slot-free sentence into one effect (kept for callers that want a single effect). */
export function parseSentence(sen: string): CardEffect | null {
  const c = parseClause(sen);
  return c && c.length === 1 ? (c[0] ?? null) : null;
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
  const cleaned = text
    .replace(/\[(Action|Reaction|Hidden)\]/gi, ' ')
    .replace(/\[Stun\]/gi, 'Stun')
    .replace(/^\s*(?:(?:Action|Reaction|Hidden)\s+)+/i, '');
  const sens = sentences(cleaned);
  if (sens.length === 0) return null;
  const st: ParseState = { slots: [], locked: false };
  const out: CardEffect[] = [];
  // "A, then B" is two sentences in order.
  for (const sen of sens.flatMap((x) => x.split(/, then /i))) {
    if (!parseSpellSentence(sen.replace(/^Then /i, '').trim(), st, out)) return null;
  }
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
    // Triggers cannot choose targets yet: only slot-free clauses.
    const effects = parseClause((m[1] ?? '').trim());
    if (!effects) return null;
    out.push({ on, effects });
  }
  return out.length > 0 ? out : null;
}
