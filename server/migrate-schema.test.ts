// @vitest-environment node
//
// The in-place schema upgrade, v1 -> v2 (LBV-1478). A real v1 database is built on disk from the
// archived v1 DDL, filled with the owner's fixture history, and migrated. The point of every
// assertion is the same: the single-tenant owner's data survives, now owned by a real `users` row
// and scoped by `user_id`, and the migration is crash-safe in the same way `migrate.ts` is —
// build fresh, verify, atomic rename, keep the old file.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { DATABASE_FILENAME, openDatabase, readRevision } from './db.js';
import { readDataset, type Dataset } from './dataset.js';
import { MAXIMAL_BACKUP, clone } from './fixtures.js';
import { migrateFileToCurrent } from './migrate-schema.js';
import {
  CHALLENGES,
  EXERCISES,
  PERFORMANCE_TESTS,
  PLAN_SLOTS,
  SETTINGS,
  WORKOUTS,
  type SqlRow,
  type TableMapping,
} from './rows.js';
import { applySchema, armConnection, readSchemaVersion } from './schema.js';
import { validateBackupStrict } from './validate.js';
import { BOOTSTRAP_USER_ID, findUserById } from './users.js';
import type { BackupFile } from '../src/data/exchange.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const V1_SCHEMA = readFileSync(join(HERE, '__fixtures__', 'schema-v1.sql'), 'utf8');
const V2_SCHEMA = readFileSync(join(HERE, '__fixtures__', 'schema-v2.sql'), 'utf8');

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-migrate-v1-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Insert one record into a v1 table (no `user_id`), with any leading fixed columns.
 *
 * Only columns the v1 table actually has are written: a column that v2 added to the mapping but v1
 * never had (`settings.goal_text`, LBV-1481) is skipped, so this helper keeps modelling a genuine
 * v1 row rather than one carrying a field that version could not hold. The migration is what fills
 * such a column in on the way to v2.
 */
function insertV1<R>(
  db: DatabaseSync,
  mapping: TableMapping<R>,
  record: R,
  leading: Record<string, SqlRow[string]> = {},
): void {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${mapping.table})`).all() as { name: string }[]).map(
      (info) => info.name,
    ),
  );
  const row = mapping.encode(record);
  const leadCols = Object.keys(leading);
  const dataCols = mapping.columns.filter((c) => present.has(c));
  const columns = [...leadCols, ...dataCols];
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${mapping.table} (${columns.join(', ')}) VALUES (${placeholders})`).run(
    ...leadCols.map((c) => leading[c]!),
    ...dataCols.map((c) => row[c]!),
  );
}

/** A real v1 database on disk holding the fixture, at the given global revision. */
function buildV1(path: string, backup: BackupFile, revision: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(V1_SCHEMA);
    armConnection(db);
    db.exec('BEGIN');
    for (const record of backup.exercises) insertV1(db, EXERCISES, record);
    for (const record of backup.challenges) insertV1(db, CHALLENGES, record);
    for (const record of backup.performanceTests) insertV1(db, PERFORMANCE_TESTS, record);
    for (const record of backup.planSlots) insertV1(db, PLAN_SLOTS, record);
    for (const record of backup.workouts) insertV1(db, WORKOUTS, record);
    // v1 settings carried the singleton `id = 'settings'` column that v2 drops.
    insertV1(db, SETTINGS, backup.settings, { id: 'settings' });
    db.exec('COMMIT');
    db.prepare('UPDATE meta SET revision = ? WHERE id = ?').run(revision, 'meta');
  } finally {
    db.close();
  }
}

function datasetOfBackup(backup: BackupFile): Dataset {
  return {
    exercises: backup.exercises,
    challenges: backup.challenges,
    performanceTests: backup.performanceTests,
    planSlots: backup.planSlots,
    workouts: backup.workouts,
    settings: backup.settings,
  };
}

const OWNER = { email: 'lennert@godmode.local', displayName: 'Lennert' };

