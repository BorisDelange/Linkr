import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `dist` = build output; `public` holds vendored worker bundles (DuckDB-WASM
  // etc.) we don't author and must never lint.
  globalIgnores(['dist', 'public']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // `_`-prefixed names are intentionally unused (e.g. destructuring rest,
      // ignored callback args, omitted-on-purpose state setters).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // This only protects Vite's dev-time fast-refresh, not production
      // correctness. Keep it visible as a warning rather than gating CI on it.
      'react-refresh/only-export-components': 'warn',
      // React Compiler rule, but the compiler is NOT enabled in our build, so
      // these flag no real runtime bug today. Keep visible (for when we do
      // enable it) without gating CI.
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  {
    // shadcn/ui components ship component + variants from one file by design
    // (e.g. `Button` + `buttonVariants`). Don't fight the upstream pattern.
    // `purity` is also off: the skeleton's `Math.random()` width (in a
    // useMemo) is intentional upstream code, not a render-purity bug.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/purity': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
