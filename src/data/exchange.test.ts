/**
 * The backup file: what goes into one, and what is refused when one comes back.
 *
 * `validateBackup` used to be the gate in front of a restore that cleared every store, which is
 * why it checks so much. There is no client-side restore any more — see the note in
 * `exchange.ts` — but the checks stay and stay tested: the same file is handed to
 * `npm run import-backup`, and a file this build will happily *write* and then refuse to *read*
 * is a bug either way.
 */

import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  backupIsEmpty,
  buildBackup,
  validateBackup,
  type BackupFile,
} from './exchange.js';
import { applyPending } from '../api/snapshot.js';
import type { Snapshot } from '../api/client.js';
import { buildChallenge, buildExercise } from '../db/records.js';
import {
  DB_NAME,
  DB_VERSION,
  DEFAULT_SETTINGS,
  openFitnessDB,
  type WorkoutRecord,
} from '../db/schema.js';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import type { Baseline } from '../core/types.js';

let dbCounter = 0;
beforeEach(() => {
  dbCounter += 1;
});

const baseline: Baseline = {
  value: 18,
  source: 'tested',
  recordedAt: new Date(2026, 0, 1).toISOString(),
};

/** A snapshot with one exercise, one challenge with slots, and one imported workout. */
function seed(importSource = 'incumbent-csv-v1'): Snapshot {
  const exercise = buildExercise('Push-ups');
  const { challenge, slots } = buildChallenge({
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
  return {
    apiVersion: 1,
    schemaVersion: 1,
    revision: 12,
    exercises: [exercise],
    challenges: [challenge],
    planSlots: slots,
    workouts: [workout],
    performanceTests: [],
    settings: DEFAULT_SETTINGS,
  };
}

describe('buildBackup — one snapshot, one file', () => {
  it('carries every collection the importer requires', () => {
    const backup = buildBackup(seed());

    expect(backup.format).toBe('godmode-backup');
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(backup.dbVersion).toBe(DB_VERSION);
    expect(backup.exercises).toHaveLength(1);
    expect(backup.challenges).toHaveLength(1);
    expect(backup.workouts).toHaveLength(1);
    expect(backup.planSlots.length).toBeGreaterThan(0);
  });

  it('writes a file this build will read back', () => {
    // The round trip that matters: what we export must survive JSON and pass our own gate.
    const file = JSON.parse(JSON.stringify(buildBackup(seed()))) as unknown;
    const validated = validateBackup(file);
    expect(validated.workouts[0]?.id).toBe('wo-seed');
  });

  it('carries a workout this device has not managed to send yet', () => {
    // The backup is the second copy of the history, so it must not be the one that omits the
    // sessions with no other copy at all. `App.exportJson` passes the snapshot the user is
    // shown — server state with the outbox overlaid — precisely for this.
    const server = seed();
    const { attemptNo: _assigned, ...queued } = {
      ...server.workouts[0]!,
      id: 'wo-not-sent-yet',
      performedAt: new Date(2026, 5, 2, 7, 15).toISOString(),
    };
    const shown = applyPending(server, [
      { id: queued.id, seq: 1, queuedAt: queued.performedAt, attempts: 2, workout: queued },
    ]);

    const backup = buildBackup(shown);
    expect(backup.workouts.map((w) => w.id).sort()).toEqual(['wo-not-sent-yet', 'wo-seed']);
  });

  it('carries no revision, no session and nothing about the server', () => {
    // The token lives in an HttpOnly cookie and is unreachable from here by construction; this
    // pins the weaker but checkable property that nothing server-side leaks into the file.
    const serialised = JSON.stringify(buildBackup(seed()));
    expect(serialised).not.toContain('revision');
    expect(serialised).not.toContain('apiVersion');
    expect(serialised).not.toContain('token');
  });
});

describe('validateBackup — refusing a file that would destroy data', () => {
  it('accepts a real backup', () => {
    const backup = buildBackup(seed());
    expect(validateBackup(JSON.parse(JSON.stringify(backup))).workouts).toHaveLength(1);
  });

  it('rejects a header-only file', () => {
    // A file containing nothing but this is well-formed JSON, and the previous implementation
    // cleared every store on it and reported success.
    expect(() =>
      validateBackup({ format: 'godmode-backup', formatVersion: BACKUP_FORMAT_VERSION }),
    ).toThrow(/incomplete/i);
  });

  it('rejects a backup whose collections are absent rather than treating them as empty', () => {
    const { workouts: _omitted, ...withoutWorkouts } = buildBackup(seed());
    expect(() => validateBackup(withoutWorkouts)).toThrow(/workouts/);
  });

  it('rejects a collection that is not a list', () => {
    expect(() => validateBackup({ ...buildBackup(seed()), planSlots: {} })).toThrow(/planSlots/);
  });

  it('rejects records missing an id', () => {
    expect(() =>
      validateBackup({ ...buildBackup(seed()), workouts: [{ actualTotal: 7 }] }),
    ).toThrow(/without an id/i);
  });

  it('rejects a non-object and a non-backup', () => {
    expect(() => validateBackup(null)).toThrow(/not a GodMode backup/);
    expect(() => validateBackup([])).toThrow(/not a GodMode backup/);
    expect(() => validateBackup('nope')).toThrow(/not a GodMode backup/);
    expect(() => validateBackup({ format: 'something-else' })).toThrow(/not a GodMode backup/);
  });

  it('refuses a backup from a newer build rather than dropping fields', () => {
    expect(() =>
      validateBackup({ ...buildBackup(seed()), formatVersion: BACKUP_FORMAT_VERSION + 1 }),
    ).toThrow(/newer version/i);
  });

  it('rejects a missing or unusable format version', () => {
    expect(() => validateBackup({ format: 'godmode-backup' })).toThrow(/format version/i);
    expect(() => validateBackup({ format: 'godmode-backup', formatVersion: 'one' })).toThrow(
      /format version/i,
    );
  });

  it('flags a structurally valid but empty backup', () => {
    const empty: Partial<BackupFile> = {
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
      'workoutOutbox',
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
