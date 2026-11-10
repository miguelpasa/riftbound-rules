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
 * R46: card-choice costs: "you may discard 1 [and|to] ...", "you may kill a friendly unit to ...", "you may pay [1] and
 * return a unit you control here to its owner's hand to ..." (exhaust / kill / return / discard, also in activated
 * ability costs: "Discard a gear, [1], [E]:", "Recycle 1 from your trash:") and "Kill a unit or gear".
 * R45: optional trigger bodies "you may pay [1][C][A] to ...", "you may [Burn N] to ..." and a free "you may ..."
 * become `CardTrigger.optional` (accept / decline when the ability resolves); "a unit you control" = a friendly unit.
 */
import { targetRequirements } from './effects.js';
import { BOMB_TOKEN_ID, GOLD_TOKEN_ID, tokenIdFor } from './tokens.js';
import type {
  AbilityCost,
  ActivatedAbility,
  CardEffect,
  Domain,
  CardDef,
  CardTrigger,
  CostCount,
  CostReduction,
  StaticCount,
  AltAmount,
  LookTake,
  DeathFilter,
  PlayFilter,
  StaticAbility,
  Condition,
  CostCardChoice,
  CountCmp,
  KeywordInstance,
  OptionalCost,
  TargetCount,
  TargetSide,
  TriggerKind,
} from './types/card.js';

/**
 * Temporary keyword grants (R43): "{Tank}", "{Assault 2} and {Ganking}" after "Give ... " in a
 * sentence. The brackets of a grant become braces before the keyword tokens of a card are stripped.
 */
