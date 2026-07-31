// @vitest-environment node
//
// These tests drive a real SQLite database. Encoding is never asserted in isolation: every
// round trip goes record -> INSERT -> SELECT -> record, so a column that coerces, truncates or
// drops a value fails here rather than in a mock that agrees with the encoder by construction.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { MAXIMAL_BACKUP, MINIMAL_BACKUP, clone } from './fixtures.js';
import {
  CHALLENGES,
  EXERCISES,
  PERFORMANCE_TESTS,
  PLAN_SLOTS,
  SETTINGS,
  TABLE_MAPPINGS,
  WORKOUTS,
  bindValues,
  insertSql,
  type SqlRow,
  type TableMapping,
} from './rows.js';
import {
  SCHEMA_VERSION,
  SchemaVersionError,
  applySchema,
  armConnection,
  assertSchemaVersion,
  foreignKeysEnabled,
  readSchemaSql,
} from './schema.js';
import { BOOTSTRAP_USER_ID, ensureBootstrapUser } from './users.js';
import { validateBackupStrict } from './validate.js';
import type { BackupFile } from '../src/data/exchange.js';

/** Fixture element, non-optional. `noUncheckedIndexedAccess` is on and these always exist. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`fixture has no element ${String(index)}`);
  return item;
}

const open = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  // v2 records are owned by a user; every fixture load below belongs to the bootstrap owner.
  ensureBootstrapUser(db);
  return db;
};

/** Insert one record, adding the bootstrap `user_id` for a `perUser` table — as `db.ts` does. */
function insert<R>(db: DatabaseSync, mapping: TableMapping<R>, record: R): void {
  const values = bindValues(mapping, mapping.encode(record));
  if (mapping.perUser) {
    const columns = ['user_id', ...mapping.columns];
    const placeholders = columns.map(() => '?').join(', ');
    db.prepare(`INSERT INTO ${mapping.table} (${columns.join(', ')}) VALUES (${placeholders})`).run(
      BOOTSTRAP_USER_ID,
      ...values,
    );
    return;
  }
  db.prepare(insertSql(mapping)).run(...values);
}

function readAll<R>(db: DatabaseSync, mapping: TableMapping<R>): R[] {
  const rows = db.prepare(`SELECT * FROM ${mapping.table}`).all() as Record<string, unknown>[];
  return rows.map((row) => mapping.decode(row));
}

/** Insert a whole backup in one transaction, relying on the deferred foreign keys. */
function load(db: DatabaseSync, backup: BackupFile): void {
  db.exec('BEGIN');
  for (const record of backup.exercises) insert(db, EXERCISES, record);
  for (const record of backup.challenges) insert(db, CHALLENGES, record);
  for (const record of backup.performanceTests) insert(db, PERFORMANCE_TESTS, record);
  for (const record of backup.planSlots) insert(db, PLAN_SLOTS, record);
  for (const record of backup.workouts) insert(db, WORKOUTS, record);
  insert(db, SETTINGS, backup.settings);
  db.exec('COMMIT');
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-sqlite-'));
  tempDirs.push(dir);
  return join(dir, 'godmode.sqlite');
}

