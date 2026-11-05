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
import { targetRequirements } from './effects.js';
import { tokenIdFor } from './tokens.js';
import type { CardEffect, CardTrigger, TargetSide, TriggerKind } from './types/card.js';

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
  /** "Choose a unit at a battlefield". */
  atBattlefield?: boolean;
}

interface ParseState {
  slots: SlotDecl[];
  /** A multi-target ("each of up to two") effect owns every target: nothing else may choose. */
  locked: boolean;
  /** What "it" refers to: the last single unit chosen (index into `slots`). */
  it?: number;
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
  if (/^Kill all units$/i.test(sen)) return [{ op: 'KILL_ALL_UNITS' }];
  const tok = parseTokenClause(sen);
  if (tok) return [tok];
  return null;
}

const COUNT_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };

/**
 * "Play [a|two|N] [ready] N [M] Name unit token(s) [with Keyword] [here | to / into / at your base]".
 * The token must exist in tokens.ts. Without a location the Base is used (the choice of a
 * battlefield you control is not modelled).
 */
function parseTokenClause(sen: string): CardEffect | null {
  const m =
    /^Play (an?|one|two|three|four|\d+) (ready )?(\d+) \[M\] (.+?) unit tokens?(?: with (\w+))?( here| (?:to|into|at) your base)?$/i.exec(
      sen,
    );
  if (!m) return null;
  const count = COUNT_WORDS[(m[1] ?? '').toLowerCase()] ?? Number(m[1]);
  const token = tokenIdFor(m[4] ?? '', Number(m[3]), m[5]);
  if (!token || !(count >= 1)) return null;
  return {
    op: 'PLAY_TOKEN',
    token,
    count,
    ...(m[2] ? { ready: true } : {}),
    ...(m[6] && /here/i.test(m[6]) ? { here: true } : {}),
  };
}

const LOOK = /^Look at the top (\d+) cards? of your Main Deck$/i;

/**
 * "Look at the top N cards of your Main Deck." plus the sentences that finish it, as one LOOK_TOP
 * effect; `used` is how many sentences were consumed. Only the full, recycling forms:
 * "Put 1 into your hand and recycle the rest" and "You may reveal a unit|gear from among them and
 * draw it. [Then] recycle the rest".
 */
