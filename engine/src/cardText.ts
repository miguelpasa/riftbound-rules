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
 * "When I conquer, <effect>.", "[Deathknell][>] <effect>." and activated abilities "[E]: <effect>."; since R41
 * their effects may choose units like a spell's (the controller picks when the ability is put on the Chain).
 * R42 adds "When I attack / defend / attack or defend, <effect>.", the scopes "... unit here" and
 * "another ... unit", the optional "You may <chooser>." (declined with an empty choice), "Kill a gear
 * with Energy cost N or less", "This enters exhausted." (Gear) and the keywords [Disarm N] (an attack
 * trigger: "give an enemy unit here -N [M] this turn") and [Weaponmaster] (a play trigger).
 */
import { targetRequirements } from './effects.js';
import { GOLD_TOKEN_ID, tokenIdFor } from './tokens.js';
import type {
  AbilityCost,
  ActivatedAbility,
  CardEffect,
  CardTrigger,
  Condition,
  CountCmp,
  KeywordInstance,
  TargetCount,
  TargetSide,
  TriggerKind,
} from './types/card.js';

/**
 * Temporary keyword grants (R43): "{Tank}", "{Assault 2} and {Ganking}" after "Give ... " in a
 * sentence. The brackets of a grant become braces before the keyword tokens of a card are stripped.
 */
const GRANT_KW = '(?:Tank|Ganking|(?:Assault|Shield)(?: \\d+)?)';
const KW_LIST = `((?:\\{${GRANT_KW}\\}(?: and )?)+)`;
export function protectGrants(text: string): string {
  return text.replace(
    new RegExp(`(\\bGive [^.\\[\\]{}]*?)((?:\\[${GRANT_KW}\\](?: and )?)+)(?= this turn)`, 'gi'),
    (_m, head: string, list: string) => head + list.replace(/\[/g, '{').replace(/\]/g, '}'),
  );
}
function parseKwList(list: string | undefined): KeywordInstance[] | null {
  if (!list) return null;
  const out: KeywordInstance[] = [];
  for (const m of list.matchAll(/\{(Tank|Ganking|Assault|Shield)(?: (\d+))?\}/gi)) {
    const raw = (m[1] ?? '').toLowerCase();
    const name = (raw.charAt(0).toUpperCase() + raw.slice(1)) as KeywordInstance['name'];
    out.push(m[2] ? { name, value: Number(m[2]) } : { name });
  }
  return out.length > 0 ? out : null;
}

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
  /** R42: "... unit here" / "another ... unit" (relative to the ability's source). */
  here?: boolean;
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
  m = /^Each player channels? (\d+) runes?( exhausted)?$/i.exec(sen);
  if (m) {
    return [
      {
        op: 'CHANNEL',
        amount: Number(m[1]),
        eachPlayer: true,
        ...(m[2] ? { exhausted: true } : {}),
      },
    ];
  }
  m =
    /^\[Burn (\d+)\]$/i.exec(sen) ??
    /^Put the top (\d+) cards? of your Main Deck into your trash$/i.exec(sen);
  if (m) return [{ op: 'BURN', amount: Number(m[1]) }];
  if (/^You win the game$/i.test(sen)) return [{ op: 'WIN_GAME' }];
  m = /^Draw (\d+) for each other battlefield you(?: or allies)? control$/i.exec(sen);
  if (m) return [{ op: 'DRAW', amount: Number(m[1]), perOtherBattlefield: true }];
  m = /^Channel (\d+) runes?( exhausted)?$/i.exec(sen);
  if (m) return [{ op: 'CHANNEL', amount: Number(m[1]), ...(m[2] ? { exhausted: true } : {}) }];
  m = new RegExp(`^Give me ${KW_LIST} this turn$`, 'i').exec(sen);
  if (m) {
    const keywords = parseKwList(m[1]);
    return keywords ? [{ op: 'GRANT_KEYWORDS', keywords, to: 'SELF' }] : null;
  }
  m = new RegExp(`^Give your other units here ${KW_LIST} this turn$`, 'i').exec(sen);
  if (m) {
    const keywords = parseKwList(m[1]);
    return keywords ? [{ op: 'GRANT_KEYWORDS', keywords, to: 'OTHERS_HERE' }] : null;
  }
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
  return parseAddClause(sen);
}

const COUNT_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };

