/**
 * Pure conversion of Hugging Face `Wysme/riftbound-cards` rows into engine CardDefs.
 * No I/O except loading the JSON schema in `createCardValidator`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import {
  parseAdditionalCost,
  parseBattlefieldAbilities,
  parseCardAbilities,
  parseRepeatCost,
  parseSelfCostReduction,
  parseFlowCost,
  parseModalSpell,
  parseOptionalAdditionalCost,
  parsePlayTo,
  takeUnlimitedCopies,
  parseStaticLines,
  parseSpellText,
} from '../../engine/src/cardText';
import { DOMAINS, MVP_KEYWORDS } from '../../engine/src/types/card';
import type {
  CardDef,
  CardType,
  CostCardChoice,
  Domain,
  EquipCost,
  KeywordInstance,
  KeywordName,
} from '../../engine/src/types/card';

/** Normalised (camelCase) row. */
export interface RawRow {
  cardCode: string;
  name: string;
  subtitle?: string | null;
  fullName?: string | null;
  cardNumber?: string | number | null;
  rarity?: string | null;
  domain?: string | null;
  domains?: string[] | null;
  cardType: string;
  cardTypeLabels?: string[] | null;
  tags?: string[] | null;
  energy?: number | null;
  power?: number | null;
  might?: number | null;
  abilityOriginal?: string | null;
  abilityCorrected?: string | null;
  abilityEffective?: string | null;
  imageUrl?: string | null;
}

const snakeToCamel = (k: string): string =>
  k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Accept either camelCase (real file) or snake_case (original HF names). */
export function normalizeRow(input: Record<string, unknown>): RawRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const key = snakeToCamel(k);
    if (!(key in out) || out[key] == null) out[key] = v;
  }
  if (out.cardCode == null && out.card_code != null) out.cardCode = out.card_code;
  return out as unknown as RawRow;
}

export interface ConvertResult {
  card: CardDef | null;
  warnings: string[];
  unknownDomains: string[];
}

const TYPE_MAP: Record<string, CardType> = {
  unit: 'UNIT',
  rune: 'RUNE',
  spell: 'SPELL',
  gear: 'GEAR',
  legend: 'LEGEND',
  battlefield: 'BATTLEFIELD',
  token: 'TOKEN',
};

const KEYWORD_LOOKUP: Record<string, KeywordName> = {
  action: 'Action',
  reaction: 'Reaction',
  tank: 'Tank',
  backline: 'Backline',
  assault: 'Assault',
  shield: 'Shield',
  ganking: 'Ganking',
  accelerate: 'Accelerate',
  temporary: 'Temporary',
  hidden: 'Hidden',
  deflect: 'Deflect',
  unique: 'Unique',
  equip: 'Equip',
  'quick-draw': 'QuickDraw',
  'quick draw': 'QuickDraw',
  quickdraw: 'QuickDraw',
  deathknell: 'Deathknell',
  legion: 'Legion',
  ambush: 'Ambush',
  level: 'Level',
  hunt: 'Hunt',
  flow: 'Flow',
  repeat: 'Repeat',
  predict: 'Predict',
  'show off': 'ShowOff',
  showoff: 'ShowOff',
  weaponmaster: 'Weaponmaster',
  empower: 'Empower',
  deploy: 'Deploy',
  vision: 'Vision',
  disarm: 'Disarm',
};

// R85: Deploy gear is implemented (play location, stays at the battlefield, killed when an opponent holds).
const MVP_SET = new Set<string>([...MVP_KEYWORDS, 'Deploy']);
/** Keywords whose behaviour the ability parser turns into triggers (R5, R42): not MVP, but not blockers. */
const PARSED_KEYWORDS = new Set<string>([
  'Deathknell',
  'Disarm',
  'Weaponmaster',
  'Empower',
  'Hunt',
  'Level',
  'Vision',
  'Predict',
]);

/** Errata marker; in the real data it may be split across lines ("▲\n[OLD TEXT]"). */
const OLD_TEXT_RE = /▲?\s*\[OLD TEXT\][\s\S]*$/;