export function parseLookSequence(
  sens: readonly string[],
  i: number,
): { effect: CardEffect; used: number } | null {
  const m = LOOK.exec(sens[i] ?? '');
  if (!m) return null;
  const count = Number(m[1]);
  const next = (sens[i + 1] ?? '').replace(/^Then /i, '');
  if (/^Put (?:1|one) into your hand and recycle the rest$/i.test(next)) {
    return { effect: { op: 'LOOK_TOP', count, take: {} }, used: 2 };
  }
  const r = /^You may reveal an? (unit|gear) from among them and draw it$/i.exec(next);
  if (r && /^(?:Then )?recycle the (?:rest|remaining cards)$/i.test(sens[i + 2] ?? '')) {
    return {
      effect: {
        op: 'LOOK_TOP',
        count,
        take: { filter: (r[1] ?? '').toLowerCase() as 'unit' | 'gear', reveal: true },
      },
      used: 3,
    };
  }
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
  m = new RegExp(
    `^Return an? ${SIDE}unit( at a battlefield)?(?: with (\\d+) \\[M\\] or less)? to its owner's hand$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'RETURN_TARGET',
        ...sideProp(s),
        ...(m[2] ? { atBattlefield: true } : {}),
        ...(m[3] ? { maxMight: Number(m[3]) } : {}),
      },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(`^Return an? ${SIDE}gear to its owner's hand$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'RETURN_TARGET', gear: true, ...sideProp(s) },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(`^Move an? ${SIDE}unit( from a battlefield)? to (?:its |their )?base$`, 'i').exec(
    sen,
  );
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'MOVE_BASE_TARGET', ...sideProp(s), ...(m[2] ? { atBattlefield: true } : {}) },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(`^Move up to ${TWO} ${SIDE}units to (?:their )?base$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'MOVE_BASE_TARGET', ...sideProp(s), count: { min: 0, max: 2 } },
      decl: { side: s ?? 'any' },
      multi: true,
    };
  }
  return null;
}

/**
 * "It" sentences after a chosen unit ("Choose a friendly unit. Give it +2 [M] this turn."): the
 * same targeted ops as above, reading the slot of the unit chosen.
 */
function parseItSentence(sen: string, d: SlotDecl, slot: number): CardEffect | null {
  const at = slot > 0 ? { slot } : {};
  const sd = d.side === 'any' ? {} : { side: d.side };
  const bf = d.atBattlefield ? { atBattlefield: true } : {};
  let m = /^Give it \+(\d+) \[M\] this turn$/i.exec(sen);
  if (m) {
    return { op: 'BUFF_TARGET', amount: Number(m[1]), duration: 'TURN', ...sd, ...bf, ...at };
  }
  m = new RegExp(
    `^Give it ${DASH}(\\d+) \\[M\\] this turn(?:, to a minimum of (\\d+) \\[M\\])?$`,
    'i',
  ).exec(sen);
  if (m) {
    return {
      op: 'DEBUFF_TARGET',
      amount: Number(m[1]),
      ...(m[2] ? { minMight: Number(m[2]) } : {}),
      ...sd,
      ...bf,
      ...at,
    };
  }
  m = /^Deal (\d+) to it$/i.exec(sen);
  if (m) return { op: 'DAMAGE_TARGET', amount: Number(m[1]), ...sd, ...bf, ...at };
  if (/^Ready it$/i.test(sen)) return { op: 'READY_TARGET', ...sd, ...at };
  if (/^Stun it$/i.test(sen)) return { op: 'STUN_TARGET', ...sd, ...bf, ...at };
  if (/^Kill it$/i.test(sen)) return { op: 'KILL_TARGET', ...sd, ...bf, ...at };
  if (/^Return it to its owner's hand$/i.test(sen)) {
    return { op: 'RETURN_TARGET', ...sd, ...bf, ...at };
  }
  if (/^Move it to (?:its |their )?base$/i.test(sen)) {
    return { op: 'MOVE_BASE_TARGET', ...sd, ...bf, ...at };
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

const CHOOSE = new RegExp(
  `^Choose an? ${SIDE}unit( at a battlefield)?(?: and (an? )?(another )?${SIDE}unit)?$`,
  'i',
);

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
    const first: SlotDecl = {
      side: side(m[1]) ?? 'any',
      ...(m[2] ? { atBattlefield: true } : {}),
    };
    const adds: SlotDecl[] = [first];
    if (/ and /i.test(sen)) {
      adds.push({ side: side(m[5]) ?? 'any', ...(m[4] ? { another: true } : {}) });
    }
    if (!canAdd(st, adds)) return false;
    st.slots.push(...adds);
    if (adds.length === 1) st.it = st.slots.length - 1;
    else delete st.it;
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
  if (st.it !== undefined && !st.locked) {
    const eff = parseItSentence(sen, st.slots[st.it] as SlotDecl, st.it);
    if (eff) {
      out.push(eff);
      return true;
    }
  }
  const ch = parseChooser(sen);
  if (ch) {
    if (!canAdd(st, [ch.decl]) || (ch.multi && st.slots.length > 0)) return false;
    const slot = st.slots.length;
    st.slots.push(ch.decl);
    if (ch.multi) st.locked = true;
    else st.it = slot;
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
    .replace(TOKEN_WITH, '$1 with $2')
    .replace(/^\s*(?:(?:Action|Reaction|Hidden)\s+)+/i, '');
  const sens = sentences(cleaned);
  if (sens.length === 0) return null;
  const st: ParseState = { slots: [], locked: false };
  const out: CardEffect[] = [];
  // "A, then B" is two sentences in order.
  const list = sens.flatMap((x) => x.split(/, then /i)).map((x) => x.replace(/^Then /i, '').trim());
  for (let i = 0; i < list.length; i++) {
    const look = parseLookSequence(list, i);
    if (look) {
      out.push(look.effect);
      i += look.used - 1;
      continue;
    }
    if (!parseSpellSentence(list[i] as string, st, out)) return null;
  }
  // Every chosen unit must be used by an effect (a bare "Choose a unit." does nothing).
  if (targetRequirements(out).length !== st.slots.length) return null;
  return out;
}

/** "unit token with [Temporary]": the keyword belongs to the token, so keep it as plain text. */
const TOKEN_WITH = /(tokens?) with \[(\w+)\]/gi;

const KEYWORD_TOKENS =
  /\[(Tank|Backline|Assault(?: \d+)?|Shield(?: \d+)?|Ganking|Accelerate|Temporary|Hidden|Deflect(?: \d+)?|Action|Reaction)\]/gi;

/**
 * Parse the triggered abilities of a unit or gear. Returns null unless the whole text is made of
 * implemented keywords plus recognised triggers, and there is at least one trigger.
 */
export function parseTriggerText(text: string): CardTrigger[] | null {
  const cleaned = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(TOKEN_WITH, '$1 with $2')
    .replace(KEYWORD_TOKENS, ' ')
    .replace(/\[Deathknell\]\s*(?:\[>\]|[—–-])/gi, ' Deathknell: ')
    .replace(/\s+/g, ' ')
    .trim();
  // A trigger sentence starts a group; the sentences after it belong to the same ability.
  const groups: { ons: TriggerKind[]; sens: string[] }[] = [];
  for (const sen of cleaned
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const m =
      /^(When you play me or when I (hold|conquer)|When you play me|When I hold|When I conquer|Deathknell:)\s*,?\s*(.*)$/i.exec(
        sen,
      );
    if (m) {
      const head = (m[1] ?? '').toLowerCase();
      const ons: TriggerKind[] = head.startsWith('when you play me or')
        ? ['PLAY', m[2]?.toLowerCase() === 'hold' ? 'HOLD' : 'CONQUER']
        : head.startsWith('when you play me')
          ? ['PLAY']
          : head.startsWith('when i hold')
            ? ['HOLD']
            : head.startsWith('when i conquer')
              ? ['CONQUER']
              : ['DEATH'];
      groups.push({ ons, sens: m[3] ? [m[3]] : [] });
    } else {
      const g = groups[groups.length - 1];
      if (!g) return null;
      g.sens.push(sen);
    }
  }
  const out: CardTrigger[] = [];
  for (const g of groups) {
    // Triggers cannot choose targets yet: only slot-free clauses.
    const list = g.sens
      .flatMap((x) => x.split(/, then /i))
      .map((x) => x.replace(/^Then /i, '').trim());
    const effects: CardEffect[] = [];
    for (let i = 0; i < list.length; i++) {
      const look = parseLookSequence(list, i);
      if (look) {
        effects.push(look.effect);
        i += look.used - 1;
        continue;
      }
      const c = parseClause(list[i] as string);
      if (!c) return null;
      effects.push(...c);
    }
    if (effects.length === 0) return null;
    for (const on of g.ons) out.push({ on, effects });
  }
  return out.length > 0 ? out : null;
}
