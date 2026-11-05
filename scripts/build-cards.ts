/**
 * Build client/public/cards.json (+ card-aliases.json) from data/raw/cards.json.
 * Usage: tsx scripts/build-cards.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CardDatabase } from '../engine/src/types/card';
import { convertRow, createCardValidator, dedupePrintings, normalizeRow } from './lib/cardConvert';

const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));

const rawRows = JSON.parse(readFileSync(root('data/raw/cards.json'), 'utf8')) as Record<
  string,
  unknown
>[];
const rows = rawRows.map(normalizeRow);
const { kept, aliases } = dedupePrintings(rows);
const validate = createCardValidator(root('resources/card-schema.json'));

const db: CardDatabase = {};
const warnings: string[] = [];
const unknownDomains = new Set<string>();
const invalid: string[] = [];

for (const row of kept.sort((a, b) => (a.cardCode < b.cardCode ? -1 : 1))) {
  const res = convertRow(row);
  warnings.push(...res.warnings);
  res.unknownDomains.forEach((d) => unknownDomains.add(d));
  if (!res.card) continue;
  const errs = validate(res.card);
  if (errs.length > 0) {
    invalid.push(`${res.card.cardId} (${res.card.name}): ${errs.join('; ')}`);
    continue;
  }
  db[res.card.cardId] = res.card;
}

if (invalid.length > 0) {
  console.error(`Schema validation failed for ${invalid.length} card(s):`);
  invalid.forEach((l) => console.error(`  ${l}`));
  process.exit(1);
}

mkdirSync(root('client/public'), { recursive: true });
writeFileSync(root('client/public/cards.json'), JSON.stringify(db));
writeFileSync(root('client/public/card-aliases.json'), JSON.stringify(aliases));

const count = <T>(items: T[], key: (t: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
};
const cards = Object.values(db);
console.log(`Total rows:        ${rows.length}`);
console.log(`Cards emitted:     ${cards.length}`);
console.log(`Deduped printings: ${Object.keys(aliases).length}`);
console.log(
  'By type:        ',
  count(cards, (c) => c.type),
);
console.log(
  'By supportLevel:',
  count(cards, (c) => c.supportLevel),
);
console.log(
  'Keyword freq:   ',
  count(
    cards.flatMap((c) => c.keywords),
    (k) => k.name,
  ),
);
console.log('Unknown domains:', [...unknownDomains]);
console.log(`Weird data (${warnings.length}):`);
warnings.slice(0, 50).forEach((w) => console.log(`  ${w}`));
if (warnings.length > 50) console.log(`  ... ${warnings.length - 50} more`);
