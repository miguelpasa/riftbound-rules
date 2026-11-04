/** Print generated preset decks from client/public/cards.json. Usage: tsx scripts/preview-decks.ts [count] */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CardDatabase } from '../engine/src/types/card';
import { buildPresetDecks } from '../client/src/decks/presets';

const path = fileURLToPath(new URL('../client/public/cards.json', import.meta.url));
const cards = JSON.parse(readFileSync(path, 'utf8')) as CardDatabase;
const count = Number(process.argv[2] ?? 1000);
const diagnostics: string[] = [];
const presets = buildPresetDecks(cards, { count, diagnostics });
let full = 0;
let total = 0;
for (const p of presets) {
  full += p.stats.fullSupportCount;
  total += p.stats.fullSupportCount + p.stats.partialCount;
  console.log(
    `${p.name.padEnd(40)} full=${p.stats.fullSupportCount}/40 avgEnergy=${p.stats.avgEnergy}`,
  );
}
const ratio = ((full / Math.max(total, 1)) * 100).toFixed(1);
console.log(`\n${presets.length} legal presets; full-support ratio ${ratio}%`);
console.log(`Diagnostics (${diagnostics.length}):`);
for (const d of diagnostics) console.log(`  ${d}`);
