/**
 * The version bump, exercised against databases that already hold data.
 *
 * This is the part of adding a store that can cost someone their history: an upgrade that
 * throws aborts its transaction, and a database whose upgrade always aborts cannot be opened
 * at all. On a device that holds the only copy, that is indistinguishable from deletion.
 *
 * So the assertions here are not "the new store exists". They are "every record that was there
 * before is still there afterwards, byte for byte" — from v1, from v2, and on a re-open that
 * has nothing left to do.
 */

import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import { newDraft } from '../ui/draft.js';
import { listDrafts, saveDraft } from './drafts.js';
import { __setDB } from './local.js';
import { countOutbox } from './outbox.js';
import {
  DB_VERSION,
  openFitnessDB,
  type ChallengeRecord,
  type ExerciseRecord,
  type PlanSlotRecord,
  type SettingsRecord,
  type WorkoutRecord,
} from './schema.js';

let dbCounter = 0;
let name = '';
beforeEach(() => {
  dbCounter += 1;
  name = `upgrade-test-db-${dbCounter}`;
  __setDB(null);
});

const exercise: ExerciseRecord = {
  id: 'ex_1',
  label: 'Push-ups',
  unit: 'reps',
  createdAt: '2026-01-01T08:00:00.000Z',
};

const challenge: ChallengeRecord = {
  id: 'ch_1',
  exerciseId: 'ex_1',
  chainId: 'ch_1',
  patternId: 'percentage-ramp',
  patternVersion: 1,
  patternParams: { baselineMax: 18, goalMax: 100, weeks: 6, daysPerWeek: 3 },
  restPolicyId: 'volume-derived',
  restPolicyVersion: 1,
  restPolicyParams: {},
  evaluationPolicyId: 'total-reps-at-least-target',
  evaluationPolicyVersion: 1,
  baseline: { value: 18, source: 'tested', recordedAt: '2026-01-01T08:00:00.000Z' },
  goalValue: 100,
  status: 'active',
  startedAt: '2026-01-01T08:00:00.000Z',
};

const planSlot: PlanSlotRecord = {
  id: 'slot_1',
  challengeId: 'ch_1',
  ordinal: 1,
  week: 1,
  day: 1,
  patternId: 'percentage-ramp',
  patternVersion: 1,
  generatedAt: '2026-01-01T08:00:00.000Z',
  targets: [
    { index: 1, targetKind: 'reps', reps: 10, role: 'medium', isAmrap: false },
    { index: 2, targetKind: 'reps', reps: 12, role: 'big', isAmrap: false },
    { index: 3, targetKind: 'reps', reps: 8, role: 'amrap', isAmrap: true },
  ],
  targetTotal: 30,
  restSeconds: 90,
  status: 'attempted',
};

/** Carries the retired import-profile id, which is what the v2 branch rewrites. */
const importedWorkout: WorkoutRecord = {
  id: 'wo_1',
  challengeId: 'ch_1',
  chainId: 'ch_1',
  planSlotId: 'slot_1',
  attemptNo: 1,
  performedAt: '2026-01-02T08:00:00.000Z',
  sets: [
    { index: 1, effectiveTarget: 10, actual: 10 },
    { index: 2, effectiveTarget: 12, actual: 12 },
    { index: 3, effectiveTarget: 8, actual: 21 },
  ],
  actualTotal: 43,
  adjustmentType: 'none',
  effectiveTotal: 30,
  outcome: 'completed_as_planned',
  kcal: { value: 12, source: 'external', estimatorVersion: 1 },
  importSource: 'just-6-weeks-csv-v1',
};

/** An in-app workout with no import provenance at all — the v2 branch must skip it untouched. */
const nativeWorkout: WorkoutRecord = {
  ...importedWorkout,
  id: 'wo_2',
  attemptNo: 2,
  performedAt: '2026-01-04T08:00:00.000Z',
};
delete (nativeWorkout as { importSource?: string }).importSource;

const settings: SettingsRecord = {
  id: 'settings',
  kcalCoefficient: 0.003,
  bodyweightKg: 82,
  lastBackupAt: '2026-01-03T08:00:00.000Z',
};

/**
 * Build a populated database at an older version, using that version's schema only.
 *
 * Deliberately a hand-written copy of the v1 store creation rather than a call into
 * `openFitnessDB`: the point is to reproduce what is actually on a group member's phone, and
 * `openFitnessDB` only ever creates the current shape.
 */
async function seedLegacyDatabase(version: 1 | 2 | 3): Promise<void> {
  const db = await openDB(name, version, {
    upgrade(database) {
      database.createObjectStore('exercises', { keyPath: 'id' });

      const challenges = database.createObjectStore('challenges', { keyPath: 'id' });
      challenges.createIndex('byChain', 'chainId');
      challenges.createIndex('byStatus', 'status');

      const tests = database.createObjectStore('performanceTests', { keyPath: 'id' });
      tests.createIndex('byExercise', 'exerciseId');

      const slots = database.createObjectStore('planSlots', { keyPath: 'id' });
      slots.createIndex('byChallenge', 'challengeId');
      slots.createIndex('byChallengeOrdinal', ['challengeId', 'ordinal']);

      const workouts = database.createObjectStore('workouts', { keyPath: 'id' });
      workouts.createIndex('byChallenge', 'challengeId');
      workouts.createIndex('bySlot', 'planSlotId');
      workouts.createIndex('byChain', 'chainId');
      workouts.createIndex('byPerformedAt', 'performedAt');

      database.createObjectStore('settings', { keyPath: 'id' });

      // v3's store, so a database seeded at 3 is the shape a phone actually holds.
      if (version >= 3) {
        const drafts = database.createObjectStore('workoutDrafts', { keyPath: 'id' });
        drafts.createIndex('bySlot', 'planSlotId');
      }
    },
  });

  const tx = db.transaction(
    ['exercises', 'challenges', 'planSlots', 'workouts', 'settings'],
    'readwrite',
  );
  await Promise.all([
    tx.objectStore('exercises').put(exercise),
    tx.objectStore('challenges').put(challenge),
    tx.objectStore('planSlots').put(planSlot),
    tx.objectStore('workouts').put(importedWorkout),
    tx.objectStore('workouts').put(nativeWorkout),
    tx.objectStore('settings').put(settings),
    tx.done,
  ]);
  db.close();
}

