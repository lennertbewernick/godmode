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
import { armConnection, readSchemaVersion } from './schema.js';
import { validateBackupStrict } from './validate.js';
import { BOOTSTRAP_USER_ID, findUserById } from './users.js';
import type { BackupFile } from '../src/data/exchange.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const V1_SCHEMA = readFileSync(join(HERE, '__fixtures__', 'schema-v1.sql'), 'utf8');

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

describe('migrateFileToCurrent — v1 to v2', () => {
  it('carries the owner’s whole history onto a bootstrap user, scoped by user_id', () => {
    const path = join(tempDir(), DATABASE_FILENAME);
    const backup = validateBackupStrict(clone(MAXIMAL_BACKUP));
    buildV1(path, backup, 5);

    const result = migrateFileToCurrent(path, { owner: OWNER, onMigrated: () => {} });
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      armConnection(db);
      expect(readSchemaVersion(db)).toBe(2);

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
    expect(readdirSync(dir).some((name) => name.includes('.pre-v2-'))).toBe(true);
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
      expect(readSchemaVersion(opened.db)).toBe(2);
      expect(readRevision(opened.db, BOOTSTRAP_USER_ID)).toBe(7);
      expect(findUserById(opened.db, BOOTSTRAP_USER_ID)).toBeDefined();
    } finally {
      opened.close();
    }
  });
});
