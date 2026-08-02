/**
 * In-place schema upgrade: an older on-disk database becomes a current one, and is proven before
 * it is trusted.
 *
 * This is the sibling of `server/migrate.ts`. That module turns a backup JSON into a database;
 * this one turns an *older database* into a current-version database. Both hold the same line: the
 * only copy of months of training is never edited in place and hoped for. A fresh file is built in
 * a temporary path, verified by `server/verify.ts` interrogating the actual SQLite file, and only
 * then renamed over the original — the single atomic operation that touches the target. A crash at
 * any point before the rename leaves the original exactly as it was; the previous file is copied
 * aside and kept.
 *
 * ## v1 → current (LBV-1478): single-tenant → multi-user, by rebuild
 *
 * v1 was global: every table was shared, `settings`/`meta` were single-row, one `meta.revision`
 * served the whole file. v2 added tenancy (`server/schema.sql`). The upgrade reads the v1 dataset —
 * which is tenancy-blind, since the record types carry no `user_id` — assigns all of it to the
 * bootstrap owner (`server/users.ts`), and seeds that owner's per-user revision from v1's old
 * global one. The owner's history survives, now owned by a real `users` row that the auth ticket
 * can later attach real credentials to. It builds a *fresh* file with `applySchema`, so a v1 file
 * lands directly at the current `SCHEMA_VERSION` (v3) — the fresh schema is the current one, and
 * the v2→v3 additions (`goal_text`, `push_subscriptions`) are simply present in it.
 *
 * The migration takes and holds its own ownership lock (`server/lock.ts`) for the whole read →
 * build → rename, and runs BEFORE the server opens the file for writing (`server/db.ts`). It must:
 * a rename under a connection another process still has open is the precise hazard the lock exists
 * to prevent.
 *
 * ## v2 → v3 (LBV-1575): additive, IN PLACE
 *
 * v3 adds only `settings.goal_text` and the `push_subscriptions` table + index — a purely additive
 * change (ADR 0002). Additive-only changes carry none of the insert-order / FK hazards that made
 * v1→v2 a rebuild, so this one migrates in place: a guarded `ALTER TABLE ADD COLUMN` and a
 * `CREATE TABLE IF NOT EXISTS`-equivalent, inside one transaction, then the version bump. It is
 * idempotent because production was already hotfixed to carry both objects while still reporting
 * version 2 (`ops/lbv1572-hotfix.mjs`): on such a file the guards skip the DDL and only the version
 * moves. A safety copy of the pre-v3 file is still taken first — this is the only copy of the data.
 *
 * `server/migrate-schema.test.ts` proves, against a frozen v2 snapshot schema, that a database
 * brought up by this migration is schema-identical to one built fresh from `schema.sql`: the drift
 * that caused LBV-1572 fails the build rather than production.
 */

import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readDataset, writeDataset } from './dataset.js';
import { LockUnavailableError, acquireLock, type HeldLock } from './lock.js';
import {
  SCHEMA_VERSION,
  applySchema,
  armConnection,
  readSchemaVersion,
} from './schema.js';
import { BOOTSTRAP_USER_ID, ensureBootstrapUser } from './users.js';
import { verifyDatabase, type ExpectedState } from './verify.js';

export class SchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMigrationError';
  }
}

export interface OwnerIdentity {
  readonly email: string;
  readonly displayName: string;
}

export interface MigrateFileOptions {
  readonly owner: OwnerIdentity;
  /** Told, once, when a migration actually ran. Defaults to a stderr warning. */
  readonly onMigrated?: (message: string) => void;
  /** Break a lock whose holder is provably gone (a crash). Never breaks a live holder. */
  readonly breakStaleLock?: boolean;
}

export interface MigrateFileResult {
  readonly migrated: boolean;
  readonly fromVersion?: number;
  readonly toVersion?: number;
  readonly safetyCopyPath?: string;
}

/**
 * Bring `path` up to `SCHEMA_VERSION` if it is behind, or do nothing.
 *
 * Returns without touching anything when the file is absent (a fresh database — `applySchema`
 * handles it), already current, or newer than this build (`assertSchemaVersion` will refuse it
 * with the right message once the server opens it). Only an older, understood version is migrated.
 */