describe('migrateFileToCurrent — v1 to current (v3)', () => {
  it('carries the owner’s whole history onto a bootstrap user, scoped by user_id', () => {
    const path = join(tempDir(), DATABASE_FILENAME);
    const backup = validateBackupStrict(clone(MAXIMAL_BACKUP));
    buildV1(path, backup, 5);

    const result = migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(1);
    // A v1 file is rebuilt fresh from `schema.sql`, so it lands directly at the current version —
    // the v2→v3 additive objects are simply present in the fresh schema, not a second hop.
    expect(result.toVersion).toBe(3);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      armConnection(db);
      expect(readSchemaVersion(db)).toBe(3);

      // The owner exists, and their history is scoped to them.
      const owner = findUserById(db, BOOTSTRAP_USER_ID);
      expect(owner?.email).toBe('lennert@godmode.local');
      expect(readRevision(db, BOOTSTRAP_USER_ID)).toBe(5);
      for (const table of ['challenges', 'performance_tests', 'plan_slots', 'workouts']) {
        const owners = db.prepare(`SELECT DISTINCT user_id FROM ${table}`).all() as {
          user_id: string;
        }[];
        expect(owners).toEqual([{ user_id: BOOTSTRAP_USER_ID }]);
      }

      // Every record round-trips unchanged — nothing was lost or rewritten by the upgrade.
      expect(canonicalJson(readDataset(db))).toBe(canonicalJson(datasetOfBackup(backup)));
    } finally {
      db.close();
    }
  });

  it('keeps the previous v1 database as a safety copy', () => {
    const dir = tempDir();
    const path = join(dir, DATABASE_FILENAME);
    buildV1(path, validateBackupStrict(clone(MAXIMAL_BACKUP)), 3);
    const result = migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });

    expect(result.safetyCopyPath).toBeDefined();
    expect(existsSync(result.safetyCopyPath!)).toBe(true);
    // The safety copy is named after the version it holds — a v1 file here.
    expect(readdirSync(dir).some((name) => name.includes('.pre-v1-'))).toBe(true);
  });

  it('is a no-op on a database that is already current', () => {
    const dir = tempDir();
    const path = join(dir, DATABASE_FILENAME);
    buildV1(path, validateBackupStrict(clone(MAXIMAL_BACKUP)), 1);
    migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });

    const before = readdirSync(dir).length;
    const again = migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });
    expect(again.migrated).toBe(false);
    // No new safety copy, because nothing was migrated.
    expect(readdirSync(dir).length).toBe(before);
  });

  it('does nothing when there is no file yet', () => {
    const path = join(tempDir(), 'absent.sqlite');
    expect(migrateFileToCurrent(path, { owner: OWNER }).migrated).toBe(false);
  });

  it('openDatabase upgrades a v1 file it is asked to open', () => {
    const dir = tempDir();
    buildV1(join(dir, DATABASE_FILENAME), validateBackupStrict(clone(MAXIMAL_BACKUP)), 7);

    const opened = openDatabase({ dataDir: dir, onStaleLockReclaimed: () => {} });
    try {
      expect(opened.created).toBe(false);
      expect(readSchemaVersion(opened.db)).toBe(3);
      expect(readRevision(opened.db, BOOTSTRAP_USER_ID)).toBe(7);
      expect(findUserById(opened.db, BOOTSTRAP_USER_ID)).toBeDefined();
    } finally {
      opened.close();
    }
  });
});

// ── v2 → v3: the additive migration and the drift guard ─────────────────────────────────────────

/** A real v2 database on disk from the frozen v2 snapshot, holding one user with a settings row. */
function buildV2(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(V2_SCHEMA);
    armConnection(db);
    db.exec(
      "INSERT INTO users (id, email, display_name, created_at) " +
        "VALUES ('u1', 'a@b.c', 'A', '2026-01-01T00:00:00.000Z')",
    );
    db.exec(
      "INSERT INTO user_revisions (user_id, revision, updated_at) " +
        "VALUES ('u1', 4, '2026-01-01T00:00:00.000Z')",
    );
    db.exec("INSERT INTO settings (user_id, kcal_coefficient) VALUES ('u1', 0.5)");
  } finally {
    db.close();
  }
}

/** Apply the v3 objects to an open v2 connection — models the LBV-1572 production hotfix. */
function applyHotfixObjects(db: DatabaseSync): void {
  db.exec(
    'ALTER TABLE settings ADD COLUMN goal_text TEXT NULL CHECK (goal_text IS NULL OR length(goal_text) > 0)',
  );
  db.exec(`CREATE TABLE push_subscriptions (
    endpoint   TEXT NOT NULL PRIMARY KEY CHECK (length(endpoint) > 0),
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    p256dh     TEXT NOT NULL CHECK (length(p256dh) > 0),
    auth       TEXT NOT NULL CHECK (length(auth) > 0),
    created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*')
  ) STRICT`);
  db.exec('CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id)');
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

/**
 * The comparable schema of a database: every named table/index, its DDL normalised so that
 * whitespace, comments, and the way SQLite rewrites a `CREATE TABLE` after `ALTER TABLE ADD COLUMN`
 * do not register as differences — but a missing/extra table, column, index, or constraint does.
 * Auto-generated internal objects (`sqlite_%`, PK indexes with a NULL `sql`) are excluded.
 */
function schemaOf(db: DatabaseSync): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { type: string; name: string; sql: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[`${row.type}:${row.name}`] = row.sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),])\s*/g, '$1')
      .trim();
  }
  return out;
}

/** A fresh current-version database built straight from `schema.sql`. */
function freshCurrent(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  applySchema(db);
  return db;
}

