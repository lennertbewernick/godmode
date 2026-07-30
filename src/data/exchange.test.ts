/**
 * Restore is the only path that deletes data, and the device holds the only copy. These tests
 * exist because the previous implementation validated two header fields and then cleared every
 * store: a file containing nothing but `{"format":"godmode-backup","formatVersion":1}` wiped
 * the database and reported success.
 */

import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  backupIsEmpty,
  buildBackup,
  restoreBackup,
} from './exchange.js';
import { __setDB, createChallenge, createExercise, putImportedWorkout } from '../db/repo.js';
import { DB_NAME, DB_VERSION, openFitnessDB, type WorkoutRecord } from '../db/schema.js';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import type { Baseline } from '../core/types.js';

let dbCounter = 0;
let dbName = '';
beforeEach(() => {
  dbCounter += 1;
  dbName = `exchange-test-db-${dbCounter}`;
  __setDB(openFitnessDB(dbName));
});

const baseline: Baseline = {
  value: 18,
  source: 'tested',
  recordedAt: new Date(2026, 0, 1).toISOString(),
};

/** A database with one exercise, one challenge with slots, and one imported workout. */
async function seed(importSource = 'incumbent-csv-v1') {
  const exercise = await createExercise('Push-ups');
  const { challenge, slots } = await createChallenge({
    exerciseId: exercise.id,
    baseline,
    params: pushupParams(18, 100),
  });
  const workout: WorkoutRecord = {
    id: 'wo-seed',
    challengeId: challenge.id,
    chainId: challenge.chainId,
    attemptNo: 1,
    performedAt: new Date(2026, 4, 29, 8, 34).toISOString(),
    sets: [{ index: 1, effectiveTarget: 7, actual: 7 }],
    actualTotal: 7,
    adjustmentType: 'none',
    effectiveTotal: 37,
    outcome: 'completed_as_planned',
    importSource,
  };
  await putImportedWorkout(workout);
  return { exercise, challenge, slots, workout };
}

describe('restoreBackup — refusing to destroy data', () => {
  it('round-trips a real backup', async () => {
    await seed();
    const backup = await buildBackup();
    const result = await restoreBackup(JSON.parse(JSON.stringify(backup)));

    expect(result.workouts).toBe(1);
    expect(result.exercises).toBe(1);
    expect(result.challenges).toBe(1);
    expect(result.planSlots).toBeGreaterThan(0);
  });

  it('rejects a header-only file and leaves the database untouched', async () => {
    const { workout } = await seed();

    await expect(
      restoreBackup({ format: 'godmode-backup', formatVersion: BACKUP_FORMAT_VERSION }),
    ).rejects.toThrow(/incomplete/i);

    // The point of the guard: the existing history must still be there.
    const after = await buildBackup();
    expect(after.workouts).toHaveLength(1);
    expect(after.workouts[0]?.id).toBe(workout.id);
    expect(after.exercises).toHaveLength(1);
  });

  it('rejects a backup whose collections are absent rather than treating them as empty', async () => {
    await seed();
    const backup = await buildBackup();
    const { workouts: _omitted, ...withoutWorkouts } = backup;

    await expect(restoreBackup(withoutWorkouts)).rejects.toThrow(/workouts/);

    const after = await buildBackup();
    expect(after.workouts).toHaveLength(1);
  });

  it('rejects a collection that is not a list', async () => {
    await seed();
    const backup = await buildBackup();

    await expect(restoreBackup({ ...backup, planSlots: {} })).rejects.toThrow(/planSlots/);

    const after = await buildBackup();
    expect(after.workouts).toHaveLength(1);
  });

  it('rejects records missing an id', async () => {
    await seed();
    const backup = await buildBackup();

    await expect(
      restoreBackup({ ...backup, workouts: [{ actualTotal: 7 }] }),
    ).rejects.toThrow(/without an id/i);

    const after = await buildBackup();
    expect(after.workouts).toHaveLength(1);
  });

  it('rejects a non-object and a non-backup', async () => {
    await expect(restoreBackup(null)).rejects.toThrow(/not a GodMode backup/);
    await expect(restoreBackup([])).rejects.toThrow(/not a GodMode backup/);
    await expect(restoreBackup('nope')).rejects.toThrow(/not a GodMode backup/);
    await expect(restoreBackup({ format: 'something-else' })).rejects.toThrow(
      /not a GodMode backup/,
    );
  });

  it('refuses a backup from a newer build rather than dropping fields', async () => {
    await seed();
    const backup = await buildBackup();

    await expect(
      restoreBackup({ ...backup, formatVersion: BACKUP_FORMAT_VERSION + 1 }),
    ).rejects.toThrow(/newer version/i);
  });

  it('rejects a missing or unusable format version', async () => {
    await expect(restoreBackup({ format: 'godmode-backup' })).rejects.toThrow(/format version/i);
    await expect(
      restoreBackup({ format: 'godmode-backup', formatVersion: 'one' }),
    ).rejects.toThrow(/format version/i);
  });

  it('normalises a retired import-source id arriving from an older backup', async () => {
    await seed();
    const backup = await buildBackup();
    const legacy = {
      ...backup,
      workouts: backup.workouts.map((w) => ({ ...w, importSource: 'incumbent-csv-v1' })),
    };

    await restoreBackup(legacy);

    const after = await buildBackup();
    expect(after.workouts[0]?.importSource).toBe('incumbent-csv-v1');
  });

  it('flags a structurally valid but empty backup so the UI can warn before wiping', async () => {
    const empty = {
      format: 'godmode-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
      dbVersion: DB_VERSION,
      exportedAt: new Date(2026, 6, 30).toISOString(),
      exercises: [],
      challenges: [],
      performanceTests: [],
      planSlots: [],
      workouts: [],
    };
    expect(backupIsEmpty(empty)).toBe(true);
    expect(backupIsEmpty({ format: 'godmode-backup', formatVersion: 1 })).toBe(false);
  });
});

