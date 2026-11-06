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
  parseSpellText,
} from '../../engine/src/cardText';
import { DOMAINS, MVP_KEYWORDS } from '../../engine/src/types/card';
import type {
  CardDef,
  CardType,
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

const MVP_SET = new Set<string>(MVP_KEYWORDS);
/** Keywords whose behaviour the ability parser turns into triggers (R5, R42): not MVP, but not blockers. */
const PARSED_KEYWORDS = new Set<string>(['Deathknell', 'Disarm', 'Weaponmaster']);

/** Errata marker; in the real data it may be split across lines ("▲\n[OLD TEXT]"). */
const OLD_TEXT_RE = /▲?\s*\[OLD TEXT\][\s\S]*$/;

/** Strip the errata marker (and everything after it) and normalise symbols. */
export function normalizeText(raw: string | null | undefined): string {
  const text = (raw ?? '').replace(OLD_TEXT_RE, '');
  return text.replace(/\[S\]/g, '[M]').replace(/\[T\]/g, '[E]').trim();
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
  if (/reduced by the Might/i.test(rest)) {
    cost.energyReducedByMight = true;
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
  const additional =
    type === 'UNIT' || type === 'SPELL' || type === 'GEAR' ? parseAdditionalCost(fullText) : null;
  const text = additional ? additional.rest : fullText;
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
    keywords.every((k) => MVP_SET.has(k.name) || (k.name === 'Repeat' && repeatCost !== null))
  ) {
    const effects = parseSpellText(text);
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
    const parsed = parseCardAbilities(text, { gearLike: type === 'GEAR' });
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
    keywords.every((k) => MVP_SET.has(k.name))
  ) {
    const parsed = parseCardAbilities(text);
    if (
      parsed &&
      parsed.abilities.length === 0 &&
      parsed.triggers.length > 0 &&
      parsed.triggers.every((t) => t.on === 'YOU_PLAY') &&
      !parsed.entersReady &&
      !parsed.entersExhausted &&
      parsed.legionCostReduction === undefined
    ) {
      card.triggers = parsed.triggers;
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
