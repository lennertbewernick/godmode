/**
 * Pins between `server/` and `src/` that would otherwise be a comment.
 *
 * Runs in the default jsdom environment, unlike the rest of the server suite, because it imports
 * `src/data/exchange.ts` for real — and that module reaches `getDB()` -> `idb` at load time.
 */

import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT_VERSION } from '../src/data/exchange.js';
import { DB_VERSION } from '../src/db/schema.js';
import { SUPPORTED_BACKUP_FORMAT_VERSION, validateBackupStrict } from './validate.js';
import { MAXIMAL_BACKUP, clone } from './fixtures.js';

describe('version pins', () => {
  it('reads exactly the backup format the app writes', () => {
    expect(SUPPORTED_BACKUP_FORMAT_VERSION).toBe(BACKUP_FORMAT_VERSION);
  });

  it('accepts a backup carrying the current IndexedDB version', () => {
    const backup = clone(MAXIMAL_BACKUP) as unknown as Record<string, unknown>;
    backup['dbVersion'] = DB_VERSION;
    expect(() => validateBackupStrict(backup)).not.toThrow();
  });
});
