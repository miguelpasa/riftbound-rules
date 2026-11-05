import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** The tests need client/public/cards.json; build it with `npm run cards` when absent. */
export default function globalSetup(): void {
  const root = resolve(import.meta.dirname, '..');
  if (!existsSync(resolve(root, 'client/public/cards.json'))) {
    console.log('[e2e] client/public/cards.json missing: running `npm run cards` ...');
    execSync('npm run cards', { cwd: root, stdio: 'inherit' });
  }
}
