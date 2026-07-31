/**
 * Opening the one database, and the transaction discipline everything above depends on.
 *
 * Three things live here because getting any of them wrong is silent rather than loud:
 *
 * 1. **Where the file lives.** Never inside the repository. `git clean -xdf` deletes ignored
 *    files and is the ordinary way to get a clean tree, so a gitignored database inside a
 *    checkout is one routine command away from gone (`.planning/BACKLOG.md`). The resolution
 *    order is explicit, the directory is created on first run, and an unwritable directory is a
 *    startup failure rather than a fallback to somewhere surprising.
 *
 * 2. **Per-connection pragmas.** `foreign_keys` is OFF by default in SQLite, is not stored in
 *    the file, and every FOREIGN KEY in `schema.sql` is silently ignored until it is turned on
 *    for *this* connection. `server/schema.ts:armConnection` owns that; this module makes sure
 *    it is called on every path that hands out a connection.
 *
 * 3. **Write transactions begin IMMEDIATE.** Every command in `routes.ts` is read-check-write:
 *    read `meta.revision`, compare, then write. A deferred transaction takes a read lock first
 *    and tries to upgrade at the first write, which under concurrency fails with SQLITE_BUSY
 *    *after* the check has already passed — the classic lost-update shape. `BEGIN IMMEDIATE`
 *    takes the write lock up front, so the check and the write are one indivisible step.
 *
 * 4. **The ownership lock is taken before the file is opened, and held until it is closed.** This
 *    is one half of the contract in `server/lock.ts`; the migration importer is the other. Without
 *    it, `server/migrate.ts` can rename a fresh database over the file this process has open, and
 *    every write this process makes afterwards goes to an inode nothing will ever read again.
 */

import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireLock, type HeldLock } from './lock.js';
import { SETTINGS_ROW_ID } from './fields.js';
import { migrateFileToCurrent } from './migrate-schema.js';
import { SETTINGS, TENANT_COLUMN, bindValues, insertSql, type TableMapping } from './rows.js';
import { SCHEMA_VERSION, applySchema, armConnection, assertSchemaVersion } from './schema.js';
import { ensureBootstrapUser, resolveOwner } from './users.js';
import type { SettingsRecord } from '../src/db/schema.js';

/** The file inside the data directory. Named, not derived, so a rename is a deliberate edit. */
export const DATABASE_FILENAME = 'godmode.sqlite';

/** The application's own directory name under whichever platform root applies. */
export const APP_DIR_NAME = 'godmode';

export class DataDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataDirError';
  }
}

/** Just enough of the environment to resolve a path, so tests never have to fake `process`. */
export interface Host {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly homedir: string;
}

export function currentHost(): Host {
  return { env: process.env, platform: process.platform, homedir: osHomedir() };
}

/**
 * Where the database lives, per `.planning/BACKLOG.md`.
 *
 * `GODMODE_DATA_DIR` wins always — that is the escape hatch a container or a developer uses
 * (`GODMODE_DATA_DIR=./.data` is a legitimate development choice; it is never the default,
 * because then real data would inherit a development convenience).
 *
 * Otherwise the platform's own place for application state. Deliberately not the home directory
 * root and deliberately not the repository.
 */
export function resolveDataDir(host: Host = currentHost()): string {
  const override = host.env['GODMODE_DATA_DIR']?.trim();
  if (override !== undefined && override !== '') {
    return isAbsolute(override) ? override : resolve(override);
  }

  if (host.platform === 'darwin') {
    return join(host.homedir, 'Library', 'Application Support', APP_DIR_NAME);
  }

  const xdg = host.env['XDG_DATA_HOME']?.trim();
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) {
    return join(xdg, APP_DIR_NAME);
  }
  return join(host.homedir, '.local', 'share', APP_DIR_NAME);
}

/**
 * Create the directory if it is missing, and refuse to continue if it cannot hold the database.
 *
 * Checked before the file is opened rather than after, because `node:sqlite` reports an
 * unwritable directory as a generic "unable to open database file" that tells the owner nothing
 * about which of the several possible causes he is looking at.
 */
