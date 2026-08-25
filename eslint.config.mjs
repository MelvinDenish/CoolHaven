/**
 * ESLint flat config.
 *
 * `npm run lint` was in package.json from the start but there was never a
 * config behind it, so it dropped into `next lint`'s interactive setup prompt -
 * meaning it had never actually run, and would have hung CI if anything had
 * called it.
 *
 * eslint-config-next is pinned to the SAME major as `next` itself (15.x). The
 * 16.x config was tried first and rejected: it ships React Compiler era rules
 * that this codebase's React version does not follow, so it flagged deliberate,
 * documented patterns - the ref-holds-latest-callback idiom in MapCanvas, and
 * setState-in-effect for data fetching - as errors. Linting against rules from
 * a framework version you are not running produces noise, not signal.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'data/**',
      'out/**',
      'next-env.d.ts',
      'eslint.config.mjs',
    ],
  },
  ...compat.extends('next/core-web-vitals'),
];

export default config;
