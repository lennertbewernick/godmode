/**
 * A whole dataset, and the six collections it is made of.
 *
 * Its own module for one reason: the importer (`server/migrate.ts`) and the verifier
 * (`server/verify.ts`) both need to walk all six collections generically, and if either owned
 * this vocabulary the two would import each other. A cycle between the module that writes the
 * database and the module that proves it is exactly the wrong shape — the verifier must be able
 * to stand alone, and be readable alone.
 *
 * The one piece of type erasure in this layer lives here, in `erase()`, with the reasoning next
 * to it. Everything above this module is typed; everything below it is `rows.ts`, which is typed.
 *
 * No filesystem. `node:sqlite` only as a type plus two query calls, so this stays testable against
 * a real database and nothing else.
 */

import { isPlainObject } from './canonical.js';
import type { DatabaseSync } from 'node:sqlite';
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
import type { PerformanceTest } from '../src/core/types.js';
import type { BackupFile } from '../src/data/exchange.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  PlanSlotRecord,
  SettingsRecord,
  WorkoutRecord,
} from '../src/db/schema.js';

export type CollectionKey =
  | 'exercises'
  | 'challenges'
  | 'performanceTests'
  | 'planSlots'
  | 'workouts'
  | 'settings';

/**
 * Everything a database holds, in record form.
 *
 * `settings` is a single record rather than a list because that is what it is — one row, held
 * there by `CHECK (id = 'settings')` in the DDL. Internally it is treated as a collection of zero
 * or one records, so nothing that walks the collections needs a special case for it.
 */
export interface Dataset {
  readonly exercises: readonly ExerciseRecord[];
  readonly challenges: readonly ChallengeRecord[];
  readonly performanceTests: readonly PerformanceTest[];
  readonly planSlots: readonly PlanSlotRecord[];
  readonly workouts: readonly WorkoutRecord[];
  readonly settings: SettingsRecord | undefined;
}

export const EMPTY_DATASET: Dataset = {
  exercises: [],
  challenges: [],
  performanceTests: [],
  planSlots: [],
  workouts: [],
  settings: undefined,
};

/** A `TableMapping` with its record type erased, so all six can be walked in one loop. */
export interface CollectionSpec {
  readonly key: CollectionKey;
  readonly table: string;
  readonly columns: readonly string[];
  readonly encode: (record: unknown) => SqlRow;
  readonly decode: (row: Readonly<Record<string, unknown>>) => unknown;
}

function erase<R>(key: CollectionKey, mapping: TableMapping<R>): CollectionSpec {
  return {
    key,
    table: mapping.table,
    columns: mapping.columns,
    // The cast is safe because `encode` is only ever reached with a record that came out of
    // `decode` or out of `validateBackupStrict` — both of which have already checked it against
    // the very field map this mapping carries. Nothing else in this layer constructs a record.
    encode: (record) => mapping.encode(record as R),
    decode: (row) => mapping.decode(row),
  };
}

/**
 * Insert order: parents first.
 *
 * Two references are genuinely cyclic — `challenges.baseline_evidence_id` -> `performance_tests`
 * and `performance_tests.challenge_id` -> `challenges` — so no order satisfies both. That is why
 * every foreign key in `schema.sql` is `DEFERRABLE INITIALLY DEFERRED` and why a whole dataset is
 * written in a single transaction. This order still puts parents first, so the ordinary
 * references would hold even without deferral.
 */
export const COLLECTIONS: readonly CollectionSpec[] = [
  erase('exercises', EXERCISES),
  erase('challenges', CHALLENGES),
  erase('performanceTests', PERFORMANCE_TESTS),
  erase('planSlots', PLAN_SLOTS),
  erase('workouts', WORKOUTS),
  erase('settings', SETTINGS),
];

/** The records of one collection, as a list — `settings` included, as zero or one. */
export function recordsOf(dataset: Dataset, key: CollectionKey): readonly unknown[] {
  if (key === 'settings') return dataset.settings === undefined ? [] : [dataset.settings];
  return dataset[key];
}

/** Assemble a `Dataset` from six lists, putting `settings` back where it belongs. */
export function datasetOf(lists: Readonly<Record<CollectionKey, readonly unknown[]>>): Dataset {
  return {
    exercises: lists.exercises as readonly ExerciseRecord[],
    challenges: lists.challenges as readonly ChallengeRecord[],
    performanceTests: lists.performanceTests as readonly PerformanceTest[],
    planSlots: lists.planSlots as readonly PlanSlotRecord[],
    workouts: lists.workouts as readonly WorkoutRecord[],
    settings: lists.settings[0] as SettingsRecord | undefined,
  };
}

/** The `id` of a record, or `undefined` if it somehow has none. Never throws. */
export function idOf(record: unknown): string | undefined {
  if (!isPlainObject(record)) return undefined;
  const id = record['id'];
  return typeof id === 'string' ? id : undefined;
}

/** The dataset a backup carries, once `validateBackupStrict` has accepted it. */
export function datasetOfBackup(backup: BackupFile): Dataset {
  return {
    exercises: backup.exercises,
    challenges: backup.challenges,
    performanceTests: backup.performanceTests,
    planSlots: backup.planSlots,
    workouts: backup.workouts,
    settings: backup.settings,
  };
}

/**
 * Every record in a database, decoded through `rows.ts`.
 *
 * Decoding re-validates. A column that has drifted from the schema — a NULL where the record
 * requires a value, a REAL where it requires a whole number, a JSON column that no longer parses
 * — throws here rather than being carried silently into whatever comes next. That is why the
 * importer rebuilds an existing target from its decoded records instead of copying its bytes: a
 * byte copy would carry forward corruption that this cannot.
 */
export function readDataset(db: DatabaseSync): Dataset {
  const lists: Record<string, readonly unknown[]> = {};
  for (const collection of COLLECTIONS) {
    const rows = db.prepare(`SELECT * FROM ${collection.table}`).all() as Record<
      string,
      unknown
    >[];
    lists[collection.key] = rows.map((row) => collection.decode(row));
  }
  const settings = lists['settings'] ?? [];
  if (settings.length > 1) {
    throw new Error(
      `That database has ${String(settings.length)} settings rows; exactly one is allowed. ` +
        'Nothing has been written.',
    );
  }
  return datasetOf(lists as Readonly<Record<CollectionKey, readonly unknown[]>>);
}

/**
 * Insert a whole dataset in one transaction.
 *
 * Plain `INSERT`, from `rows.ts`, which has no other mode. Never `INSERT OR REPLACE`: SQLite's
 * `REPLACE` deletes the conflicting row and re-inserts it, firing `ON DELETE` actions and
 * cascading through foreign keys (`server/rows.ts:92-98`). A re-run of an import must be
 * insert / no-op / abort, never a silent delete-and-reinsert.
 */
export function writeDataset(db: DatabaseSync, dataset: Dataset): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const collection of COLLECTIONS) {
      const records = recordsOf(dataset, collection.key);
      if (records.length === 0) continue;
      const statement = db.prepare(
        `INSERT INTO ${collection.table} (${collection.columns.join(', ')}) ` +
          `VALUES (${collection.columns.map(() => '?').join(', ')})`,
      );
      for (const record of records) {
        const row = collection.encode(record);
        statement.run(
          ...collection.columns.map((column) => {
            const value = row[column];
            if (value === undefined) {
              throw new Error(`${collection.table}: encoder produced no value for "${column}"`);
            }
            return value;
          }),
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