export function ensureDataDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new DataDirError(
      `The data directory ${dir} could not be created (${describe(cause)}). ` +
        'Set GODMODE_DATA_DIR to a directory this user can write to. Nothing has been opened.',
    );
  }

  const stats = statSync(dir);
  if (!stats.isDirectory()) {
    throw new DataDirError(`${dir} exists but is not a directory. Nothing has been opened.`);
  }

  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch {
    throw new DataDirError(
      `The data directory ${dir} is not writable by this user. ` +
        'The database would be unreadable and every write would fail, so the server will not ' +
        'start. Nothing has been opened.',
    );
  }
  return dir;
}

export interface OpenOptions {
  /** Skip resolution entirely — the tests and the migration importer both need an exact path. */
  readonly dataDir?: string;
  readonly host?: Host;
  readonly filename?: string;
  /**
   * Take the exclusive ownership lock. On by default, and the default is the point.
   *
   * `false` exists for the one legitimate case: a test that deliberately opens a *second*
   * connection to the same file to prove SQLite's own write locking. Production never sets it, and
   * a connection opened this way carries no protection against the importer.
   */
  readonly exclusive?: boolean;
  /** Told when a provably stale lock was reclaimed. Defaults to a warning on stderr. */
  readonly onStaleLockReclaimed?: (message: string) => void;
}

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly dataDir: string;
  /** True when this call created the schema, rather than opening an existing database. */
  readonly created: boolean;
  /** The ownership lock, held until `close`. `undefined` only when `exclusive: false`. */
  readonly lock: HeldLock | undefined;
  /**
   * Close the connection and release the lock, in that order.
   *
   * Both, always: releasing the lock while the connection is still open would advertise the file
   * as free while this process still had it, which is precisely the state the lock exists to make
   * impossible. Safe to call twice.
   */
  close(): void;
}

/**
 * Open — or create — the database and return a connection that is safe to use.
 *
 * "Safe to use" is the whole point of routing every open through here: exclusive ownership of the
 * file, foreign keys on, a busy timeout so a concurrent writer is waited for rather than crashed
 * into, WAL so a reader never blocks the writer, `synchronous = FULL` because this file is the
 * only copy of months of training and a lost final commit is not an acceptable trade for a few
 * milliseconds, and a schema version that this build actually understands.
 *
 * The lock comes first, before the file is touched at all, so a refusal means nothing was opened.
 */
export function openDatabase(options: OpenOptions = {}): OpenedDatabase {
  const host = options.host ?? currentHost();
  const dataDir = ensureDataDir(options.dataDir ?? resolveDataDir(host));
  const path = join(dataDir, options.filename ?? DATABASE_FILENAME);
  const owner = resolveOwner(host.env);

  const warn =
    options.onStaleLockReclaimed ??
    ((message: string) => {
      console.warn(message);
    });

  // Bring an older on-disk schema up to this build's version before anything opens the file for
  // writing. The migration takes and releases its own ownership lock (`server/migrate-schema.ts`),
  // so it must run before the server's lock below, not after — a rename under an open connection is
  // exactly what the lock exists to prevent. Skipped for the non-exclusive test connection, which
  // deliberately opens a second handle to a file another connection already owns.
  if (options.exclusive !== false) {
    migrateFileToCurrent(path, {
      owner: { email: owner.email, displayName: owner.displayName },
      onMigrated: warn,
    });
  }

  const lock =
    options.exclusive === false
      ? undefined
      : acquireLock({
          databasePath: path,
          role: 'server',
          // The server must come back after a power cut without a human deleting a file. It only
          // ever breaks a lock whose holder is *provably* gone — see `server/lock.ts`.
          reclaimStale: true,
          onReclaim: (info) => {
            warn(
              `[godmode] a lock left behind by process ${String(info.holder?.pid ?? 0)} was ` +
                `reclaimed: ${info.reason}. The old lock file was kept at ${info.sidelinedTo}.`,
            );
          },
        });

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    lock?.release();
    throw cause;
  }

  try {
    // WAL survives across connections once set, but setting it is idempotent and cheap.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = FULL;');
    armConnection(db);

    const fresh = !hasMetaTable(db);
    if (fresh) {
      applySchema(db);
    } else {
      assertSchemaVersion(db);
    }
    // Every database — fresh or migrated — has exactly one bootstrap owner (`server/users.ts`), so
    // the token exchange has a user to mint sessions for and every per-user query has a tenant.
    // Idempotent: a migrated file already carries the owner, and this leaves it untouched.
    ensureBootstrapUser(db, { email: owner.email, displayName: owner.displayName });
    let closed = false;
    return {
      db,
      path,
      dataDir,
      created: fresh,
      lock,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          db.close();
        } finally {
          lock?.release();
        }
      },
    };
  } catch (cause) {
    // `finally`, not a second statement: a `db.close()` that throws would otherwise skip the
    // release and replace the real startup error with its own, leaving a lock file behind that
    // nothing ever cleans up.
    try {
      db.close();
    } finally {
      lock?.release();
    }
    throw cause;
  }
}