/** Strip the errata marker (and everything after it) and normalise symbols. */
/** A spell's flag lines ("This can't be countered.", "Ignore [Deflect] while paying this spell's cost.") taken out of its text. */
function takeSpellFlags(text: string): {
  uncounterable: boolean;
  ignoreDeflect: boolean;
  rest: string;
} | null {
  const counter = /(?:^|\n)[ \t]*This can['’]t be countered\.?[ \t]*(?=\n|$)/i;
  const deflect =
    /(?:^|\n)[ \t]*Ignore \[Deflect\] while paying this spell['’]s cost\.?[ \t]*(?=\n|$)/i;
  const uncounterable = counter.test(text);
  const ignoreDeflect = deflect.test(text);
  if (!uncounterable && !ignoreDeflect) return null;
  return {
    uncounterable,
    ignoreDeflect,
    rest: text.replace(counter, '').replace(deflect, '').replace(/^\n+/, ''),
  };
}

/** "[Show Off] a Mech." / "a card with [Hidden]" / "a card with Energy cost [7] or more": the reveal as an optional additional cost. */
function takeShowOff(text: string): { cost: CostCardChoice; rest: string } | null {
  const re =
    /(?:^|\n)[ \t]*\[Show Off\][ \t]+an? ([^.\n(]+?)\.?[ \t]*(?:\([^)\n]*\)[ \t]*)?(?=\n|$)/i;
  const m = re.exec(text);
  if (!m) return null;
  const what = (m[1] ?? '').trim();
  const cost: CostCardChoice = { kind: 'REVEAL' };
  const energy = /^card with Energy cost \[(\d+)\] or more$/i.exec(what);
  if (/^card$/i.test(what)) {
    // any card
  } else if (/^card with \[Hidden\]$/i.test(what)) {
    cost.hidden = true;
  } else if (energy) {
    cost.minEnergy = Number(energy[1]);
  } else if (/^(unit|gear|spell)$/i.test(what)) {
    cost.what = what.toLowerCase() as 'unit' | 'gear' | 'spell';
  } else if (/^[A-Za-z]+$/.test(what)) {
    cost.subtype = what;
  } else {
    return null;
  }
  return { cost, rest: text.replace(re, '\n').replace(/^\n+/, '') };
}

export function normalizeText(raw: string | null | undefined): string {
  const text = (raw ?? '').replace(OLD_TEXT_RE, '');
  return (
    text
      .replace(/\[S\]/g, '[M]')
      .replace(/\[T\]/g, '[E]')
      // R69: some printings write "Equip [1]" without the keyword brackets.
      .replace(/(^|\n)Equip (?=\[)/g, '$1[Equip] ')
      // R110: "a card from [Hidden]" means a card played from face down (it is not the Hidden keyword).
      .replace(/ from \[Hidden\]/g, ' from face down')
      // R103: and a few write other keywords as plain words before their reminder ("Ganking (I can move ...)").
      .replace(/(^|\n)(Ganking|Hidden|Action|Tank|Backline|Reaction)(?= \()/g, '$1[$2]')
      .trim()
  );
}

/** Remove parenthesised reminder text. */
export function stripReminders(text: string): string {
  return text.replace(/\([^()]*\)/g, ' ');
}

function parseKeywordToken(token: string): KeywordInstance | null {
  const t = token.trim().toLowerCase();
  const direct = KEYWORD_LOOKUP[t];
  if (direct) return { name: direct };
  const m = /^(.*?)\s*\+?(\d+)$/.exec(t);
  if (m) {
    const name = KEYWORD_LOOKUP[(m[1] ?? '').trim()];
    if (name) return { name, value: Number(m[2]) };
  }
  return null;
}

/** Extract keyword instances from bracket tokens, ignoring reminder text. */
export function extractKeywords(text: string): KeywordInstance[] {
  const out: KeywordInstance[] = [];
  const seen = new Set<string>();
  for (const m of stripReminders(text).matchAll(/\[([^\]]+)\]/g)) {
    const kw = parseKeywordToken(m[1] ?? '');
    if (!kw) continue;
    const key = `${kw.name}:${kw.value ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
  }
  return out;
}

function isSymbolToken(token: string): boolean {
  return /^(?:\d+|[A-Z]|>+|\+\d+\s*[A-Z]?)$/.test(token.trim());
}

/** 'full' when the text has no prose beyond MVP keywords, reminder text and symbols. */
export function computeSupportLevel(text: string, keywords: KeywordInstance[]): 'full' | 'partial' {
  if (keywords.some((k) => !MVP_SET.has(k.name))) return 'partial';
  let rest = stripReminders(text);
  rest = rest.replace(/\[([^\]]+)\]/g, (whole, token: string) => {
    const kw = parseKeywordToken(token);
    if (kw && MVP_SET.has(kw.name)) return ' ';
    if (isSymbolToken(token)) return ' ';
    return whole;
  });
  return /[A-Za-z0-9]/.test(rest) ? 'partial' : 'full';
}

/**
 * Rule 818: parse the printed Equip cost, e.g. "[Equip] [1][C] ([1][C]: Attach ...)".
 * Numbers are Energy, [C] is Power of the Equipment's domain, [A] is any-domain Power.
 * Returns undefined when the text has no Equip keyword or no cost at all.
 */
export function parseEquipCost(text: string): EquipCost | undefined {
  const m = /\[Equip\]\s*(?:[—-]\s*)?((?:\[[A-Z0-9]+\]\s*)*)([^(\n]*)/.exec(text);
  if (!m) return undefined;
  const cost: EquipCost = { energy: 0, power: 0, anyPower: 0 };
  let any = false;
  for (const t of (m[1] ?? '').matchAll(/\[([A-Z0-9]+)\]/g)) {
    const tok = t[1] as string;
    any = true;
    if (/^\d+$/.test(tok)) cost.energy += Number(tok);
    else if (tok === 'C') cost.power += 1;
    else if (tok === 'A') cost.anyPower += 1;
  }
  const rest = (m[2] ?? '').replace(/^[\s,.]+/, '').trim();
  const spendXp = /^Spend (\d+) XP$/i.exec(rest.replace(/[.\s]+$/, ''));
  if (/reduced by the Might/i.test(rest)) {
    cost.energyReducedByMight = true;
  } else if (spendXp) {
    cost.xp = Number(spendXp[1]);
    any = true;
  } else if (rest && !/^Pay the cost/i.test(rest)) {
    cost.nonResource = rest.replace(/[.\s]+$/, '');
  }
  if (!any && !cost.nonResource) return undefined;
  return cost;
}

function normalizeDomain(name: string): Domain | null {
  return DOMAINS.find((d) => d.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

export function convertRow(row: RawRow): ConvertResult {
  const warnings: string[] = [];
  const unknownDomains: string[] = [];
  const code = row.cardCode;
  const warn = (msg: string): void => {
    warnings.push(`${code}: ${msg}`);
  };

  const type = TYPE_MAP[String(row.cardType ?? '').toLowerCase()];
  if (!code || !row.name || !type) {
    warn(`unusable row (name=${String(row.name)}, type=${String(row.cardType)})`);
    return { card: null, warnings, unknownDomains };
  }

  const rawDomains = row.domains ?? (row.domain ? [row.domain] : []);
  const domains: Domain[] = [];
  for (const d of rawDomains) {
    if (d.trim().toLowerCase() === 'colorless') continue; // colorless = no domain
    const nd = normalizeDomain(d);
    if (nd) {
      if (!domains.includes(nd)) domains.push(nd);
    } else {
      unknownDomains.push(d);
      warn(`unknown domain "${d}"`);
    }
  }

  const energy = row.energy ?? 0;
  const power = row.power ?? 0;
  const cost: CardDef['cost'] = { energy };
  if (power > 0) {
    cost.power = power;
    if (domains.length === 1 && domains[0]) {
      cost.domain = [{ element: domains[0], amount: power }];
    } else if (domains.length > 1) {
      warn(`power ${power} with multiple domains (${domains.join('/')}); domain breakdown omitted`);
    }
  }

  const fullText = normalizeText(
    row.abilityEffective ?? row.abilityCorrected ?? row.abilityOriginal,
  );
  // R47: "As an additional cost to play this, <card-choice cost>." is taken out of the text and stored
  // on the card (only when the rest of the card turns out fully supported, see below).
  // "This can't be countered." / "Ignore [Deflect] while paying this spell's cost." are flags of the card.
  const spellFlags = type === 'SPELL' ? takeSpellFlags(fullText) : null;
  const flagged = spellFlags ? spellFlags.rest : fullText;
  const showOff = type === 'UNIT' || type === 'SPELL' ? takeShowOff(flagged) : null;
  const baseText0 = showOff ? showOff.rest : flagged;
  // "Your deck can have any number of cards named X": a deck-building rule, kept on the card.
  const deckRule = takeUnlimitedCopies(baseText0);
  const baseText = deckRule ? deckRule.rest : baseText0;
  const additional =
    type === 'UNIT' || type === 'SPELL' || type === 'GEAR' ? parseAdditionalCost(baseText) : null;
  const afterAdditionalCost = additional ? additional.rest : baseText;
  // R61: a spell's Flow cost line is stored on the card (kept only when the rest is fully supported).
  const flowLine = type === 'SPELL' ? parseFlowCost(afterAdditionalCost) : null;
  // R76: "You may play me to an open battlefield." lines of a Unit.
  const playToLine = type === 'UNIT' ? parsePlayTo(afterAdditionalCost) : null;
  const afterPlayTo = playToLine ? playToLine.rest : afterAdditionalCost;
  const afterAdditional = flowLine ? flowLine.rest : afterPlayTo;
  // R50: "I cost [N] less for each ..." / "This costs [N] less if ..." is stored on the card too.
  const selfCost =
    type === 'UNIT' || type === 'SPELL' || type === 'GEAR'
      ? parseSelfCostReduction(afterAdditional)
      : null;
  // R58: "You may pay [N] as an additional cost to play me" (only kept when the text uses it: "if you paid ...").
  const optionalExtra =
    (type === 'UNIT' || type === 'SPELL' || type === 'GEAR') &&
    /(if you paid the additional cost|as an additional cost[^\n]*you may[^\n]*\n?[^\n]*If you do|as an additional cost[^\n]*If you do, (?:I cost|reduce my cost|ignore this spell))/i.test(
      afterAdditional,
    )
      ? parseOptionalAdditionalCost(afterAdditional)
      : null;
  const afterExtra = optionalExtra ? optionalExtra.rest : afterAdditional;
  const afterSelfCost = selfCost ? selfCost.rest : afterExtra;
  // R51: static abilities ("Your gear have [Deflect]", "While ..., I have +1 [M]") are lines of their own.
  const staticLines =
    type === 'UNIT' || type === 'GEAR' || type === 'LEGEND' || type === 'BATTLEFIELD'
      ? parseStaticLines(afterSelfCost)
      : null;
  const text = staticLines ? staticLines.rest : afterSelfCost;
  // A keyword in "unit token with [Keyword]" belongs to the token, not to the card.
  let keywords = extractKeywords(text.replace(/(tokens?) with \[[^\]]+\]/gi, '$1'));
  // Rule 816: Temporary is a keyword of Permanents. On spells, legends and battlefields the bracket
  // is part of an effect ("Give it [Temporary]"), so it is not a keyword of the card itself.
  if (type === 'SPELL' || type === 'LEGEND' || type === 'BATTLEFIELD') {
    keywords = keywords.filter((k) => k.name !== 'Temporary');
  }

  const primary = String(row.cardType).toLowerCase();
  const subtypes: string[] = [];
  for (const s of [...(row.cardTypeLabels ?? []), ...(row.tags ?? [])]) {
    if (s.toLowerCase() === primary) continue;
    if (!subtypes.includes(s)) subtypes.push(s);
  }

  const stats: CardDef['stats'] = {};
  if (row.might != null) stats.might = row.might;

  const card: CardDef = {
    cardId: code,
    name: row.name,
    type,
    subtypes,
    cost,
    domains,
    stats,
    keywords,
    text: fullText,
    supportLevel: computeSupportLevel(text, keywords),
  };
  // R3: spells whose every sentence the text parser understands become executable.
  // R42: a printed Repeat cost ("[Repeat] [2]") is an optional additional cost, stored on the card.
  const repeatCost = type === 'SPELL' ? parseRepeatCost(text) : null;
  if (
    type === 'SPELL' &&
    card.supportLevel === 'partial' &&
    keywords.every(
      (k) =>
        MVP_SET.has(k.name) ||
        (k.name === 'Repeat' && repeatCost !== null) ||
        k.name === 'Predict' ||
        k.name === 'Level',
    )
  ) {
    const modes = parseModalSpell(text);
    if (modes) {
      card.modes = modes;
      if (repeatCost) card.repeatCost = repeatCost;
      card.supportLevel = 'full';
    }
    const effects = modes ? null : parseSpellText(text);
    if (effects) {
      card.effects = effects;
      if (repeatCost) card.repeatCost = repeatCost;
      card.supportLevel = 'full';
    }
  }
  // R5: units/gear whose text is only implemented keywords plus recognised triggers.
  if (
    (type === 'UNIT' || type === 'GEAR') &&
    card.supportLevel === 'partial' &&
    keywords.every((k) => MVP_SET.has(k.name) || PARSED_KEYWORDS.has(k.name))
  ) {
    // An Equip line whose cost is plain Energy / Power is stored as `equipCost`; the rest of the text is parsed alone.
    const eq = type === 'GEAR' ? parseEquipCost(text) : undefined;
    const forParse =
      eq && !eq.nonResource ? text.replace(/(?:^|\n)[ \t]*\[Equip\][^\n]*/i, '\n').trim() : text;
    const parsed = parseCardAbilities(forParse, { gearLike: type === 'GEAR' });
    if (parsed) {
      if (parsed.triggers.length > 0) card.triggers = parsed.triggers;
      if (parsed.abilities.length > 0) card.abilities = parsed.abilities;
      if (parsed.entersReady) card.entersReady = true;
      if (parsed.entersReadyWhen) card.entersReadyWhen = parsed.entersReadyWhen;
      if (parsed.entersExhausted) card.entersExhausted = true;
      if (parsed.legionCostReduction !== undefined) {
        card.legionCostReduction = parsed.legionCostReduction;
      }
      card.supportLevel = 'full';
    }
  }
  // R49: Legends whose text is only "When you play a <card>, ..." triggers (the Legend sits in its zone).
  if (
    type === 'LEGEND' &&
    card.supportLevel === 'partial' &&
    keywords.every((k) => MVP_SET.has(k.name) || PARSED_KEYWORDS.has(k.name))
  ) {
    const parsed = parseCardAbilities(text, { legend: true });
    if (
      parsed &&
      // R68: Legends also have activated abilities (used from the Legend zone).
      (parsed.abilities.length > 0 || parsed.triggers.length > 0) &&
      // R101: and the player-scoped triggers of winning a combat, holding and conquering.
      parsed.triggers.every((t) =>
        [
          'YOU_PLAY',
          'WIN_COMBAT',
          'HOLD',
          'CONQUER',
          'YOU_STUN_ENEMY',
          'YOU_DISCARD',
          'UNIT_BECOMES_MIGHTY',
          'UNIT_CHOSEN',
          'TURN_START',
          'TURN_END',
          'UNIT_ATTACKS',
          'YOU_EMPOWER_ELSE',
          'YOU_BANISH_OWN',
        ].includes(t.on),
      ) &&
      !parsed.entersReady &&
      !parsed.entersExhausted &&
      parsed.legionCostReduction === undefined
    ) {
      if (parsed.triggers.length > 0) card.triggers = parsed.triggers;
      if (parsed.abilities.length > 0) card.abilities = parsed.abilities;
      card.supportLevel = 'full';
    }
  }
  // R44: Battlefield cards whose every sentence is a "When you hold / conquer / defend / attack here" trigger.
  if (
    type === 'BATTLEFIELD' &&
    card.supportLevel === 'partial' &&
    keywords.every((k) => MVP_SET.has(k.name))
  ) {
    const triggers = parseBattlefieldAbilities(text);
    if (triggers) {
      card.triggers = triggers;
      card.supportLevel = 'full';
    }
  }
  if (deckRule && deckRule.name === row.name && card.supportLevel === 'full') {
    card.unlimitedCopies = true;
  }
  // R76: likewise the extra play locations.
  if (playToLine && card.supportLevel === 'full') card.playTo = playToLine.playTo;
  // R61: likewise the Flow cost.
  if (flowLine && card.supportLevel === 'full') card.flowCost = flowLine.cost;
  if (showOff && card.supportLevel === 'full') {
    card.optionalAdditionalCost = { energy: 0, card: showOff.cost };
  }
  if (spellFlags && card.supportLevel === 'full') {
    if (spellFlags.uncounterable) card.uncounterable = true;
    if (spellFlags.ignoreDeflect) card.ignoreDeflect = true;
  }
  // R58: likewise the optional additional cost.
  if (optionalExtra && card.supportLevel === 'full')
    card.optionalAdditionalCost = optionalExtra.cost;
  // R51: likewise the static abilities.
  if (staticLines && card.supportLevel === 'full') card.statics = staticLines.statics;
  // R50: likewise the self cost reduction.
  if (selfCost && card.supportLevel === 'full') card.costReduction = selfCost.reduction;
  // R47: the additional cost is stored only on a card that is fully supported without it.
  if (additional && card.supportLevel === 'full') card.additionalCost = { card: additional.cost };
  // Rule 818: structured Equip cost for Equipment.
  if (type === 'GEAR' && keywords.some((k) => k.name === 'Equip')) {
    const equipCost = parseEquipCost(text);
    if (equipCost) card.equipCost = equipCost;
  }
  if (row.subtitle) card.subtitle = row.subtitle;
  if (row.imageUrl) card.imageUrl = row.imageUrl;
  return { card, warnings, unknownDomains };
}

/** Showcase rarity, "sp" collector numbers, or lettered variants like "063a-166". */
function isAlternate(row: RawRow): boolean {
  const num = String(row.cardNumber ?? '');
  return (
    String(row.rarity ?? '').toLowerCase() === 'showcase' ||
    /sp/i.test(num) ||
    /^\d+[a-z]/i.test(num)
  );
}

function numericCardNumber(row: RawRow): number {
  const n = parseInt(String(row.cardNumber ?? ''), 10);
  return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}

function printingOrder(a: RawRow, b: RawRow): number {
  const alt = Number(isAlternate(a)) - Number(isAlternate(b));
  if (alt !== 0) return alt;
  const num = numericCardNumber(a) - numericCardNumber(b);
  if (num !== 0) return num;
  return a.cardCode < b.cardCode ? -1 : a.cardCode > b.cardCode ? 1 : 0;
}

export interface DedupeResult {
  kept: RawRow[];
  /** dropped cardCode -> kept cardCode */
  aliases: Record<string, string>;
}

/** Group by fullName (+ type); keep the base printing of each group. */
export function dedupePrintings(rows: RawRow[]): DedupeResult {
  const groups = new Map<string, RawRow[]>();
  for (const row of rows) {
    const name = row.fullName || [row.name, row.subtitle].filter(Boolean).join(', ');
    const key = `${String(row.cardType).toLowerCase()}|${name}`;
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }
  const kept: RawRow[] = [];
  const aliases: Record<string, string> = {};
  for (const g of groups.values()) {
    const sorted = [...g].sort(printingOrder);
    const keep = sorted[0] as RawRow;
    kept.push(keep);
    for (const other of sorted.slice(1)) {
      if (other.cardCode !== keep.cardCode) aliases[other.cardCode] = keep.cardCode;
    }
  }
  return { kept, aliases };
}

export function createCardValidator(
  schemaPath = fileURLToPath(new URL('../../resources/card-schema.json', import.meta.url)),
): (card: unknown) => string[] {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  return (card) => {
    if (validate(card)) return [];
    return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  };
}