describe('migrateFileToCurrent — v2 to v3 (additive)', () => {
  it('adds goal_text + push_subscriptions to a pure v2 database and bumps the version', () => {
    const path = join(tempDir(), DATABASE_FILENAME);
    buildV2(path);

    // Guard the fixture: this must be a genuine v2 shape, or the migration would be a hollow no-op.
    const before = new DatabaseSync(path, { readOnly: true });
    try {
      armConnection(before);
      expect(readSchemaVersion(before)).toBe(2);
      expect(columnNames(before, 'settings')).not.toContain('goal_text');
      expect(tableExists(before, 'push_subscriptions')).toBe(false);
    } finally {
      before.close();
    }

    const result = migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(2);
    expect(result.toVersion).toBe(3);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      armConnection(db);
      expect(readSchemaVersion(db)).toBe(3);
      expect(columnNames(db, 'settings')).toContain('goal_text');
      expect(tableExists(db, 'push_subscriptions')).toBe(true);
      // The pre-existing settings row survived; its new column defaulted to NULL.
      const row = db.prepare('SELECT kcal_coefficient, goal_text FROM settings').get() as {
        kcal_coefficient: number;
        goal_text: unknown;
      };
      expect(row.kcal_coefficient).toBe(0.5);
      expect(row.goal_text).toBeNull();
    } finally {
      db.close();
    }
  });

  it('is idempotent on an already-hotfixed v2 database: only the version moves', () => {
    const path = join(tempDir(), DATABASE_FILENAME);
    buildV2(path);
    // Reproduce production after the LBV-1572 hotfix: objects present, but version still 2. A live
    // subscription row proves the migration does NOT drop and recreate the table it finds.
    const seed = new DatabaseSync(path);
    try {
      armConnection(seed);
      applyHotfixObjects(seed);
      seed.exec(
        "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) " +
          "VALUES ('https://push.example/abc', 'u1', 'key', 'auth', '2026-01-02T00:00:00.000Z')",
      );
    } finally {
      seed.close();
    }

    const result = migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(2);
    expect(result.toVersion).toBe(3);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      armConnection(db);
      expect(readSchemaVersion(db)).toBe(3);
      const count = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number };
      expect(count.n).toBe(1); // the subscription survived — the table was left in place
    } finally {
      db.close();
    }
  });

  it('keeps the previous v2 database as a safety copy', () => {
    const dir = tempDir();
    const path = join(dir, DATABASE_FILENAME);
    buildV2(path);
    const result = migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });

    expect(result.safetyCopyPath).toBeDefined();
    expect(existsSync(result.safetyCopyPath!)).toBe(true);
    expect(readdirSync(dir).some((name) => name.includes('.pre-v2-'))).toBe(true);
  });

  it('is a no-op on a database already at v3', () => {
    const dir = tempDir();
    const path = join(dir, DATABASE_FILENAME);
    buildV2(path);
    migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });

    const before = readdirSync(dir).length;
    const again = migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });
    expect(again.migrated).toBe(false);
    expect(readdirSync(dir).length).toBe(before); // no second safety copy
  });
});

describe('schema-drift guard', () => {
  it('a v2 database migrated to v3 is schema-identical to a fresh v3 database', () => {
    const dir = tempDir();
    const migratedPath = join(dir, DATABASE_FILENAME);
    buildV2(migratedPath);
    migrateFileToCurrent(migratedPath, { owner: OWNER, onMigrated: () => {} });

    const migrated = new DatabaseSync(migratedPath, { readOnly: true });
    const fresh = freshCurrent(join(dir, 'fresh.sqlite'));
    try {
      armConnection(migrated);
      // The whole point of LBV-1575: schema.sql and the migration chain cannot diverge unseen.
      // If someone adds a column/table/index to schema.sql without teaching the migration, the
      // fresh database grows it, the migrated one does not, and this equality fails the build.
      expect(schemaOf(migrated)).toEqual(schemaOf(fresh));
    } finally {
      migrated.close();
      fresh.close();
    }
  });

  it('the comparator can tell a v2 schema apart from v3 (it is not vacuously equal)', () => {
    const dir = tempDir();
    const v2Path = join(dir, 'v2.sqlite');
    buildV2(v2Path);

    const v2 = new DatabaseSync(v2Path, { readOnly: true });
    const fresh = freshCurrent(join(dir, 'fresh.sqlite'));
    try {
      armConnection(v2);
      // A v2 file genuinely differs from v3 (no push_subscriptions, no goal_text) — proving the
      // equality above is a real comparison, not a comparator that returns equal for anything.
      expect(schemaOf(v2)).not.toEqual(schemaOf(fresh));
    } finally {
      v2.close();
      fresh.close();
    }
  });
});