function hasMetaTable(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  return row !== undefined;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ── Transactions ────────────────────────────────────────────────────────────────────────────

/**
 * Run `body` inside one write transaction, committing on return and rolling back on throw.
 *
 * IMMEDIATE, not DEFERRED: see the note at the top of this file. Not re-entrant — SQLite has no
 * nested transactions, and pretending otherwise with savepoints would let a caller believe an
 * inner failure had been undone when the outer transaction had already committed part of it.
 */
export function inWriteTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = body();
    // COMMIT is inside the guard, not after it. `schema.sql` declares its foreign keys
    // `DEFERRABLE INITIALLY DEFERRED`, so a dangling reference is not reported by the INSERT
    // that created it — it is reported by the COMMIT. A commit that throws while the helper is
    // not looking leaves this process's one shared connection inside an open transaction, and
    // every request after it fails with "cannot start a transaction within a transaction".
    db.exec('COMMIT;');
    return result;
  } catch (cause) {
    rollbackQuietly(db);
    throw cause;
  }
}

/**
 * Run `body` inside one read transaction, so a multi-table snapshot is one coherent view.
 *
 * Without it, six `SELECT`s are six points in time: a snapshot could contain a workout whose
 * plan slot it does not contain, and the client would render a history with a hole in it.
 */
export function inReadTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN DEFERRED;');
  try {
    const result = body();
    db.exec('COMMIT;');
    return result;
  } catch (cause) {
    rollbackQuietly(db);
    throw cause;
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK;');
  } catch {
    // SQLite already rolled back and closed the transaction — for instance on a constraint
    // failure that aborted the statement. Reporting *this* would bury the real error.
  }
}

// ── The revision counter ────────────────────────────────────────────────────────────────────

/**
 * The per-user dataset version for optimistic concurrency (`user_revisions`, v2).
 *
 * One counter per user rather than per record, because the commands here are multi-record by
 * nature — starting the next block touches challenges, plan slots, performance tests and settings
 * in one transaction — and a per-record version would have to be checked in a set the client
 * cannot know in advance. Per *user* rather than per *file* (v1's `meta.revision`) so one user's
 * write never bumps the revision another user's client is holding and 409s their next command.
 *
 * Every user has a `user_revisions` row from the moment they are created (`server/users.ts`); a
 * missing row is a bug, not a fresh-user default, and is reported rather than silently zeroed.
 */
export function readRevision(db: DatabaseSync, userId: string): number {
  const row = db.prepare(`SELECT revision FROM user_revisions WHERE ${TENANT_COLUMN} = ?`).get(
    userId,
  ) as { revision: number } | undefined;
  if (row === undefined) {
    throw new Error(`no user_revisions row for user "${userId}": the user was not created cleanly`);
  }
  return row.revision;
}

/** Bump one user's revision. Called exactly once per accepted command, inside its transaction. */
export function bumpRevision(db: DatabaseSync, userId: string, nowIso: string): number {
  const next = readRevision(db, userId) + 1;
  db.prepare(`UPDATE user_revisions SET revision = ?, updated_at = ? WHERE ${TENANT_COLUMN} = ?`).run(
    next,
    nowIso,
    userId,
  );
  return next;
}