const GRANT_KW = '(?:Tank|Ganking|(?:Assault|Shield|Deflect)(?: \\d+)?)';
const KW_LIST = `((?:\\{${GRANT_KW}\\}(?: and )?)+)`;
export function protectGrants(text: string): string {
  // "Give <a unit> +N [M] and [Keyword] this turn" = the buff, then the keyword for the same unit.
  const split = text.replace(
    new RegExp(`(\\bGive [^.\\n]*? \\+\\d+ \\[M\\]) and \\[(${GRANT_KW})\\](?= this turn)`, 'gi'),
    (_m, head: string, kw: string) => `${head} this turn. Give it {${kw}}`,
  );
  return split.replace(
    new RegExp(
      `(\\b(?:Give|It gains) [^.\\[\\]{}]*?)((?:\\[${GRANT_KW}\\](?: and )?)+)(?= this (?:turn|combat))`,
      'gi',
    ),
    (_m, head: string, list: string) => head + list.replace(/\[/g, '{').replace(/\]/g, '}'),
  );
}
function parseKwList(list: string | undefined): KeywordInstance[] | null {
  if (!list) return null;
  const out: KeywordInstance[] = [];
  for (const m of list.matchAll(/\{(Tank|Ganking|Assault|Shield|Deflect)(?: (\d+))?\}/gi)) {
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
  /** "Choose an occupied enemy battlefield": only battlefields with an enemy unit. */
  enemyOccupied?: boolean;
  /** "another unit": distinct from the earlier slot even without a side. */
  another?: boolean;
  /** "Choose a unit at a battlefield". */
  atBattlefield?: boolean;
  /** R42: "... unit here" / "another ... unit" (relative to the ability's source). */
  here?: boolean;
  /** X-loc: a chosen battlefield, or the location a moved unit goes to (not a unit). */
  kind?: 'battlefield' | 'location' | 'gear';
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
  return parseClauseWith(sen, true);
}

function parseClauseNoSplit(sen: string): CardEffect[] | null {
  return parseClauseWith(sen, false);
}

function parseClauseWith(sen: string, allowSplit: boolean): CardEffect[] | null {
  let m = /^Draw (\d+)$/i.exec(sen);
  if (m) return [{ op: 'DRAW', amount: Number(m[1]) }];
  if (/^Banish this$/i.test(sen)) return [{ op: 'BANISH_THIS_SPELL' }];
  if (/^Kill this$/i.test(sen)) return [{ op: 'KILL_SELF' }];
  if (/^Take a turn after this one$/i.test(sen)) return [{ op: 'EXTRA_TURN' }];
  m =
    /^(Starting with the next player, )?[Ee]ach player (?:must |may )?(kill|return)s? (?:one of their (units|gear)|an? (unit|gear)(?: to its owner['’]s hand)?)$/.exec(
      sen,
    );
  if (m) {
    const kill = /^kill$/i.test(m[2] ?? '');
    return [
      {
        op: 'EACH_CHOOSE',
        board: /gear/i.test(m[3] ?? m[4] ?? '') ? 'gear' : 'unit',
        action: kill ? 'KILL' : 'RETURN',
        ...(/ may /.test(sen) ? { optional: true } : {}),
        ...(m[1] ? { startWithOpponent: true } : {}),
      },
    ];
  }
  m = /^(Each player|They) discards? (\d+)$/i.exec(sen);
  if (m) {
    return [
      {
        op: 'HAND_DISCARD',
        who: /^each/i.test(m[1] ?? '') ? 'EACH' : 'OPPONENT',
        count: Number(m[2]),
      },
    ];
  }
  m = /^Each player discards their hand, then draws (\d+)$/i.exec(sen);
  if (m) {
    return [
      { op: 'DISCARD_HAND', eachPlayer: true },
      { op: 'DRAW', amount: Number(m[1]), eachPlayer: true },
    ];
  }
  m = /^They score (\d+) points?$/i.exec(sen);
  if (m) return [{ op: 'GAIN_POINT', amount: Number(m[1]), forOpponent: true }];
  if (/^Play me$/i.test(sen)) return [{ op: 'PLAY_SELF' }];
  if (/^Prevent all spell and ability damage this turn$/i.test(sen))
    return [{ op: 'PREVENT_EFFECT_DAMAGE_TURN' }];
  m = /^(?:You and that player each draw|Each player draws) (\d+)$/i.exec(sen);
  if (m) return [{ op: 'DRAW', amount: Number(m[1]), eachPlayer: true }];
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
  m = /^Draw (\d+) for each battlefield you(?: or allies)? control$/i.exec(sen);
  if (m) return [{ op: 'DRAW', amount: Number(m[1]), per: 'BATTLEFIELD' }];
  m = /^Draw (\d+) for each of your \[Mighty\] units$/i.exec(sen);
  if (m) return [{ op: 'DRAW', amount: Number(m[1]), per: 'MIGHTY_UNIT' }];
  m = /^Return all units with (\d+) \[M\] or less to their owners['’] hands$/i.exec(sen);
  if (m) return [{ op: 'RETURN_ALL_UNITS', maxMight: Number(m[1]) }];
  if (/^Return all units and gear to their owners['’] hands$/i.test(sen)) {
    return [{ op: 'RETURN_ALL_BOARD' }];
  }
  m = /^Channel (\d+) runes?( exhausted)?$/i.exec(sen);
  if (m) return [{ op: 'CHANNEL', amount: Number(m[1]), ...(m[2] ? { exhausted: true } : {}) }];
  m = /^Give me \+(\d+) \[M\] this turn$/i.exec(sen);
  if (m) return [{ op: 'BUFF_SELF', amount: Number(m[1]) }];
  if (/^(?:\[Buff\]|Buff) me$/i.test(sen)) return [{ op: 'BUFF_SELF', amount: 1, buff: true }];
  if (/^Ready me$/i.test(sen)) return [{ op: 'READY_SELF' }];
  if (/^Empower me$/i.test(sen)) return [{ op: 'EMPOWER_SELF' }];
  if (/^Return (?:me|this) to (?:my|its) owner['’]s hand$/i.test(sen))
    return [{ op: 'RETURN_SELF' }];
  m = /^\[Predict(?: (\d+))?\]$/i.exec(sen);
  if (m) return [{ op: 'PREDICT', count: Number(m[1] ?? 1) }];
  m = /^Gain (\d+) XP(?: for each friendly unit)?$/i.exec(sen);
  if (m) {
    return [
      {
        op: 'GAIN_XP',
        amount: Number(m[1]),
        ...(/for each friendly unit/i.test(sen) ? { perFriendlyUnit: true } : {}),
      },
    ];
  }
  if (/^Ready (?:your|a friendly) legend$/i.test(sen)) return [{ op: 'READY_LEGEND' }];
  // R72: runes.
  m = /^Ready up to (\d+) (?:friendly |your )?runes$/i.exec(sen);
  if (m) return [{ op: 'READY_RUNES', count: Number(m[1]) }];
  if (/^Ready your runes$/i.test(sen)) return [{ op: 'READY_RUNES', count: 99 }];
  if (/^Recycle all your runes$/i.test(sen)) return [{ op: 'RECYCLE_RUNES' }];
  m = /^Recycle (\d+) from your trash$/i.exec(sen);
  if (m) return [{ op: 'RECYCLE_TRASH', count: Number(m[1]) }];
  if (/^Double my Might this combat$/i.test(sen)) {
    return [{ op: 'DOUBLE_MIGHT_SELF', duration: 'COMBAT' }];
  }
  if (/^Double my Might this turn$/i.test(sen)) return [{ op: 'DOUBLE_MIGHT_SELF' }];
  if (/^Give me (?:\[Temporary\]|Temporary)$/i.test(sen)) return [{ op: 'GRANT_TEMPORARY_SELF' }];
  if (/^Move me to your base$/i.test(sen)) return [{ op: 'MOVE_SELF_BASE' }];
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
  m = /^(?:You )?score (\d+) points?$/i.exec(sen);
  if (m) return [{ op: 'GAIN_POINT', amount: Number(m[1]) }];
  m = new RegExp(
    `^Give (friendly|enemy) units ${DASH}(\\d+) \\[M\\] this turn, to a minimum of (\\d+) \\[M\\]$`,
    'i',
  ).exec(sen);
  if (m) {
    return [
      {
        op: 'BUFF_ALL',
        amount: -Number(m[2]),
        side: (m[1] ?? 'enemy').toLowerCase() as TargetSide,
        duration: 'TURN',
        minMight: Number(m[3]),
      },
    ];
  }
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
  // R86: "Deal N to all enemy units here" / "Deal damage equal to my Might to all enemy units here".
  m = /^Deal (\d+) to (?:all |each )?(friendly |enemy )?units? (?:here|at my battlefield)$/i.exec(
    sen,
  );
  if (m) {
    return [
      {
        op: 'DAMAGE_ALL',
        amount: Number(m[1]),
        side: side((m[2] ?? '').trim()) ?? 'any',
        scope: 'here',
      },
    ];
  }
  m = /^Deal damage equal to my Might to all (friendly |enemy )?units here$/i.exec(sen);
  if (m) {
    return [
      {
        op: 'DAMAGE_ALL',
        amount: 0,
        amountFrom: 'MY_MIGHT',
        side: side((m[1] ?? '').trim()) ?? 'any',
        scope: 'here',
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
  if (/^Ready all enemy units$/i.test(sen)) return [{ op: 'READY_ALL', side: 'enemy' }];
  if (/^Heal your units here$/i.test(sen))
    return [{ op: 'HEAL_ALL', side: 'friendly', here: true }];
  // "Give your units here [Ganking] this turn" (Megatusk).
  m = new RegExp(`^Give (?:your|all friendly) units( here)? ${KW_LIST} this turn$`, 'i').exec(sen);
  if (m) {
    const keywords = parseKwList(m[2]);
    return keywords
      ? [{ op: 'GRANT_KEYWORD_ALL', keywords, side: 'friendly', ...(m[1] ? { here: true } : {}) }]
      : null;
  }
  // R93: "[Buff] all units here" / "buff all other friendly units there".
  m = /^(?:\[Buff\]|Buff) all (other )?(friendly )?units (?:here|there)$/i.exec(sen);
  if (m) {
    return [
      {
        op: 'BUFF_ALL',
        amount: 1,
        buff: true,
        side: m[2] ? 'friendly' : 'any',
        here: true,
        ...(m[1] ? { others: true } : {}),
      },
    ];
  }
  // "Give your Mechs +1 [M] this turn" (Danger Zone): every friendly unit with the subtype.
  m = /^Give your ([A-Z][a-z]+)s \+(\d+) \[M\] this turn$/.exec(sen);
  if (m && m[1] !== 'Unit') {
    return [
      {
        op: 'BUFF_ALL',
        amount: Number(m[2]),
        side: 'friendly',
        duration: 'TURN',
        subtype: m[1] as string,
      },
    ];
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
  m = /^Kill all (damaged )?(friendly |enemy )?units( here)?$/i.exec(sen);
  if (m && (m[1] || m[2] || m[3])) {
    const sideWord = (m[2] ?? '').trim().toLowerCase();
    return [
      {
        op: 'KILL_ALL_UNITS',
        ...(sideWord === 'friendly' || sideWord === 'enemy' ? { side: sideWord } : {}),
        ...(m[1] ? { damaged: true } : {}),
        ...(m[3] ? { here: true } : {}),
      },
    ];
  }
  const tok = parseTokenClause(sen);
  if (tok) return [tok];
  const add = parseAddClause(sen);
  if (add) return add;
  // R102: "Ready me and give me +2 [M] this turn", "Ready me and gain 3 XP": two target-free clauses joined by "and".
  const both = /^(.+?) and (.+)$/.exec(sen);
  if (allowSplit && both && !/ (?:and|or) /i.test(both[2] ?? '')) {
    const first = parseClauseNoSplit(both[1] ?? '');
    const second = parseClauseNoSplit(both[2] ?? '');
    if (first && second) return [...first, ...second];
  }
  return null;
}

const COUNT_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };

/**
 * "Play [a|two|N] [ready] N [M] Name unit token(s) [with Keyword] [here | to / into / at your base]".
 * The token must exist in tokens.ts. Without a location the Base is used (the choice of a
 * battlefield you control is not modelled).
 */
function parseTokenClause(sen00: string): CardEffect | null {
  // R97: "They play a 1 [M] Bird unit token ..." (the opponent chosen by the previous sentence plays it).
  const theirs = /^They play /i.test(sen00);
  const sen0 = theirs ? sen00.replace(/^They play /i, 'Play ') : sen00;
  const r = parseTokenClauseBase(sen0);
  return r && theirs && r.op === 'PLAY_TOKEN' ? { ...r, forOpponent: true } : theirs ? null : r;
}

function parseTokenClauseBase(sen0: string): CardEffect | null {
  // R92: "a [1] [M] Tentacle unit token from Bilgewater" = "a 1 [M] Tentacle unit token".
  const sen = sen0
    .replace(/^(Play (?:an?|one|two|three|four|\d+) (?:ready )?)\[(\d+)\] \[M\]/i, '$1$2 [M]')
    .replace(/ from Bilgewater/i, '');
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
  // R96: "Draw one and recycle the other" (Look at the top 2).
  if (/^Draw one and recycle the other$/i.test(next)) {
    return { effect: { op: 'LOOK_TOP', count, take: {} }, used: 2 };
  }
  // R96: "You may choose a card from among them and draw it. Put the rest into your trash."
  if (
    /^You may choose a card from among them and draw it$/i.test(next) &&
    /^Put the rest into your trash$/i.test(sens[i + 2] ?? '')
  ) {
    return { effect: { op: 'LOOK_TOP', count, take: {}, rest: 'TRASH' }, used: 3 };
  }
  const r =
    /^You may reveal (?:from among them )?an? (unit or gear|unit|gear|spell)(?: with Energy cost (?:no more than \[(\d+)\]|\[(\d+)\] or more))?(?: and with Power cost no more than \[A\])?(?: from among them)? and draw it$/i.exec(
      next,
    );
  if (r && /^(?:Then )?recycle the (?:rest|remaining cards)$/i.test(sens[i + 2] ?? '')) {
    const word = (r[1] ?? '').toLowerCase();
    const take: LookTake = {
      filter: word === 'unit or gear' ? 'unitOrGear' : (word as 'unit' | 'gear' | 'spell'),
      reveal: true,
    };
    if (r[2] !== undefined) take.maxEnergy = Number(r[2]);
    if (r[3] !== undefined) take.minEnergy = Number(r[3]);
    if (/and with Power cost no more than/i.test(next)) take.maxPower = 1;
    return { effect: { op: 'LOOK_TOP', count, take }, used: 3 };
  }
  return null;
}

/**
 * X-reveal: "Reveal the top card of your Main Deck. If it's a gear, draw it. Otherwise, recycle it." (Apprentice Smith,
 * Raving Witness with [Mighty], Pakaa Protector with "put it in your trash and give me +2 [M] this turn", Ravenbloom
 * Conservatory with "put it in your hand"). `used` is how many sentences were consumed.
 */
export function parseRevealSequence(
  sens: readonly string[],
  i: number,
): { effect: CardEffect; used: number } | null {
  if (!/^(?:Then,? )?Reveal the top card of your Main Deck$/i.test(sens[i] ?? '')) return null;
  const hit =
    /^If it['’]s (?:an? )?(\[Mighty\]|unit|gear|spell), (draw it|put it in your hand)$/i.exec(
      sens[i + 1] ?? '',
    );
  if (!hit) return null;
  const word = (hit[1] ?? '').toLowerCase();
  const filter = word === '[mighty]' ? 'mighty' : (word as 'unit' | 'gear' | 'spell');
  const take: 'DRAW' | 'HAND' = /draw it/i.test(hit[2] ?? '') ? 'DRAW' : 'HAND';
  const other = /^Otherwise,? (.+)$/i.exec(sens[i + 2] ?? '');
  if (!other) return null;
  const rest = (other[1] ?? '').trim();
  if (/^recycle it$/i.test(rest)) {
    return { effect: { op: 'REVEAL_TOP', filter, hit: take, miss: 'RECYCLE' }, used: 3 };
  }
  const trash = /^put it in your trash(?: and give me \+(\d+) \[M\] this turn)?$/i.exec(rest);
  if (trash) {
    return {
      effect: {
        op: 'REVEAL_TOP',
        filter,
        hit: take,
        miss: 'TRASH',
        ...(trash[1] ? { missBuff: Number(trash[1]) } : {}),
      },
      used: 3,
    };
  }
  return null;
}

/**
 * X-hand: "They reveal their hand. Choose a non-unit card from it, and recycle that card." (Sabotage), "... Choose a
 * card from it, and they discard that card." (Mindsplitter), "They reveal their hand and you choose a Mind card from it.
 * They recycle that card." (Decree of Strength). `used` is how many sentences were consumed.
 */
export function parseHandPickSequence(
  sens: readonly string[],
  i: number,
): { effect: CardEffect; used: number } | null {
  const first = /^They reveal their hand(?: and you choose an? ([A-Za-z-]+) card from it)?$/i.exec(
    sens[i] ?? '',
  );
  if (!first) return null;
  const kind = (word: string | undefined): { notUnit?: boolean; domain?: string } | null => {
    if (!word || /^card$/i.test(word)) return {};
    if (/^non-unit$/i.test(word)) return { notUnit: true };
    return /^[A-Z][a-z]+$/.test(word) ? { domain: word } : null;
  };
  if (first[1] !== undefined) {
    const filter = kind(first[1]);
    const act = /^They (recycle|discard) that card$/i.exec(sens[i + 1] ?? '');
    if (!filter || !act) return null;
    return {
      effect: {
        op: 'HAND_PICK',
        action: (act[1] ?? '').toLowerCase() === 'recycle' ? 'RECYCLE' : 'DISCARD',
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      },
      used: 2,
    };
  }
  const pick =
    /^Choose an? (non-unit |[A-Z][a-z]+ )?card from it, and (recycle that card|they discard that card)$/i.exec(
      sens[i + 1] ?? '',
    );
  if (!pick) return null;
  const filter = kind((pick[1] ?? '').trim() || undefined);
  if (!filter) return null;
  return {
    effect: {
      op: 'HAND_PICK',
      action: /^recycle/i.test(pick[2] ?? '') ? 'RECYCLE' : 'DISCARD',
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    },
    used: 2,
  };
}

/**
 * X-reveal-play: "reveal / look at the top N cards, banish one, play it [ignoring / reducing its cost], recycle (or
 * draw) the rest" (Reinforce, Rek'Sai, Void Burrower, Void Rush, Blind Fury, Drakehound Packmaster) and Dazzling
 * Aurora's "reveal cards until you reveal a unit and banish it. Play it, ignoring its cost, and recycle the rest".
 * The choice among the revealed cards is made by the engine (the most expensive playable card; UNCLEAR).
 */
export function parseRevealPlaySequence(
  sens: readonly string[],
  i: number,
): { effect: CardEffect; used: number } | null {
  const first = sens[i] ?? '';
  // Clocktower Guardian: "Banish the top card of your Main Deck. You may play it, ignoring its Energy cost."
  const topPlay = /^You may play it, ignoring its (Energy )?cost$/i.exec(sens[i + 1] ?? '');
  if (/^Banish the top card of your Main Deck$/i.test(first) && topPlay) {
    return {
      effect: {
        op: 'REVEAL_PLAY',
        from: 'SELF',
        count: 1,
        play: topPlay[1] ? 'ENERGY' : 'ALL',
        rest: 'RECYCLE',
      },
      used: 2,
    };
  }
  // Dazzling Aurora.
  if (
    /^[Rr]eveal cards from the top of your Main Deck until you reveal a unit and banish it$/.test(
      first,
    ) &&
    /^Play it, ignoring its cost, and recycle the rest$/i.test(sens[i + 1] ?? '')
  ) {
    return {
      effect: { op: 'REVEAL_PLAY', from: 'SELF', untilUnit: true, play: 'ALL', rest: 'RECYCLE' },
      used: 2,
    };
  }
  let from: 'SELF' | 'OPPONENT' = 'SELF';
  let count = 1;
  let unitsOnly = false;
  const own = /^(?:You may )?(?:[Rr]eveal|[Ll]ook at) the top (\d+) cards of your Main Deck$/.exec(
    first,
  );
  const opp =
    /^(?:Each opponent reveals the top card of their Main Deck|[Rr]eveal the top card of each opponent['’]s Main Deck)$/.exec(
      first,
    );
  if (own) count = Number(own[1]);
  else if (opp) from = 'OPPONENT';
  else return null;
  // ", then" splits the sentence, so "banish ..." and "play it ..." arrive separately.
  const banish =
    /^(?:Choose one and banish it|You may banish (a unit|one)(?: from among them)?)$/i.exec(
      sens[i + 1] ?? '',
    );
  const second = banish
    ? /^play it(?:, (ignoring its cost|reducing its cost by \[(\d+)\]))?$/i.exec(sens[i + 2] ?? '')
    : null;
  if (!banish || !second) return null;
  unitsOnly = /unit/i.test(banish[1] ?? '');
  let k = i + 3;
  let here = false;
  if (/^If it is a unit, you may play it here$/i.test(sens[k] ?? '')) {
    here = true;
    k++;
  }
  const tail = sens[k] ?? '';
  let rest: 'RECYCLE' | 'DRAW';
  if (/^(?:Then )?[Rr]ecycle the (?:rest|remaining cards)$/.test(tail)) rest = 'RECYCLE';
  else if (/^Draw any you didn['’]t banish$/i.test(tail)) rest = 'DRAW';
  else return null;
  const how = (second[1] ?? '').toLowerCase();
  const play: 'ALL' | 'REDUCE' | 'FULL' = how.startsWith('ignoring')
    ? 'ALL'
    : how.startsWith('reducing')
      ? 'REDUCE'
      : 'FULL';
  return {
    effect: {
      op: 'REVEAL_PLAY',
      from,
      count,
      play,
      ...(play === 'REDUCE' ? { reduceBy: Number(second[2]) } : {}),
      ...(unitsOnly ? { unitsOnly: true } : {}),
      ...(here ? { here: true } : {}),
      rest,
    },
    used: k - i + 1,
  };
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
  // R45: "a unit you control (here)" is "a friendly unit (here)".
  text = text.replace(/\b(an? |another )(units?) you control\b/i, '$1friendly $2');
  const hereRe = /\b(units? or gear|units?) here\b/i;
  const here = hereRe.test(text);
  if (here) text = text.replace(hereRe, (_m, noun: string) => noun);
  const anotherRe = /\banother (?=(?:friendly |enemy )?unit\b)/i;
  // R75: "buff up to two other friendly units" = up to two friendly units besides the source.
  const otherMany = /\bup to (\w+) other (?=(?:friendly |enemy )?units\b)/i.test(text);
  if (otherMany) text = text.replace(/\bup to (\w+) other /i, 'up to $1 ');
  // X5/tail: "deal 2 to up to one other unit" = an optional second unit, distinct from the first.
  const otherOne = /\bup to one other (?=(?:friendly |enemy )?unit\b)/i.test(text);
  if (otherOne) text = text.replace(/\bup to one other /i, 'up to one ');
  const another = anotherRe.test(text) || otherMany || otherOne;
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
  // R98: "Give a gear [Temporary]", "Give a unit at a battlefield or a gear [Temporary]", "Double a friendly unit's Might this turn".
  {
    const gt = new RegExp(
      `^Give an? ${SIDE}(gear|unit at a battlefield or a gear|unit) \\[Temporary\\]$`,
      'i',
    ).exec(sen);
    if (gt) {
      const s = side(gt[1]);
      const what = (gt[2] ?? '').toLowerCase();
      const kind = what === 'gear' ? 'gear' : what === 'unit' ? 'unit' : 'unitOrGear';
      return {
        effect: {
          op: 'GRANT_TEMPORARY_TARGET',
          kind,
          ...(kind === 'unitOrGear' ? { atBattlefield: true } : {}),
          ...sideProp(s),
        },
        decl: { side: s ?? 'any' },
      };
    }
    const dm = new RegExp(`^Double an? ${SIDE}unit['’]s Might this turn$`, 'i').exec(sen);
    if (dm) {
      const s = side(dm[1]);
      return { effect: { op: 'DOUBLE_MIGHT_TARGET', ...sideProp(s) }, decl: { side: s ?? 'any' } };
    }
  }
  // R106: subtype-limited choices: "Ready another friendly Mech", "Return a non-Dragon unit to its owner's hand".
  {
    const rm = /^[Rr]eady another friendly ([A-Z][a-z]+)$/.exec(sen);
    if (rm) {
      return {
        effect: { op: 'READY_TARGET', side: 'friendly', another: true, subtype: rm[1] as string },
        decl: { side: 'friendly', another: true },
      };
    }
    const nd = /^[Rr]eturn an? non-([A-Z][a-z]+) unit to its owner['’]s hand$/.exec(sen);
    if (nd) {
      return {
        effect: { op: 'RETURN_TARGET', notSubtype: nd[1] as string },
        decl: { side: 'any' },
      };
    }
  }
  // R93: "Give a unit [Assault] this turn equal to its Might" / "Give a unit -[M] this turn equal to the number of exhausted units you control" / "+N [M] ... for each enemy unit there".
  {
    const bw = new RegExp(
      `^Give an? ${SIDE}unit \\{Assault\\} this turn equal to its Might$`,
      'i',
    ).exec(sen);
    if (bw) {
      const s = side(bw[1]);
      return {
        effect: {
          op: 'GRANT_KEYWORD_TARGET',
          keywords: [{ name: 'Assault' }],
          valueFromMight: true,
          ...sideProp(s),
        },
        decl: { side: s ?? 'any' },
      };
    }
    const hn = new RegExp(
      `^Give an? ${SIDE}unit ${DASH}\\[M\\] this turn equal to the number of exhausted units you control$`,
      'i',
    ).exec(sen);
    if (hn) {
      const s = side(hn[1]);
      return {
        effect: { op: 'DEBUFF_TARGET', amount: 1, timesExhausted: true, ...sideProp(s) },
        decl: { side: s ?? 'any' },
      };
    }
    const ao = new RegExp(
      `^Give an? ${SIDE}unit at a battlefield \\+(\\d+) \\[M\\] this turn for each enemy unit there$`,
      'i',
    ).exec(sen);
    if (ao) {
      const s = side(ao[1]);
      return {
        effect: {
          op: 'BUFF_TARGET',
          amount: Number(ao[2]),
          duration: 'TURN',
          timesEnemiesThere: true,
          atBattlefield: true,
          ...sideProp(s),
        },
        decl: { side: s ?? 'any', atBattlefield: true },
      };
    }
  }
  // R87: "Deal that much to <unit>" (the excess damage just assigned).
  const that = /^Deal that much to (.+)$/i.exec(sen);
  if (that) {
    const base = parseChooserBase('Deal 1 to ' + (that[1] ?? ''));
    if (!base || base.effect.op !== 'DAMAGE_TARGET') return null;
    return { ...base, effect: { ...base.effect, amount: 0, amountFrom: 'EXCESS' } };
  }
  // R74: "Deal damage equal to my Might / [Assault] / [Shield] to <unit>".
  const dm = /^Deal damage equal to my (Might|[{\[]Assault[}\]]|[{\[]Shield[}\]]) to (.+)$/i.exec(
    sen,
  );
  if (dm) {
    const base = parseChooserBase(`Deal 1 to ${dm[2]}`);
    if (!base || base.effect.op !== 'DAMAGE_TARGET') return null;
    const w = (dm[1] ?? '').toLowerCase();
    const amountFrom =
      w === 'might' ? 'MY_MIGHT' : w.includes('assault') ? 'MY_ASSAULT' : 'MY_SHIELD';
    return { ...base, effect: { ...base.effect, amount: 0, amountFrom } };
  }
  const markedDmg = new RegExp(
    `^Deal damage to an? ${SIDE}unit equal to the damage marked on it$`,
    'i',
  ).exec(sen);
  if (markedDmg) {
    const s = side(markedDmg[1]);
    return {
      effect: { op: 'DAMAGE_TARGET', amount: 0, amountFrom: 'TARGET_DAMAGE', ...sideProp(s) },
      decl: { side: s ?? 'any' },
    };
  }
  let m = new RegExp(`^Deal (\\d+) to an? ${SIDE}unit( at a battlefield| in a base)?$`, 'i').exec(
    sen,
  );
  if (m) {
    const s = side(m[2]);
    return {
      effect: {
        op: 'DAMAGE_TARGET',
        amount: Number(m[1]),
        ...sideProp(s),
        ...(/battlefield/i.test(m[3] ?? '') ? { atBattlefield: true } : {}),
        ...(/base/i.test(m[3] ?? '') ? { inBase: true } : {}),
      },
      decl: { side: s ?? 'any' },
    };
  }
  // "Deal N to up to one [other] unit": an optional single target.
  m = new RegExp(`^Deal (\\d+) to up to one ${SIDE}unit( at a battlefield)?$`, 'i').exec(sen);
  if (m) {
    const s = side(m[2]);
    return {
      effect: {
        op: 'DAMAGE_TARGET',
        amount: Number(m[1]),
        count: { min: 0, max: 1 },
        ...sideProp(s),
        ...(m[3] ? { atBattlefield: true } : {}),
      },
      decl: { side: s ?? 'any' },
    };
  }
  // X1: "Deal N damage split among any number of enemy units" (here is lifted off by parseChooser) and
  // "Deal N damage split among units at a single battlefield".
  m = new RegExp(
    `^Deal (\\d+) damage split among (?:any number of ${SIDE}units|units at a single battlefield)$`,
    'i',
  ).exec(sen);
  if (m) {
    const n = Number(m[1]);
    const single = /single battlefield/i.test(sen);
    const s = single ? undefined : side(m[2]);
    return {
      effect: {
        op: 'DAMAGE_TARGET',
        amount: n,
        split: true,
        ...(single ? { atBattlefield: true, sameBattlefield: true } : {}),
        ...sideProp(s),
        count: { min: 1, max: n },
      },
      decl: { side: s ?? 'any', ...(single ? { atBattlefield: true } : {}) },
      multi: true,
    };
  }
  // "Return any number of enemy units with total Might 5 or less to their owners' hands" (Decree of Discord).
  m = new RegExp(
    `^Return any number of ${SIDE}units with total Might (\\d+) or less to their owners['’] hands$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'RETURN_TARGET',
        ...sideProp(s),
        totalMaxMight: Number(m[2]),
        count: { min: 0, max: 99 },
      },
      decl: { side: s ?? 'any' },
      multi: true,
    };
  }
  // "Kill any number of units at a battlefield with total Might 4 or less" (Fox-Fire).
  m = /^Kill any number of units at a battlefield with total Might (\d+) or less$/i.exec(sen);
  if (m) {
    return {
      effect: {
        op: 'KILL_TARGET',
        atBattlefield: true,
        sameBattlefield: true,
        totalMaxMight: Number(m[1]),
        count: { min: 0, max: 99 },
      },
      decl: { side: 'any', atBattlefield: true },
      multi: true,
    };
  }
  // "Deal N to up to three units at the same location" (Bellows Breath): they share a battlefield or a Base.
  m = /^Deal (\d+) to up to (two|three|2|3) units at the same location$/i.exec(sen);
  if (m) {
    const max = /^(?:three|3)$/i.test(m[2] ?? '') ? 3 : 2;
    return {
      effect: {
        op: 'DAMAGE_TARGET',
        amount: Number(m[1]),
        sameLocation: true,
        count: { min: 0, max },
      },
      decl: { side: 'any' },
      multi: true,
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
  m = new RegExp(`^(?:\\[Buff\\]|Buff) up to (\\d+|two|three|four|five) ${SIDE}units$`, 'i').exec(
    sen,
  );
  if (m) {
    const n = NUMBER_WORDS[(m[1] ?? '').toLowerCase()] ?? Number(m[1]);
    const sd = side(m[2]);
    return {
      effect: {
        op: 'BUFF_TARGET',
        amount: 1,
        buff: true,
        ...sideProp(sd),
        count: { min: 0, max: n },
      },
      decl: { side: sd ?? 'any' },
      multi: true,
    };
  }
  m = new RegExp(`^(?:\\[Buff\\]|Buff) an? ${SIDE}unit( in your base)?$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'BUFF_TARGET',
        amount: 1,
        buff: true,
        ...(m[2] ? { inBase: true } : {}),
        ...sideProp(s),
      },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(`^Give an? ${SIDE}unit ${KW_LIST} this (turn|combat)$`, 'i').exec(sen);
  if (m) {
    const keywords = parseKwList(m[2]);
    if (!keywords) return null;
    const s = side(m[1]);
    return {
      effect: {
        op: 'GRANT_KEYWORD_TARGET',
        keywords,
        ...(m[3]?.toLowerCase() === 'combat' ? { duration: 'COMBAT' as const } : {}),
        ...sideProp(s),
      },
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
  m = new RegExp(`^Take control of an? ${SIDE}unit( at a battlefield)?$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'TAKE_CONTROL',
        ...sideProp(s),
        ...(m[2] ? { atBattlefield: true } : {}),
      },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(`^Kill an? ${SIDE}unit or gear( here)?$`, 'i').exec(sen);
  if (m) {
    // R46: either kind of permanent; "an enemy unit or gear" limits it to the opponent's.
    const s = side(m[1]);
    return {
      effect: { op: 'KILL_TARGET', orGear: true, ...sideProp(s), ...(m[2] ? { here: true } : {}) },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(
    `^Kill an? ${SIDE}gear(?: with Energy cost (?:\\[?(\\d+)\\]? or less|no more than \\[?(\\d+)\\]?))?$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    const cap = m[2] ?? m[3];
    return {
      effect: { op: 'KILL_GEAR', ...sideProp(s), ...(cap ? { maxEnergy: Number(cap) } : {}) },
      decl: { side: s ?? 'any' },
    };
  }
  if (/^[Kk]ill a gear with Energy cost no more than my Might$/.test(sen)) {
    return {
      effect: { op: 'KILL_GEAR', maxEnergyMyMight: true },
      decl: { side: 'any' },
    };
  }
  if (/^(?:You may )?kill up to one gear$/i.test(sen)) {
    return {
      effect: { op: 'KILL_GEAR', count: { min: 0, max: 1 } },
      decl: { side: 'any' },
      multi: true,
    };
  }
  m = new RegExp(`^Ready an? ${SIDE}gear$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'READY_TARGET', gear: true, ...sideProp(s) },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(`^Ready (?:two|2) ${SIDE}gear$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'READY_TARGET', gear: true, ...sideProp(s), count: { min: 0, max: 2 } },
      decl: { side: s ?? 'any' },
      multi: true,
    };
  }
  m = new RegExp(`^Ready an? ${SIDE}unit$`, 'i').exec(sen);
  if (m) {
    const s = side(m[1]);
    return { effect: { op: 'READY_TARGET', ...sideProp(s) }, decl: { side: s ?? 'any' } };
  }
  m = new RegExp(`^Stun an? (attacking )?${SIDE}unit( at a battlefield)?$`, 'i').exec(sen);
  if (m) {
    const s = side(m[2]);
    return {
      effect: {
        op: 'STUN_TARGET',
        ...sideProp(s),
        ...(m[3] ? { atBattlefield: true } : {}),
        ...(m[1] ? { attacking: true } : {}),
      },
      decl: { side: s ?? 'any' },
    };
  }
  if (/^Counter a spell$/i.test(sen)) {
    return { effect: { op: 'COUNTER_SPELL' }, decl: { side: 'any' } };
  }
  // R80: counters limited by the countered spell's printed cost.
  m = /^Counter a spell with Power cost ((?:\[A\]){1,4}) or more$/i.exec(sen);
  if (m) {
    const n = (m[1] ?? '').split('[').length - 1;
    return { effect: { op: 'COUNTER_SPELL', minPower: n }, decl: { side: 'any' } };
  }
  m = /^Counter a spell that costs no more than \[(\d+)\] and no more than ((?:\[A\]){1,4})$/i.exec(
    sen,
  );
  if (m) {
    const n = (m[2] ?? '').split('[').length - 1;
    return {
      effect: { op: 'COUNTER_SPELL', maxEnergy: Number(m[1]), maxPower: n },
      decl: { side: 'any' },
    };
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
  // X5: "Play a unit [costing / with cost no more than [3] and no more than [A]] from your trash, ignoring its cost".
  m =
    /^[Pp]lay an? unit(?: (?:costing|with cost) no more than \[(\d+)\](?: and no more than \[A\])?)? from your trash, ignoring its (Energy )?cost$/.exec(
      sen,
    );
  if (m) {
    return {
      effect: {
        op: 'PLAY_FROM_TRASH',
        ...(m[2] ? { payPower: true } : {}),
        ...(m[1] !== undefined ? { maxEnergy: Number(m[1]) } : {}),
        ...(m[1] !== undefined && /and no more than \[A\]/.test(sen) ? { maxPower: 1 } : {}),
      },
      decl: { side: 'friendly' },
    };
  }
  // "Play a spell from your trash with Energy cost no more than [3] / less than your points, ignoring its Energy cost".
  m =
    /^[Pp]lay a spell from your trash(?: with Energy cost (?:no more than \[(\d+)\]|(less than your points)))?,? (?:ignoring its (Energy )?cost|without paying its Energy cost)$/.exec(
      sen,
    );
  if (m) {
    return {
      effect: {
        op: 'PLAY_FROM_TRASH',
        what: 'spell',
        payPower: true,
        ...(m[1] !== undefined ? { maxEnergy: Number(m[1]) } : {}),
        ...(m[2] ? { energyBelowPoints: true } : {}),
      },
      decl: { side: 'friendly' },
    };
  }
  // "Play a unit from your hand to your base, ignoring its [Energy] cost" (Rift Herald).
  m = /^[Pp]lay an? unit from your hand to your base, ignoring its (Energy )?cost$/.exec(sen);
  if (m) {
    return {
      effect: { op: 'PLAY_FROM_TRASH', from: 'hand', ...(m[1] ? { payPower: true } : {}) },
      decl: { side: 'friendly' },
    };
  }
  // "Play up to 3 units and/or gear from your trash, each with Energy cost no more than [3] and Power cost no more
  // than [A], ignoring their costs" (Remember the Fallen).
  m =
    /^[Pp]lay up to (two|three|\d+) units and\/or gear from your trash, each with Energy cost no more than \[(\d+)\] and Power cost no more than \[A\], ignoring their costs$/.exec(
      sen,
    );
  if (m) {
    const n = COUNT_WORDS[(m[1] ?? '').toLowerCase()] ?? Number(m[1]);
    return {
      effect: {
        op: 'PLAY_FROM_TRASH',
        what: 'unitOrGear',
        maxEnergy: Number(m[2]),
        maxPower: 1,
        count: { min: 0, max: n },
      },
      decl: { side: 'friendly' },
      multi: true,
    };
  }
  // R75: "Return a unit / gear / spell (or a Bird, Cat, ...) from your trash to your hand".
  m =
    /^[Rr]eturn an? (unit or gear|unit|gear|spell|(?:[A-Z][a-z]+, )*(?:[A-Z][a-z]+,? or )?[A-Z][a-z]+) from your trash to your hand$/.exec(
      sen,
    );
  if (m) {
    const w = (m[1] ?? '').toLowerCase();
    const named = !['unit or gear', 'unit', 'gear', 'spell'].includes(w);
    const what =
      w === 'unit or gear'
        ? 'unitOrGear'
        : w === 'gear'
          ? 'gear'
          : w === 'spell'
            ? 'spell'
            : 'unit';
    const subtypes = named ? (m[1] ?? '').split(/,? or |, /).filter(Boolean) : undefined;
    return {
      effect: { op: 'RETURN_FROM_TRASH', what, ...(subtypes ? { subtypes } : {}) },
      decl: { side: 'friendly' },
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
  // R79: "Move an enemy unit to that battlefield / here / my battlefield".
  m = new RegExp(
    `^Move an? ${SIDE}unit to (?:here|that battlefield|my battlefield|this battlefield)$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return { effect: { op: 'MOVE_HERE_TARGET', ...sideProp(s) }, decl: { side: s ?? 'any' } };
  }
  m = new RegExp(
    `^Banish an? ${SIDE}unit, then its owner plays it(?: to (their base|the same location))?, ignoring its cost$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'BLINK_TARGET',
        to: /same location/i.test(m[2] ?? '') ? 'SAME' : 'BASE',
        ...sideProp(s),
      },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(
    `^Move an? ${SIDE}unit( (?:from|at) a battlefield)? to (?:its |their |your )?base$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: { op: 'MOVE_BASE_TARGET', ...sideProp(s), ...(m[2] ? { atBattlefield: true } : {}) },
      decl: { side: s ?? 'any' },
    };
  }
  m = new RegExp(
    `^Move any number of ${SIDE}units( (?:from|at) a battlefield)? to (?:their |its )?base$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'MOVE_BASE_TARGET',
        ...sideProp(s),
        ...(m[2] ? { atBattlefield: true } : {}),
        count: { min: 0, max: 99 },
      },
      decl: { side: s ?? 'any' },
      multi: true,
    };
  }
  m = new RegExp(
    `^Move any number of ${SIDE}units each with (\\d+) \\[M\\] or less to (?:their |its )?base$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    return {
      effect: {
        op: 'MOVE_BASE_TARGET',
        ...sideProp(s),
        maxMight: Number(m[2]),
        count: { min: 0, max: 99 },
      },
      decl: { side: s ?? 'any' },
      multi: true,
    };
  }
  m = new RegExp(`^Move an attacking unit to (?:its |their )?base$`, 'i').exec(sen);
  if (m) {
    return {
      effect: { op: 'MOVE_BASE_TARGET', attacking: true, side: 'enemy' },
      decl: { side: 'enemy' },
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
function parseItSentence(sen0: string, d: SlotDecl, slot: number): CardEffect | null {
  const sen = sen0.replace(/^It gains /i, 'Give it ');
  const at = slot > 0 ? { slot } : {};
  const sd = d.side === 'any' ? {} : { side: d.side };
  const bf = {
    ...(d.atBattlefield ? { atBattlefield: true } : {}),
    ...(d.here ? { here: true } : {}),
  };
  let m = new RegExp(`^Give it ${KW_LIST} this (turn|combat)$`, 'i').exec(sen);
  if (m) {
    const keywords = parseKwList(m[1]);
    const combat = m[2]?.toLowerCase() === 'combat';
    return keywords
      ? {
          op: 'GRANT_KEYWORD_TARGET',
          keywords,
          ...(combat ? { duration: 'COMBAT' as const } : {}),
          ...sd,
          ...bf,
          ...at,
        }
      : null;
  }
  m =
    /^Give it \+(\d+) \[M\] this turn for each of the following tags among your units [—–-] Bird, Cat, Dog, and Poro$/i.exec(
      sen,
    );
  if (m) {
    return {
      op: 'BUFF_TARGET',
      amount: Number(m[1]),
      duration: 'TURN',
      perPetTags: true,
      ...sd,
      ...bf,
      ...at,
    };
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
  m = /^Its base Might becomes (\d+) this turn$/i.exec(sen);
  if (m) return { op: 'SET_BASE_MIGHT', amount: Number(m[1]), ...sd, ...at };
  if (
    /^The next time it would die this turn, heal it, exhaust it, and recall it instead$/i.test(sen)
  )
    return { op: 'DEATH_REPLACE_TARGET', mode: 'RECALL', ...sd, ...bf, ...at };
  if (/^The next time (?:that unit|it) would be dealt damage this turn, prevent it$/i.test(sen))
    return { op: 'DAMAGE_MOD_TARGET', mod: 'PREVENT_NEXT', ...sd, ...bf, ...at };
  m = /^Prevent the next (\d+) damage that would be dealt to it this turn$/i.exec(sen);
  if (m)
    return {
      op: 'DAMAGE_MOD_TARGET',
      mod: 'PREVENT_AMOUNT',
      amount: Number(m[1]),
      ...sd,
      ...bf,
      ...at,
    };
  if (/^Double all damage that would be dealt to it this turn$/i.test(sen))
    return { op: 'DAMAGE_MOD_TARGET', mod: 'DOUBLE', ...sd, ...bf, ...at };
  m =
    /^The next time it would die this turn, you may pay ((?:\[(?:\d+|C|A)\])+) to heal it, exhaust it, and recall it instead$/i.exec(
      sen,
    );
  if (m)
    return {
      op: 'DEATH_REPLACE_TARGET',
      mode: 'RECALL',
      offer: offerCost(m[1] ?? ''),
      ...sd,
      ...bf,
      ...at,
    };
  if (/^If it would die this turn, banish it instead$/i.test(sen))
    return { op: 'DEATH_REPLACE_TARGET', mode: 'BANISH', ...sd, ...bf, ...at };
  if (/^Give it \[Temporary\]$/i.test(sen)) return { op: 'GRANT_TEMPORARY_TARGET', ...sd, ...at };
  if (/^Ready it$/i.test(sen)) return { op: 'READY_TARGET', ...sd, ...at };
  const tc = /^Take control of it( and recall it)?$/i.exec(sen);
  if (tc) return { op: 'TAKE_CONTROL', ...(tc[1] ? { recall: true } : {}), ...sd, ...bf, ...at };
  if (/^It can['’]t move this turn$/i.test(sen)) return { op: 'LOCK_MOVE_TARGET', ...sd, ...at };
  if (/^Stun it$/i.test(sen)) return { op: 'STUN_TARGET', ...sd, ...bf, ...at };
  if (/^Kill it$/i.test(sen)) return { op: 'KILL_TARGET', ...sd, ...bf, ...at };
  if (/^Banish it$/i.test(sen)) return { op: 'BANISH_TARGET', ...sd, ...bf, ...at };
  if (/^Disempower it$/i.test(sen)) return { op: 'DISEMPOWER_TARGET', ...sd, ...bf, ...at };
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
  // Battlefield / location choices are not units: at most one of them, beside the unit rules below.
  if ([...st.slots, ...add].filter((d) => d.kind !== undefined).length > 2) return false;
  const all = [...st.slots, ...add].filter((d) => d.kind === undefined);
  if (all.length <= 1) return true;
  if (all.length > 2) return false;
  const [a, b] = all as [SlotDecl, SlotDecl];
  if (b.another) return true;
  return a.side !== 'any' && b.side !== 'any' && a.side !== b.side;
}

const CHOOSE = new RegExp(
  `^Choose an? ${SIDE}unit( at a battlefield| here)?(?: and (an? )?(another )?${SIDE}unit)?$`,
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

/**
 * The body of a "this turn" trigger: clauses joined by " and ", where "buff it" / "ready it" / "kill it" mean the unit
 * the trigger is about (effect slot 0) and any other clause is a plain effect ("draw 1", "gain 2 XP").
 */
function parseDelayedBody(body: string, friendly: boolean): CardEffect[] | null {
  const out: CardEffect[] = [];
  for (const raw of body.split(/ and /i)) {
    const clause = raw.trim();
    const it = /^(\[?Buff\]?|ready|kill) it$/i.exec(clause);
    const sentence = it
      ? `${(it[1] ?? '').replace(/[[\]]/g, '')} a${friendly ? ' friendly' : ''} unit`
      : clause;
    const eff = parseSpellText(sentence);
    if (!eff || eff.some((e) => e.op === 'DELAYED')) return null;
    out.push(...eff);
  }
  return targetRequirements(out).length <= 1 ? out : null;
}

/** "When a friendly unit is played this turn, ..." and the other "this turn" trigger sentences (see delayed.ts). */
function parseDelayedSentence(sen: string, st: ParseState): CardEffect | null {
  const numberWord = (w: string | undefined): number | undefined =>
    w === undefined ? undefined : (NUMBER_WORDS[w.toLowerCase()] ?? Number(w));
  let m = /^When a friendly unit is played this turn, (.+)$/i.exec(sen);
  if (m) {
    const effects = parseDelayedBody(m[1] as string, true);
    return effects ? { op: 'DELAYED', on: 'UNIT_PLAYED', effects } : null;
  }
  m = /^(?:The )?next (?:(\w+) times|time) you play a unit this turn, (.+)$/i.exec(sen);
  if (m) {
    const times = m[1] === undefined ? 1 : numberWord(m[1]);
    const effects = parseDelayedBody(m[2] as string, true);
    return effects && times && times >= 1
      ? { op: 'DELAYED', on: 'UNIT_PLAYED', times, effects }
      : null;
  }
  // "... at the end of this turn": the body is target-free (it runs in the Ending step).
  m = /^(.+?) at the end of this turn$/i.exec(sen);
  if (m) {
    const effects = parseDelayedBody(m[1] as string, false);
    return effects && effects.length > 0 && targetRequirements(effects).length === 0
      ? { op: 'DELAYED', on: 'END_OF_TURN', effects }
      : null;
  }
  m = /^When any unit takes damage this turn, (.+)$/i.exec(sen);
  if (m) {
    const effects = parseDelayedBody(m[1] as string, false);
    return effects ? { op: 'DELAYED', on: 'UNIT_DAMAGED', effects } : null;
  }
  m = /^When it dies this turn, (.+)$/i.exec(sen);
  if (m && st.it !== undefined) {
    const effects = parseDelayedBody(m[1] as string, false);
    return effects && targetRequirements(effects).length === 0
      ? { op: 'DELAYED', on: 'SUBJECT_DIES', subjectSlot: st.it, times: 1, effects }
      : null;
  }
  return null;
}

function parseSpellSentence(sen: string, st: ParseState, out: CardEffect[]): boolean {
  // "This turn" triggers (Rally the Troops, Fanfare, Deadly Flourish, Imperial Decree).
  const delayed = parseDelayedSentence(sen, st);
  if (delayed) {
    out.push(delayed);
    return true;
  }
  // "Give the friendly unit +N [M] this turn" after "Choose a friendly unit and an enemy unit" (Rampage).
  const sideRef = /^Give the (friendly|enemy) unit \+(\d+) \[M\] this turn$/i.exec(sen);
  if (sideRef && st.slots.length === 2) {
    const wanted = (sideRef[1] ?? '').toLowerCase();
    const idx = st.slots.findIndex((d) => d.side === wanted);
    if (idx < 0) return false;
    out.push({
      op: 'BUFF_TARGET',
      amount: Number(sideRef[2]),
      duration: 'TURN',
      side: wanted as TargetSide,
      ...(idx > 0 ? { slot: idx } : {}),
    });
    return true;
  }
  // Hostile Takeover: "Lose control of that unit and recall it at end of turn".
  if (/^Lose control of that unit and recall it at end of turn$/i.test(sen)) {
    const tcEff = [...out].reverse().find((x) => x.op === 'TAKE_CONTROL');
    if (!tcEff || tcEff.op !== 'TAKE_CONTROL') return false;
    tcEff.untilEnd = true;
    return true;
  }
  // A spell's own "Discard N" (Lunar Boon): the caster chooses cards from their hand.
  const selfDiscard = /^Discard (\d+)$/.exec(sen);
  if (selfDiscard) {
    out.push({ op: 'HAND_DISCARD', who: 'YOU', count: Number(selfDiscard[1]) });
    return true;
  }
  // X-loc: "Choose a battlefield" declares a battlefield slot for the sentence that follows.
  if (/^Choose a battlefield$/i.test(sen)) {
    const add: SlotDecl = { side: 'any', kind: 'battlefield' };
    if (!canAdd(st, [add])) return false;
    st.slots.push(add);
    delete st.it;
    return true;
  }
  // "Choose an occupied enemy battlefield. Play three 1 [M] Recruit unit tokens there."
  if (/^Choose an occupied enemy battlefield$/i.test(sen)) {
    const add: SlotDecl = { side: 'any', kind: 'battlefield', enemyOccupied: true };
    if (!canAdd(st, [add])) return false;
    st.slots.push(add);
    delete st.it;
    return true;
  }
  {
    const there = /^(Play .+ unit tokens?) there$/i.exec(sen);
    const bfSlot = st.slots.findIndex((d) => d.kind === 'battlefield');
    if (there && bfSlot >= 0) {
      const tok = parseTokenClause(`${there[1]} here`);
      if (!tok || tok.op !== 'PLAY_TOKEN') return false;
      const placed = { ...tok };
      delete placed.here; // "there" is the chosen battlefield, not the source's
      out.push({
        ...placed,
        atSlot: bfSlot,
        ...(st.slots[bfSlot]?.enemyOccupied ? { atEnemyOccupied: true as const } : {}),
      });
      return true;
    }
  }
  // "Give friendly units there +1 [M] this turn and enemy units there -1 [M] this turn, to a minimum of 1 [M]".
  let m = new RegExp(
    `^Give friendly units there \\+(\\d+) \\[M\\] this turn and enemy units there ${DASH}(\\d+) \\[M\\] this turn, to a minimum of (\\d+) \\[M\\]$`,
    'i',
  ).exec(sen);
  if (m) {
    const bf = st.slots.findIndex((d) => d.kind === 'battlefield');
    if (bf < 0) return false;
    out.push({
      op: 'BF_AREA',
      slot: bf,
      friendlyMight: Number(m[1]),
      enemyMight: Number(m[2]),
      minMight: Number(m[3]),
    });
    return true;
  }
  // "Give friendly units there [Shield 2] this turn".
  m = /^Give friendly units there ((?:\{[^}]+\}(?: and )?)+) this turn$/i.exec(sen);
  if (m) {
    const bf = st.slots.findIndex((d) => d.kind === 'battlefield');
    const keywords = parseKwList(m[1] ?? '');
    if (bf < 0 || !keywords) return false;
    out.push({ op: 'BF_AREA', slot: bf, keywords });
    return true;
  }
  // Bomb gear tokens are played to a battlefield the controller chooses (one battlefield for all of them).
  m = /^Play (an?|one|two|three|four|d+) Bomb gear tokens? to (?:a|a single) battlefield$/i.exec(
    sen,
  );
  if (m) {
    const n = COUNT_WORDS[(m[1] ?? '').toLowerCase()] ?? Number(m[1]);
    const add: SlotDecl = { side: 'any', kind: 'battlefield' };
    if (!(n >= 1) || !canAdd(st, [add])) return false;
    const slot = st.slots.length;
    st.slots.push(add);
    delete st.it;
    out.push({ op: 'PLAY_TOKEN', token: BOMB_TOKEN_ID, count: n, atSlot: slot });
    return true;
  }
  // "Move an enemy unit" / "Move a friendly unit and ready it": the unit and where it goes are both chosen.
  m = new RegExp(
    `^Move an? ${SIDE}unit(?: with (\\d+) \\[M\\] or less)?( that moved this turn)?( and ready it)?( to or from its base| to an occupied enemy battlefield| to an open battlefield| to a battlefield)?$`,
    'i',
  ).exec(sen);
  if (m) {
    const s = side(m[1]);
    const where3 = (m[5] ?? '').toLowerCase();
    const dest: 'TO_OR_FROM_BASE' | 'ENEMY_OCCUPIED' | 'OPEN' | 'BATTLEFIELD' | undefined =
      where3.includes('from its base')
        ? 'TO_OR_FROM_BASE'
        : where3.includes('occupied')
          ? 'ENEMY_OCCUPIED'
          : where3.includes('open')
            ? 'OPEN'
            : where3.includes('a battlefield')
              ? 'BATTLEFIELD'
              : undefined;
    const unit: SlotDecl = { side: s ?? 'any' };
    const where: SlotDecl = { side: 'any', kind: 'location' };
    if (!canAdd(st, [unit, where])) return false;
    const slot = st.slots.length;
    st.slots.push(unit, where);
    delete st.it;
    out.push({
      op: 'MOVE_TARGET',
      slot,
      destSlot: slot + 1,
      ...sideProp(s),
      ...(m[2] ? { maxMight: Number(m[2]) } : {}),
      ...(m[3] ? { movedThisTurn: true } : {}),
      ...(m[4] ? { ready: true } : {}),
      ...(dest ? { dest } : {}),
    });
    return true;
  }
  // "Move it to a battlefield" (the unit chosen or buffed by the sentence before).
  if (/^Move it to a battlefield$/i.test(sen) && st.it !== undefined) {
    const where: SlotDecl = { side: 'any', kind: 'location' };
    if (!canAdd(st, [where])) return false;
    const destSlot = st.slots.length;
    st.slots.push(where);
    out.push({ op: 'MOVE_TARGET', slot: st.it, destSlot, dest: 'BATTLEFIELD' });
    return true;
  }
  // "You may move a friendly unit to that enemy unit's battlefield" (Zenith Blade).
  m = /^You may move an? friendly unit to that (?:enemy )?unit['’]s battlefield$/i.exec(sen);
  if (m) {
    if (st.it === undefined) return false;
    const unit: SlotDecl = { side: 'friendly' };
    if (!canAdd(st, [unit])) return false;
    const slot = st.slots.length;
    const from = st.it;
    st.slots.push(unit);
    out.push({
      op: 'MOVE_TARGET',
      slot,
      destSlot: -1,
      destFromSlot: from,
      side: 'friendly',
      count: { min: 0, max: 1 },
    });
    return true;
  }
  // "Deal 3 to all enemy units at a battlefield": the battlefield is chosen.
  m = /^Deal (\d+) to all (friendly |enemy )?units at a battlefield$/i.exec(sen);
  if (m) {
    const add: SlotDecl = { side: 'any', kind: 'battlefield' };
    if (!canAdd(st, [add])) return false;
    const slot = st.slots.length;
    st.slots.push(add);
    out.push({
      op: 'DAMAGE_ALL',
      amount: Number(m[1]),
      side: side((m[2] ?? '').trim()) ?? 'any',
      scope: 'chosen',
      slot,
    });
    return true;
  }
  if (/^Choose two units$/i.test(sen)) {
    const adds: SlotDecl[] = [{ side: 'any' }, { side: 'any', another: true }];
    if (!canAdd(st, adds)) return false;
    st.slots.push(...adds);
    delete st.it;
    return true;
  }
  // "Choose a friendly gear": a gear is chosen only to read from it (Improvised Projectile).
  if (/^Choose a friendly gear$/i.test(sen)) {
    const gear: SlotDecl = { side: 'friendly', kind: 'gear' };
    if (!canAdd(st, [gear])) return false;
    st.slots.push(gear);
    st.it = st.slots.length - 1;
    return true;
  }
  // "Swap the Mights of two units at the same battlefield this turn" (Switcheroo).
  if (/^Swap the Mights of two units at the same battlefield this turn$/i.test(sen)) {
    const one: SlotDecl = { side: 'any', atBattlefield: true };
    const two: SlotDecl = { side: 'any', atBattlefield: true, another: true };
    if (!canAdd(st, [one, two])) return false;
    const slot = st.slots.length;
    st.slots.push(one, two);
    delete st.it;
    out.push({ op: 'SWAP_MIGHT', slots: [slot, slot + 1] });
    return true;
  }
  // "Stun a friendly unit and an enemy unit at the same battlefield" (Facebreaker).
  if (/^Stun a friendly unit and an enemy unit at the same battlefield$/i.test(sen)) {
    const mine: SlotDecl = { side: 'friendly', atBattlefield: true };
    const theirs: SlotDecl = { side: 'enemy', atBattlefield: true };
    if (!canAdd(st, [mine, theirs])) return false;
    const slot = st.slots.length;
    st.slots.push(mine, theirs);
    delete st.it;
    out.push(
      { op: 'STUN_TARGET', side: 'friendly', atBattlefield: true, slot },
      {
        op: 'STUN_TARGET',
        side: 'enemy',
        atBattlefield: true,
        slot: slot + 1,
        sameBattlefieldAsSlot: slot,
      },
    );
    return true;
  }
  // "Stun an enemy unit at its location": at the battlefield of the unit chosen just before (Heroic Charge).
  if (/^Stun an enemy unit at its location$/i.test(sen)) {
    const k = st.it;
    if (k === undefined || st.locked || (st.slots[k] as SlotDecl).kind !== undefined) return false;
    const theirs: SlotDecl = { side: 'enemy', atBattlefield: true };
    if (!canAdd(st, [theirs])) return false;
    const slot = st.slots.length;
    st.slots.push(theirs);
    delete st.it;
    out.push({
      op: 'STUN_TARGET',
      side: 'enemy',
      atBattlefield: true,
      slot,
      sameBattlefieldAsSlot: k,
    });
    return true;
  }
  // "This turn, increase its Might to the Might of another friendly unit": raise the chosen unit (Convergent Mutation).
  if (/^This turn, increase its Might to the Might of another friendly unit$/i.test(sen)) {
    const k = st.it;
    if (k === undefined || st.locked) return false;
    const target = st.slots[k] as SlotDecl;
    if (target.kind !== undefined || target.side !== 'friendly') return false;
    const other: SlotDecl = { side: 'friendly', another: true };
    if (!canAdd(st, [other])) return false;
    const slot = st.slots.length;
    st.slots.push(other);
    delete st.it;
    out.push({
      op: 'BUFF_TARGET',
      amount: 0,
      mightUpToSlot: slot,
      duration: 'TURN',
      side: 'friendly',
      slot: k,
    });
    return true;
  }
  // "Give +[M] equal to its Might to another friendly unit this turn": the unit just killed / chosen (Deathgrip).
  m =
    /^Give \+\[M\] equal to its Might to (another friendly unit|a friendly unit) this turn$/i.exec(
      sen,
    );
  if (m) {
    const prev = out[out.length - 1];
    const from = prev?.op === 'KILL_TARGET' ? (prev.slot ?? 0) : st.it;
    if (from === undefined || st.locked) return false;
    const other: SlotDecl = {
      side: 'friendly',
      ...(/another/i.test(m[1] ?? '') ? { another: true } : {}),
    };
    if (!canAdd(st, [other])) return false;
    const slot = st.slots.length;
    st.slots.push(other);
    delete st.it;
    out.push({
      op: 'BUFF_TARGET',
      amount: 0,
      mightOfSlot: from,
      duration: 'TURN',
      side: 'friendly',
      ...(other.another ? { another: true } : {}),
      slot,
    });
    return true;
  }
  // "Kill an enemy unit with less Might than it": the unit chosen just before is the yardstick (Public Execution).
  if (/^Kill an enemy unit with less Might than it$/i.test(sen)) {
    const k = st.it;
    if (k === undefined || st.locked || (st.slots[k] as SlotDecl).kind !== undefined) return false;
    const foe: SlotDecl = { side: 'enemy' };
    if (!canAdd(st, [foe])) return false;
    const slot = st.slots.length;
    st.slots.push(foe);
    delete st.it;
    out.push({
      op: 'KILL_TARGET',
      side: 'enemy',
      slot,
      lessMightThanSlot: k,
      lessMightSlotSide: (st.slots[k] as SlotDecl).side,
    });
    return true;
  }
  // "Deal damage equal to its [Shield] to <unit>": the unit chosen / given Shield just before (Ntofo Strikes).
  m = /^Deal damage equal to its \[Shield\] to (.+)$/i.exec(sen);
  if (m) {
    const k = st.it;
    if (k === undefined || st.locked || (st.slots[k] as SlotDecl).kind !== undefined) return false;
    const ch = parseChooser('Deal 1 to ' + (m[1] ?? ''));
    if (!ch || ch.effect.op !== 'DAMAGE_TARGET' || ch.multi) return false;
    if (!canAdd(st, [ch.decl])) return false;
    const slot = st.slots.length;
    st.slots.push(ch.decl);
    st.it = slot;
    out.push({
      ...ch.effect,
      slot,
      amount: 0,
      amountFrom: 'SLOT_SHIELD',
      amountSlot: k,
      amountSlotSide: (st.slots[k] as SlotDecl).side,
    });
    return true;
  }
  // "Deal damage equal to its Energy cost to <unit>": the gear chosen just before names the amount.
  m = /^Deal damage equal to its Energy cost to (.+)$/i.exec(sen);
  if (m) {
    const k = st.it;
    if (k === undefined || st.locked || (st.slots[k] as SlotDecl).kind !== 'gear') return false;
    const ch = parseChooser('Deal 1 to ' + (m[1] ?? ''));
    if (!ch || ch.effect.op !== 'DAMAGE_TARGET' || ch.multi) return false;
    if (!canAdd(st, [ch.decl])) return false;
    const slot = st.slots.length;
    st.slots.push(ch.decl);
    st.it = slot;
    out.push({
      ...ch.effect,
      slot,
      amount: 0,
      amountFrom: 'SLOT_ENERGY',
      amountSlot: k,
      amountSlotSide: 'friendly',
    });
    return true;
  }
  m = CHOOSE.exec(sen);
  if (m) {
    const first: SlotDecl = {
      side: side(m[1]) ?? 'any',
      ...(m[2] === ' at a battlefield' ? { atBattlefield: true } : {}),
      ...(m[2] === ' here' ? { here: true } : {}),
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
  // "We deal damage equal to our Mights to each other": me and the unit just chosen.
  if (/^We deal damage equal to our Mights to each other$/i.test(sen)) {
    const k = st.it;
    const d = k === undefined ? undefined : st.slots[k];
    if (k === undefined || !d || d.kind !== undefined || st.locked) return false;
    out.push({
      op: 'MUTUAL_DAMAGE_SELF',
      slot: k,
      side: d.side,
      ...(d.atBattlefield ? { atBattlefield: true } : {}),
    });
    return true;
  }
  if (/^They deal damage equal to their Mights to each other$/i.test(sen)) {
    if (st.slots.length !== 2 || st.locked) return false;
    const [a, b] = st.slots as [SlotDecl, SlotDecl];
    out.push({ op: 'MUTUAL_DAMAGE', slots: [0, 1], sides: [a.side, b.side] });
    st.locked = true;
    return true;
  }
  {
    const nd = /^the next spell you play this turn costs \[(\d+)\] less$/i.exec(sen);
    if (nd) {
      out.push({ op: 'NEXT_PLAY_DISCOUNT', amount: Number(nd[1]), spellsOnly: true });
      return true;
    }
    if (
      /^(?:Friendly units enter ready this turn|Units you play this turn enter ready)$/i.test(sen)
    ) {
      out.push({ op: 'ENTER_READY_THIS_TURN' });
      return true;
    }
    const bb = /^Buffs give an additional \+(\d+) \[M\] to friendly units this turn$/i.exec(sen);
    if (bb) {
      out.push({ op: 'BUFF_BONUS_TURN', amount: Number(bb[1]) });
      return true;
    }
    if (/^The next unit you play this turn enters ready$/i.test(sen)) {
      out.push({ op: 'ENTER_READY_NEXT' });
      return true;
    }
  }
  if (/^Opponents can['’]t play spells this turn$/i.test(sen)) {
    out.push({ op: 'LOCK_PLAYS', who: 'OPPONENTS', what: 'SPELLS' });
    return true;
  }
  if (/^Opponents can['’]t play cards this turn$/i.test(sen)) {
    out.push({ op: 'LOCK_PLAYS', who: 'OPPONENTS', what: 'CARDS' });
    return true;
  }
  if (/^Its controller can['’]t play spells this turn$/i.test(sen)) {
    const prev = out[out.length - 1];
    if (!prev || prev.op !== 'COUNTER_SPELL') return false;
    out.push({
      op: 'LOCK_PLAYS',
      who: 'TARGET_CONTROLLER',
      what: 'SPELLS',
      ...(prev.slot ? { slot: prev.slot } : {}),
    });
    return true;
  }
  m = /^Its owner channels (\d+) runes? exhausted$/i.exec(sen);
  if (m) {
    const prev = out[out.length - 1];
    if (!prev || prev.op !== 'RETURN_TARGET' || 'count' in prev) return false;
    out.push({
      op: 'TARGET_OWNER_CHANNEL',
      amount: Number(m[1]),
      ...(prev.slot ? { slot: prev.slot } : {}),
    });
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
  // R94: "It deals damage equal to its Might to <unit>" (the chosen unit hits another unit, one way).
  m = /^It deals damage equal to its Might to (.+)$/i.exec(sen);
  if (m) {
    if (st.it === undefined || st.locked || st.slots.length !== 1) return false;
    const ch = parseChooser('Deal 1 to ' + (m[1] ?? ''));
    if (!ch || ch.effect.op !== 'DAMAGE_TARGET' || ch.multi) return false;
    if (!canAdd(st, [ch.decl])) return false;
    const from = st.it;
    const slot = st.slots.length;
    st.slots.push(ch.decl);
    st.it = slot;
    out.push({
      ...ch.effect,
      slot,
      amount: 0,
      amountFrom: 'SLOT_MIGHT',
      amountSlot: from,
      amountSlotSide: (st.slots[from] as SlotDecl).side,
    });
    return true;
  }
  // "Then recycle it" after a spell played by an effect (Fizz, Kai'Sa).
  if (/^recycle it$/i.test(sen)) {
    const prev = out[out.length - 1];
    if (prev?.op === 'PLAY_FROM_TRASH' && prev.what === 'spell') {
      prev.thenRecycle = true;
      return true;
    }
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
 * R47: "As an additional cost to play this/me, <card-choice cost>." as a line of its own (a reminder in
 * parentheses may follow, e.g. Sacrifice's "[Mighty]" explanation). The cost is any R46 card-choice phrase;
 * "[Mighty]" before the noun restricts it to units with Might 5+. Returns the cost and the text without
 * that line, or null when the text has no such line or the phrase is not a card-choice cost.
 */
export function parseAdditionalCost(text: string): { cost: CostCardChoice; rest: string } | null {
  const re =
    /(?:^|\n)[ \t]*As an additional cost to play (?:this|me),\s*([^.\n]+)\.?(?:[ \t]*\([^)\n]*\))?[ \t]*(?=\n|$)/i;
  const m = re.exec(text);
  if (!m) return null;
  const phrase = (m[1] ?? '').trim();
  const mighty = /\[Mighty\]\s*/i.test(phrase);
  const cc = parseCostCard(phrase.replace(/\[Mighty\]\s*/i, ''));
  if (!cc) return null;
  if (mighty) cc.mighty = true;
  return {
    cost: cc,
    rest: (text.slice(0, m.index) + '\n' + text.slice(m.index + m[0].length)).trim(),
  };
}

const LEVEL_PREFIX = /^\[Level (\d+)\]\s*(?:\[>\]|[^\w[\s])\s*(.*)$/i;
const EMPOWERED_PREFIX = /^\[Empowered\]\s*(?:\[>\]|[^\w[\s])\s*(.*)$/i;
const STATIC_KW = 'Deflect|Ganking|Assault|Shield|Tank';
const STATIC_GRANT = String.raw`((?:\+\d+ \[M\](?:,? and )?)?(?:\[(?:${STATIC_KW})(?: \d+)?\](?:,? and |, )?)*)`;
const COUNT_PHRASES: [RegExp, StaticCount][] = [
  [/^other exhausted units? you control$/i, 'OTHER_EXHAUSTED_UNIT'],
  [/^other units? you control here with my name$/i, 'OTHER_SAME_NAME_HERE'],
  [/^token units? you control$/i, 'FRIENDLY_TOKEN_UNIT'],
  [/^of your units with \[Temporary\] at my battlefield$/i, 'FRIENDLY_TEMPORARY_HERE'],
  [/^(?:friendly gear|gear you control)$/i, 'FRIENDLY_GEAR'],
  [/^buffed friendly units? at my battlefield$/i, 'BUFFED_FRIENDLY_HERE'],
  [/^enemy units here$/i, 'ENEMY_UNITS_HERE'],
];

/** R67: "I have +N [M] for each <thing>", "My Might is increased by your points", "I have [Assault] equal to the number of <thing>". */
function parseCountedStatic(body: string): StaticAbility | null {
  if (/^My Might is increased by the number of cards in your trash$/i.test(body)) {
    return { affects: 'SELF', might: 1, per: 'TRASH_CARDS' };
  }
  if (/^My Might is increased by your points$/i.test(body)) {
    return { affects: 'SELF', might: 1, per: 'POINTS' };
  }
  const m = /^I (?:have|get) \+(\d+) \[M\] for each (.+)$/i.exec(body);
  if (m) {
    const c = COUNT_PHRASES.find(([re]) => re.test((m[2] ?? '').trim()));
    return c ? { affects: 'SELF', might: Number(m[1]), per: c[1] } : null;
  }
  const k = /^I have \[(Assault|Shield)\] equal to the number of (.+)$/i.exec(body);
  if (k) {
    const c = COUNT_PHRASES.find(([re]) => re.test((k[2] ?? '').trim()));
    const name = (k[1] ?? '').toLowerCase() === 'shield' ? 'Shield' : 'Assault';
    return c ? { affects: 'SELF', per: c[1], perKeyword: name } : null;
  }
  return null;
}

/** R104: "[While <condition>,] the Energy costs for spells you play are reduced by [N], to a minimum of [M]" and "Your Dragons' Energy costs are reduced by [N], to a minimum of [M]". */
function parsePlayCostMod(body: string): StaticAbility | null {
  const a =
    /^(?:While (.+?), )?the Energy costs? (?:for|of) spells you play (?:is|are) reduced by \[(\d+)\], to a minimum of \[(\d+)\]$/i.exec(
      body,
    );
  if (a) {
    const when = a[1] === undefined ? undefined : parseCondition(a[1]);
    if (a[1] !== undefined && !when) return null;
    return {
      affects: 'SELF',
      playCostMod: { energy: Number(a[2]), min: Number(a[3]), spellsOnly: true },
      ...(when ? { when } : {}),
    };
  }
  const b =
    /^Your ([A-Za-z]+)s['’] Energy costs are reduced by \[(\d+)\], to a minimum of \[(\d+)\]$/i.exec(
      body,
    );
  if (b) {
    return {
      affects: 'SELF',
      playCostMod: { energy: Number(b[2]), min: Number(b[3]), subtype: b[1] as string },
    };
  }
  return null;
}

/** R74: "I don't deal combat damage [unless ...]", "Enemy units here with less Might than me don't deal combat damage", "I can't be chosen by enemy spells and abilities [unless ...]", "I must be assigned combat damage last". */
function parseRestrictStatic(body: string): StaticAbility | null {
  if (/^I must be assigned combat damage last$/i.test(body)) {
    return { affects: 'SELF', keywords: [{ name: 'Backline' }] };
  }
  const re =
    /^(.+?) (don['’]t deal combat damage|can['’]t be chosen by enemy spells and abilities)(?: unless (.+))?$/i;
  const m = re.exec(body);
  if (!m) return null;
  const who = (m[1] ?? '').toLowerCase();
  const restrict = /combat damage/i.test(m[2] ?? '') ? 'NO_COMBAT_DAMAGE' : 'NO_ENEMY_CHOOSE';
  let aff: Pick<StaticAbility, 'affects' | 'lessMight'> | null = null;
  if (who === 'i') aff = { affects: 'SELF' };
  else if (who === 'enemy units here with less might than me') {
    aff = { affects: 'ENEMY_UNITS_HERE', lessMight: true };
  } else if (who === 'your units here with less might than me') {
    aff = { affects: 'FRIENDLY_UNITS_HERE', lessMight: true };
  }
  if (!aff) return null;
  if (restrict === 'NO_COMBAT_DAMAGE' && who.startsWith('your')) return null;
  let unless: Condition | undefined;
  if (m[3] !== undefined) {
    const c = parseCondition(m[3]);
    if (!c) return null;
    unless = c;
  }
  return { ...aff, restrict, ...(unless ? { unless } : {}) };
}

/**
 * X7: "If a friendly unit would die, kill this instead. Heal that unit, exhaust it, and recall it." (Zhonya's
 * Hourglass) and "If another unit you control here would die, if it has less Might than me, instead heal it,
 * exhaust it, and recall it." (Soraka).
 */
/** "[C][1][A]" tokens as an optional cost (Energy / Power of the source's Domain / any Power). */
function offerCost(tokens: string): OptionalCost {
  const cost: OptionalCost = {};
  for (const t of tokens.matchAll(/\[(\d+|C|A)\]/gi)) {
    const tok = (t[1] ?? '').toUpperCase();
    if (tok === 'C') cost.power = (cost.power ?? 0) + 1;
    else if (tok === 'A') cost.anyPower = (cost.anyPower ?? 0) + 1;
    else cost.energy = (cost.energy ?? 0) + Number(tok);
  }
  return cost;
}

function parseDeathReplaceStatic(body: string): StaticAbility | null {
  const altar =
    /^If a unit here would die during combat, its controller may pay ((?:\[(?:\d+|C|A)\])+) to heal it, exhaust it, and recall it instead$/i.exec(
      body,
    );
  if (altar) {
    return {
      affects: 'UNITS_HERE',
      replaceDeath: { offer: { cost: offerCost(altar[1] ?? ''), combatOnly: true } },
    };
  }
  const boss =
    /^If a buffed unit you control would die, you may pay ((?:\[(?:\d+|C|A)\])+), exhaust me, and spend its buff to heal it, exhaust it, and recall it instead$/i.exec(
      body,
    );
  if (boss) {
    return {
      affects: 'FRIENDLY_UNITS',
      replaceDeath: {
        offer: {
          cost: offerCost(boss[1] ?? ''),
          exhaustSource: true,
          spendBuff: true,
          buffedOnly: true,
        },
      },
    };
  }
  if (
    /^Once each turn, if I would die, you may kill a friendly unit to heal me, exhaust me, and recall me instead$/i.test(
      body,
    )
  ) {
    return {
      affects: 'SELF',
      replaceDeath: {
        offer: {
          cost: { card: { kind: 'KILL', what: 'unit', another: true } },
          oncePerTurn: true,
        },
      },
    };
  }
  const pd =
    /^While (.+?), prevent all damage that enemy spells and abilities would deal to me$/i.exec(
      body,
    );
  if (pd) {
    const when = parseCondition(pd[1] ?? '');
    return when ? { affects: 'SELF', restrict: 'NO_ENEMY_EFFECT_DAMAGE', when } : null;
  }
  const lc = /^Stunned enemy units here have -(\d+) \[M\], to a minimum of (\d+) \[M\]$/i.exec(
    body,
  );
  if (lc) {
    return {
      affects: 'ENEMY_UNITS_HERE',
      onlyStunned: true,
      might: -Number(lc[1]),
      minMight: Number(lc[2]),
    };
  }
  if (/^Units can['’]t be played here$/i.test(body))
    return { affects: 'SELF', restrict: 'NO_PLAY_HERE' };
  if (/^I can['’]t be played on your first, second, or third turns$/i.test(body)) {
    return { affects: 'SELF', restrict: 'NO_PLAY_EARLY' };
  }
  if (/^Players can['’]t score here until their third turn$/i.test(body)) {
    return { affects: 'SELF', restrict: 'NO_EARLY_SCORE' };
  }
  const vb = /^Increase the points needed to win the game by (\d+)$/i.exec(body);
  if (vb) return { affects: 'SELF', victoryBonus: Number(vb[1]) };
  const fw = /^While a unit here is defending alone, it has -(\d+) \[M\]$/i.exec(body);
  if (fw) return { affects: 'UNITS_HERE', onlyDefendingAlone: true, might: -Number(fw[1]) };
  const wj = /^While a friendly unit defends alone, it gets \+(\d+) \[M\]$/i.exec(body);
  if (wj) return { affects: 'FRIENDLY_UNITS', onlyDefendingAlone: true, might: Number(wj[1]) };
  const bd =
    /^(Your spells and abilities|Spells and abilities) deal (\d+) Bonus Damage(?: to units here)?$/i.exec(
      body,
    );
  if (bd) {
    return {
      affects: 'SELF',
      bonusDamage: {
        amount: Number(bd[2]),
        scope: /^your/i.test(bd[1] ?? '') ? 'YOURS' : 'HERE',
      },
    };
  }
  if (/^Your \[Deathknell\] effects trigger an additional time$/i.test(body)) {
    return { affects: 'SELF', doubleDeathknell: true };
  }
  const nd = /^If (.+?), I don['’]t take damage$/i.exec(body);
  if (nd) {
    const when = parseCondition(nd[1] ?? '');
    return when ? { affects: 'SELF', restrict: 'NO_DAMAGE', when } : null;
  }
  if (
    /^If a friendly unit would die, kill this instead\. Heal that unit, exhaust it, and recall it$/i.test(
      body,
    )
  ) {
    return { affects: 'FRIENDLY_UNITS', replaceDeath: { killSource: true } };
  }
  if (
    /^If another unit you control here would die, if it has less Might than me, instead heal it, exhaust it, and recall it$/i.test(
      body,
    )
  ) {
    return { affects: 'OTHER_FRIENDLY_HERE', lessMight: true, replaceDeath: {} };
  }
  return null;
}

const STATIC_RESTRICT = [
  [/^(I) can['’]t move to base$/i, 'SELF'],
  [/^(Units) can['’]t move to base$/i, 'ALL_UNITS'],
  [/^(Units) can['’]t move from here to base$/i, 'UNITS_HERE'],
] as const;
const STATIC_AFF =
  '(I|Other buffed friendly units at my battlefield|Your gear|Your token units|Friendly units here|Friendly buffed units|Other friendly units|Friendly units|Your units|Your [A-Za-z]+s|Other friendly units here|Your other units here|Units here with [\\[A-Za-z]+\\]|Champion units here|Units here)';

function staticAffects(
  raw: string,
): Pick<
  StaticAbility,
  'affects' | 'subtype' | 'onlyKeyword' | 'onlySubtype' | 'onlyToken' | 'onlyBuffed'
> | null {
  const w = raw.toLowerCase();
  // R70: filtered "here" statics.
  if (w === 'champion units here') return { affects: 'UNITS_HERE', onlySubtype: 'Champion' };
  const wk = /^units here with \[([a-z]+)\]$/.exec(w);
  if (wk) {
    const name = (wk[1] ?? '').replace(/^./, (c) => c.toUpperCase());
    return { affects: 'UNITS_HERE', onlyKeyword: name };
  }
  if (w === 'i') return { affects: 'SELF' };
  if (w === 'your gear') return { affects: 'FRIENDLY_GEAR' };
  if (w === 'your token units') return { affects: 'FRIENDLY_UNITS', onlyToken: true };
  if (w === 'friendly units here') return { affects: 'FRIENDLY_UNITS_HERE' };
  if (w === 'other buffed friendly units at my battlefield')
    return { affects: 'OTHER_FRIENDLY_HERE', onlyBuffed: true };
  if (w === 'friendly buffed units') return { affects: 'FRIENDLY_UNITS', onlyBuffed: true };
  if (w === 'other friendly units') return { affects: 'OTHER_FRIENDLY_UNITS' };
  if (w === 'friendly units' || w === 'your units') return { affects: 'FRIENDLY_UNITS' };
  if (w === 'other friendly units here' || w === 'your other units here')
    return { affects: 'OTHER_FRIENDLY_HERE' };
  if (w === 'units here') return { affects: 'UNITS_HERE' };
  const m = /^your ([a-z]+)s$/.exec(w);
  if (m && m[1] !== 'unit' && m[1] !== 'gear') {
    return {
      affects: 'FRIENDLY_SUBTYPE',
      subtype: (m[1] ?? '').replace(/^./, (c) => c.toUpperCase()),
    };
  }
  return null;
}

function staticGrant(raw: string): Pick<StaticAbility, 'might' | 'keywords'> | null {
  const mm = /\+(\d+) \[M\]/.exec(raw);
  const keywords: KeywordInstance[] = [];
  for (const m of raw.matchAll(/\[(Deflect|Ganking|Assault|Shield|Tank)(?: (\d+))?\]/gi)) {
    const n = (m[1] ?? '').toLowerCase();
    const name = (n.charAt(0).toUpperCase() + n.slice(1)) as KeywordInstance['name'];
    keywords.push(m[2] ? { name, value: Number(m[2]) } : { name });
  }
  if (!mm && keywords.length === 0) return null;
  return { ...(mm ? { might: Number(mm[1]) } : {}), ...(keywords.length > 0 ? { keywords } : {}) };
}

/**
 * R51: lines that are static abilities: "<Your gear | Friendly units | Your Mechs | Other friendly units
 * here | Units here | I> have [Keyword]... / +N [M]", optionally "While <condition>, ..." or
 * "... while <condition>". Returns them and the text without those lines (null when there are none).
 */
export function parseStaticLines(text: string): { statics: StaticAbility[]; rest: string } | null {
  const statics: StaticAbility[] = [];
  const keep: string[] = [];
  // "[Level N][>] I have +1 [M] and enter ready" = the Might static, plus a gated "enter ready" line (Scorchclaw).
  const lines = text.split('\n').flatMap((l) => {
    const both =
      /^(\s*\[(?:Level \d+|Empowered)\]\s*\[>\]\s*)I have ([^.\n(]+?) and enter ready\.?/i.exec(l);
    return both ? [`${both[1]}I have ${both[2]}.`, `${both[1]}I enter ready.`] : [l];
  });
  for (const line of lines) {
    const plain = line
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*\.$/, '');
    // R52: "[Empowered][>] ..." is a static that applies only while the source is Empowered.
    const em = EMPOWERED_PREFIX.exec(plain);
    // R53: "[Level N][>] I have ..." applies while the controller has N or more XP.
    const lv = em ? null : LEVEL_PREFIX.exec(plain);
    const body0 = em ? (em[1] ?? '') : lv ? (lv[2] ?? '') : plain;
    // R86: "Other friendly units have +1 [M] here" = "Other friendly units here have +1 [M]"; "an additional +1" = "+1".
    const body = body0
      .replace(/^(Other friendly units) (have .+?) here$/i, '$1 here $2')
      .replace(/\ban additional (\+\d+ \[M\])/i, '$1')
      .replace(/^(Friendly buffed units have .+?) if they didn['’]t already$/i, '$1');
    // X7: standing "would die ... instead" replacements.
    const rd = parseDeathReplaceStatic(body);
    if (rd) {
      statics.push(rd);
      continue;
    }
    // X7: the replacement may be followed by another sentence on the same line (The Boss: "When you conquer, ready me.").
    const dot = body.search(/\.\s+(?=[A-Z])/);
    if (dot > 0) {
      const lead = parseDeathReplaceStatic(body.slice(0, dot));
      if (lead) {
        statics.push(lead);
        keep.push(body.slice(dot + 1).trim());
        continue;
      }
    }
    const cnt = parseCountedStatic(body);
    if (cnt) {
      statics.push(cnt);
      continue;
    }
    const gateWhen: Condition | undefined = em
      ? { kind: 'EMPOWERED' }
      : lv
        ? { kind: 'XP', n: Number(lv[1]) }
        : undefined;
    const rs = STATIC_RESTRICT.find(([re]) => re.test(body));
    if (rs) {
      statics.push({
        affects: rs[1],
        restrict: 'NO_MOVE_TO_BASE',
        ...(gateWhen ? { when: gateWhen } : {}),
      });
      continue;
    }
    // R104: cost-modifier statics.
    const pcm = parsePlayCostMod(body);
    if (pcm) {
      statics.push({ ...pcm, ...(gateWhen ? { when: gateWhen } : {}) });
      continue;
    }
    if (/^Units you play to battlefields you control enter ready$/i.test(body)) {
      statics.push({
        affects: 'FRIENDLY_UNITS',
        entersReady: true,
        onlyAtControlled: true,
        ...(gateWhen ? { when: gateWhen } : {}),
      });
      continue;
    }
    // R88: "Your tokens enter ready" / "Other friendly units enter ready".
    const er = /^(Your tokens|Your units|Other friendly units) enter ready$/i.exec(body);
    if (er) {
      statics.push(
        /^your/i.test(er[1] ?? '')
          ? {
              affects: 'FRIENDLY_UNITS',
              ...(/tokens/i.test(er[1] ?? '') ? { onlyToken: true } : {}),
              entersReady: true,
              ...(gateWhen ? { when: gateWhen } : {}),
            }
          : {
              affects: 'OTHER_FRIENDLY_UNITS',
              entersReady: true,
              ...(gateWhen ? { when: gateWhen } : {}),
            },
      );
      continue;
    }
    // "[While <condition>,] players only channel 1 rune at the start of their Channel Phase" (Sandstone Chimera).
    const oc =
      /^(?:While (.+?), )?Players only channel 1 rune at the start of their Channel Phase$/i.exec(
        body,
      );
    if (oc) {
      const w = oc[1] === undefined ? undefined : parseCondition(oc[1]);
      if (oc[1] !== undefined && !w) {
        keep.push(line);
        continue;
      }
      statics.push({ affects: 'SELF', restrict: 'ONE_CHANNEL', ...(w ? { when: w } : {}) });
      continue;
    }
    // "[While <condition>,] opponents can't gain points" (Tianna Crownguard).
    const np = /^(?:While (.+?), )?Opponents can['’]t gain points$/i.exec(body);
    if (np) {
      const w = np[1] === undefined ? undefined : parseCondition(np[1]);
      if (np[1] !== undefined && !w) {
        keep.push(line);
        continue;
      }
      statics.push({ affects: 'SELF', restrict: 'NO_ENEMY_POINTS', ...(w ? { when: w } : {}) });
      continue;
    }
    // R74: combat-damage and targeting restrictions, "... unless <condition>", and "must be assigned last".
    const rx = parseRestrictStatic(body);
    if (rx) {
      statics.push({ ...rx, ...(gateWhen ? { when: gateWhen } : {}) });
      continue;
    }
    const f1 = new RegExp(`^${STATIC_AFF} (?:have|has) ${STATIC_GRANT}$`, 'i').exec(body);
    const f2 = new RegExp(
      `^(?:While|If) (.+?), ${STATIC_AFF} (?:have|has) ${STATIC_GRANT}$`,
      'i',
    ).exec(body);
    const f3 = new RegExp(`^I have ${STATIC_GRANT} while (.+)$`, 'i').exec(body);
    let aff: string | undefined;
    let grant: string | undefined;
    let cond: string | undefined;
    if (f1) [, aff, grant] = f1;
    else if (f2) [, cond, aff, grant] = f2;
    else if (f3) {
      [, grant, cond] = f3;
      aff = 'I';
    }
    if (aff === undefined || grant === undefined) {
      keep.push(line);
      continue;
    }
    const a = staticAffects(aff);
    const g = staticGrant(grant);
    const when = cond === undefined ? undefined : parseCondition(cond);
    if (!a || !g || (cond !== undefined && !when) || ((em || lv) && cond !== undefined)) {
      keep.push(line);
      continue;
    }
    statics.push({
      ...a,
      ...g,
      ...(em
        ? { when: { kind: 'EMPOWERED' as const } }
        : lv
          ? { when: { kind: 'XP' as const, n: Number(lv[1]) } }
          : when
            ? { when }
            : {}),
    });
  }
  return statics.length > 0 ? { statics, rest: keep.join('\n').trim() } : null;
}

/** R76: "You may play me to an open battlefield." / "... an occupied enemy battlefield." lines of a Unit. */
export function parsePlayTo(text: string): { playTo: ('OPEN' | 'ENEMY')[]; rest: string } | null {
  const re =
    /(?:^|\n)[ \t]*You may play me to an? (open|occupied enemy) battlefield\.?(?:[ \t]*(?:\([^)\n]*\)))?[ \t]*(?=\n|$)/i;
  const playTo: ('OPEN' | 'ENEMY')[] = [];
  let rest = text;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    const kind = (m[1] ?? '').toLowerCase() === 'open' ? 'OPEN' : 'ENEMY';
    if (!playTo.includes(kind)) playTo.push(kind);
    rest = (rest.slice(0, m.index) + '\n' + rest.slice(m.index + m[0].length)).trim();
  }
  return playTo.length > 0 ? { playTo, rest } : null;
}

/**
 * R58 / R63: an optional additional cost to play a card, as a line of its own:
 *  - "You may pay [N][C] as an additional cost to play me."            (Energy / Power)
 *  - "You may spend N XP as an additional cost to play me."            (XP)
 *  - "You may discard 1 / kill a friendly unit ... as an additional cost to play me." (a card choice)
 *  - "As an additional cost to play this, you may discard 1."
 * each optionally followed by "If you do, I cost [N] less." on the same line. Returns the cost and the
 * text without that line.
 */
export function parseOptionalAdditionalCost(text: string): {
  cost: NonNullable<CardDef['optionalAdditionalCost']>;
  rest: string;
} | null {
  const re =
    /(?:^|\n)[ \t]*(?:You may ([^.\n]+?) as an additional cost to play (?:me|this)|As an additional cost to play (?:me|this), you may ([^.\n]+?)|As you play (?:me|this), you may ([^.\n]+?) as an additional cost)\.?(?:[ \t]*If you do, (?:I cost \[(\d+)\] less|reduce my cost by \[(\d+)\]|(ignore this spell['’]s cost))\.?)?(?:[ \t]*\([^)\n]*\))?[ \t]*(?=\n|$|If you do,)/i;
  const m = re.exec(text);
  if (!m) return null;
  const phrase = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  const cost: NonNullable<CardDef['optionalAdditionalCost']> = { energy: 0 };
  const pay = /^pay ((?:\[(?:\d+|C|A)\])+)$/i.exec(phrase);
  const xp = /^spend (\d+) XP$/i.exec(phrase);
  if (pay) {
    let power = 0;
    let anyPower = 0;
    for (const t of (pay[1] ?? '').matchAll(/\[(\d+|C|A)\]/gi)) {
      const tok = (t[1] ?? '').toUpperCase();
      if (tok === 'C') power++;
      else if (tok === 'A') anyPower++;
      else cost.energy += Number(tok);
    }
    if (power) cost.power = power;
    if (anyPower) cost.anyPower = anyPower;
  } else if (xp) {
    cost.xp = Number(xp[1]);
  } else {
    const cc = parseCostCard(phrase);
    if (!cc) return null;
    cost.card = cc;
  }
  if (m[4] !== undefined) cost.reduceEnergy = Number(m[4]);
  if (m[5] !== undefined) cost.reduceEnergy = Number(m[5]);
  if (m[6] !== undefined) cost.reduceAll = true;
  return {
    cost,
    rest: (text.slice(0, m.index) + '\n' + text.slice(m.index + m[0].length)).trim(),
  };
}

/**
 * R59: a modal spell: a line "Choose one —" followed by lines "- <effects>". Each mode is parsed like a
 * spell; null unless there are at least two modes, every mode parses, and nothing else but keyword
 * lines (Action / Reaction) is left. The mode is chosen when the card is played.
 */
export function parseModalSpell(text: string): CardEffect[][] | null {
  const lines = text
    .replace(/\([^)]*\)/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines.findIndex((l) => /^Choose one\s*[—–-]\s*$/i.test(l));
  if (head < 0) return null;
  const modes: CardEffect[][] = [];
  for (const l of lines.slice(head + 1)) {
    const m = /^[-•–—]\s*(.+)$/.exec(l);
    if (!m) return null;
    const eff = parseSpellText(m[1] as string);
    if (!eff || eff.length === 0) return null;
    modes.push(eff);
  }
  const before = lines.slice(0, head).join('\n');
  // R84: a Repeat cost line may precede the modes (the cost itself is stored separately).
  const keywordsOnly = before.replace(/^\[Repeat\]\s*(?:\[[0-9CA]+\]\s*)+$/gim, '').trim();
  if (keywordsOnly && !/^(?:\[(?:Action|Reaction|Hidden)\]\s*)+$/i.test(keywordsOnly)) return null;
  return modes.length >= 2 ? modes : null;
}

/**
 * R61: "[Flow] [4][C]" as a line of its own (the reminder text may follow): the Flow cost of a spell.
 * Returns the cost ([N] Energy, [C] Power of the card's Domain, [A] any Power) and the text without it.
 */
export function parseFlowCost(text: string): {
  cost: { energy: number; power?: number; anyPower?: number };
  rest: string;
} | null {
  const re =
    /(?:^|\n)[ \t]*\[Flow\][ \t]*((?:\[(?:\d+|C|A)\])+)[ \t]*(?:\([^)\n]*\))?[ \t]*(?=\n|$)/i;
  const m = re.exec(text);
  if (!m) return null;
  let energy = 0;
  let power = 0;
  let anyPower = 0;
  for (const t of (m[1] ?? '').matchAll(/\[(\d+|C|A)\]/gi)) {
    const tok = (t[1] ?? '').toUpperCase();
    if (tok === 'C') power++;
    else if (tok === 'A') anyPower++;
    else energy += Number(tok);
  }
  return {
    cost: { energy, ...(power ? { power } : {}), ...(anyPower ? { anyPower } : {}) },
    rest: (text.slice(0, m.index) + '\n' + text.slice(m.index + m[0].length)).trim(),
  };
}

const COST_PER: [RegExp, CostCount][] = [
  [/^exhausted units? you control$/i, 'EXHAUSTED_UNIT'],
  [/^gear you control$/i, 'GEAR'],
  [/^cards? in your trash$/i, 'TRASH'],
  [/^cards? with my name in your trash$/i, 'TRASH_SAME_NAME'],
  [/^of your \[Mighty\] units$/i, 'MIGHTY_UNIT'],
  [/^cards? you['’]ve played this turn$/i, 'CARDS_PLAYED'],
  [/^runes? you control$/i, 'RUNE'],
  [/^battlefield you['’]ve conquered this turn$/i, 'CONQUERED_THIS_TURN'],
];

/**
 * R50: "I cost [N] less for each <thing>[, to a minimum of [M]]." or "This costs [N] less if <condition>."
 * as its own line of a card; returns the reduction and the text without that line. Null for other shapes
 * (other zones, "to play from anywhere other than your hand", Power, several lines).
 */
export function parseSelfCostReduction(
  text0: string,
): { reduction: CostReduction; rest: string } | null {
  // "I cost [N] less to play from anywhere other than your hand" = the reversed condition form.
  const text = text0.replace(
    /\bI cost \[(\d+)\] less to play from anywhere other than your hand\b/i,
    'If I am not in your hand, I cost [$1] less',
  );
  // "Reduce my cost by [1] for each of the following tags among your units — Bird, Cat, Dog, and Poro." (Daisy!)
  const pet =
    /(?:^|\n)[ \t]*Reduce my cost by \[(\d+)\] for each of the following tags among your units [—–-] Bird, Cat, Dog, and Poro\.?[ \t]*(?=\n|$)/i.exec(
      text,
    );
  if (pet) {
    return {
      reduction: { energy: Number(pet[1]), per: 'PET_TAGS' },
      rest: (text.slice(0, pet.index) + '\n' + text.slice(pet.index + pet[0].length)).trim(),
    };
  }
  // R91: "This spell's Energy cost is reduced by the highest Might among units you control."
  const hm =
    /(?:^|\n)[ \t]*This spell['’]s Energy cost is reduced by the highest Might among units you control\.?[ \t]*(?=\n|$)/i.exec(
      text,
    );
  if (hm) {
    return {
      reduction: { energy: 1, per: 'HIGHEST_MIGHT' },
      rest: (text.slice(0, hm.index) + '\n' + text.slice(hm.index + hm[0].length)).trim(),
    };
  }
  // R73: "If <condition>, I cost [N] less and enter ready." = the discount plus "I enter ready if <condition>".
  const both =
    /(?:^|\n)[ \t]*If ([^.\n]+?), I cost \[(\d+)\] less and enter ready\.?[ \t]*(?=\n|$)/i.exec(
      text,
    );
  if (both) {
    const when = parseCondition(both[1] ?? '');
    if (!when) return null;
    return {
      reduction: { energy: Number(both[2]), when },
      rest: (
        text.slice(0, both.index) +
        '\nI enter ready if ' +
        (both[1] ?? '') +
        '\n' +
        text.slice(both.index + both[0].length)
      ).trim(),
    };
  }
  // R56: the reversed form "If <condition>, this costs [N] less."
  const rev =
    /(?:^|\n)[ \t]*If ([^.\n]+?), (?:this costs|I cost) \[(\d+)\] less\.?(?:[ \t]*\([^)\n]*\))?[ \t]*(?=\n|$)/i.exec(
      text,
    );
  if (rev) {
    const when = parseCondition(rev[1] ?? '');
    if (!when) return null;
    return {
      reduction: { energy: Number(rev[2]), when },
      rest: (text.slice(0, rev.index) + '\n' + text.slice(rev.index + rev[0].length)).trim(),
    };
  }
  const re =
    /(?:^|\n)[ \t]*(?:I cost|This costs) \[(\d+)\] less (?:for each ([^.\n,]+?)(?:, to a minimum of \[(\d+)\])?|if ([^.\n]+?))\.?(?:[ \t]*\([^)\n]*\))?[ \t]*(?=\n|$)/i;
  const m = re.exec(text);
  if (!m) return null;
  const reduction: CostReduction = { energy: Number(m[1]) };
  if (m[2] !== undefined) {
    const per = COST_PER.find(([r]) => r.test((m[2] ?? '').trim()));
    if (!per) return null;
    reduction.per = per[1];
    if (m[3] !== undefined) reduction.min = Number(m[3]);
  } else {
    const when = parseCondition(m[4] ?? '');
    if (!when) return null;
    reduction.when = when;
  }
  return {
    reduction,
    rest: (text.slice(0, m.index) + '\n' + text.slice(m.index + m[0].length)).trim(),
  };
}

/**
 * "[Repeat] [2]" / "[Repeat] [1][C]" / "[Repeat] [C]" (820, R42): the printed Repeat cost of a spell.
 * Null for other cost shapes ("Discard 1", several costs, [A]) so the card stays partial.
 */
export function parseRepeatCost(
  text: string,
): { energy: number; power: number; card?: CostCardChoice } | null {
  // R47: "[Repeat] — Discard 1" (a card-choice Repeat cost, nothing else).
  const cm = /(?:^|\n)\s*\[Repeat\]\s*[—–-]\s*([^(\n]+?)\s*(?=\(|\n|$)/i.exec(text);
  if (cm) {
    const cc = parseCostCard((cm[1] ?? '').replace(/\.$/, ''));
    return cc ? { energy: 0, power: 0, card: cc } : null;
  }
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
    .replace(/\b(is|it's|it’s) \[Empowered\]/gi, '$1 empowered')
    .replace(/\[Level (\d+)\]\s*(?:\[>\]|[—–-])\s*/gi, 'LEVEL$1 ')
    .replace(/(?:^|\n)\s*\[Repeat\]\s*(?:\[[0-9C]+\]\s*)+/gi, '\n')
    .replace(/(?:^|\n)\s*\[Repeat\]\s*[—–-][^(\n]*/gi, '\n')
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
/**
 * R81: "[If <condition>,] give it +N [M] this turn instead" / "[If ...,] deal N to it instead" attaches an
 * alternative amount to the previous targeted Might / damage effect. Conditions: the chosen unit is Empowered /
 * attacking / already buffed, or a controller / source condition (Level N, a facedown card, "this is Empowered").
 */
function attachInstead(sen: string, out: CardEffect[]): boolean {
  const m =
    /^(?:If (.+?), )?(?:LEVEL(\d+) )?(?:give (?:it|that unit) \+(\d+) \[M\] this turn|deal (\d+) to it) instead$/i.exec(
      sen,
    );
  if (!m) return false;
  const last = out[out.length - 1];
  const isGive = m[3] !== undefined;
  if (!last || last.op !== (isGive ? 'BUFF_TARGET' : 'DAMAGE_TARGET') || last.alt) return false;
  const alt: AltAmount = { amount: Number(m[3] ?? m[4]) };
  if (m[1] !== undefined) {
    const c = m[1].trim().replace(/^it['’]s /i, 'it is ');
    if (/^it is (?:already )?empowered$/i.test(c)) alt.target = 'EMPOWERED';
    else if (/^it is attacking$/i.test(c)) alt.target = 'ATTACKING';
    else if (/^it is already buffed$/i.test(c)) alt.target = 'BUFFED';
    else if (/^this is empowered$/i.test(c)) alt.when = { kind: 'EMPOWERED' };
    else {
      const w = parseCondition(m[1]);
      if (!w) return false;
      alt.when = w;
    }
  } else if (m[2] !== undefined) {
    alt.when = { kind: 'XP', n: Number(m[2]) };
  } else {
    return false;
  }
  if (isGive && last.op === 'BUFF_TARGET' && last.buff) alt.temp = true;
  last.alt = alt;
  return true;
}

const DOMAIN_OPS: ReadonlySet<string> = new Set([
  'KILL_TARGET',
  'DAMAGE_TARGET',
  'DEBUFF_TARGET',
  'BUFF_TARGET',
  'RETURN_TARGET',
  'STUN_TARGET',
  'READY_TARGET',
  'MOVE_BASE_TARGET',
  'GRANT_KEYWORD_TARGET',
]);

function parseEffectSentences(sens: readonly string[]): CardEffect[] | null {
  const st: ParseState = { slots: [], locked: false };
  const out: CardEffect[] = [];
  const filters: { dom?: Domain; exhausted?: boolean }[] = [];
  const list = sens
    .flatMap((x) =>
      /^Banish an? [a-z ]*unit, then its owner plays it/i.test(x) ||
      /^Each player discards their hand, then draws \d+$/i.test(x)
        ? [x]
        : x.split(/, then /i),
    )
    .flatMap((x) => {
      // R65: "Ready a unit and give it [Assault 3] this turn" = two sentences about the same unit.
      const m = /^(Ready an? (?:friendly |enemy )?unit) and (give it .+)$/i.exec(x);
      if (m) return [m[1] as string, m[2] as string];
      // "Give a friendly unit +1 [M] this turn and [Stun] an enemy unit at its location" (Heroic Charge).
      const gs = /^(Give .+? this turn) and \[?Stun\]? (an enemy unit) at its location$/i.exec(x);
      if (gs) return [gs[1] as string, `Stun ${gs[2]} at its location`];
      // "[Buff] a friendly unit and [Stun] an enemy unit": two keyword actions, each choosing its own unit.
      const kw =
        /^(\[?(?:Buff|Stun|Ready)\]? an? [a-z ]+?) and (\[?(?:Buff|Stun|Ready)\]? an? [a-z ]+)$/i.exec(
          x,
        );
      if (kw) return [kw[1] as string, kw[2] as string];
      // R82: "Return a friendly unit and an enemy unit to their owners' hands" = two separate choices.
      const two =
        /^Return (another |a )friendly unit and an enemy unit to their owners['’] hands$/i.exec(x);
      if (two) {
        return [
          `Return ${(two[1] ?? 'a ').trim()} friendly unit to its owner's hand`,
          "Return an enemy unit to its owner's hand",
        ];
      }
      return [x];
    })
    .filter((x) => !/^Choose (?:an opponent|a player)$/i.test(x)) // R97: the only opponent in a duel
    // "Move up to one enemy unit from here to its base" = "You may move an enemy unit here to its base".
    .map((x) =>
      x.replace(
        /^Move up to one ((?:friendly |enemy )?unit) from here to (its|their) base$/i,
        'You may move an $1 here to $2 base',
      ),
    )
    // R98: "Choose a friendly unit without [Temporary]": granting it again changes nothing.
    .map((x) => x.replace(/ without \[Temporary\]/i, ''))
    // "one of your other units here" (Yuumi) = "another friendly unit here".
    .map((x) => x.replace(/\bone of your other units here\b/i, 'another friendly unit here'))
    .map((x) =>
      x
        .replace(/^Then,? /i, '')
        // R93: "if I am at a battlefield" is implied by a "here / there" effect (it does nothing elsewhere).
        .replace(/^if I am at a battlefield, /i, '')
        .trim(),
    )
    // "an enemy Calm unit" / "an exhausted friendly unit": the word becomes a filter on the effect that targets it
    // (`filters`, by sentence).
    .map((x) => {
      const dm = /\b(Fury|Calm|Mind|Body|Chaos|Order)\s+(units?)\b/.exec(x);
      const ex = /\b(an?|another) exhausted\s+((?:friendly |enemy )?units?)\b/.exec(x);
      filters.push({
        ...(dm ? { dom: dm[1] as Domain } : {}),
        ...(ex ? { exhausted: true } : {}),
      });
      let y = x;
      if (dm) y = y.replace(dm[0], dm[2] as string);
      if (ex) y = y.replace(ex[0], `${ex[1]} ${ex[2]}`);
      return y.replace(/\s+/g, ' ');
    });
  let lastGate: Condition | null = null;
  let pend: { from: number; dom?: Domain; exhausted?: boolean } | null = null;
  const flushDomain = (): void => {
    if (!pend || out.length <= pend.from) return;
    for (let k = pend.from; k < out.length; k++) {
      const ef = out[k] as CardEffect;
      if (!DOMAIN_OPS.has(ef.op)) continue;
      if (pend.dom) (ef as { domain?: Domain }).domain = pend.dom;
      if (pend.exhausted) (ef as { exhausted?: boolean }).exhausted = true;
    }
    pend = null;
  };
  for (let i = 0; i < list.length; i++) {
    flushDomain();
    const flt = filters[i];
    if (flt && (flt.dom || flt.exhausted) && !pend) {
      pend = {
        from: out.length,
        ...(flt.dom ? { dom: flt.dom } : {}),
        ...(flt.exhausted ? { exhausted: true } : {}),
      };
    }
    // "Stun a unit. If it's already stunned, return it to its owner's hand instead" (Existential Dread).
    if (
      /^If it['’]s already stunned, return it to its owner['’]s hand instead$/i.test(
        list[i] as string,
      )
    ) {
      const last = out[out.length - 1];
      if (last?.op !== 'STUN_TARGET' || last.orReturn) return null;
      last.orReturn = true;
      continue;
    }
    // "[Level N][>] <effect>": the effect works only while its controller has N or more XP.
    const lvl = /^LEVEL(\d+) (.+)$/.exec(list[i] as string);
    if (lvl && !/ instead$/i.test(list[i] as string)) {
      const before = out.length;
      if (!parseSpellSentence(lvl[2] as string, st, out)) return null;
      for (let k = before; k < out.length; k++) {
        (out[k] as CardEffect).when = { kind: 'XP', n: Number(lvl[1]) };
      }
      continue;
    }
    // "Counter a spell if an opponent has played another spell this turn" (Crumbling Sands).
    const cs = /^(Counter a spell) if an opponent has played another spell this turn$/i.exec(
      list[i] as string,
    );
    if (cs) {
      const before = out.length;
      if (!parseSpellSentence(cs[1] as string, st, out) || out.length !== before + 1) return null;
      const ce = out[before] as CardEffect;
      if (ce.op !== 'COUNTER_SPELL') return null;
      ce.when = { kind: 'OPP_OTHER_SPELL', slot: ce.slot ?? 0 };
      continue;
    }
    // "Kill it if it has 3 [M] or less": the effect before the "if" carries the Might condition.
    const sfx = /^(.+) if it has (\d+) \[M\] or less$/i.exec(list[i] as string);
    if (sfx && st.it !== undefined) {
      const before = out.length;
      if (!parseSpellSentence(sfx[1] as string, st, out) || out.length !== before + 1) return null;
      (out[before] as CardEffect).when = {
        kind: 'TARGET_MIGHT',
        slot: st.it,
        max: Number(sfx[2]),
      };
      continue;
    }
    // "... If <condition>, <effect>": the effect carries its own condition (checked as it resolves).
    const cw = /^If (.+?), (.+)$/i.exec(list[i] as string);
    if (cw && !/^you do$/i.test(cw[1] as string) && !/ instead$/i.test(list[i] as string)) {
      const parsedCond =
        /^it is stunned$/i.test(cw[1] as string) && st.it !== undefined
          ? ({ kind: 'TARGET_STUNNED', slot: st.it } as const)
          : /^it(?: is|['’]s) empowered$/i.test(cw[1] as string) && st.it !== undefined
            ? ({ kind: 'TARGET_EMPOWERED', slot: st.it } as const)
            : /^it has \d+ \[M\] or less$/i.test(cw[1] as string) && st.it !== undefined
              ? ({
                  kind: 'TARGET_MIGHT',
                  slot: st.it,
                  max: Number(/\d+/.exec(cw[1] as string)?.[0]),
                } as const)
              : parseCondition(cw[1] as string);
      const cond =
        parsedCond?.kind === 'PAID_ADDITIONAL'
          ? { ...parsedCond, spell: true as const }
          : parsedCond;
      if (cond) {
        const before = out.length;
        if (!parseSpellSentence(cw[2] as string, st, out)) return null;
        for (let k = before; k < out.length; k++) (out[k] as CardEffect).when = cond;
        if (cond.kind === 'TARGET_STUNNED' || cond.kind === 'TARGET_MIGHT') lastGate = cond;
        continue;
      }
    }
    // "... If this kills it, <effect>": the effect runs only when the previous damage left its target dead.
    const ifKill = /^If this kills (?:it|them), (?:do this: )?(.+)$/i.exec(list[i] as string);
    if (ifKill && out.length > 0 && out[out.length - 1]?.op === 'DAMAGE_TARGET') {
      const before = out.length;
      if (!parseSpellSentence(ifKill[1] as string, st, out)) return null;
      for (let k = before; k < out.length; k++) (out[k] as CardEffect).ifKilled = true;
      continue;
    }
    // "... If you do, <effect>": the effect runs only when the previous effect actually did something.
    const ifDo = /^If you do, (.+)$/i.exec(list[i] as string);
    if (ifDo) {
      const before = out.length;
      // As the first sentence it refers to the optional additional cost ("you may exhaust a unit. If you do, draw 2").
      const paid: Condition = { kind: 'PAID_ADDITIONAL', spell: true };
      if (!parseSpellSentence(ifDo[1] as string, st, out)) return null;
      for (let k = before; k < out.length; k++) {
        if (before === 0) (out[k] as CardEffect).when = paid;
        else (out[k] as CardEffect).ifDid = true;
      }
      lastGate = before === 0 ? paid : null;
      continue;
    }
    // "Otherwise, <effect>": the opposite of the condition the sentence before was gated on.
    const otherwise = /^Otherwise, (.+)$/i.exec(list[i] as string);
    if (otherwise && lastGate) {
      const before = out.length;
      if (!parseSpellSentence(otherwise[1] as string, st, out)) return null;
      for (let k = before; k < out.length; k++) {
        (out[k] as CardEffect).when = { kind: 'NOT', cond: lastGate };
      }
      lastGate = null;
      continue;
    }
    if (attachInstead(list[i] as string, out)) continue;
    // "If <condition>, <effect> instead": replaces the effect just before it (both carry the condition or its negation).
    const ins = /^If (.+?), (.+) instead$/i.exec(list[i] as string);
    const insCond = ins ? parseCondition(ins[1] as string) : null;
    const insPrev = out[out.length - 1];
    if (ins && insCond && insPrev && !insPrev.when) {
      const tmp: CardEffect[] = [];
      const slotsBefore = st.slots.length;
      if (parseSpellSentence(ins[2] as string, st, tmp) && tmp.length === 1) {
        const rep = tmp[0] as CardEffect;
        if (rep.op === insPrev.op) {
          insPrev.when = { kind: 'NOT', cond: insCond };
          rep.when = insCond;
          out.push(rep);
          continue;
        }
      }
      st.slots.length = slotsBefore;
    }
    const look = parseLookSequence(list, i);
    if (look) {
      out.push(look.effect);
      i += look.used - 1;
      continue;
    }
    const revealPlay = parseRevealPlaySequence(list, i);
    if (revealPlay) {
      out.push(revealPlay.effect);
      i += revealPlay.used - 1;
      continue;
    }
    const handPick = parseHandPickSequence(list, i);
    if (handPick) {
      out.push(handPick.effect);
      i += handPick.used - 1;
      continue;
    }
    const reveal = parseRevealSequence(list, i);
    if (reveal) {
      out.push(reveal.effect);
      i += reveal.used - 1;
      continue;
    }
    if (!parseSpellSentence(list[i] as string, st, out)) return null;
  }
  flushDomain();
  // Every chosen unit must be used by an effect (a bare "Choose a unit." does nothing).
  if (targetRequirements(out).length !== st.slots.length) return null;
  return out;
}

/** "unit token with [Temporary]": the keyword belongs to the token, so keep it as plain text. */
const TOKEN_WITH = /(tokens?) with \[(\w+)\]/gi;

const KEYWORD_TOKENS =
  /\[(Tank|Backline|Assault(?: \d+)?|Shield(?: \d+)?|Ganking|Accelerate|Temporary|Hidden|Deflect(?: \d+)?|Action|Reaction|Ambush|Unique)\]/gi;

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
  // R55: Vision = "When you play me, look at the top card of your Main Deck. You may recycle it."
  if (/(?:^|\n)\s*\[Vision\]/i.test(text)) {
    out.push({ on: 'PLAY', effects: [{ op: 'PREDICT', count: 1 }] });
  }
  // R53: Hunt N = "When I conquer or hold, gain N XP".
  let hunt = 0;
  for (const m of text.matchAll(/(?:^|\n)\s*\[Hunt(?: (\d+))?\]/gi)) hunt += Number(m[1] ?? 1);
  if (hunt > 0) {
    for (const on of ['CONQUER', 'HOLD'] as const) {
      out.push({ on, effects: [{ op: 'GAIN_XP', amount: hunt }] });
    }
  }
  if (/(?:^|\n)\s*\[Weaponmaster\]/i.test(text)) {
    out.push({
      on: 'PLAY',
      effects: [{ op: 'WEAPONMASTER_EQUIP', count: { min: 0, max: 1 } }],
    });
  }
  return out;
}

/** "[Add] [N]" (Energy), "[Add] [C]" (Power of the source's Domain), "[Add] [A]" (Universal Power); several tokens add up. */
function parseAddClause(sen: string): CardEffect[] | null {
  const m = /^\[Add\] ?((?:\[(?:\d+|A|C)\])+)$/i.exec(sen);
  if (!m) return null;
  let energy = 0;
  let any = 0;
  let own = 0;
  for (const t of (m[1] ?? '').matchAll(/\[(\d+|A|C)\]/gi)) {
    const tok = (t[1] ?? '').toUpperCase();
    if (tok === 'A') any++;
    else if (tok === 'C') own++;
    else energy += Number(tok);
  }
  const out: CardEffect[] = [];
  if (energy > 0) out.push({ op: 'ADD_ENERGY', amount: energy });
  if (any > 0) out.push({ op: 'ADD_POWER', amount: any, domain: 'ANY' });
  if (own > 0) out.push({ op: 'ADD_POWER', amount: own, domain: 'SOURCE' });
  return out.length > 0 ? out : null;
}

/**
 * R46: the card-choice cost phrases, matched at the start of a string: "discard 1" / "discard a gear",
 * "kill a friendly unit [or gear] [here]", "kill another unit you control", "kill 3 other friendly units and/or
 * gear", "exhaust a friendly unit", "return a unit you control here to its owner's hand", "recycle a unit from
 * your trash". Kill / exhaust / return need "friendly" or "you control" (an enemy choice is an effect, not a
 * cost). Returns the choice and how many characters it used.
 */
const CC_N = '(a|an|one|two|three|four|five|\\d+)';
const CC_BOARD = '(units? or gear|units? and/or gear|units?|gear)';
const CC_RE: { kind: CostCardChoice['kind']; re: RegExp }[] = [
  { kind: 'SPEND_BUFF', re: /spend (a|an|one|two|three|\d+) buffs?(?![\w[])/iy },
  {
    kind: 'DISCARD',
    re: new RegExp(`discard ${CC_N}(?: (gear|unit|spell))?(?: cards?)?(?![\\w\\[])`, 'iy'),
  },
  {
    kind: 'KILL',
    re: new RegExp(
      `kill (another|${CC_N}( other)?) (friendly )?${CC_BOARD}( you control)?( here)?`,
      'iy',
    ),
  },
  {
    kind: 'EXHAUST',
    re: new RegExp(
      `exhaust (another|${CC_N}( other)?) (friendly )?(units?)( you control)?( here)?`,
      'iy',
    ),
  },
  {
    kind: 'RETURN',
    re: new RegExp(
      `return (another|${CC_N}( other)?) (friendly )?${CC_BOARD}( you control)?( here)? to its owner['’]s hand`,
      'iy',
    ),
  },
  {
    kind: 'RECYCLE',
    re: new RegExp(`recycle ${CC_N}(?: (unit|gear|spell|card))?(?: cards?)? from your trash`, 'iy'),
  },
];

function parseCostCardAt(s: string): { cc: CostCardChoice; len: number } | null {
  for (const { kind, re } of CC_RE) {
    re.lastIndex = 0;
    const m = re.exec(s);
    if (!m) continue;
    if (kind === 'SPEND_BUFF') {
      const w = (m[1] ?? '').toLowerCase();
      const n = numberOf(w === 'a' || w === 'an' ? 'one' : w);
      if (n === null || n < 1) return null;
      return { cc: { kind, ...(n > 1 ? { count: n } : {}) }, len: m[0].length };
    }
    if (kind === 'DISCARD' || kind === 'RECYCLE') {
      const word = (m[1] ?? '').toLowerCase();
      const count = numberOf(word === 'a' || word === 'an' ? 'one' : word);
      if (count === null || count < 1) return null;
      const what = (m[2] ?? '').toLowerCase();
      const cc: CostCardChoice = { kind };
      if (count > 1) cc.count = count;
      if (what === 'unit' || what === 'gear' || what === 'spell') cc.what = what;
      return { cc, len: m[0].length };
    }
    // Board kinds: m = [all, "another" | "N other?", N, other?, friendly?, noun, "you control"?, "here"?]
    const another = (m[1] ?? '').toLowerCase() === 'another';
    const word = (m[2] ?? '').toLowerCase();
    const count = another ? 1 : numberOf(word === 'a' || word === 'an' ? 'one' : word);
    if (count === null || count < 1) return null;
    if (m[4] === undefined && m[6] === undefined) return null; // not "friendly" / "you control"
    const noun = (m[5] ?? '').toLowerCase();
    const cc: CostCardChoice = { kind };
    if (count > 1) cc.count = count;
    if (kind !== 'EXHAUST') {
      cc.what = noun === 'gear' ? 'gear' : /^units?$/.test(noun) ? 'unit' : 'unitOrGear';
    }
    if (another || m[3] !== undefined) cc.another = true;
    if (m[7] !== undefined) cc.here = true;
    return { cc, len: m[0].length };
  }
  return null;
}

/** A whole string that is exactly one card-choice cost phrase. */
function parseCostCard(part: string): CostCardChoice | null {
  const t = part.trim();
  const r = parseCostCardAt(t);
  return r && r.len === t.length ? r.cc : null;
}

/** "[E]", "[N]" / "[C]" / "[A]" (Energy / Power), "Kill this", a card-choice cost, joined by commas. */
function parseAbilityCost(text: string, gearLike: boolean): AbilityCost | null {
  const cost: AbilityCost = {};
  for (const part of text.split(/\s*,\s*/)) {
    const res = /^((?:\[(?:\d+|C|A)\])+)$/i.exec(part);
    const xp = /^Spend (\d+) XP$/i.exec(part);
    if (xp) cost.xp = (cost.xp ?? 0) + Number(xp[1]);
    else if (/^\[E\]$/i.test(part)) cost.exhaust = true;
    else if (res) {
      for (const t of (res[1] ?? '').matchAll(/\[(\d+|C|A)\]/gi)) {
        const tok = (t[1] ?? '').toUpperCase();
        if (tok === 'C') cost.power = (cost.power ?? 0) + 1;
        else if (tok === 'A') cost.anyPower = (cost.anyPower ?? 0) + 1;
        else cost.energy = (cost.energy ?? 0) + Number(tok);
      }
    } else if (/^Kill this$/i.test(part) && gearLike) cost.killSelf = true;
    else if (/^Disempower (?:this|me)$/i.test(part)) cost.disempower = true;
    else {
      const cc = parseCostCard(part);
      if (!cc || cost.card) return null; // one card-choice component per cost
      cost.card = cc;
    }
  }
  return cost.exhaust ||
    cost.energy ||
    cost.power ||
    cost.anyPower ||
    cost.killSelf ||
    cost.card ||
    cost.disempower ||
    cost.xp
    ? cost
    : null;
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
  if (/^you showed off$/i.test(text)) return { kind: 'SHOWED_OFF' };
  if (/^you played this from your hand$/i.test(text)) return { kind: 'PLAYED_FROM', from: 'HAND' };
  if (/^you played this from face down$/i.test(text)) {
    return { kind: 'PLAYED_FROM', from: 'FACEDOWN' };
  }
  if (/^it['’]s your turn$/i.test(text)) return { kind: 'YOUR_TURN' };
  if (/^it['’]s not your turn$/i.test(text)) return { kind: 'YOUR_TURN', not: true };
  if (/^I['’]m buffed$/i.test(text)) return { kind: 'BUFFED' };
  if (/^I['’]m \[Mighty\]$/i.test(text)) return { kind: 'MIGHTY' };
  if (/^I am not in your hand$/i.test(text)) return { kind: 'NOT_IN_HAND' };
  if (/^I have moved twice this turn$/i.test(text)) return { kind: 'MOVES_AT_LEAST', n: 2 };
  if (/^an opponent controls a battlefield$/i.test(text)) {
    return { kind: 'CONTROLS_BATTLEFIELD', who: 'enemy' };
  }
  const sn = /^(your|an opponent['’]s) score is (not )?within 3 points of the Victory Score$/i.exec(
    text,
  );
  if (sn) {
    return {
      kind: 'SCORE_NEAR',
      who: /^your/i.test(sn[1] ?? '') ? 'friendly' : 'enemy',
      ...(sn[2] ? { not: true } : {}),
    };
  }
  if (/^you paid the additional cost$/i.test(text)) return { kind: 'PAID_ADDITIONAL' };
  if (/^I died alone$/i.test(text)) return { kind: 'DIED_ALONE' };
  if (/^I was \[?Mighty\]?$/i.test(text)) return { kind: 'DIED_MIGHTY' };
  if (/^you['’]ve played a unit or gear to a battlefield this turn$/i.test(text)) {
    return { kind: 'PLAYED_TO_BATTLEFIELD' };
  }
  if (/^you control something that['’]s \[?Empowered\]?$/i.test(text)) {
    return { kind: 'CONTROLS_EMPOWERED' };
  }
  if (/^an opponent controls a stunned unit$/i.test(text)) return { kind: 'ENEMY_STUNNED' };
  if (/^I['’]m in combat$/i.test(text)) return { kind: 'IN_COMBAT' };
  if (/^you control this battlefield$/i.test(text)) return { kind: 'CONTROLS_HERE' };
  {
    const om = /^your other units have total Might (\d+) or more$/i.exec(text);
    if (om) return { kind: 'OTHER_UNITS_MIGHT', n: Number(om[1]) };
  }
  if (/^I['’]m attacking or defending alone$/i.test(text)) {
    return { kind: 'COMBAT_ROLE', role: 'EITHER', alone: true };
  }
  {
    const pt = /^your units have all (\d+) tags$/i.exec(text);
    if (pt) return { kind: 'PET_TAGS', n: Number(pt[1]) };
  }
  if (/^you['’]ve discarded a card this turn$/i.test(text)) {
    return { kind: 'TURN_FLAG', flag: 'discarded' };
  }
  if (/^you['’]ve gained XP this turn$/i.test(text)) return { kind: 'TURN_FLAG', flag: 'xpGained' };
  {
    const sp = /^you['’]ve spent \[(\d+)\] or more to play a spell this turn$/i.exec(text);
    if (sp) return { kind: 'TURN_SPENT', what: 'spellEnergy', n: Number(sp[1]) };
    const pw = /^you['’]ve spent at least ((?:\[A\])+) this turn$/i.exec(text);
    if (pw) return { kind: 'TURN_SPENT', what: 'power', n: (pw[1]?.match(/A/g) ?? []).length };
  }
  if (/^I['’]m attacking with another unit$/i.test(text)) {
    return { kind: 'COMBAT_ROLE', role: 'ATTACKING', withOther: true };
  }
  {
    const ex = /^you assigned (\d+) or more excess damage(?: to enemy units)?$/i.exec(text);
    if (ex) return { kind: 'EXCESS_DAMAGE', n: Number(ex[1]) };
  }
  {
    const g = /^there['’]s an? (friendly )?(gear|unit) here$/i.exec(text);
    if (g) {
      return {
        kind: 'COUNT',
        what: (g[2] ?? '').toLowerCase() === 'gear' ? 'gear' : 'unit',
        where: 'here',
        who: 'friendly',
        cmp: 'GTE',
        n: 1,
      };
    }
    // "there are 2 or more other friendly units and/or gear at my battlefield" (Steadfast Outrider).
    const og =
      /^there are (\d+) or more other friendly units and\/or gear (?:here|at my battlefield)$/i.exec(
        text,
      );
    if (og) {
      return {
        kind: 'COUNT',
        what: 'unitOrGear',
        where: 'here',
        who: 'friendly',
        other: true,
        cmp: 'GTE',
        n: Number(og[1]),
      };
    }
    // "you have a [Mighty] unit here" (Sunken Temple: "... with one or more [Mighty] units").
    if (/^you have a \[Mighty\] unit here$/i.test(text)) {
      return {
        kind: 'COUNT',
        what: 'unit',
        where: 'here',
        who: 'friendly',
        mighty: true,
        cmp: 'GTE',
        n: 1,
      };
    }
    // "there's a friendly gear with [Deploy] at my battlefield" (Overloaded Traveler, Jarvan IV).
    if (/^there['’]s an? friendly gear with \[Deploy\] (?:here|at my battlefield)$/i.test(text)) {
      return {
        kind: 'COUNT',
        what: 'gear',
        where: 'here',
        who: 'friendly',
        withDeploy: true,
        cmp: 'GTE',
        n: 1,
      };
    }
    const a = /^I['’]m at a battlefield with exactly one other unit you control$/i.test(text);
    if (a) {
      return {
        kind: 'COUNT',
        what: 'unit',
        where: 'here',
        who: 'friendly',
        other: true,
        cmp: 'EQ',
        n: 1,
      };
    }
  }
  if (/^you have a card with my name in your trash$/i.test(text)) return { kind: 'NAME_IN_TRASH' };
  {
    const rv = /^you control (fewer|more) runes than an opponent$/i.exec(text);
    if (rv)
      return {
        kind: 'RUNES_VS_OPPONENT',
        cmp: (rv[1] ?? '').toLowerCase() === 'fewer' ? 'FEWER' : 'MORE',
      };
    const fd = /^you control a facedown card(?: (here)| at a battlefield)?$/i.exec(text);
    if (fd) return { kind: 'FACEDOWN', ...(fd[1] ? { here: true } : {}) };
  }
  if (/^I (?:didn['’]t|did not) die alone$/i.test(text)) return { kind: 'DIED_ALONE', not: true };
  const m0 = /^(?:an? )?(friendly|enemy)? ?unit( or gear)? (?:has )?died this turn$/i.exec(text);
  if (m0) {
    const who = (m0[1] ?? '').toLowerCase();
    return {
      kind: 'DIED_THIS_TURN',
      who: who === 'friendly' ? 'friendly' : who === 'enemy' ? 'enemy' : 'any',
      ...(m0[2] ? { orGear: true as const } : {}),
    };
  }
  if (
    /^(?:there['’]?s? (?:is )?)?an enemy unit (?:is )?alone (?:here|there|at that battlefield)$/i.test(
      text,
    )
  ) {
    return { kind: 'COUNT', what: 'unit', where: 'here', who: 'enemy', cmp: 'EQ', n: 1 };
  }
  // "you have 4+ units at that battlefield" (Might of Demacia): the battlefield that was scored.
  const sc = /^you (?:have|control) (\d+)(?:\+| or more) units? at that battlefield$/i.exec(text);
  if (sc) {
    return {
      kind: 'COUNT',
      what: 'unit',
      where: 'scored',
      who: 'friendly',
      cmp: 'GTE',
      n: Number(sc[1]),
    };
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
  if (/^there is an? (ready )?enemy unit here$/i.test(text)) {
    return {
      kind: 'COUNT',
      what: 'unit',
      where: 'here',
      who: 'enemy',
      ...(/ready/i.test(text) ? { ready: true } : {}),
      cmp: 'GTE',
      n: 1,
    };
  }
  if (/^you (?:have|control) another unit here$/i.test(text)) {
    return {
      kind: 'COUNT',
      what: 'unit',
      where: 'here',
      who: 'friendly',
      other: true,
      cmp: 'GTE',
      n: 1,
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

/**
 * R77: a mandatory discard at the start of a trigger body: "Discard 1", "Discard 2, then draw 2". Returns the
 * cost (a hand-card choice that cannot be declined) and the remaining sentences.
 */
function splitMandatoryDiscard(
  sens: readonly string[],
): { optional: OptionalCost; rest: string[] } | null {
  const first = sens[0];
  const m =
    first === undefined
      ? null
      : /^discard (\d+|one|two|three|a card)(?:, then (.+))?$/i.exec(first);
  if (!m) return null;
  const w = (m[1] ?? '').toLowerCase();
  const n = w === 'a card' ? 1 : (NUMBER_WORDS[w] ?? Number(w));
  if (!(n >= 1)) return null;
  const rest = [m[2], ...sens.slice(1)].filter((x): x is string => !!x);
  return {
    optional: {
      card: n > 1 ? { kind: 'DISCARD', count: n } : { kind: 'DISCARD' },
      mandatory: true,
    },
    rest,
  };
}

/**
 * R45: the body of an optional triggered ability: "You may pay [1][C] to <effects>", "You may [Burn 1]
 * to <effects>", or a free "You may <effects>". Returns the cost and the remaining sentences (the
 * first one without the "you may ... to" prefix), or null when the first sentence is not that shape.
 */
function splitOptional(sens: readonly string[]): { optional: OptionalCost; rest: string[] } | null {
  // "Recycle me to <effect>" (Ekko) is an optional cost without the words "you may".
  const first0 = sens[0];
  const first =
    first0 !== undefined && /^recycle (?:me|this) to /i.test(first0) ? 'You may ' + first0 : first0;
  const may = first === undefined ? null : /^you may (.+)$/i.exec(first);
  if (!may) return null;
  const body = may[1] as string;
  const rest = (s: string): string[] => [s, ...sens.slice(1)];
  // R45 / R46: the cost is a list of parts joined by " and " and ended by " to " (or, after an " and ", by
  // the effect itself: "discard 1 and channel 1 rune exhausted"). Parts: pay [..], [Burn N], a card choice.
  const optional: OptionalCost = {};
  let s = body;
  let parts = 0;
  for (;;) {
    let used = 0;
    const pay = /^pay ((?:\[(?:\d+|C|A)\]\s*)+)/i.exec(s);
    const burn = /^\[Burn (\d+)\]/i.exec(s);
    const spendXp = /^spend (\d+) XP(?= to | and |$)/i.exec(s);
    const exSelf = /^exhaust (?:me|this)(?= to | and |$)/i.exec(s);
    const killMe = /^kill (?:me|this)(?= to | and |$)/i.exec(s);
    const recycleMe = /^recycle (?:me|this)(?= to | and |$)/i.exec(s);
    if (recycleMe) {
      optional.recycleSelf = true;
      used = recycleMe[0].length;
    } else if (killMe) {
      optional.killSelf = true;
      used = killMe[0].length;
    } else if (spendXp) {
      optional.xp = (optional.xp ?? 0) + Number(spendXp[1]);
      used = spendXp[0].length;
    } else if (exSelf) {
      optional.exhaustSelf = true;
      used = exSelf[0].length;
    } else if (pay) {
      for (const t of (pay[1] ?? '').matchAll(/\[(\d+|C|A)\]/gi)) {
        const tok = (t[1] ?? '').toUpperCase();
        if (tok === 'C') optional.power = (optional.power ?? 0) + 1;
        else if (tok === 'A') optional.anyPower = (optional.anyPower ?? 0) + 1;
        else optional.energy = (optional.energy ?? 0) + Number(tok);
      }
      used = pay[0].trimEnd().length;
    } else if (burn) {
      optional.burn = (optional.burn ?? 0) + Number(burn[1]);
      used = burn[0].length;
    } else {
      const cc = parseCostCardAt(s);
      if (cc) {
        if (optional.card) return null; // one card-choice component per cost
        optional.card = cc.cc;
        used = cc.len;
      }
    }
    if (used === 0) {
      // No (more) cost part. After an " and " the rest is the effect; with no part at all it is a free
      // "you may <effects>"; a stray "pay" is not understood.
      if (parts === 0) {
        if (/^pay\b/i.test(s)) return null;
        return { optional: {}, rest: rest(s) };
      }
      return { optional, rest: rest(s) };
    }
    parts++;
    s = s.slice(used);
    if (/^ to /i.test(s)) return { optional, rest: rest(s.slice(4)) };
    if (/^ and /i.test(s)) {
      s = s.slice(5);
      continue;
    }
    // A cost phrase with nothing after it is not a cost (the effect sentences were tried first).
    return null;
  }
}

const OR_WHEN: Record<string, TriggerKind> = {
  hold: 'HOLD',
  conquer: 'CONQUER',
  attack: 'ATTACK',
  defend: 'DEFEND',
};

/** R49: "When you play [another] a spell / unit / gear / card [that costs [N] or more] [on an opponent's turn]". */
const PLAY_HEAD =
  /^When you play (?:(another) )?(?:an? )?(\[Mighty\] )?(card from face down|card|spell|unit|gear|token unit)(?: (?:that costs|with Energy cost) \[(\d+)\] or more| with Power cost ((?:\[A\])+) or more)?( on an opponent's turn| during a showdown)?\s*,\s*(.+)$/i;
/** R99: "When you play your second card in a turn, ..." */
const PLAY_NTH_HEAD = /^When you play your (second|third) card in a turn\s*,\s*(.+)$/i;

/** "When you play [me or] [another] a Dragon, ...": a played unit of a given subtype (a capitalised word). */
const PLAY_SUBTYPE_HEAD = /^When you play (me or )?(another |an? )([A-Z][a-z]+)\s*,\s*(.+)$/;
const NOT_A_SUBTYPE = new Set(['Card', 'Spell', 'Unit', 'Gear', 'Token', 'Mighty']);

function parsePlayHead(
  sen: string,
): { filter: PlayFilter; body: string; alsoSelf?: boolean } | null {
  const nth = PLAY_NTH_HEAD.exec(sen);
  if (nth) {
    return {
      filter: { nth: (nth[1] ?? '').toLowerCase() === 'second' ? 2 : 3 },
      body: nth[2] ?? '',
    };
  }
  const st = PLAY_SUBTYPE_HEAD.exec(sen);
  if (st && !NOT_A_SUBTYPE.has(st[3] ?? '')) {
    const other = /another/i.test(st[2] ?? '');
    if (st[1] && !other) return null; // "me or a Dragon" is not a printed form
    return {
      filter: { subtype: st[3] ?? '', ...(other ? { other: true } : {}) },
      body: st[4] ?? '',
      ...(st[1] ? { alsoSelf: true } : {}),
    };
  }
  const m = PLAY_HEAD.exec(sen);
  if (!m) return null;
  const filter: PlayFilter = {};
  const kind = (m[3] ?? '').toLowerCase();
  if (kind === 'token unit') filter.token = true;
  else if (kind === 'card from face down') filter.fromFacedown = true;
  else if (kind !== 'card') filter.type = kind.toUpperCase() as 'SPELL' | 'UNIT' | 'GEAR';
  if (m[1]) filter.other = true;
  if (m[2]) filter.mighty = true;
  if (m[4]) filter.minEnergy = Number(m[4]);
  if (m[5]) filter.minPower = (m[5].match(/A/g) ?? []).length;
  const when = (m[6] ?? '').trim();
  if (when.startsWith('on an')) filter.onOpponentTurn = true;
  if (when.startsWith('during')) filter.inShowdown = true;
  return { filter, body: m[7] ?? '' };
}

/** R71: "When [another] a friendly / an enemy unit [here] dies [while I'm at a battlefield]" and "When one or more friendly units die". */
const DEATH_HEAD =
  /^When (?:(?:another|an?) )?(?:non-([A-Za-z]+) )?(?:(friendly|enemy) unit|unit you control)( here)? dies( while I['’]m at a battlefield)?\s*,\s*(.*)$/i;
const DEATH_BATCH_HEAD = /^When one or more (friendly|enemy) units die\s*,\s*(.*)$/i;

const TRIGGER_HEAD =
  /^(When you conquer or hold|When you or an ally hold|When you conquer|When you hold|When a friendly unit attacks or defends alone|When an enemy unit attacks a battlefield you control|When this is played, discarded, or killed|When this leaves the board|When (?:a unit you control|one of your units) becomes \[?Mighty\]?|When you buff me|When you buff a friendly unit|When you choose a friendly unit|When you choose me with a spell|When you choose or ready me|When you stun (?:an enemy unit|one or more enemy units)|When you discard me|When you discard one or more cards|When a unit moves from here|When you ready a friendly unit|When I move from a battlefield|When you use an activated ability of a gear|When you hide a card|When you play me from face down|When you play me or when I score|When an opponent scores|When you play me or when I become exhausted|When I become (?:exhausted|ready|empowered)|When you play me or at (?:the )?start of your Beginning Phase|At (?:the )?start of your Beginning Phase|At the end of your turn|When I win a combat|When a combat that I was in ends|When you play me or when I (hold|conquer|attack|defend)|When you play me to a battlefield|When you play me|When I hold|When I conquer|When I attack or defend one on one|When I attack or defend|When I attack|When I defend|When I move to a battlefield|When I move|When I die in combat|Deathknell:)\s*,?\s*(.*)$/i;

/**
 * Parse the abilities of a unit, gear or token: triggered abilities ("When you play me / hold /
 * conquer", Deathknell), their Legion-conditioned forms ("[Legion] - When you play me, ..."),
 * activated abilities ("[E]: [Reaction] - [Add] [C]", "[Reaction][>] Kill this, [E]: [Add] [A]"),
 * "I enter ready" and "[Legion] - I cost [N] less". Returns null unless the whole text is made of
 * implemented keywords plus these forms (all-or-nothing) and there is at least one of them.
 * `gearLike`: the card may use "Kill this" as a cost (gear and gear-like tokens).
 */
/** X-modes: a "..., choose one —" head followed by bullet lines, found in a card's raw text. */
interface ModalBlock {
  modes: string[];
  /** "choose one that hasn't been chosen this turn" / "you've not chosen this turn". */
  once: boolean;
  /** "choose one to give me this turn": each bullet is a keyword list, "Give me <bullet> this turn". */
  giveMe: boolean;
}

/**
 * Replace each "<trigger head>, choose one —" plus its bullet lines by "<trigger head>, MODAL<k>" so the
 * trigger parser sees one ordinary sentence; the bullets come back through `ModalBlock`.
 */
function extractModal(text: string): { text: string; blocks: ModalBlock[] } {
  const lines = text.split('\n');
  const out: string[] = [];
  const blocks: ModalBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // "..., draw 1 or channel 1 rune exhausted." (Qiyana) is a "choose one" written on one line.
    const inline = /^((?:When|At) .+?),\s*draw (\d+) or channel (\d+) runes? exhausted\.?$/i.exec(
      line.trim(),
    );
    if (inline) {
      out.push(`${inline[1]}, MODAL${blocks.length}.`);
      blocks.push({
        modes: [`Draw ${inline[2]}.`, `Channel ${inline[3]} rune exhausted.`],
        once: false,
        giveMe: false,
      });
      continue;
    }
    // "..., you may draw 1 or buff me." (Buhru Captain): two simple clauses joined by "or" are the same choice.
    const simple = String.raw`(draw \d+|buff me|ready me|gain \d+ XP|channel \d+ runes?(?: exhausted)?)`;
    const inline2 = new RegExp(
      String.raw`^((?:When|At) .+?),\s*(?:you may )?${simple} or ${simple}\.?$`,
      'i',
    ).exec(line.trim().replace(/\s*\([^)]*\)\s*$/, ''));
    if (inline2) {
      const cap = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
      out.push(`${inline2[1]}, MODAL${blocks.length}.`);
      blocks.push({
        modes: [cap(inline2[2] as string), cap(inline2[3] as string)],
        once: false,
        giveMe: false,
      });
      continue;
    }
    const m =
      /^((?:When|At) .+?),\s*choose one( that hasn['’]t been chosen this turn| to give me this turn)?\s*[—–-]\s*$/i.exec(
        line.trim(),
      );
    if (m) {
      const modes: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^[-*•–]\s+/.test((lines[j] ?? '').trim())) {
        modes.push((lines[j] ?? '').trim().replace(/^[-*•–]\s+/, ''));
        j++;
      }
      if (modes.length >= 2) {
        const tail = (m[2] ?? '').toLowerCase();
        out.push(`${m[1]}, MODAL${blocks.length}.`);
        blocks.push({ modes, once: tail.includes('hasn'), giveMe: tail.includes('give me') });
        i = j - 1;
        continue;
      }
    }
    out.push(line);
  }
  return { text: out.join('\n'), blocks };
}

/** The effect lists of a modal block (and the cost of each "pay ... to ..." mode), or null when any bullet is not understood. */
function parseModes(
  block: ModalBlock,
): { modes: CardEffect[][]; optional: (OptionalCost | undefined)[] } | null {
  const modes: CardEffect[][] = [];
  const optional: (OptionalCost | undefined)[] = [];
  for (const raw of block.modes) {
    const text = protectGrants(block.giveMe ? `Give me ${raw.replace(/\.$/, '')} this turn.` : raw)
      .replace(/\[Stun\]/gi, 'Stun')
      .replace(/\([^)]*\)/g, ' ');
    const sens = sentences(text);
    let eff = parseEffectSentences(sens);
    let cost: OptionalCost | undefined;
    if (!eff) {
      // "Pay [C] to draw 1" = "you may pay [C] to draw 1".
      const pay = /^pay (.+)$/i.exec(sens[0] ?? '');
      const opt = pay ? splitOptional([`you may pay ${pay[1] as string}`, ...sens.slice(1)]) : null;
      eff = opt ? parseEffectSentences(opt.rest) : null;
      cost = opt?.optional;
    }
    if (!eff || eff.length === 0) return null;
    modes.push(eff);
    optional.push(cost);
  }
  return { modes, optional };
}

export function parseCardAbilities(
  text0: string,
  opts: { gearLike?: boolean; legend?: boolean } = {},
): ParsedAbilities | null {
  const { text, blocks: modalBlocks } = extractModal(text0);
  const kwTriggers = keywordTriggers(text);
  const cleaned = protectGrants(text)
    .replace(/(?:^|\n)\s*\[(?:Disarm(?: \d+)?|Weaponmaster|Hunt(?: \d+)?|Vision)\]/gi, '\n')
    .replace(/\s*\n\s*/g, '. ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(TOKEN_WITH, '$1 with $2')
    .replace(/\b(is|it's|it’s) \[Empowered\]/gi, '$1 empowered')
    // R78: "When I become [Empowered]" is a trigger head, not the Empowered gate.
    .replace(/\bbecome \[Empowered\]/gi, 'become empowered')
    // R74: keep "my [Assault]" from being read as the keyword itself.
    .replace(/\bmy \[(Assault|Shield)\]/gi, 'my {$1}')
    .replace(/\bWhen I conquer after an attack\b/gi, 'When I conquer')
    // R101: a Legend's own player-scoped triggers: "When you win a combat / hold / conquer, ...".
    .replace(/\bWhen you (win a combat|hold|conquer)\b/gi, (m: string, k: string) =>
      opts.legend === true ? 'When I ' + k.toLowerCase() : m,
    )
    // R85: Deploy gear at a battlefield: "When you hold / conquer / win a combat here".
    .replace(/\bwhen you (hold|conquer) here\b/gi, (m: string, k: string) =>
      opts.gearLike === true ? 'when I ' + k.toLowerCase() : m,
    )
    .replace(/\bwhen you win a combat here\b/gi, (m: string) =>
      opts.gearLike === true ? 'when I win a combat' : m,
    )
    // R71: gear says "When you play this" where units say "When you play me".
    .replace(/\bWhen you play this\b/gi, 'When you play me')
    .replace(/\[Stun\]/gi, 'Stun')
    // "give me [Temporary]" is an effect, not the keyword line (it would be stripped below).
    .replace(/\bgive me \[Temporary\]/gi, 'give me Temporary')
    // "When I attack while <condition>, ..." = "When I attack, if <condition>, ...".
    .replace(/\bWhen I (attack|defend|conquer|hold) while (.+?), /gi, 'When I $1, if $2, ')
    .replace(/\[Reaction\],\s*(?=\[Legion\])/gi, 'REACTION ')
    .replace(
      /\[(Reaction|Action)\]\s*(?:\[>\]|[—–-])\s*/gi,
      (_m, k: string) => `${k.toUpperCase()} `,
    )
    // R52: "[Empower] <cost>" is the activated ability "<cost>: Empower me"; "[Empowered][>] ..." prefixes an
    // ability that only exists while Empowered.
    .replace(
      /\[Empower\]\s*(?:\[>\]|[^\w[\s])?\s*((?:\[[0-9CAE]+\](?:, )?)+|Discard \d+|Kill an? [a-z ]+?)(?=[ \t]*[.\n(]|[ \t]*$)/gi,
      '$1: Empower me. ',
    )
    .replace(/\[Empowered\]\s*(?:\[>\]|[^\w[\s])\s*(?:\[>>\]\s*)?/gi, 'EMPOWERED ')
    .replace(/\[Legion\]\s*(?:\[>\]|[—–-])\s*/gi, 'LEGION ')
    .replace(/\[Level (\d+)\]\s*(?:\[>\]|[—–-])\s*/gi, 'LEVEL$1 ')
    .replace(/\[Deploy\]/gi, ' ')
    .replace(KEYWORD_TOKENS, ' ')
    .replace(/\[Deathknell\]\s*(?:\[>\]|[—–-])/gi, ' Deathknell: ')
    .replace(/\s+/g, ' ')
    .trim();
  const out: ParsedAbilities = { triggers: [...kwTriggers], abilities: [] };
  // A trigger / ability sentence starts a group; the sentences after it belong to the same ability.
  type Group =
    | {
        kind: 'trigger';
        ons: TriggerKind[];
        legion: boolean;
        when?: Condition;
        playFilter?: PlayFilter;
        dies?: DeathFilter;
        once?: boolean;
        moveNth?: number;
        youScore?: boolean;
        unitFilter?: CardTrigger['unitFilter'];
        chosen?: CardTrigger['chosen'];
        buffed?: CardTrigger['buffed'];
        inCombat?: boolean;
        sens: string[];
      }
    | {
        kind: 'ability';
        cost: AbilityCost;
        reaction: boolean;
        action?: boolean;
        legion?: boolean;
        atBattlefield?: boolean;
        costReduction?: CostReduction;
        /** "[Empowered][>]" / "[Level N][>]" gate. */
        when?: Condition;
        sens: string[];
      };
  const groups: Group[] = [];
  let cur: Group | null = null;
  for (const raw of cleaned
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean)) {
    let sen = raw;
    let legion = false;
    let empowered = false;
    /** R52 / R73: "[Empowered][>]" / "[Level N][>]" gate the ability on a condition. */
    let gate: Condition | undefined;
    if (/^EMPOWERED /.test(sen)) {
      empowered = true;
      gate = { kind: 'EMPOWERED' };
      sen = sen.slice(10).trim();
    }
    const lvl = /^LEVEL(\d+) /.exec(sen);
    if (lvl) {
      empowered = true;
      gate = { kind: 'XP', n: Number(lvl[1]) };
      sen = sen.slice(lvl[0].length).trim();
    }
    if (/^LEGION /.test(sen)) {
      legion = true;
      sen = sen.slice(7).trim();
    }
    let once = false;
    if (/^Once each turn,\s*/i.test(sen)) {
      once = true;
      sen = sen.replace(/^Once each turn,\s*/i, '');
    }
    // R72: "If <condition> at the start of your Beginning Phase, <effects>" reads like the "At ..., if" form.
    const iat = /^If (.+?) at the start of your Beginning Phase,\s*(.+)$/i.exec(sen);
    if (iat) sen = `At the start of your Beginning Phase, if ${iat[1]}, ${iat[2]}`;
    // R88: "The first time I conquer / a friendly unit dies each turn, ..." = "Once each turn, when ...".
    // Yasuo: "The third time I move in a turn, ..." fires on the unit's third move to a battlefield.
    let moveNth: number | undefined;
    const mn = /^The third time I move in a turn,s*(.*)$/i.exec(sen);
    if (mn) {
      moveNth = 3;
      sen = 'When I move, ' + mn[1];
    }
    const ft = /^The first time (I|a friendly unit) ([a-z ]+?) each turn,\s*(.*)$/i.exec(sen);
    if (ft) {
      once = true;
      sen = 'When ' + ft[1] + ' ' + ft[2] + ', ' + ft[3];
    }
    const deadStunned = /^When (?:a|an) stunned (enemy|friendly) unit\b/i.test(sen);
    const deadBuffed = /^When (?:a|an) buffed (enemy|friendly) unit\b/i.test(sen);
    const dm = DEATH_HEAD.exec(
      deadStunned || deadBuffed
        ? sen.replace(/(?:stunned|buffed) (enemy|friendly) unit/i, '$1 unit')
        : sen,
    );
    const db = DEATH_BATCH_HEAD.exec(sen);
    if (dm || db) {
      const side =
        ((dm ? (dm[2] ?? 'friendly') : db?.[1]) ?? '').toLowerCase() === 'friendly'
          ? 'friendly'
          : 'enemy';
      let body = (dm ? dm[5] : db?.[2]) ?? '';
      let when: Condition | undefined = dm?.[4] ? { kind: 'AT_BATTLEFIELD' } : undefined;
      const split = splitCondition(body);
      if (!split || (split.when && when)) return null;
      when = when ?? split.when;
      body = split.rest;
      if (empowered) {
        if (when) return null;
        when = gate;
      }
      cur = {
        kind: 'trigger',
        ons: ['UNIT_DIES'],
        legion,
        ...(when ? { when } : {}),
        dies: {
          side,
          ...(dm?.[3] ? { here: true } : {}),
          ...(deadStunned ? { stunned: true } : {}),
          ...(deadBuffed ? { buffed: true } : {}),
          ...(dm?.[1] ? { exceptSubtype: dm[1] } : {}),
          ...(db ? { batch: true } : {}),
        },
        ...(once ? { once: true } : {}),
        sens: [body],
      };
      groups.push(cur);
      continue;
    }
    const ph = parsePlayHead(sen);
    if (ph) {
      if (once) return null;
      const split = splitCondition(ph.body);
      if (!split) return null;
      if (empowered && split.when) return null;
      cur = {
        kind: 'trigger',
        ons: ph.alsoSelf ? ['PLAY', 'YOU_PLAY'] : ['YOU_PLAY'],
        legion,
        ...(empowered ? { when: gate as Condition } : split.when ? { when: split.when } : {}),
        playFilter: ph.filter,
        sens: [split.rest],
      };
      groups.push(cur);
      continue;
    }
    const m = TRIGGER_HEAD.exec(sen);
    if (m) {
      const head = (m[1] ?? '').toLowerCase();
      const youScore = /^when you(?: or an ally)? (?:conquer|hold)/.test(head);
      const ons: TriggerKind[] = youScore
        ? head.includes('conquer or hold')
          ? ['CONQUER', 'HOLD']
          : [head.endsWith('conquer') ? 'CONQUER' : 'HOLD']
        : head.includes('unit attacks')
          ? ['UNIT_ATTACKS']
          : head.startsWith('when you buff')
            ? ['UNIT_BUFFED']
            : head.startsWith('when you choose or ready me')
              ? ['UNIT_CHOSEN', 'BECOME_READY']
              : head.startsWith('when you choose')
                ? ['UNIT_CHOSEN']
                : head.startsWith('when this is played, discarded')
                  ? ['PLAY', 'DISCARD_SELF', 'GEAR_LEAVES']
                  : head.startsWith('when this leaves the board')
                    ? ['GEAR_LEAVES']
                    : head.includes('becomes')
                      ? ['UNIT_BECOMES_MIGHTY']
                      : head.startsWith('when you stun')
                        ? ['YOU_STUN_ENEMY']
                        : head.startsWith('when you discard me')
                          ? ['DISCARD_SELF']
                          : head.startsWith('when you discard')
                            ? ['YOU_DISCARD']
                            : head.startsWith('when a unit moves from here')
                              ? ['UNIT_LEAVES_HERE']
                              : head.startsWith('when you ready a friendly unit')
                                ? ['FRIENDLY_READIED']
                                : head.startsWith('when i move from a battlefield')
                                  ? ['MOVE_FROM']
                                  : head.startsWith('when you use an activated ability of a gear')
                                    ? ['USE_GEAR_ABILITY']
                                    : head.startsWith('when you hide a card')
                                      ? ['YOU_HIDE']
                                      : head.startsWith('when you play me from face down')
                                        ? ['PLAY']
                                        : head.startsWith('when you play me or when i score')
                                          ? ['PLAY', 'HOLD', 'CONQUER']
                                          : head.startsWith('when an opponent scores')
                                            ? ['OPP_SCORES']
                                            : head.startsWith('when you play me or when i become')
                                              ? ['PLAY', 'BECOME_EXHAUSTED']
                                              : head.startsWith('when i become')
                                                ? [
                                                    head.endsWith('exhausted')
                                                      ? 'BECOME_EXHAUSTED'
                                                      : head.endsWith('ready')
                                                        ? 'BECOME_READY'
                                                        : 'BECOME_EMPOWERED',
                                                  ]
                                                : head.startsWith('when you play me or at')
                                                  ? ['PLAY', 'TURN_START']
                                                  : head.startsWith('at the end of')
                                                    ? ['TURN_END']
                                                    : head.startsWith('at ')
                                                      ? ['TURN_START']
                                                      : head.startsWith('when i win a combat')
                                                        ? ['WIN_COMBAT']
                                                        : head.startsWith(
                                                              'when a combat that i was in ends',
                                                            )
                                                          ? ['COMBAT_END']
                                                          : head.startsWith('when you play me or')
                                                            ? [
                                                                'PLAY',
                                                                OR_WHEN[
                                                                  m[2]?.toLowerCase() ?? ''
                                                                ] ?? 'CONQUER',
                                                              ]
                                                            : head.startsWith('when you play me')
                                                              ? ['PLAY']
                                                              : head.startsWith('when i hold')
                                                                ? ['HOLD']
                                                                : head.startsWith('when i conquer')
                                                                  ? ['CONQUER']
                                                                  : head.startsWith(
                                                                        'when i attack or defend',
                                                                      )
                                                                    ? ['ATTACK', 'DEFEND']
                                                                    : head.startsWith(
                                                                          'when i attack',
                                                                        )
                                                                      ? ['ATTACK']
                                                                      : head.startsWith(
                                                                            'when i defend',
                                                                          )
                                                                        ? ['DEFEND']
                                                                        : head.startsWith(
                                                                              'when i move',
                                                                            )
                                                                          ? ['MOVE']
                                                                          : ['DEATH'];
      let body = m[3] ?? '';
      // "give it ..." targets the unit that attacked: written as a friendly / enemy unit, preset as the target.
      let unitFilter: CardTrigger['unitFilter'] | undefined;
      if (head.includes('unit attacks')) {
        const friendly = head.startsWith('when a friendly');
        unitFilter = friendly
          ? { side: 'friendly', alone: true }
          : { side: 'enemy', attacking: true, atMine: true };
        body = body.replace(
          /^(give|deal) it /i,
          (_m, v: string) => `${v} ${friendly ? 'a friendly' : 'an enemy'} unit `,
        );
      }
      // Battlefield event units: "give it ..." targets the unit of the event (preset as the target).
      if (head.startsWith('when a unit moves from here')) {
        body = body.replace(/^give it /i, 'give a unit ');
      } else if (head.startsWith('when you ready a friendly unit')) {
        body = body.replace(/^give it /i, 'give a friendly unit ');
      }
      const chosen: CardTrigger['chosen'] | undefined = head.startsWith(
        'when you choose a friendly',
      )
        ? { target: 'friendly' }
        : head.startsWith('when you choose')
          ? { target: 'self', ...(head.includes('spell') ? { spellOnly: true } : {}) }
          : undefined;
      const buffed: CardTrigger['buffed'] | undefined = head.startsWith('when you buff me')
        ? 'self'
        : head.startsWith('when you buff')
          ? 'friendly'
          : undefined;
      if (chosen?.target === 'friendly' || buffed === 'friendly') {
        body = body.replace(/ ready it$/i, ' ready a friendly unit');
      }
      let when: Condition | undefined;
      if (body) {
        const split = splitCondition(body);
        if (!split) return null; // an "if" clause we do not understand
        when = split.when;
        body = split.rest;
      }
      if (head.endsWith('one on one')) {
        if (when) return null;
        when = { kind: 'COMBAT_ROLE', role: 'EITHER', oneOnOne: true };
      }
      if (empowered) {
        if (when) return null;
        when = gate;
      }
      if (head.startsWith('when you play me from face down')) {
        if (when) return null;
        when = { kind: 'FROM_FACEDOWN' };
      }
      if (head.startsWith('when you play me to a battlefield')) {
        // R45: played to a battlefield = the unit stands at a battlefield as the ability triggers.
        if (when) return null;
        when = { kind: 'AT_BATTLEFIELD' };
      }
      cur = {
        kind: 'trigger',
        ons,
        legion,
        ...(when ? { when } : {}),
        ...(once ? { once: true } : {}),
        ...(moveNth ? { moveNth } : {}),
        ...(youScore ? { youScore: true } : {}),
        ...(unitFilter ? { unitFilter } : {}),
        ...(chosen ? { chosen } : {}),
        ...(buffed ? { buffed } : {}),
        ...(head.startsWith('when i die in combat') ? { inCombat: true } : {}),
        sens: body ? [body] : [],
      };
      groups.push(cur);
      continue;
    }
    // R73: "[Level N][>] I enter ready".
    if (empowered && gate?.kind === 'XP' && /^I enter ready$/i.test(sen) && !legion) {
      out.entersReadyWhen = gate;
      cur = null;
      continue;
    }
    // R52: only triggers and activated abilities can be Empowered-only (statics are read by parseStaticLines).
    if (empowered && !/^(?:(?:REACTION|ACTION) )?[^:]+: /.test(sen)) return null;
    if (once) return null;
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
    const erc = /^I enter ready if (.+)$/i.exec(sen) ?? /^If (.+?), I enter ready$/i.exec(sen);
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
    const ab = /^(?:(REACTION|ACTION) )?([^:]+): (?:(REACTION|ACTION) )?(.+)$/.exec(sen);
    // 812: "<cost>: [Legion] — <effect>" is an activated ability usable only after another card was played.
    const abLegion = ab !== null && /^(?:REACTION,? )?LEGION /.test(ab[4] ?? '');
    if (legion && !abLegion && !ab) return null;
    if (ab) {
      const cost = parseAbilityCost(ab[2] ?? '', opts.gearLike === true);
      if (!cost) return null;
      let abBody = ab[4] as string;
      let abReaction = ab[1] === 'REACTION' || ab[3] === 'REACTION';
      const lead = /^(REACTION,? )?LEGION /.exec(abBody);
      if (lead) {
        if (lead[1]) abReaction = true;
        abBody = abBody.slice(lead[0].length).trim();
      }
      cur = {
        kind: 'ability',
        cost,
        reaction: abReaction,
        ...(ab[1] === 'ACTION' || ab[3] === 'ACTION' ? { action: true } : {}),
        ...(legion || abLegion ? { legion: true } : {}),
        ...(empowered && gate ? { when: gate } : {}),
        sens: [abBody],
      };
      groups.push(cur);
      continue;
    }
    // R91: "This ability costs [N] less for each <thing> / if <condition>".
    const acr =
      cur?.kind === 'ability'
        ? /^This ability costs \[(\d+)\] less (?:for each (.+)|if (.+))$/i.exec(sen)
        : null;
    if (cur?.kind === 'ability' && acr) {
      const per =
        acr[2] === undefined ? undefined : COST_PER.find(([re]) => re.test(acr[2]?.trim() ?? ''));
      const when = acr[3] === undefined ? undefined : parseCondition(acr[3]);
      if ((acr[2] !== undefined && !per) || (acr[3] !== undefined && !when)) return null;
      cur.costReduction = {
        energy: Number(acr[1]),
        ...(per ? { per: per[1] } : {}),
        ...(when ? { when } : {}),
      };
      continue;
    }
    if (
      cur?.kind === 'ability' &&
      /^Use this ability only while I['’]m at a battlefield$/i.test(sen)
    ) {
      cur.atBattlefield = true;
      continue;
    }
    // "Use my abilities only while I'm at a battlefield": every activated ability of the card.
    if (/^Use my abilities only while I['’]m at a battlefield$/i.test(sen)) {
      let any = false;
      for (const g of groups) {
        if (g.kind === 'ability') {
          g.atBattlefield = true;
          any = true;
        }
      }
      if (!any) return null;
      continue;
    }
    if (!cur) return null;
    cur.sens.push(sen);
  }
  for (const g of groups) {
    // X-modes: "..., choose one —" followed by bullets.
    const mm =
      g.kind === 'trigger' && g.sens.length === 1 ? /^MODAL(\d+)$/.exec(g.sens[0] ?? '') : null;
    if (mm && g.kind === 'trigger') {
      const block = modalBlocks[Number(mm[1])];
      const parsedModes = block ? parseModes(block) : null;
      if (!block || !parsedModes) return null;
      const { modes, optional: modeCosts } = parsedModes;
      if (g.ons.some((o) => o === 'TURN_START' || o === 'TURN_END')) return null;
      for (const on of g.ons) {
        out.triggers.push({
          on,
          effects: [],
          modes,
          ...(modeCosts.some((c) => c !== undefined) ? { modeOptional: modeCosts } : {}),
          modeTexts: block.modes.map((x) => x.replace(/\([^)]*\)/g, '').trim()),
          ...(block.once ? { modeOnce: true } : {}),
          ...(g.legion ? { condition: 'LEGION' as const } : {}),
          ...(g.when ? { when: g.when } : {}),
          ...(g.once ? { oncePerTurn: true } : {}),
          ...(g.inCombat ? { inCombat: true } : {}),
        });
      }
      continue;
    }
    // R41: bodies may choose targets ("give a unit +2 [M] this turn"), like a spell's sentences.
    let effects = parseEffectSentences(g.sens);
    let optional: OptionalCost | undefined;
    if (!effects && g.kind === 'trigger') {
      // R45: "you may [pay COST to] ..." that is not an optional target choice (R42).
      const opt = splitOptional(g.sens);
      effects = opt ? parseEffectSentences(opt.rest) : null;
      optional = opt?.optional;
    }
    if (!effects && g.kind === 'trigger') {
      // R77: "Discard N[, then ...]" is a cost the controller must pay.
      const md = splitMandatoryDiscard(g.sens);
      const after = md ? (md.rest.length > 0 ? parseEffectSentences(md.rest) : []) : null;
      if (md && after) {
        effects = after;
        optional = md.optional;
      }
    }
    if (!effects || (effects.length === 0 && !optional?.mandatory)) return null;
    // R72: turn triggers resolve inline, so they cannot ask for a target or a payment.
    if (
      g.kind === 'trigger' &&
      g.ons.some((o) => o === 'TURN_START' || o === 'TURN_END') &&
      (optional || targetRequirements(effects).length > 0)
    ) {
      return null;
    }
    // R46: a Deathknell's "here" would be where the unit died, which the engine does not keep (the
    // object is already in the Trash): such a card stays partial rather than silently doing nothing.
    if (
      g.kind === 'trigger' &&
      g.ons.includes('DEATH') &&
      (optional?.card?.here || JSON.stringify(effects).includes('"here":true'))
    ) {
      return null;
    }
    if (g.kind === 'ability') {
      // An Action-speed [Add] ability is not a mana ability (UNCLEAR): keep such cards partial.
      if (g.action && effects.every((e) => e.op === 'ADD_ENERGY' || e.op === 'ADD_POWER'))
        return null;
      out.abilities.push({
        cost: g.cost,
        ...(g.reaction ? { reaction: true } : {}),
        ...(g.action ? { action: true } : {}),
        ...(g.legion ? { legion: true } : {}),
        ...(g.when ? { when: g.when } : {}),
        ...(g.atBattlefield ? { atBattlefield: true } : {}),
        ...(g.costReduction ? { costReduction: g.costReduction } : {}),
        effects,
      });
    } else {
      for (const on of g.ons) {
        out.triggers.push({
          on,
          effects,
          ...(optional ? { optional } : {}),
          ...(g.legion ? { condition: 'LEGION' as const } : {}),
          ...(g.when ? { when: g.when } : {}),
          ...(g.playFilter ? { playFilter: g.playFilter } : {}),
          ...(g.dies ? { dies: g.dies } : {}),
          ...(g.once ? { oncePerTurn: true } : {}),
          ...(g.moveNth ? { moveNth: g.moveNth } : {}),
          ...(g.youScore ? { youScore: true } : {}),
          ...(g.unitFilter ? { unitFilter: g.unitFilter } : {}),
          ...(g.chosen ? { chosen: g.chosen } : {}),
          ...(g.buffed ? { buffed: g.buffed } : {}),
          ...(g.inCombat ? { inCombat: true } : {}),
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
  // "At the start of each player's [first] Beginning Phase, that player ...": the active player's turn start.
  const firstTurn = /At the start of each player['’]s first Beginning Phase/i.test(text);
  const rewritten = text
    .replace(
      /At the start of each player['’]s (?:first )?Beginning Phase/gi,
      'At the start of your Beginning Phase',
    )
    .replace(/\ba unit you control here\b/gi, 'a friendly unit here')
    .replace(/\bWhen you hide a card here\b/gi, 'When you hide a card')
    .replace(
      /\bWhen you (conquer|hold) here with one or more \[Mighty\] units,/gi,
      'When you $1 here, if you have a [Mighty] unit here,',
    )
    .replace(/\bthat player channels\b/gi, 'channel')
    .replace(/\bthat player gains (\d+) points?\b/gi, 'score $1 point')
    .replace(
      /(^|[.\n]\s*)When you (hold|conquer|defend|attack) here\b/gi,
      (_m, pre: string, k: string) => `${pre}When I ${k.toLowerCase()}`,
    );
  const r = parseCardAbilities(rewritten);
  if (!r || r.triggers.length === 0) return null;
  if (r.abilities.length > 0 || r.entersReady || r.entersReadyWhen || r.entersExhausted)
    return null;
  if (r.legionCostReduction !== undefined || r.triggers.some((t) => t.condition)) return null;
  if (
    r.triggers.some(
      (t) =>
        ![
          'HOLD',
          'CONQUER',
          'DEFEND',
          'ATTACK',
          'TURN_START',
          'YOU_HIDE',
          'UNIT_LEAVES_HERE',
          'FRIENDLY_READIED',
        ].includes(t.on),
    )
  )
    return null;
  const hideHere = /When you hide a card here\b/i.test(text);
  // A battlefield hide trigger is always "here" (it only sees cards hidden at that battlefield).
  if (!hideHere && r.triggers.some((t) => t.on === 'YOU_HIDE')) return null;
  return r.triggers.map((t) =>
    t.on === 'YOU_HIDE' && hideHere
      ? { ...t, hiddenHere: true as const }
      : t.on === 'TURN_START' && firstTurn
        ? { ...t, firstTurn: true }
        : t,
  );
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
