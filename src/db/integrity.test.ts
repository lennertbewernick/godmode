/**
 * Write-path integrity: the three places a concurrent or interrupted write could corrupt state.
 *
 * Each of these was a real defect. Attempt numbers were read outside the write transaction, a
 * late failed write could downgrade a completed slot, and continuation ended the current block
 * before its successor existed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __setDB,
  countAllWorkouts,
  createChallenge,
  createExercise,
  endChallenge,
  getCurrentSlot,
  getSettings,
  listActiveChallenges,
  listSlots,
  listWorkouts,
  logWorkout,
  putImportedWorkout,
  startNextBlock,
} from './repo.js';
import { openFitnessDB, type PlanSlotRecord } from './schema.js';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import type { Baseline, WorkoutPerformance } from '../core/types.js';

let dbCounter = 0;
beforeEach(() => {
  dbCounter += 1;
  __setDB(openFitnessDB(`integrity-test-db-${dbCounter}`));
});

const baseline: Baseline = {
  value: 18,
  source: 'tested',
  recordedAt: new Date(2026, 0, 1).toISOString(),
};

async function seedChallenge(label = 'Push-ups') {
  const exercise = await createExercise(label);
  const { challenge, slots } = await createChallenge({
    exerciseId: exercise.id,
    baseline,
    params: pushupParams(18, 100, 6, 3),
  });
  return { exercise, challenge, slots };
}

/** A performance that falls short of the slot target, so it does not advance. */
function failing(slot: PlanSlotRecord): WorkoutPerformance {
  return {
    sets: slot.targets.map((t, i) => ({ index: i + 1, effectiveTarget: t.reps, actual: 1 })),
    actualTotal: slot.targets.length,
    adjustmentType: 'none',
    effectiveTotal: slot.targetTotal,
  };
}

/** A performance that meets the slot target. */
function passing(slot: PlanSlotRecord): WorkoutPerformance {
  return {
    sets: slot.targets.map((t, i) => ({ index: i + 1, effectiveTarget: t.reps, actual: t.reps })),
    actualTotal: slot.targetTotal,
    adjustmentType: 'none',
    effectiveTotal: slot.targetTotal,
  };
}

describe('attempt numbering', () => {
  it('numbers sequential attempts on the same slot', async () => {
    const { challenge, slots } = await seedChallenge();
    const slot = slots[0]!;

    const a = await logWorkout({ challenge, slot, performance: failing(slot), durationSeconds: 60 });
    const b = await logWorkout({ challenge, slot, performance: failing(slot), durationSeconds: 60 });

    expect(a.workout.attemptNo).toBe(1);
    expect(b.workout.attemptNo).toBe(2);
  });

  it('does not hand two concurrent writes the same attempt number', async () => {
    const { challenge, slots } = await seedChallenge();
    const slot = slots[0]!;

    // Both calls start before either finishes — two tabs, or a double-tapped Save. Reading the
    // count before opening the transaction let both see 0 and both claim attempt 1.
    const [first, second] = await Promise.all([
      logWorkout({ challenge, slot, performance: failing(slot), durationSeconds: 60 }),
      logWorkout({ challenge, slot, performance: failing(slot), durationSeconds: 60 }),
    ]);

    const numbers = [first.workout.attemptNo, second.workout.attemptNo].sort();
    expect(numbers).toEqual([1, 2]);
  });
});

describe('a completed slot is a ratchet', () => {
  it('does not fall back to attempted when a later failed attempt lands', async () => {
    const { challenge, slots } = await seedChallenge();
    const slot = slots[0]!;

    await logWorkout({ challenge, slot, performance: passing(slot), durationSeconds: 60 });
    const afterPass = (await listSlots(challenge.id)).find((s) => s.id === slot.id);
    expect(afterPass?.status).toBe('completed');

    // A stale tab, still holding the pre-pass slot, saves a failed attempt.
    await logWorkout({ challenge, slot, performance: failing(slot), durationSeconds: 60 });

    const afterFail = (await listSlots(challenge.id)).find((s) => s.id === slot.id);
    expect(afterFail?.status).toBe('completed');
  });

  it('keeps the user on the next day rather than re-locking the one they passed', async () => {
    const { challenge, slots } = await seedChallenge();
    const slot = slots[0]!;

    await logWorkout({ challenge, slot, performance: passing(slot), durationSeconds: 60 });
    await logWorkout({ challenge, slot, performance: failing(slot), durationSeconds: 60 });

    const current = await getCurrentSlot(challenge.id);
    expect(current?.ordinal).toBe(slots[1]!.ordinal);
  });

  it('still records the failed attempt as history', async () => {
    const { challenge, slots } = await seedChallenge();
    const slot = slots[0]!;

    await logWorkout({ challenge, slot, performance: passing(slot), durationSeconds: 60 });
    await logWorkout({ challenge, slot, performance: failing(slot), durationSeconds: 60 });

    // Not downgrading the slot must not mean discarding the attempt.
    expect(await countAllWorkouts()).toBe(2);
  });
});

