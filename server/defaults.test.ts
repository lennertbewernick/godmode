// @vitest-environment node
//
// The one constant `server/` copies from `src/` instead of importing.
//
// `DEFAULT_SETTINGS` lives in `src/db/schema.ts`, which imports `idb` at module scope — a
// browser storage library that has no business being loaded into the server process, and which
// would make the compiled server depend on it. So `server/db.ts` restates the value and this
// test holds the two together by importing both for real.
//
// Node environment, not jsdom: `server/schema.ts` resolves `schema.sql` through
// `fileURLToPath(import.meta.url)`, and under jsdom `import.meta.url` is an http URL.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_ROW } from './db.js';
import { DEFAULT_SETTINGS } from '../src/db/schema.js';

describe('default settings', () => {
  it('are exactly what a fresh IndexedDB build would have used', () => {
    expect(DEFAULT_SETTINGS_ROW).toEqual(DEFAULT_SETTINGS);
  });

  it('carry no optional property, so an untouched row round-trips as absent', () => {
    expect(Object.keys(DEFAULT_SETTINGS_ROW).sort()).toEqual(['id', 'kcalCoefficient']);
  });
});