/**
 * "Play [a|two|N] [ready] N [M] Name unit token(s) [with Keyword] [here | to / into / at your base]".
 * The token must exist in tokens.ts. Without a location the Base is used (the choice of a
 * battlefield you control is not modelled).
 */
function parseTokenClause(sen: string): CardEffect | null {
  const g = /^Play (an?|one|two|three|four|\d+) (ready )?Gold gear tokens?( exhausted)?$/i.exec(
    sen,
  );
  if (g) {
    const n = COUNT_WORDS[(g[1] ?? '').toLowerCase()] ?? Number(g[1]);
    if (!(n >= 1) || (g[2] && g[3])) return null;
    return { op: 'PLAY_TOKEN', token: GOLD_TOKEN_ID, count: n, ...(g[2] ? { ready: true } : {}) };
  }
  const m =
    /^Play (an?|one|two|three|four|\d+) (ready )?(\d+) \[M\] (.+?) unit tokens?(?: with (\w+))?( here| (?:to|into|at|in) your base)?$/i.exec(
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

/**
 * R42: scopes and optionality around a chooser sentence. "here" after a unit noun and "another" before
 * a unit are lifted off the sentence and put on the effect; "You may <chooser>" makes the choice
 * optional ("up to one": choosing nothing declines).
 */
function parseChooser(sen: string): Chooser | null {
  let text = sen;
  let optional = false;
  const may = /^You may (.+)$/i.exec(text);
  if (may && !/^kill up to one gear$/i.test(may[1] ?? '')) {
    optional = true;
    text = may[1] ?? '';
  }
  const here = /\b(units?) here\b/i.test(text);
  if (here) text = text.replace(/\b(units?) here\b/i, '$1');
  const anotherRe = /\banother (?=(?:friendly |enemy )?unit\b)/i;
  const another = anotherRe.test(text);
  if (another) text = text.replace(anotherRe, 'a ');
  const ch = parseChooserBase(text);
  if (!ch) return null;
  if (!here && !another && !optional) return ch;
  const op = ch.effect.op;
  // Scopes are about units; counters and gear choices cannot carry them.
  if (op === 'COUNTER_SPELL' || op === 'WEAPONMASTER_EQUIP') return null;
  if ((here || another) && (op === 'KILL_GEAR' || (op === 'RETURN_TARGET' && ch.effect.gear))) {
    return null;
  }
  // "You may" needs a single-target choice that is not already a multi-target one.
  if (optional && (ch.multi === true || 'count' in ch.effect)) return null;
  const effect = { ...ch.effect } as CardEffect & {
    here?: boolean;
    another?: boolean;
    count?: TargetCount;
  };
  if (here) effect.here = true;
  if (another) effect.another = true;
  const decl: SlotDecl = { ...ch.decl, ...(here ? { here: true } : {}) };
  if (another) decl.another = true;
  if (optional) {
    effect.count = { min: 0, max: 1 };
    return { effect, decl, multi: true };
  }
  return { effect, decl, ...(ch.multi ? { multi: true } : {}) };
}

function parseChooserBase(sen: string): Chooser | null {
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
  m = new RegExp(`^Give an? ${SIDE}unit ${KW_LIST} this turn$`, 'i').exec(sen);
  if (m) {
    const keywords = parseKwList(m[2]);
    if (!keywords) return null;
    const s = side(m[1]);
    return {
      effect: { op: 'GRANT_KEYWORD_TARGET', keywords, ...sideProp(s) },
      decl: { side: s ?? 'any' },
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
  m = new RegExp(`^Kill an? ${SIDE}gear(?: with Energy cost \\[?(\\d+)\\]? or less)?$`, 'i').exec(
    sen,
  );
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'KILL_GEAR', ...sideProp(s), ...(m[2] ? { maxEnergy: Number(m[2]) } : {}) },
      decl: { side: s ?? 'any' },
    };
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
  let m = new RegExp(`^Give it ${KW_LIST} this turn$`, 'i').exec(sen);
  if (m) {
    const keywords = parseKwList(m[1]);
    return keywords ? { op: 'GRANT_KEYWORD_TARGET', keywords, ...sd, ...bf, ...at } : null;
  }
  m = /^Give it \+(\d+) \[M\] this turn$/i.exec(sen);
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
  m = /^Its controller plays (an?|one|two) Gold gear tokens?( exhausted)?$/i.exec(sen);
  if (m) {
    const prev = out[out.length - 1];
    if (!prev || (prev.op !== 'KILL_TARGET' && prev.op !== 'KILL_GEAR') || 'count' in prev) {
      return false;
    }
    out.push({
      op: 'TARGET_CONTROLLER_PLAY_TOKEN',
      token: GOLD_TOKEN_ID,
      count: COUNT_WORDS[(m[1] ?? '').toLowerCase()] ?? 1,
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

/**
 * "[Repeat] [2]" / "[Repeat] [1][C]" / "[Repeat] [C]" (820, R42): the printed Repeat cost of a spell.
 * Null for other cost shapes ("Discard 1", several costs, [A]) so the card stays partial.
 */
export function parseRepeatCost(text: string): { energy: number; power: number } | null {
  const m = /(?:^|\n)\s*\[Repeat\]\s*((?:\[[0-9C]+\]\s*)+)(?=\(|\n|$)/i.exec(text);
  if (!m) return null;
  let energy = 0;
  let power = 0;
  for (const t of (m[1] ?? '').matchAll(/\[([0-9C]+)\]/gi)) {
    const tok = (t[1] ?? '').toUpperCase();
    if (tok === 'C') power += 1;
    else if (/^\d+$/.test(tok)) energy += Number(tok);
    else return null;
  }
  return energy > 0 || power > 0 ? { energy, power } : null;
}

export function parseSpellText(text: string): CardEffect[] | null {
  const cleaned = protectGrants(text)
    .replace(/(?:^|\n)\s*\[Repeat\]\s*(?:\[[0-9C]+\]\s*)+/gi, '\n')
    .replace(/\[(Action|Reaction|Hidden)\]/gi, ' ')
    .replace(/\[Stun\]/gi, 'Stun')
    .replace(TOKEN_WITH, '$1 with $2')
    .replace(/^\s*(?:(?:Action|Reaction|Hidden)\s+)+/i, '');
  const sens = sentences(cleaned);
  if (sens.length === 0) return null;
  return parseEffectSentences(sens);
}

/**
 * The effect list of sentences that may choose targets (spells; since R41 also the body of
 * triggered and activated abilities). "A, then B" is two sentences in order. Null unless every
 * sentence is understood and every chosen unit is used by an effect.
 */
function parseEffectSentences(sens: readonly string[]): CardEffect[] | null {
  const st: ParseState = { slots: [], locked: false };
  const out: CardEffect[] = [];
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
  /\[(Tank|Backline|Assault(?: \d+)?|Shield(?: \d+)?|Ganking|Accelerate|Temporary|Hidden|Deflect(?: \d+)?|Action|Reaction|Ambush)\]/gi;

/** What a unit / gear / token text defines besides keywords (R5, R38). */
export interface ParsedAbilities {
  triggers: CardTrigger[];
  abilities: ActivatedAbility[];
  entersReady?: boolean;
  /** "I enter ready if <condition>." (R43). */
  entersReadyWhen?: Condition;
  /** "This enters exhausted." (R42). */
  entersExhausted?: boolean;
  legionCostReduction?: number;
}

/** [Disarm N] (831) and [Weaponmaster] (821) as the triggers their reminder text describes (R42). */
function keywordTriggers(text: string): CardTrigger[] {
  const out: CardTrigger[] = [];
  let disarm = 0;
  for (const m of text.matchAll(/(?:^|\n)\s*\[Disarm(?: (\d+))?\]/gi)) disarm += Number(m[1] ?? 1);
  // 831: several instances sum into one trigger.
  if (disarm > 0) {
    out.push({
      on: 'ATTACK',
      effects: [{ op: 'DEBUFF_TARGET', amount: disarm, side: 'enemy', here: true }],
    });
  }
  if (/(?:^|\n)\s*\[Weaponmaster\]/i.test(text)) {
    out.push({
      on: 'PLAY',
      effects: [{ op: 'WEAPONMASTER_EQUIP', count: { min: 0, max: 1 } }],
    });
  }
  return out;
}

/** "[Add] [N]" (Energy), "[Add] [C]" (Power of the source's Domain), "[Add] [A]" (Universal Power). */
function parseAddClause(sen: string): CardEffect[] | null {
  const m = /^\[Add\] \[(\d+|A|C)\]$/i.exec(sen);
  if (!m) return null;
  const t = (m[1] ?? '').toUpperCase();
  if (t === 'A') return [{ op: 'ADD_POWER', amount: 1, domain: 'ANY' }];
  if (t === 'C') return [{ op: 'ADD_POWER', amount: 1, domain: 'SOURCE' }];
  const n = Number(t);
  return n > 0 ? [{ op: 'ADD_ENERGY', amount: n }] : null;
}

/** "[E]", "[N]" (Energy), "Kill this" joined by commas. */
function parseAbilityCost(text: string, gearLike: boolean): AbilityCost | null {
  const cost: AbilityCost = {};
  for (const part of text.split(/\s*,\s*/)) {
    if (/^\[E\]$/i.test(part)) cost.exhaust = true;
    else if (/^\[\d+\]$/.test(part)) cost.energy = (cost.energy ?? 0) + Number(part.slice(1, -1));
    else if (/^Kill this$/i.test(part) && gearLike) cost.killSelf = true;
    else return null;
  }
  return cost.exhaust || cost.energy || cost.killSelf ? cost : null;
}

const NUMBER_WORDS: Record<string, number> = {
  no: 0,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};
const NUM = '(\\d+|no|zero|one|two|three|four|five|six|seven|eight)';
const numberOf = (w: string | undefined): number | null => {
  if (w === undefined) return null;
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w.toLowerCase()] ?? null;
};

/**
 * R43: the condition clauses understood after "if" (case-insensitive, no final period):
 *  - "there is exactly one other unit you control here", "you control two or more other gear",
 *    "you control no other units", "you control three or fewer runes", "you have two or more other
 *    units in your base", "you have one or fewer cards in your hand", "there is an enemy unit alone
 *    here"  (COUNT)
 *  - "you control a Poro", "you control another Dragon"  (CONTROL_SUBTYPE)
 *  - "I'm at a battlefield"  (AT_BATTLEFIELD)
 * Anything else is null, which keeps the card partial.
 */
export function parseCondition(raw: string): Condition | null {
  const text = raw
    .trim()
    .replace(/[.\s]+$/, '')
    .replace(/\s+/g, ' ');
  if (/^I['’]m at a battlefield$/i.test(text)) return { kind: 'AT_BATTLEFIELD' };
  if (/^there['’]?s? (?:is )?an enemy unit alone (?:here|at that battlefield)$/i.test(text)) {
    return { kind: 'COUNT', what: 'unit', where: 'here', who: 'enemy', cmp: 'EQ', n: 1 };
  }
  let m = new RegExp(
    `^there is (exactly|at least) ${NUM} (other )?(units?|gear) you control here$`,
    'i',
  ).exec(text);
  if (m) {
    const n = numberOf(m[2]);
    if (n === null) return null;
    return {
      kind: 'COUNT',
      what: /gear/i.test(m[4] ?? '') ? 'gear' : 'unit',
      where: 'here',
      who: 'friendly',
      ...(m[3] ? { other: true } : {}),
      cmp: /least/i.test(m[1] ?? '') ? 'GTE' : 'EQ',
      n,
    };
  }
  if (/^your Rune Deck is empty$/i.test(text)) {
    return { kind: 'COUNT', what: 'card', where: 'runeDeck', who: 'friendly', cmp: 'EQ', n: 0 };
  }
  m = new RegExp(
    `^you (?:control|have) ${NUM}(?:(\\+)| or (more|fewer))? (other )?(units?|gear|runes?|cards?)(?: (in your base|in your hand|here))?$`,
    'i',
  ).exec(text);
  if (m) {
    const n = numberOf(m[1]);
    if (n === null) return null;
    const noun = (m[5] ?? '').toLowerCase();
    const what = noun.startsWith('unit')
      ? 'unit'
      : noun === 'gear'
        ? 'gear'
        : noun.startsWith('rune')
          ? 'rune'
          : 'card';
    const place = (m[6] ?? '').toLowerCase();
    // "N cards" only makes sense in the hand; runes only on the board; "here" holds units and gear.
    if ((what === 'card') !== (place === 'in your hand')) return null;
    if (what === 'rune' && place !== '') return null;
    const where =
      place === 'in your base'
        ? 'base'
        : place === 'in your hand'
          ? 'hand'
          : place === 'here'
            ? 'here'
            : 'board';
    const cmp: CountCmp =
      m[2] || /^more$/i.test(m[3] ?? '') ? 'GTE' : /^fewer$/i.test(m[3] ?? '') ? 'LTE' : 'EQ';
    return {
      kind: 'COUNT',
      what,
      where,
      who: 'friendly',
      ...(m[4] ? { other: true } : {}),
      cmp,
      n,
    };
  }
  m = /^you control (a|an|another) ([A-Z][A-Za-z]+)$/.exec(text);
  if (m && !/^(Battlefield|Unit|Gear|Rune|Spell)$/.test(m[2] ?? '')) {
    return {
      kind: 'CONTROL_SUBTYPE',
      subtype: m[2] as string,
      ...(m[1]?.toLowerCase() === 'another' ? { other: true } : {}),
    };
  }
  return null;
}

/** "if <cond>, <rest>" or "<rest> if <cond>": split a condition off the first sentence of a body. */
function splitCondition(sen: string): { when?: Condition; rest: string } | null {
  let m = /^if (.+?), (.+)$/i.exec(sen);
  if (m) {
    const when = parseCondition(m[1] as string);
    return when ? { when, rest: m[2] as string } : null;
  }
  m = /^(.+?),? if (.+)$/i.exec(sen);
  if (m) {
    const when = parseCondition(m[2] as string);
    if (when) return { when, rest: m[1] as string };
  }
  return { rest: sen };
}

const TRIGGER_HEAD =
  /^(When you play me or when I (hold|conquer)|When you play me|When I hold|When I conquer|When I attack or defend|When I attack|When I defend|When I move|Deathknell:)\s*,?\s*(.*)$/i;

/**
 * Parse the abilities of a unit, gear or token: triggered abilities ("When you play me / hold /
 * conquer", Deathknell), their Legion-conditioned forms ("[Legion] - When you play me, ..."),
 * activated abilities ("[E]: [Reaction] - [Add] [C]", "[Reaction][>] Kill this, [E]: [Add] [A]"),
 * "I enter ready" and "[Legion] - I cost [N] less". Returns null unless the whole text is made of
 * implemented keywords plus these forms (all-or-nothing) and there is at least one of them.
 * `gearLike`: the card may use "Kill this" as a cost (gear and gear-like tokens).
 */
export function parseCardAbilities(
  text: string,
  opts: { gearLike?: boolean } = {},
): ParsedAbilities | null {
  const kwTriggers = keywordTriggers(text);
  const cleaned = protectGrants(text)
    .replace(/(?:^|\n)\s*\[(?:Disarm(?: \d+)?|Weaponmaster)\]/gi, '\n')
    .replace(/\s*\n\s*/g, '. ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(TOKEN_WITH, '$1 with $2')
    .replace(/\[Stun\]/gi, 'Stun')
    .replace(
      /\[(Reaction|Action)\]\s*(?:\[>\]|[—–-])\s*/gi,
      (_m, k: string) => `${k.toUpperCase()} `,
    )
    .replace(/\[Legion\]\s*(?:\[>\]|[—–-])\s*/gi, 'LEGION ')
    .replace(KEYWORD_TOKENS, ' ')
    .replace(/\[Deathknell\]\s*(?:\[>\]|[—–-])/gi, ' Deathknell: ')
    .replace(/\s+/g, ' ')
    .trim();
  const out: ParsedAbilities = { triggers: [...kwTriggers], abilities: [] };
  // A trigger / ability sentence starts a group; the sentences after it belong to the same ability.
  type Group =
    | { kind: 'trigger'; ons: TriggerKind[]; legion: boolean; when?: Condition; sens: string[] }
    | { kind: 'ability'; cost: AbilityCost; reaction: boolean; sens: string[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  for (const raw of cleaned
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean)) {
    let sen = raw;
    let legion = false;
    if (/^LEGION /.test(sen)) {
      legion = true;
      sen = sen.slice(7).trim();
    }
    const m = TRIGGER_HEAD.exec(sen);
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
              : head.startsWith('when i attack or defend')
                ? ['ATTACK', 'DEFEND']
                : head.startsWith('when i attack')
                  ? ['ATTACK']
                  : head.startsWith('when i defend')
                    ? ['DEFEND']
                    : head.startsWith('when i move')
                      ? ['MOVE']
                      : ['DEATH'];
      let body = m[3] ?? '';
      let when: Condition | undefined;
      if (body) {
        const split = splitCondition(body);
        if (!split) return null; // an "if" clause we do not understand
        when = split.when;
        body = split.rest;
      }
      cur = { kind: 'trigger', ons, legion, ...(when ? { when } : {}), sens: body ? [body] : [] };
      groups.push(cur);
      continue;
    }
    if (/^This enters exhausted$/i.test(sen) && !legion && opts.gearLike === true) {
      out.entersExhausted = true;
      cur = null;
      continue;
    }
    if (/^I enter ready$/i.test(sen) && !legion) {
      out.entersReady = true;
      cur = null;
      continue;
    }
    const erc = /^I enter ready if (.+)$/i.exec(sen);
    if (erc && !legion) {
      const when = parseCondition(erc[1] as string);
      if (!when) return null;
      out.entersReadyWhen = when;
      cur = null;
      continue;
    }
    const cr = /^I cost \[(\d+)\] less$/i.exec(sen);
    if (cr && legion) {
      out.legionCostReduction = Number(cr[1]);
      cur = null;
      continue;
    }
    if (legion) return null;
    const ab = /^(?:(REACTION|ACTION) )?([^:]+): (?:(REACTION|ACTION) )?(.+)$/.exec(sen);
    if (ab && ab[1] !== 'ACTION' && ab[3] !== 'ACTION') {
      const cost = parseAbilityCost(ab[2] ?? '', opts.gearLike === true);
      if (!cost) return null;
      cur = { kind: 'ability', cost, reaction: !!(ab[1] ?? ab[3]), sens: [ab[4] as string] };
      groups.push(cur);
      continue;
    }
    if (!cur) return null;
    cur.sens.push(sen);
  }
  for (const g of groups) {
    // R41: bodies may choose targets ("give a unit +2 [M] this turn"), like a spell's sentences.
    const effects = parseEffectSentences(g.sens);
    if (!effects || effects.length === 0) return null;
    if (g.kind === 'ability') {
      out.abilities.push({ cost: g.cost, ...(g.reaction ? { reaction: true } : {}), effects });
    } else {
      for (const on of g.ons) {
        out.triggers.push({
          on,
          effects,
          ...(g.legion ? { condition: 'LEGION' as const } : {}),
          ...(g.when ? { when: g.when } : {}),
        });
      }
    }
  }
  const any =
    out.triggers.length > 0 ||
    out.abilities.length > 0 ||
    out.entersReady === true ||
    out.entersReadyWhen !== undefined ||
    out.entersExhausted === true ||
    out.legionCostReduction !== undefined;
  return any ? out : null;
}

/**
 * R44: the abilities of a Battlefield card: "When you hold / conquer / defend / attack here, <effects>".
 * The text is rewritten to the unit forms ("When I hold, ...") and parsed by the same interpreter, so
 * every effect and condition shape of triggered abilities is available; "here" is the battlefield
 * itself and "you" the player the moment is about. Null unless the whole text is such triggers
 * (all-or-nothing, like units). Static and "while you control this battlefield" text stays partial.
 */
export function parseBattlefieldAbilities(text: string): CardTrigger[] | null {
  const rewritten = text.replace(
    /(^|[.\n]\s*)When you (hold|conquer|defend|attack) here\b/gi,
    (_m, pre: string, k: string) => `${pre}When I ${k.toLowerCase()}`,
  );
  const r = parseCardAbilities(rewritten);
  if (!r || r.triggers.length === 0) return null;
  if (r.abilities.length > 0 || r.entersReady || r.entersReadyWhen || r.entersExhausted)
    return null;
  if (r.legionCostReduction !== undefined || r.triggers.some((t) => t.condition)) return null;
  if (r.triggers.some((t) => !['HOLD', 'CONQUER', 'DEFEND', 'ATTACK'].includes(t.on))) return null;
  return r.triggers;
}

/** Triggered abilities only (kept for callers and tests): null unless the text has a trigger. */
export function parseTriggerText(text: string): CardTrigger[] | null {
  const r = parseCardAbilities(text);
  if (!r || r.triggers.length === 0) return null;
  if (
    r.abilities.length > 0 ||
    r.entersReady ||
    r.entersReadyWhen ||
    r.entersExhausted ||
    r.legionCostReduction !== undefined
  ) {
    return null;
  }
  return r.triggers;
}