describe('schema.sql', () => {
  it('creates a usable database and seeds the meta row', () => {
    const db = open();
    const meta = db.prepare('SELECT * FROM meta').get() as Record<string, unknown>;
    expect(meta['id']).toBe('meta');
    expect(meta['schema_version']).toBe(SCHEMA_VERSION);
    // The revision is per-user in v2 (`user_revisions`), not on `meta`.
    expect('revision' in meta).toBe(false);
    const rev = db.prepare('SELECT revision FROM user_revisions WHERE user_id = ?').get(BOOTSTRAP_USER_ID);
    expect(rev).toEqual({ revision: 0 });
    db.close();
  });

  it('holds the meta table to a single row', () => {
    const db = open();
    expect(() =>
      db.prepare('INSERT INTO meta (id, schema_version, created_at, updated_at) VALUES (?, 2, ?, ?)')
        .run('other', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('holds the settings table to one row per user', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP)); // creates the bootstrap owner's single settings row
    expect(() =>
      db.prepare('INSERT INTO settings (user_id, kcal_coefficient) VALUES (?, ?)').run(
        BOOTSTRAP_USER_ID,
        0.003,
      ),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
    db.close();
  });

  it('declares every table STRICT', () => {
    const db = open();
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string }[];
    // v2 adds users, sessions, user_revisions to the original seven, plus push_subscriptions
    // (LBV-1481).
    expect(tables.length).toBe(11);
    for (const table of tables) expect(table.sql).toMatch(/\)\s*STRICT\s*$/);
    db.close();
  });

  it('has inert foreign keys on a connection that did not enable them', () => {
    // Foreign key enforcement is per connection and is not stored in the file. `node:sqlite`
    // happens to default `enableForeignKeyConstraints` to true — verified below — but SQLite
    // itself defaults it OFF, so the sqlite3 CLI, a backup script or any other driver opens
    // this same file with every FOREIGN KEY inert. `armConnection` is what makes it explicit
    // rather than a property of whichever client happened to open the file.
    const path = tempFile();
    const first = new DatabaseSync(path);
    applySchema(first);
    expect(foreignKeysEnabled(first)).toBe(true);
    first.close();

    const unarmed = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    expect(foreignKeysEnabled(unarmed)).toBe(false);
    // user_id is NOT NULL, so it must be bound even with foreign keys off; its value need not
    // resolve here, which is precisely what this unarmed connection is demonstrating.
    const orphanSql =
      'INSERT INTO challenges (id, user_id, exercise_id, chain_id, pattern_id, pattern_version, ' +
      'pattern_params, rest_policy_id, rest_policy_version, rest_policy_params, ' +
      'evaluation_policy_id, evaluation_policy_version, baseline_value, baseline_source, ' +
      'baseline_recorded_at, status, started_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, 1, 1, ?, ?, ?, ?)';
    expect(() =>
      unarmed
        .prepare(orphanSql)
        .run('ch_x', 'usr_nonexistent', 'ex_nonexistent', 'ch_x', 'p', '{}', 'r', '{}', 'e', 'user_entered', '2026-07-30T00:00:00Z', 'active', '2026-07-30T00:00:00Z'),
    ).not.toThrow();
    // Two dangling references now: the missing exercise and the missing user_id owner.
    expect(unarmed.prepare('PRAGMA foreign_key_check').all().length).toBe(2);

    armConnection(unarmed);
    expect(foreignKeysEnabled(unarmed)).toBe(true);
    unarmed.close();

    // A default node:sqlite connection is armed without being asked.
    const armed = new DatabaseSync(path);
    expect(foreignKeysEnabled(armed)).toBe(true);
    armed.close();
  });

  it('passes integrity_check and foreign_key_check after a full load', () => {
    const db = open();
    load(db, clone(MAXIMAL_BACKUP));
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('is the only source of column names — the mappings must match table_info exactly', () => {
    const db = open();
    for (const mapping of TABLE_MAPPINGS) {
      const columns = (
        db.prepare(`PRAGMA table_info(${mapping.table})`).all() as { name: string }[]
      ).map((c) => c.name);
      // A `perUser` table carries the `user_id` tenancy column the mapping deliberately omits.
      const expected = mapping.perUser ? [...mapping.columns, 'user_id'] : [...mapping.columns];
      expect(expected.sort()).toEqual([...columns].sort());
    }
    db.close();
  });

  it('refuses a database whose schema version this build does not understand', () => {
    const db = open();
    db.exec(`UPDATE meta SET schema_version = ${String(SCHEMA_VERSION + 1)}`);
    expect(() => assertSchemaVersion(db)).toThrow(SchemaVersionError);
    expect(() => assertSchemaVersion(db)).toThrow(/Nothing has been read or written/);

    db.exec(`UPDATE meta SET schema_version = ${String(SCHEMA_VERSION)}`);
    expect(() => assertSchemaVersion(db)).not.toThrow();

    db.exec("DELETE FROM meta");
    expect(() => assertSchemaVersion(db)).toThrow(/0 meta rows/);
    db.close();
  });

  it('mentions the per-connection foreign key requirement in the file itself', () => {
    expect(readSchemaSql()).toMatch(/PRAGMA foreign_keys IS PER CONNECTION/);
  });
});

describe('round trip through SQLite', () => {
  it('returns every record of a maximal dataset unchanged', () => {
    const db = open();
    const backup = clone(MAXIMAL_BACKUP);
    load(db, backup);

    expect(readAll(db, EXERCISES)).toEqual(backup.exercises);
    expect(readAll(db, CHALLENGES)).toEqual(backup.challenges);
    expect(readAll(db, PERFORMANCE_TESTS)).toEqual(backup.performanceTests);
    expect(readAll(db, PLAN_SLOTS)).toEqual(backup.planSlots);
    expect(readAll(db, WORKOUTS)).toEqual(backup.workouts);
    expect(readAll(db, SETTINGS)).toEqual([backup.settings]);
    db.close();
  });

  it('returns every record of a minimal dataset unchanged', () => {
    const db = open();
    const backup = clone(MINIMAL_BACKUP);
    load(db, backup);

    expect(readAll(db, EXERCISES)).toEqual(backup.exercises);
    expect(readAll(db, CHALLENGES)).toEqual(backup.challenges);
    expect(readAll(db, PLAN_SLOTS)).toEqual(backup.planSlots);
    expect(readAll(db, WORKOUTS)).toEqual(backup.workouts);
    expect(readAll(db, SETTINGS)).toEqual([backup.settings]);
    db.close();
  });

  it('is canonically identical end to end, which is the migration pass condition', () => {
    const db = open();
    const backup = validateBackupStrict(clone(MAXIMAL_BACKUP));
    load(db, backup);

    const reexported: BackupFile = {
      ...backup,
      exercises: readAll(db, EXERCISES),
      challenges: readAll(db, CHALLENGES),
      performanceTests: readAll(db, PERFORMANCE_TESTS),
      planSlots: readAll(db, PLAN_SLOTS),
      workouts: readAll(db, WORKOUTS),
      settings: at(readAll(db, SETTINGS), 0),
    };
    expect(canonicalJson(reexported)).toBe(canonicalJson(backup));
    db.close();
  });

  it('omits the key for a NULL column rather than defining it as undefined', () => {
    // The rule from the design: absent is the sole canonical representation of an optional.
    // `{planSlotId: undefined}` would be an own property, would show up in Object.keys, and is
    // rejected outright by exactOptionalPropertyTypes.
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    const workout = at(readAll(db, WORKOUTS), 0) as unknown as Record<string, unknown>;
    expect(Object.keys(workout).sort()).toEqual([
      'actualTotal',
      'adjustmentType',
      'attemptNo',
      'chainId',
      'challengeId',
      'id',
      'outcome',
      'performedAt',
      'sets',
    ]);
    expect('planSlotId' in workout).toBe(false);
    expect('kcal' in workout).toBe(false);
    expect('evaluation' in workout).toBe(false);

    const settings = at(readAll(db, SETTINGS), 0) as unknown as Record<string, unknown>;
    expect(Object.keys(settings).sort()).toEqual(['id', 'kcalCoefficient']);
    db.close();
  });

  it('keeps a zone-less imported timestamp byte for byte', () => {
    const db = open();
    load(db, clone(MAXIMAL_BACKUP));
    const workout = readAll(db, WORKOUTS).find((w) => w.id === 'wo_2');
    expect(workout?.performedAt).toBe('2026-05-29T08:34:00');
    db.close();
  });

  it('stores a fractional baseline, goal, max test and rest without rejecting or rounding it', () => {
    // The columns that a human types into. INTEGER here would have refused a device holding
    // 18.5 at the migration gate, and rounding it would have rewritten the record.
    const db = open();
    const backup = clone(MAXIMAL_BACKUP);
    const challenge = at(backup.challenges, 1);
    challenge.baseline.value = 18.5;
    challenge.goalValue = 100.5;
    at(backup.performanceTests, 0).value = 42.5;
    at(backup.planSlots, 1).restSeconds = 62.5;
    backup.settings.restOverrideSeconds = 45.5;
    load(db, backup);

    expect(readAll(db, CHALLENGES).find((c) => c.id === 'ch_1')?.baseline.value).toBe(18.5);
    expect(readAll(db, CHALLENGES).find((c) => c.id === 'ch_1')?.goalValue).toBe(100.5);
    expect(at(readAll(db, PERFORMANCE_TESTS), 0).value).toBe(42.5);
    expect(readAll(db, PLAN_SLOTS).find((s) => s.id === 'slot_1')?.restSeconds).toBe(62.5);
    expect(at(readAll(db, SETTINGS), 0).restOverrideSeconds).toBe(45.5);
    db.close();
  });

  it('returns a whole number from a REAL column as a whole number', () => {
    // 18 bound to a REAL column is stored as 18.0. JavaScript has one number type, so the
    // round trip must be exact — but it is worth asserting rather than assuming.
    const db = open();
    load(db, clone(MAXIMAL_BACKUP));
    const value = readAll(db, CHALLENGES).find((c) => c.id === 'ch_1')?.baseline.value;
    expect(value).toBe(42);
    expect(Number.isInteger(value)).toBe(true);
    db.close();
  });

  it('carries an own __proto__ key through a JSON column intact', () => {
    const db = open();
    const backup = clone(MAXIMAL_BACKUP);
    at(backup.challenges, 1).patternParams = JSON.parse('{"__proto__": {"x": 1}, "a": 2}') as Record<string, unknown>;
    load(db, backup);
    const params = readAll(db, CHALLENGES).find((c) => c.id === 'ch_1')?.patternParams ?? {};
    expect(Object.keys(params).sort()).toEqual(['__proto__', 'a']);
    expect(Object.hasOwn(params, '__proto__')).toBe(true);
    db.close();
  });

  it('keeps kcal provenance rather than flattening it to a number', () => {
    const db = open();
    load(db, clone(MAXIMAL_BACKUP));
    const workouts = readAll(db, WORKOUTS);
    expect(workouts.find((w) => w.id === 'wo_1')?.kcal).toEqual({
      value: 18.5,
      source: 'estimated',
      estimatorVersion: 1,
    });
    expect(workouts.find((w) => w.id === 'wo_2')?.kcal).toEqual({
      value: 7,
      source: 'external',
      estimatorVersion: 1,
    });
    db.close();
  });

  it('keeps the fields the previous draft of this design omitted', () => {
    // evaluation, evaluationPolicyId, evaluationPolicyVersion, note on a workout;
    // supersedesId on a slot; challengeId and note on a performance test.
    const db = open();
    load(db, clone(MAXIMAL_BACKUP));
    const workout = readAll(db, WORKOUTS).find((w) => w.id === 'wo_1');
    expect(workout?.evaluation).toEqual({
      satisfied: true,
      advances: true,
      reason: 'total reps met the prescription',
      measured: { actualTotal: 77, targetTotal: 63, surplus: 14 },
    });
    expect(workout?.evaluationPolicyId).toBe('total-reps-at-least-target');
    expect(workout?.evaluationPolicyVersion).toBe(1);
    expect(workout?.note).toBe('felt strong');
    expect(readAll(db, PLAN_SLOTS).find((s) => s.id === 'slot_1')?.supersedesId).toBe('slot_0');
    const test = readAll(db, PERFORMANCE_TESTS)[0];
    expect(test?.challengeId).toBe('ch_1');
    expect(test?.note).toBe('rested, morning');
    db.close();
  });

  it('keeps opaque pattern params structurally intact, nesting and all', () => {
    const db = open();
    const backup = clone(MAXIMAL_BACKUP);
    load(db, backup);
    const challenge = readAll(db, CHALLENGES).find((c) => c.id === 'ch_1');
    expect(challenge?.patternParams).toEqual(backup.challenges[1]?.patternParams);
    db.close();
  });

  it('keeps set order and every per-set optional', () => {
    const db = open();
    const backup = clone(MAXIMAL_BACKUP);
    load(db, backup);
    expect(readAll(db, WORKOUTS).find((w) => w.id === 'wo_1')?.sets).toEqual(
      backup.workouts[0]?.sets,
    );
    expect(readAll(db, PLAN_SLOTS).find((s) => s.id === 'slot_1')?.targets).toEqual(
      backup.planSlots[1]?.targets,
    );
    db.close();
  });

  it('survives a close and reopen from a real file', () => {
    const path = tempFile();
    const first = new DatabaseSync(path);
    applySchema(first);
    ensureBootstrapUser(first);
    load(first, clone(MAXIMAL_BACKUP));
    first.close();

    // The schema is already in the file; the new connection only has to arm itself.
    const second = new DatabaseSync(path);
    armConnection(second);
    expect(readAll(second, WORKOUTS)).toEqual(MAXIMAL_BACKUP.workouts);
    second.close();
  });
});

describe('constraints', () => {
  const withData = (): DatabaseSync => {
    const db = open();
    load(db, clone(MAXIMAL_BACKUP));
    return db;
  };

  it('refuses a second attempt with the same number on the same slot', () => {
    const db = withData();
    const duplicate = { ...at(clone(MAXIMAL_BACKUP).workouts, 0), id: 'wo_dup' };
    expect(() => insert(db, WORKOUTS, duplicate)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('allows unlinked workouts to repeat attempt number 1', () => {
    const db = withData();
    const unlinked = at(clone(MAXIMAL_BACKUP).workouts, 1);
    expect(() => insert(db, WORKOUTS, { ...unlinked, id: 'wo_3' })).not.toThrow();
    expect(() => insert(db, WORKOUTS, { ...unlinked, id: 'wo_4' })).not.toThrow();
    db.close();
  });

  it('refuses a duplicate primary key', () => {
    const db = withData();
    expect(() => insert(db, EXERCISES, at(clone(MAXIMAL_BACKUP).exercises, 0))).toThrow(
      /UNIQUE constraint failed/,
    );
    db.close();
  });

  it('refuses a workout pointing at a challenge that does not exist', () => {
    const db = withData();
    const orphan = { ...at(clone(MAXIMAL_BACKUP).workouts, 1), id: 'wo_o', challengeId: 'ch_nope' };
    db.exec('BEGIN');
    insert(db, WORKOUTS, orphan);
    expect(() => db.exec('COMMIT')).toThrow(/FOREIGN KEY constraint failed/);
    db.exec('ROLLBACK');
    db.close();
  });

  it('refuses to delete a parent that still has children', () => {
    const db = withData();
    expect(() => db.prepare('DELETE FROM exercises WHERE id = ?').run('ex_1')).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    db.close();
  });

  it('accepts a genuine foreign-key cycle inside one transaction, because the keys are deferred', () => {
    // ch_1.baseline_evidence_id -> test_1, and test_1.challenge_id -> ch_1. No insert order
    // satisfies both without deferral, and the real dataset can contain exactly this.
    const db = open();
    expect(() => load(db, clone(MAXIMAL_BACKUP))).not.toThrow();
    db.close();
  });

  it('rejects a fractional value in a whole-number column instead of rounding it', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    expect(() =>
      db.prepare('UPDATE workouts SET attempt_no = ? WHERE id = ?').run(1.5, 'wo_1'),
    ).toThrow(/cannot store REAL value in INTEGER column/);
    expect(() =>
      db.prepare('UPDATE workouts SET actual_total = ? WHERE id = ?').run(21.5, 'wo_1'),
    ).toThrow(/cannot store REAL value in INTEGER column/);
    db.close();
  });

  it('rejects text in a numeric column — but only text that does not convert losslessly', () => {
    // The boundary worth knowing, because it decides what the DDL can and cannot promise.
    // A STRICT INTEGER column still accepts the *string* "77" and stores the integer 77: the
    // conversion is lossless and reversible, so SQLite performs it. So the schema alone cannot
    // guarantee that a JavaScript number went in — which is why every value crosses the runtime
    // validator first, and why `validate.test.ts` asserts that "77" is rejected there.
    const db = open();
    load(db, clone(MINIMAL_BACKUP));

    expect(() =>
      db.prepare('UPDATE workouts SET actual_total = ? WHERE id = ?').run('seventy-seven', 'wo_1'),
    ).toThrow(/cannot store TEXT value in INTEGER column/);

    db.prepare('UPDATE workouts SET actual_total = ? WHERE id = ?').run('77', 'wo_1');
    expect(db.prepare('SELECT actual_total AS n, typeof(actual_total) AS t FROM workouts').get()).toEqual(
      { n: 77, t: 'integer' },
    );
    db.close();
  });

  it('rejects an unknown enum value at the database, not only at the validator', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    expect(() =>
      db.prepare('UPDATE workouts SET outcome = ? WHERE id = ?').run('nailed_it', 'wo_1'),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare('UPDATE challenges SET status = ? WHERE id = ?').run('paused', 'ch_1'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('rejects half an evaluation and half a kcal record', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    expect(() =>
      db.prepare('UPDATE workouts SET evaluation_satisfied = 1 WHERE id = ?').run('wo_1'),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare('UPDATE workouts SET kcal_value = 12 WHERE id = ?').run('wo_1'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('rejects a timestamp that is not a timestamp', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    expect(() =>
      db.prepare('UPDATE workouts SET performed_at = ? WHERE id = ?').run('29.05.2026', 'wo_1'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('accepts both the zone-less and the zoned timestamp spellings', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    for (const stamp of ['2026-05-29T08:34:00', '2026-05-29T08:34:00.000Z', '2026-05-29T08:34:00+02:00']) {
      expect(() =>
        db.prepare('UPDATE workouts SET performed_at = ? WHERE id = ?').run(stamp, 'wo_1'),
      ).not.toThrow();
    }
    db.close();
  });

  it('rejects a negative count', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    expect(() =>
      db.prepare('UPDATE workouts SET actual_total = -1 WHERE id = ?').run('wo_1'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('rejects a JSON column that does not hold the shape it promises', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    expect(() => db.prepare('UPDATE workouts SET sets = ? WHERE id = ?').run('{}', 'wo_1')).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      db.prepare('UPDATE challenges SET pattern_params = ? WHERE id = ?').run('[]', 'ch_1'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('rejects a slot that supersedes itself', () => {
    const db = open();
    load(db, clone(MINIMAL_BACKUP));
    expect(() =>
      db.prepare('UPDATE plan_slots SET supersedes_id = id WHERE id = ?').run('slot_1'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });
});

describe('row encoding', () => {
  it('never emits undefined as a bound value', () => {
    const backup = clone(MAXIMAL_BACKUP);
    const rows: SqlRow[] = [
      EXERCISES.encode(at(backup.exercises, 0)),
      CHALLENGES.encode(at(backup.challenges, 1)),
      PERFORMANCE_TESTS.encode(at(backup.performanceTests, 0)),
      PLAN_SLOTS.encode(at(backup.planSlots, 1)),
      WORKOUTS.encode(at(backup.workouts, 1)),
      SETTINGS.encode(backup.settings),
    ];
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        expect(value === undefined, `${key} was undefined`).toBe(false);
      }
    }
  });

  it('writes JSON columns in canonical form, so re-import can compare them as text', () => {
    const encoded = CHALLENGES.encode(at(clone(MAXIMAL_BACKUP).challenges, 1));
    expect(encoded['rest_policy_params']).toBe('{"baseSeconds":60,"perRepSeconds":1.5}');
    // Same params, typed the other way round: identical text.
    const shuffled = at(clone(MAXIMAL_BACKUP).challenges, 1);
    shuffled.restPolicyParams = { perRepSeconds: 1.5, baseSeconds: 60 };
    expect(CHALLENGES.encode(shuffled)['rest_policy_params']).toBe(encoded['rest_policy_params']);
  });

  it('refuses to encode a record carrying a value JSON cannot represent', () => {
    const broken = at(clone(MAXIMAL_BACKUP).challenges, 1);
    broken.patternParams = { when: new Date() };
    expect(() => CHALLENGES.encode(broken)).toThrow(/has no JSON representation/);
  });

  it('rejects a decoded row that has drifted from the record contract', () => {
    expect(() => EXERCISES.decode({ id: 'ex_1', label: 'x', unit: 'seconds', created_at: '2026-01-01T00:00:00Z' })).toThrow(
      /expected one of "reps"/,
    );
    expect(() => EXERCISES.decode({ id: 'ex_1', label: 'x', unit: 'reps', created_at: null })).toThrow(
      /expected an ISO timestamp string, received null/,
    );
    expect(() => EXERCISES.decode({ id: 'ex_1', label: 'x', unit: 'reps' })).toThrow(
      /required property is missing/,
    );
  });
});
