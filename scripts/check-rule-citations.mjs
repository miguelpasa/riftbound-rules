// Verifies that every it(...) / test(...) block in engine/src/**/*.test.ts
// carries a `// Tests Rule` citation between its call and the next it/test call (or EOF).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TESTS_DIR = join(ROOT, 'engine', 'src');
const CALL_PATTERN = /\b(?:it|test)\s*\(/g;
const CITATION = '// Tests Rule';

function findTestFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...findTestFiles(full));
    } else if (name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function checkFile(file) {
  const text = readFileSync(file, 'utf8');
  const matches = [...text.matchAll(CALL_PATTERN)];
  const violations = [];
  matches.forEach((match, i) => {
    const start = match.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end);
    if (!block.includes(CITATION)) {
      violations.push(lineOf(text, start));
    }
  });
  return violations;
}

const files = findTestFiles(TESTS_DIR);
let failures = 0;
let checked = 0;

for (const file of files) {
  const lines = checkFile(file);
  checked += (readFileSync(file, 'utf8').match(CALL_PATTERN) ?? []).length;
  for (const line of lines) {
    failures++;
    const display = relative(ROOT, file).split(sep).join('/');
    console.error(`${display}:${line} it/test block has no "${CITATION}" comment`);
  }
}

if (failures > 0) {
  console.error(`\ncheck:rules failed: ${failures} block(s) missing a rule citation.`);
  process.exit(1);
}

console.log(
  `check:rules passed: ${checked} it/test block(s) across ${files.length} file(s) cite a rule.`,
);
