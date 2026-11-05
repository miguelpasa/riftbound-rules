// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'data/**', 'playwright-report/**', 'test-results/**'],
  },
  ...tseslint.configs.recommended,
);