describe('starting the next block is atomic', () => {
  it('ends the old block, creates the successor, and moves the selection together', async () => {
    const { challenge } = await seedChallenge();

    const { challenge: next, slots } = await startNextBlock({
      previous: challenge,
      strategy: 'retest',
      baselineValue: 30,
      goalValue: 120,
      weeks: 6,
      daysPerWeek: 3,
      tested: true,
    });

    const active = await listActiveChallenges();
    expect(active.map((c) => c.id)).toEqual([next.id]);
    expect(slots.length).toBeGreaterThan(0);

    const settings = await getSettings();
    expect(settings.selectedChallengeId).toBe(next.id);

    // The chain is preserved, so history spans both blocks.
    expect(next.chainId).toBe(challenge.chainId);
    expect(next.previousChallengeId).toBe(challenge.id);
  });

  it('records the rested max test as evidence when one was taken', async () => {
    const { challenge } = await seedChallenge();

    const { challenge: next } = await startNextBlock({
      previous: challenge,
      strategy: 'retest',
      baselineValue: 30,
      goalValue: 120,
      weeks: 6,
      daysPerWeek: 3,
      tested: true,
    });

    expect(next.baseline.source).toBe('tested');
    expect(next.baseline.evidenceId).toBeDefined();
  });

  it('marks a user-entered baseline as such, with no fabricated evidence', async () => {
    const { challenge } = await seedChallenge();

    const { challenge: next } = await startNextBlock({
      previous: challenge,
      strategy: 'user_entered',
      baselineValue: 30,
      goalValue: 120,
      weeks: 6,
      daysPerWeek: 3,
      tested: false,
    });

    expect(next.baseline.source).toBe('user_entered');
    expect(next.baseline.evidenceId).toBeUndefined();
  });

  it('leaves the current block untouched when the new numbers are invalid', async () => {
    const { challenge } = await seedChallenge();

    await expect(
      startNextBlock({
        previous: challenge,
        strategy: 'retest',
        baselineValue: 0,
        goalValue: 120,
        weeks: 6,
        daysPerWeek: 3,
        tested: true,
      }),
    ).rejects.toThrow(/positive/i);

    // The old plan must still be the active one — the previous implementation ended it first.
    const active = await listActiveChallenges();
    expect(active.map((c) => c.id)).toEqual([challenge.id]);
    expect(active[0]?.status).toBe('active');
  });
});

describe('backup prompting sees the whole database', () => {
  it('counts workouts the selected chain cannot see', async () => {
    const first = await seedChallenge('Push-ups');
    const second = await seedChallenge('Pull-ups');

    await logWorkout({
      challenge: first.challenge,
      slot: first.slots[0]!,
      performance: passing(first.slots[0]!),
      durationSeconds: 60,
    });

    // What the UI would show having switched to the freshly added second exercise: nothing.
    // The nag used this number, so adding an exercise silenced "you have never backed up"
    // while real history sat one tap away.
    const visibleFromSecond = await listWorkouts(second.challenge.chainId);
    expect(visibleFromSecond).toHaveLength(0);

    // What durability actually depends on.
    expect(await countAllWorkouts()).toBe(1);
  });

  it('counts imported history belonging to a chain that has been ended', async () => {
    const { challenge, exercise } = await seedChallenge();
    await putImportedWorkout({
      id: 'wo-imported',
      challengeId: challenge.id,
      chainId: challenge.chainId,
      attemptNo: 1,
      performedAt: new Date(2026, 4, 29).toISOString(),
      sets: [{ index: 1, actual: 7 }],
      actualTotal: 7,
      adjustmentType: 'none',
      outcome: 'completed_as_planned',
      importSource: 'incumbent-csv-v1',
    });

    await endChallenge(challenge.id, 'closed_manually');

    // No active challenge at all now, so every chain-scoped view is empty — but the history
    // is still there and still the only copy.
    expect(await listActiveChallenges()).toHaveLength(0);
    expect(await countAllWorkouts()).toBe(1);
    expect(exercise.label).toBe('Push-ups');
  });
});