// ── Record helpers ──────────────────────────────────────────────────────────────────────────
//
// `userId` scopes every `perUser` table (`server/rows.ts`): it is injected on insert and required
// on read, so no helper can reach across users. For a global table (`exercises`) it is ignored —
// the argument is still required so call sites are uniform and cannot forget it for a table that
// does need it.

/** Insert one record through its table mapping. Plain INSERT — never `INSERT OR REPLACE`. */
export function insertRecord<R>(
  db: DatabaseSync,
  mapping: TableMapping<R>,
  record: R,
  userId: string,
): void {
  const values = bindValues(mapping, mapping.encode(record));
  if (mapping.perUser) {
    const columns = [TENANT_COLUMN, ...mapping.columns];
    const placeholders = columns.map(() => '?').join(', ');
    db.prepare(`INSERT INTO ${mapping.table} (${columns.join(', ')}) VALUES (${placeholders})`).run(
      userId,
      ...values,
    );
    return;
  }
  db.prepare(insertSql(mapping)).run(...values);
}

/** Read one record by primary key within the user's scope. Decoding re-validates it. */
export function findRecord<R>(
  db: DatabaseSync,
  mapping: TableMapping<R>,
  id: string,
  userId: string,
): R | undefined {
  const row = mapping.perUser
    ? db.prepare(`SELECT * FROM ${mapping.table} WHERE id = ? AND ${TENANT_COLUMN} = ?`).get(id, userId)
    : db.prepare(`SELECT * FROM ${mapping.table} WHERE id = ?`).get(id);
  return row === undefined ? undefined : mapping.decode(row as Record<string, unknown>);
}

/** Read every record of a table the user owns, in a stated order. */
export function listRecords<R>(
  db: DatabaseSync,
  mapping: TableMapping<R>,
  orderBy: string,
  userId: string,
): R[] {
  const rows = mapping.perUser
    ? db.prepare(`SELECT * FROM ${mapping.table} WHERE ${TENANT_COLUMN} = ? ORDER BY ${orderBy}`).all(userId)
    : db.prepare(`SELECT * FROM ${mapping.table} ORDER BY ${orderBy}`).all();
  return rows.map((row) => mapping.decode(row as Record<string, unknown>));
}

/**
 * The settings a fresh database has before anything has been saved.
 *
 * `schema.sql` deliberately does not seed a settings row: the migration importer inserts the
 * one from the backup, and a seeded row would collide with it. So an absent row means
 * "defaults", exactly as `src/db/repo.ts:69` already treats it. `server/defaults.test.ts` pins
 * this against `DEFAULT_SETTINGS` in `src/db/schema.ts` so the two cannot drift; it is copied
 * rather than imported because importing that module pulls `idb` into the server process.
 */
export const DEFAULT_SETTINGS_ROW: SettingsRecord = {
  id: SETTINGS_ROW_ID,
  kcalCoefficient: 0.003,
};

export function readSettings(db: DatabaseSync, userId: string): SettingsRecord {
  const row = db.prepare(`SELECT * FROM settings WHERE ${TENANT_COLUMN} = ?`).get(userId);
  return row === undefined
    ? { ...DEFAULT_SETTINGS_ROW }
    : SETTINGS.decode(row as Record<string, unknown>);
}

/**
 * Write one user's settings row, creating it if this is their first save.
 *
 * `ON CONFLICT (user_id) DO UPDATE`, never `INSERT OR REPLACE`: replace deletes the existing row
 * and inserts a new one, which fires `ON DELETE` actions and would make settings a foreign-key
 * hazard for no reason. `SETTINGS.columns` is the domain columns only; `user_id` is prepended
 * here, exactly as `insertRecord` does for every other `perUser` table.
 */
export function writeSettings(db: DatabaseSync, userId: string, record: SettingsRecord): void {
  const columns = [TENANT_COLUMN, ...SETTINGS.columns];
  const placeholders = columns.map(() => '?').join(', ');
  const assignments = SETTINGS.columns
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const sql =
    `INSERT INTO settings (${columns.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT (${TENANT_COLUMN}) DO UPDATE SET ${assignments}`;
  db.prepare(sql).run(userId, ...bindValues(SETTINGS, SETTINGS.encode(record)));
}

/** Re-exported so callers do not have to know which module owns the number. */
export { SCHEMA_VERSION };