describe('upgrading a populated database to v4', () => {
  it('is the version this build claims', () => {
    expect(DB_VERSION).toBe(4);
  });

  it('keeps every record when it comes from v2', async () => {
    await seedLegacyDatabase(2);
    const db = await openFitnessDB(name);

    expect(db.version).toBe(4);
    expect(await db.get('exercises', 'ex_1')).toEqual(exercise);
    expect(await db.get('challenges', 'ch_1')).toEqual(challenge);
    expect(await db.get('planSlots', 'slot_1')).toEqual(planSlot);
    expect(await db.get('workouts', 'wo_1')).toEqual(importedWorkout);
    expect(await db.get('workouts', 'wo_2')).toEqual(nativeWorkout);
    expect(await db.get('settings', 'settings')).toEqual(settings);
    expect(await db.count('workouts')).toBe(2);
    db.close();
  });

  it('keeps the indexes usable, not merely the rows', async () => {
    await seedLegacyDatabase(2);
    const db = await openFitnessDB(name);

    expect(await db.getAllFromIndex('workouts', 'bySlot', 'slot_1')).toHaveLength(2);
    expect(await db.getAllFromIndex('challenges', 'byStatus', 'active')).toHaveLength(1);
    expect(await db.getAllFromIndex('planSlots', 'byChallengeOrdinal', ['ch_1', 1])).toHaveLength(
      1,
    );
    db.close();
  });

  it('runs the v2 rewrite and both store creations in one jump from v1', async () => {
    await seedLegacyDatabase(1);
    const db = await openFitnessDB(name);

    expect(db.version).toBe(4);
    // v2's work still happened: the retired profile id was rewritten.
    expect((await db.get('workouts', 'wo_1'))?.importSource).toBe('incumbent-csv-v1');
    // …and the workout that never carried one was left exactly as it was.
    expect(await db.get('workouts', 'wo_2')).toEqual(nativeWorkout);
    expect([...db.objectStoreNames]).toContain('workoutDrafts');
    expect([...db.objectStoreNames]).toContain('workoutOutbox');
    db.close();
  });

  it('adds an empty drafts store that is immediately writable', async () => {
    await seedLegacyDatabase(2);
    __setDB(openFitnessDB(name));

    expect(await listDrafts()).toEqual([]);

    const draft = newDraft({
      id: 'wo_draft',
      challengeId: challenge.id,
      chainId: challenge.chainId,
      slot: planSlot,
      attemptNo: 1,
      effectiveTargets: [10, 12, 8],
      adjustmentType: 'none',
      nowMs: Date.parse('2026-07-30T09:00:00.000Z'),
    });
    await saveDraft(draft);

    expect(await listDrafts()).toEqual([draft]);
  });

  it('is a no-op the second time, and the third', async () => {
    await seedLegacyDatabase(2);
    const first = await openFitnessDB(name);
    first.close();
    const second = await openFitnessDB(name);
    second.close();
    const third = await openFitnessDB(name);

    expect(third.version).toBe(4);
    expect(await third.get('workouts', 'wo_1')).toEqual(importedWorkout);
    expect(await third.count('workouts')).toBe(2);
    third.close();
  });

  it('creates the whole shape from nothing, unchanged by the new branch', async () => {
    const db = await openFitnessDB(name);
    expect([...db.objectStoreNames].sort()).toEqual([
      'challenges',
      'exercises',
      'performanceTests',
      'planSlots',
      'settings',
      'workoutDrafts',
      'workoutOutbox',
      'workouts',
    ]);
    db.close();
  });

  /**
   * The cutover's own migration, and the assertion that matters most about it: adding the
   * outbox does not touch the five stores that hold the pre-cutover history. That history is
   * the fallback copy — nothing in this work deletes it, and nothing calls
   * `indexedDB.deleteDatabase`.
   */
  it('adds an empty outbox to a v3 database without disturbing anything', async () => {
    await seedLegacyDatabase(3);
    __setDB(openFitnessDB(name));
    const db = await openFitnessDB(name);

    expect(db.version).toBe(4);
    expect(await countOutbox()).toBe(0);
    expect(await db.get('exercises', 'ex_1')).toEqual(exercise);
    expect(await db.get('challenges', 'ch_1')).toEqual(challenge);
    expect(await db.get('planSlots', 'slot_1')).toEqual(planSlot);
    expect(await db.get('workouts', 'wo_1')).toEqual(importedWorkout);
    expect(await db.get('workouts', 'wo_2')).toEqual(nativeWorkout);
    expect(await db.get('settings', 'settings')).toEqual(settings);
  });
});
