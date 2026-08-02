/**
 * Loading `schema.sql` and arming a connection.
 *
 * Small on purpose. It exists so that there is exactly one place that knows a connection is not
 * usable until `PRAGMA foreign_keys = ON` has been issued **on that connection** — SQLite
 * defaults it OFF, does not persist it in the file, and silently ignores every FOREIGN KEY in
 * the schema until it is set. A per-connection setting that everyone must remember is a defect
 * waiting for the one caller who forgets.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

/** Must equal `meta.schema_version` seeded by `schema.sql`. */
export const SCHEMA_VERSION = 3;

/**
 * The `meta.schema_version` currently in a file, or `undefined` if there is no readable meta row.
 *
 * Used by the in-place upgrade path (`server/migrate-schema.ts`) to decide whether a file needs
 * migrating before `assertSchemaVersion` would refuse it. Reads exactly one column and never
 * throws on a missing table — a database without `meta` is one this build did not create.
 */
export function readSchemaVersion(db: DatabaseSync): number | undefined {
  const row = db.prepare('SELECT schema_version FROM meta WHERE id = ?').get('meta') as
    | { schema_version?: unknown }
    | undefined;
  return typeof row?.schema_version === 'number' ? row.schema_version : undefined;
}

export const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

export function readSchemaSql(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * Turn on foreign keys for this connection, and ask SQLite to fail rather than wait forever if
 * another connection holds a write lock.
 */
export function armConnection(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
}

/** Create every table and index in a fresh database, then arm the connection. */
export function applySchema(db: DatabaseSync): void {
  db.exec(readSchemaSql());
  armConnection(db);
  assertSchemaVersion(db);
}

export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

/**
 * Refuse a database this build does not understand, before reading or writing a single record.
 *
 * `meta.schema_version >= 1` is all the DDL can say about itself; it cannot know which build is
 * opening it. Without this check an older binary opens a newer file and reads it happily,
 * ignoring whatever the newer schema added — the same class of silent loss as an unknown
 * property in a backup, but against the live dataset. Newer *and* unexpected older versions are
 * both refused: a migration is a deliberate act, not something a mismatched version number
 * should be allowed to imply.
 *
 * Every connection that opens an existing file must call this. `applySchema` calls it for a
 * fresh one.
 */
export function assertSchemaVersion(db: DatabaseSync): void {
  const rows = db.prepare('SELECT schema_version FROM meta').all() as { schema_version: number }[];
  if (rows.length !== 1) {
    throw new SchemaVersionError(
      `This database has ${String(rows.length)} meta rows; exactly one is required. ` +
        'Nothing has been read or written.',
    );
  }
  const found = rows[0]?.schema_version;
  if (found !== SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `This database is schema version ${String(found)}; this build understands ` +
        `${String(SCHEMA_VERSION)}. Nothing has been read or written.`,
    );
  }
}

/** `PRAGMA foreign_keys` as a boolean — the check a caller should be able to make cheaply. */
export function foreignKeysEnabled(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
  return row?.foreign_keys === 1;
}