describe('schema migration v1 to v2', () => {
  it('rewrites the retired import-source id and leaves other records alone', async () => {
    const name = `migration-test-db-${dbCounter}`;

    // Build a v1 database by hand: the v1 upgrade branch, then a workout carrying the old id.
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('exercises', { keyPath: 'id' });
        const challenges = db.createObjectStore('challenges', { keyPath: 'id' });
        challenges.createIndex('byChain', 'chainId');
        challenges.createIndex('byStatus', 'status');
        const tests = db.createObjectStore('performanceTests', { keyPath: 'id' });
        tests.createIndex('byExercise', 'exerciseId');
        const slots = db.createObjectStore('planSlots', { keyPath: 'id' });
        slots.createIndex('byChallenge', 'challengeId');
        slots.createIndex('byChallengeOrdinal', ['challengeId', 'ordinal']);
        const workouts = db.createObjectStore('workouts', { keyPath: 'id' });
        workouts.createIndex('byChallenge', 'challengeId');
        workouts.createIndex('bySlot', 'planSlotId');
        workouts.createIndex('byChain', 'chainId');
        workouts.createIndex('byPerformedAt', 'performedAt');
        db.createObjectStore('settings', { keyPath: 'id' });
      },
    });
    await v1.put('workouts', {
      id: 'wo-legacy',
      challengeId: 'ch-1',
      chainId: 'ch-1',
      attemptNo: 1,
      performedAt: new Date(2026, 4, 29).toISOString(),
      sets: [],
      actualTotal: 37,
      adjustmentType: 'none',
      effectiveTotal: 37,
      outcome: 'completed_as_planned',
      importSource: 'incumbent-csv-v1',
    });
    await v1.put('workouts', {
      id: 'wo-manual',
      challengeId: 'ch-1',
      chainId: 'ch-1',
      attemptNo: 1,
      performedAt: new Date(2026, 4, 31).toISOString(),
      sets: [],
      actualTotal: 39,
      adjustmentType: 'none',
      effectiveTotal: 39,
      outcome: 'completed_as_planned',
    });
    v1.close();

    // Reopening through the real opener runs the guarded v2 branch.
    const migrated = await openFitnessDB(name);
    expect(migrated.version).toBe(2);

    const legacy = await migrated.get('workouts', 'wo-legacy');
    expect(legacy?.importSource).toBe('incumbent-csv-v1');

    // A workout that never came from an import must not gain a provenance string.
    const manual = await migrated.get('workouts', 'wo-manual');
    expect(manual?.importSource).toBeUndefined();
    expect(manual?.actualTotal).toBe(39);

    migrated.close();
  });

  it('opens a fresh database at the current version with every store present', async () => {
    const db = await openFitnessDB(`fresh-db-${dbCounter}`);
    expect(db.version).toBe(DB_VERSION);
    for (const store of [
      'exercises',
      'challenges',
      'performanceTests',
      'planSlots',
      'workouts',
      'settings',
    ]) {
      expect(db.objectStoreNames).toContain(store);
    }
    db.close();
  });

  it('uses a stable database name', () => {
    expect(DB_NAME).toBe('fitness-companion');
  });
});