export function migrateFileToCurrent(
  path: string,
  options: MigrateFileOptions,
): MigrateFileResult {
  if (!existsSync(path)) return { migrated: false };

  let version: number | undefined;
  const probe = new DatabaseSync(path, { readOnly: true });
  try {
    armConnection(probe);
    version = readSchemaVersion(probe);
  } catch {
    // Unreadable or not one of ours. Leave it for the server open path to report precisely.
    return { migrated: false };
  } finally {
    probe.close();
  }

  if (version === undefined) return { migrated: false };
  if (version >= SCHEMA_VERSION) return { migrated: false };
  if (version === 1) return migrateOneToCurrent(path, options);
  if (version === 2) return migrateTwoToThree(path, options);
  throw new SchemaMigrationError(
    `Database at ${path} is schema version ${String(version)}, which this build cannot ` +
      `migrate to ${String(SCHEMA_VERSION)}. Nothing has been changed.`,
  );
}

function migrateOneToCurrent(path: string, options: MigrateFileOptions): MigrateFileResult {
  const lock = acquireOwnership(path, options.breakStaleLock === true);
  try {
    // 1. Read the v1 file, read-only. Tenancy-blind: the record types carry no user_id, so the
    //    same decoders read a v1 row as a v2 one.
    const source = new DatabaseSync(path, { readOnly: true });
    let dataset;
    let revision: number;
    let createdAt: string;
    try {
      armConnection(source);
      const meta = source.prepare('SELECT revision, created_at FROM meta WHERE id = ?').get('meta') as
        | { revision: number; created_at: string }
        | undefined;
      if (meta === undefined) {
        throw new SchemaMigrationError(`${path} has no meta row; it was not created by this app.`);
      }
      revision = meta.revision;
      createdAt = meta.created_at;
      dataset = readDataset(source);
    } finally {
      source.close();
    }

    // 2. Build the v2 file in the target's own directory, so the rename is a same-filesystem move.
    const workDir = mkdtempSync(join(dirname(path), '.godmode-migrate-'));
    const temporaryPath = join(workDir, basename(path));
    try {
      const fresh = new DatabaseSync(temporaryPath);
      try {
        applySchema(fresh);
        const now = new Date().toISOString();
        // Preserve the file's original creation time; only touch updated_at.
        fresh
          .prepare('UPDATE meta SET created_at = ?, updated_at = ? WHERE id = ?')
          .run(createdAt, now, 'meta');
        ensureBootstrapUser(fresh, {
          email: options.owner.email,
          displayName: options.owner.displayName,
          now,
        });
        writeDataset(fresh, dataset, BOOTSTRAP_USER_ID);
        // Carry the owner's v1 global revision onto their v2 per-user counter.
        fresh
          .prepare('UPDATE user_revisions SET revision = ?, updated_at = ? WHERE user_id = ?')
          .run(revision, now, BOOTSTRAP_USER_ID);

        // 3. Prove it against the source, before the target is touched.
        const expected: ExpectedState = { dataset, revision, userId: BOOTSTRAP_USER_ID };
        verifyDatabase(fresh, expected);
      } finally {
        fresh.close();
      }

      // 4. Put it in place: fsync, copy the v1 file aside for good, then the atomic rename.
      fsyncPath(temporaryPath);
      const safetyCopyPath = copyAside(path, 1);
      assertStillOwned(lock);
      renameSync(temporaryPath, path);
      fsyncPath(dirname(path));

      const message =
        `[godmode] migrated ${path} from schema v1 to v${String(SCHEMA_VERSION)} ` +
        `(multi-user). The previous database was copied to ${safetyCopyPath} and left there.`;
      (options.onMigrated ?? ((m: string) => console.warn(m)))(message);

      return {
        migrated: true,
        fromVersion: 1,
        toVersion: SCHEMA_VERSION,
        safetyCopyPath,
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    lock.release();
  }
}

// ── v2 → v3: additive, in place ───────────────────────────────────────────────────────────────

/**
 * The two objects v3 adds over v2 (LBV-1481, shipped without a version bump — LBV-1572).
 *
 * These are token-equivalent to their definitions in `server/schema.sql`; the drift test proves a
 * database migrated with them is schema-identical to a fresh `applySchema`, so the two cannot
 * diverge unnoticed. `goal_text` is added as the LAST `settings` column because `ALTER TABLE ADD
 * COLUMN` appends, and the schema declares it last to match (see `schema.sql`).
 */
const ADD_GOAL_TEXT =
  'ALTER TABLE settings ADD COLUMN goal_text TEXT NULL ' +
  'CHECK (goal_text IS NULL OR length(goal_text) > 0)';

const CREATE_PUSH_SUBSCRIPTIONS = `CREATE TABLE push_subscriptions (
  endpoint   TEXT NOT NULL PRIMARY KEY CHECK (length(endpoint) > 0),
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  p256dh     TEXT NOT NULL CHECK (length(p256dh) > 0),
  auth       TEXT NOT NULL CHECK (length(auth) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*')
) STRICT`;

const CREATE_PUSH_SUBSCRIPTIONS_INDEX =
  'CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id)';

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
  return info.some((row) => row.name === column);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

/**
 * Apply the v2→v3 additions to an open connection, guarded so a file that already carries them
 * (production, hotfixed under LBV-1572) is left untouched but for the version bump. Caller owns the
 * transaction.
 */
function applyTwoToThree(db: DatabaseSync, now: string): void {
  if (!hasColumn(db, 'settings', 'goal_text')) db.exec(ADD_GOAL_TEXT);
  if (!hasTable(db, 'push_subscriptions')) {
    db.exec(CREATE_PUSH_SUBSCRIPTIONS);
    db.exec(CREATE_PUSH_SUBSCRIPTIONS_INDEX);
  }
  db.prepare('UPDATE meta SET schema_version = ?, updated_at = ? WHERE id = ?').run(
    SCHEMA_VERSION,
    now,
    'meta',
  );
}

/**
 * Additive in-place upgrade. No rebuild/rename: the objects are added to the live file inside one
 * transaction (SQLite DDL is transactional, so a crash mid-way rolls back to the exact v2 file),
 * behind existence guards that make it idempotent on the already-hotfixed production database. A
 * safety copy of the pre-v3 file is taken first regardless — it is the only copy of the data.
 */
function migrateTwoToThree(path: string, options: MigrateFileOptions): MigrateFileResult {
  const lock = acquireOwnership(path, options.breakStaleLock === true);
  try {
    // Fold any WAL back into the main file, then copy it aside, so the safety copy is a complete
    // snapshot of the v2 database before a single byte of it is altered.
    const checkpoint = new DatabaseSync(path);
    try {
      armConnection(checkpoint);
      checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      checkpoint.close();
    }
    const safetyCopyPath = copyAside(path, 2);
    assertStillOwned(lock);

    const db = new DatabaseSync(path);
    try {
      armConnection(db);
      db.exec('BEGIN');
      try {
        applyTwoToThree(db, new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      // Fold the committed DDL back into the main file so the fsync below actually persists it,
      // rather than leaving it in a WAL a later open would have to recover.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    fsyncPath(path);

    const message =
      `[godmode] migrated ${path} from schema v2 to v${String(SCHEMA_VERSION)} ` +
      `(additive: goal_text + push_subscriptions). The previous database was copied to ` +
      `${safetyCopyPath} and left there.`;
    (options.onMigrated ?? ((m: string) => console.warn(m)))(message);

    return { migrated: true, fromVersion: 2, toVersion: SCHEMA_VERSION, safetyCopyPath };
  } finally {
    lock.release();
  }
}

function acquireOwnership(path: string, breakStaleLock: boolean): HeldLock {
  try {
    return acquireLock({ databasePath: path, role: 'migrate', reclaimStale: breakStaleLock });
  } catch (error) {
    if (error instanceof LockUnavailableError) {
      throw new SchemaMigrationError(`${error.message}\nNothing has been changed.`);
    }
    throw error;
  }
}

function assertStillOwned(lock: HeldLock): void {
  try {
    lock.assertStillHeld();
  } catch (error) {
    if (error instanceof LockUnavailableError) {
      throw new SchemaMigrationError(`${error.message}\nNothing has been replaced.`);
    }
    throw error;
  }
}

/**
 * Copy the previous database aside, refusing to overwrite an earlier copy. Named after the version
 * it holds (`fromVersion`) — the shape you would restore to if the upgrade were ever regretted.
 */
function copyAside(path: string, fromVersion: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const candidate = `${path}.pre-v${String(fromVersion)}-${stamp}.sqlite`;
  copyFileSync(path, candidate, constants.COPYFILE_EXCL);
  fsyncPath(candidate);
  return candidate;
}

/** Push bytes to disk before the rename, so a crash cannot leave a renamed-but-empty file. */
function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
