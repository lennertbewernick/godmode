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
  mergeBackup,
  previewMergeBackup,
  restoreBackup,
  type BackupFile,
} from './exchange.js';
import {
  __setDB,
  createChallenge,
  createExercise,
  endChallenge,
  getSettings,
  putImportedWorkout,
  saveSettings,
} from '../db/repo.js';
import {
  DB_NAME,
  DB_VERSION,
  DEFAULT_SETTINGS,
  openFitnessDB,
  type Database,
  type WorkoutRecord,
} from '../db/schema.js';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import type { Baseline } from '../core/types.js';

let dbCounter = 0;
let dbName = '';
let myDatabase: Promise<Database>;
beforeEach(() => {
  dbCounter += 1;
  dbName = `exchange-test-db-${dbCounter}`;
  myDatabase = openFitnessDB(dbName);
  __setDB(myDatabase);
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

  it('normalises an unrecognised import-source id arriving from an older backup', async () => {
    await seed();
    const backup = await buildBackup();
    const legacy = {
      ...backup,
      workouts: backup.workouts.map((w) => ({ ...w, importSource: 'retired-profile-id' })),
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
      importSource: 'retired-profile-id',
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

    // Reopening through the real opener runs the guarded v2 branch — and every branch above
    // it. Asserted against DB_VERSION rather than a literal, because what this test is about
    // is that the rewrite happens on the way past, not which version it stops at.
    const migrated = await openFitnessDB(name);
    expect(migrated.version).toBe(DB_VERSION);

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
      'workoutDrafts',
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

let otherCounter = 0;

/**
 * Do some work on a *different* device, and hand back the file it would export.
 *
 * Its records carry ids this device has never seen, which is what a second phone actually
 * looks like — and the file goes through JSON on the way back, as a real one does, so no
 * explicit `undefined` survives and key order is whatever the serialiser chose.
 */
async function onAnotherDevice<T>(
  work: () => Promise<T>,
): Promise<{ made: T; file: BackupFile }> {
  const mine = myDatabase;
  otherCounter += 1;
  __setDB(openFitnessDB(`${dbName}-other-${otherCounter}`));
  try {
    const made = await work();
    const file = JSON.parse(JSON.stringify(await buildBackup())) as BackupFile;
    return { made, file };
  } finally {
    __setDB(mine);
  }
}

/** This device's own export, as a file: through JSON, exactly as the user would hand it back. */
async function exportedFile(): Promise<BackupFile> {
  return JSON.parse(JSON.stringify(await buildBackup())) as BackupFile;
}

describe('mergeBackup — adding without destroying', () => {
  it('writes nothing when a device merges its own backup back into itself', async () => {
    const { slots } = await seed();
    const before = await buildBackup();
    const file = await exportedFile();

    const result = await mergeBackup(file);

    expect(result.totals.added).toBe(0);
    expect(result.totals.divergent).toBe(0);
    expect(result.totals.skipped).toBe(0);
    expect(result.counts.exercises.identical).toBe(1);
    expect(result.counts.challenges.identical).toBe(1);
    expect(result.counts.workouts.identical).toBe(1);
    expect(result.counts.planSlots.identical).toBe(slots.length);

    const after = await buildBackup();
    expect(after.exercises).toEqual(before.exercises);
    expect(after.challenges).toEqual(before.challenges);
    expect(after.planSlots).toEqual(before.planSlots);
    expect(after.workouts).toEqual(before.workouts);
  });

  it('adds a workout and its sessions that this device does not have', async () => {
    const { made, file } = await onAnotherDevice(() => seed());

    const result = await mergeBackup(file);

    expect(result.counts.exercises.added).toBe(1);
    expect(result.counts.challenges.added).toBe(1);
    expect(result.counts.planSlots.added).toBe(made.slots.length);
    expect(result.counts.workouts.added).toBe(1);
    expect(result.totals.skipped).toBe(0);

    const after = await buildBackup();
    expect(after.challenges.map((c) => c.id)).toEqual([made.challenge.id]);
    expect(after.workouts.map((w) => w.id)).toEqual([made.workout.id]);
    expect(after.planSlots).toHaveLength(made.slots.length);
  });

  it('leaves a session this device has and the file does not exactly where it is', async () => {
    const { challenge, workout } = await seed();
    const file = await exportedFile();

    // Logged after the backup was taken — the phone-only session the old restore would have
    // destroyed.
    const later: WorkoutRecord = {
      ...workout,
      id: 'wo-after-the-backup',
      challengeId: challenge.id,
      chainId: challenge.chainId,
      attemptNo: 2,
      performedAt: new Date(2026, 5, 2, 7, 15).toISOString(),
      actualTotal: 41,
    };
    await putImportedWorkout(later);

    const result = await mergeBackup(file);

    expect(result.totals.added).toBe(0);
    const after = await buildBackup();
    expect(after.workouts.map((w) => w.id).sort()).toEqual(['wo-after-the-backup', 'wo-seed']);
  });

  it('cannot reopen a workout this device ended', async () => {
    const { challenge } = await seed();
    const file = await exportedFile();
    expect(file.challenges[0]?.status).toBe('active');

    // Ended through the real path, not a hand-written record.
    await endChallenge(challenge.id, 'closed_manually');

    const result = await mergeBackup(file);

    expect(result.divergent).toEqual([
      { store: 'challenges', id: challenge.id, reason: 'local-ended' },
    ]);

    const after = await buildBackup();
    expect(after.challenges[0]?.status).toBe('ended');
    expect(after.challenges[0]?.endReason).toBe('closed_manually');
    expect(after.challenges[0]?.endedAt).toBeTypeOf('string');
  });

  it('leaves the local settings alone, including the last backup and the selection', async () => {
    const { challenge } = await seed();
    await saveSettings({
      bodyweightKg: 77,
      lastBackupAt: '2026-07-01T00:00:00.000Z',
      selectedChallengeId: challenge.id,
    });

    const file = await exportedFile();
    file.settings = {
      ...file.settings,
      bodyweightKg: 999,
      kcalCoefficient: 0.9,
      lastBackupAt: '2020-01-01T00:00:00.000Z',
      selectedChallengeId: 'a-challenge-from-another-phone',
    };

    const result = await mergeBackup(file);
    expect(result.settingsMerged).toBe(false);

    const settings = await getSettings();
    expect(settings.bodyweightKg).toBe(77);
    expect(settings.kcalCoefficient).toBe(DEFAULT_SETTINGS.kcalCoefficient);
    expect(settings.lastBackupAt).toBe('2026-07-01T00:00:00.000Z');
    expect(settings.selectedChallengeId).toBe(challenge.id);
  });

  it('keeps this device version of a session the file disagrees about', async () => {
    const { workout } = await seed();
    const file = await exportedFile();
    expect(file.workouts[0]?.actualTotal).toBe(7);

    // The same id, a different result — two devices that both logged the session.
    await putImportedWorkout({
      ...workout,
      sets: [{ index: 1, effectiveTarget: 7, actual: 42 }],
      actualTotal: 42,
    });

    const result = await mergeBackup(file);

    expect(result.counts.workouts.divergent).toBe(1);
    expect(result.counts.workouts.added).toBe(0);

    const after = await buildBackup();
    expect(after.workouts).toHaveLength(1);
    expect(after.workouts[0]?.actualTotal).toBe(42);
  });

  it('does not write a session whose workout exists in neither place', async () => {
    await seed();
    const file = await exportedFile();
    file.workouts = [
      ...file.workouts,
      { ...file.workouts[0]!, id: 'wo-orphan', challengeId: 'cha-that-does-not-exist' },
    ];

    const result = await mergeBackup(file);

    expect(result.skipped).toEqual([
      { store: 'workouts', id: 'wo-orphan', missing: 'challenge cha-that-does-not-exist' },
    ]);

    const after = await buildBackup();
    expect(after.workouts.map((w) => w.id)).not.toContain('wo-orphan');
    expect(after.workouts).toHaveLength(1);
  });

  it('rejects the files restore rejects, and changes nothing when it does', async () => {
    await seed();
    const file = await exportedFile();
    const { workouts: _omitted, ...withoutWorkouts } = file;

    await expect(
      mergeBackup({ format: 'godmode-backup', formatVersion: BACKUP_FORMAT_VERSION }),
    ).rejects.toThrow(/incomplete/i);
    await expect(mergeBackup(withoutWorkouts)).rejects.toThrow(/workouts/);
    await expect(mergeBackup({ ...file, planSlots: {} })).rejects.toThrow(/planSlots/);
    await expect(mergeBackup({ ...file, workouts: [{ actualTotal: 7 }] })).rejects.toThrow(
      /without an id/i,
    );
    await expect(
      mergeBackup({ ...file, formatVersion: BACKUP_FORMAT_VERSION + 1 }),
    ).rejects.toThrow(/newer version/i);
    await expect(mergeBackup(null)).rejects.toThrow(/not a GodMode backup/);

    const after = await buildBackup();
    expect(after.workouts).toHaveLength(1);
    expect(after.exercises).toHaveLength(1);
    expect(after.planSlots.length).toBeGreaterThan(0);
  });
});

describe('previewMergeBackup — counting without committing', () => {
  it('reports what a file would add and writes none of it', async () => {
    await seed();
    const before = await buildBackup();
    const { file } = await onAnotherDevice(() => seed());

    const plan = await previewMergeBackup(file);

    expect(plan.totals.added).toBeGreaterThan(0);
    expect(plan.settingsMerged).toBe(false);

    const after = await buildBackup();
    expect(after.exercises).toEqual(before.exercises);
    expect(after.challenges).toEqual(before.challenges);
    expect(after.planSlots).toEqual(before.planSlots);
    expect(after.workouts).toEqual(before.workouts);
  });

  it('rejects a damaged file before it opens the database', async () => {
    await seed();
    await expect(
      previewMergeBackup({ format: 'godmode-backup', formatVersion: BACKUP_FORMAT_VERSION }),
    ).rejects.toThrow(/incomplete/i);
  });
});
