/**
 * The in-progress workout buffer, and the one question it must answer without hedging:
 * can a draft put a workout back that has already been logged?
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import type { Baseline, WorkoutPerformance } from '../core/types.js';
import { newDraft } from '../ui/draft.js';
import {
  __forgetDiscardedDrafts,
  __setDB,
  createChallenge,
  createExercise,
  deleteDraft,
  getDraft,
  listDrafts,
  logWorkout,
  newId,
  saveDraft,
} from './repo.js';
import { openFitnessDB, type ChallengeRecord, type PlanSlotRecord } from './schema.js';

let dbCounter = 0;
beforeEach(() => {
  dbCounter += 1;
  __setDB(openFitnessDB(`drafts-test-db-${dbCounter}`));
  __forgetDiscardedDrafts();
});

const baseline: Baseline = {
  value: 18,
  source: 'tested',
  recordedAt: new Date(2026, 0, 1).toISOString(),
};

async function seed(): Promise<{ challenge: ChallengeRecord; slots: PlanSlotRecord[] }> {
  const exercise = await createExercise('Push-ups');
  return createChallenge({
    exerciseId: exercise.id,
    baseline,
    params: pushupParams(18, 100, 6, 3),
  });
}

function draftFor(challenge: ChallengeRecord, slot: PlanSlotRecord, id = newId('wo')) {
  return newDraft({
    id,
    challengeId: challenge.id,
    chainId: challenge.chainId,
    slot,
    attemptNo: 1,
    effectiveTargets: slot.targets.map((t) => t.reps),
    adjustmentType: 'none',
    nowMs: Date.now(),
  });
}

function performanceFrom(slot: PlanSlotRecord): WorkoutPerformance {
  const targets = slot.targets.map((t) => t.reps);
  return {
    sets: targets.map((t, i) => ({ index: i + 1, effectiveTarget: t, actual: t })),
    actualTotal: slot.targetTotal,
    adjustmentType: 'none',
    effectiveTotal: slot.targetTotal,
  };
}

describe('draft round trip', () => {
  it('survives being written and read back', async () => {
    const { challenge, slots } = await seed();
    const slot = slots[0]!;
    const draft = draftFor(challenge, slot);

    await saveDraft(draft);
    expect(await getDraft(draft.id)).toEqual(draft);
    expect(await listDrafts()).toHaveLength(1);
  });

  it('overwrites in place rather than accumulating a version per tap', async () => {
    const { challenge, slots } = await seed();
    const draft = draftFor(challenge, slots[0]!);

    await saveDraft(draft);
    await saveDraft({ ...draft, actuals: [1, 2, 3], updatedAt: new Date().toISOString() });

    const stored = await listDrafts();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.actuals).toEqual([1, 2, 3]);
  });

  it('deletes idempotently — a second delete is not an error', async () => {
    const { challenge, slots } = await seed();
    const draft = draftFor(challenge, slots[0]!);
    await saveDraft(draft);

    await deleteDraft(draft.id);
    await deleteDraft(draft.id);
    expect(await listDrafts()).toEqual([]);
  });
});

describe('logging a workout clears its draft', () => {
  it('deletes the draft in the same transaction that writes the workout', async () => {
    const { challenge, slots } = await seed();
    const slot = slots[0]!;
    const draft = draftFor(challenge, slot);
    await saveDraft(draft);

    const { workout, written } = await logWorkout({
      challenge,
      slot,
      performance: performanceFrom(slot),
      workoutId: draft.id,
    });

    expect(written).toBe(true);
    expect(workout.id).toBe(draft.id);
    expect(await listDrafts()).toEqual([]);
  });

  it('clears every draft for that slot, not only the one it was given', async () => {
    const { challenge, slots } = await seed();
    const slot = slots[0]!;
    const abandoned = draftFor(challenge, slot);
    const current = draftFor(challenge, slot);
    await saveDraft(abandoned);
    await saveDraft(current);

    await logWorkout({
      challenge,
      slot,
      performance: performanceFrom(slot),
      workoutId: current.id,
    });

    expect(await listDrafts()).toEqual([]);
  });

  it('leaves a draft for a different slot alone', async () => {
    const { challenge, slots } = await seed();
    const other = draftFor(challenge, slots[1]!);
    await saveDraft(other);

    await logWorkout({
      challenge,
      slot: slots[0]!,
      performance: performanceFrom(slots[0]!),
    });

    expect((await listDrafts()).map((d) => d.id)).toEqual([other.id]);
  });
});

describe('a write that would undo a decision is refused', () => {
  it('refuses to write back a draft that was discarded', async () => {
    const { challenge, slots } = await seed();
    const draft = draftFor(challenge, slots[0]!);
    await saveDraft(draft);
    await deleteDraft(draft.id);

    // The runner's debounce still had an edit in hand when the user discarded, and its unmount
    // flushed it. Without this guard the record comes straight back while the screen says it
    // is gone.
    expect(await saveDraft({ ...draft, actuals: [99, 99, 99] })).toBe('refused-gone');
    expect(await listDrafts()).toEqual([]);
  });

  it('refuses to write a draft whose workout is already logged', async () => {
    const { challenge, slots } = await seed();
    const slot = slots[0]!;
    const draft = draftFor(challenge, slot);
    await saveDraft(draft);
    await logWorkout({
      challenge,
      slot,
      performance: performanceFrom(slot),
      workoutId: draft.id,
    });

    // A second tab, still holding the session, writes it again. The check is inside the write
    // transaction rather than in this tab's memory, which is the only way it can see the
    // other tab's work.
    __forgetDiscardedDrafts();
    expect(await saveDraft(draft)).toBe('refused-gone');
    expect(await listDrafts()).toEqual([]);
  });

  it('refuses a write that has completed fewer sets than the one already stored', async () => {
    const { challenge, slots } = await seed();
    const draft = draftFor(challenge, slots[0]!);
    const stamp = { startedAt: 'a', endedAt: 'b' };

    const ahead = { ...draft, stamps: [stamp, stamp, null] };
    await saveDraft(ahead);

    // A stale tab, two sets behind, writing its whole record. Overwriting would erase reps the
    // other tab had already recorded.
    const behind = { ...draft, stamps: [stamp, null, null], actuals: [1, 1, 1] };
    expect(await saveDraft(behind)).toBe('refused-stale');
    expect((await listDrafts())[0]!.stamps).toEqual([stamp, stamp, null]);
  });

  it('still accepts a write that is level with, or ahead of, what is stored', async () => {
    const { challenge, slots } = await seed();
    const draft = draftFor(challenge, slots[0]!);
    const stamp = { startedAt: 'a', endedAt: 'b' };

    await saveDraft({ ...draft, stamps: [stamp, null, null] });
    // Same set count, corrected reps: a plain edit, which must land.
    expect(await saveDraft({ ...draft, stamps: [stamp, null, null], actuals: [7, 12, 8] })).toBe(
      'saved',
    );
    expect((await listDrafts())[0]!.actuals).toEqual([7, 12, 8]);

    expect(await saveDraft({ ...draft, stamps: [stamp, stamp, null] })).toBe('saved');
  });
});

describe('a draft cannot resurrect a workout that was already logged', () => {
  it('saving the same session twice writes one workout and counts one attempt', async () => {
    const { challenge, slots } = await seed();
    const slot = slots[0]!;
    const draft = draftFor(challenge, slot);
    const performance = performanceFrom(slot);

    const first = await logWorkout({ challenge, slot, performance, workoutId: draft.id });
    // The same draft, replayed: a retry after a failed-looking save, or a second tab that
    // still had the session on screen.
    await saveDraft(draft);
    const second = await logWorkout({ challenge, slot, performance, workoutId: draft.id });

    expect(second.written).toBe(false);
    expect(second.workout.id).toBe(first.workout.id);
    expect(second.workout.attemptNo).toBe(1);
    expect(second.workout.performedAt).toBe(first.workout.performedAt);

    const { listWorkouts } = await import('./repo.js');
    expect(await listWorkouts(challenge.chainId)).toHaveLength(1);
    // The replayed draft is gone too, so the offer cannot come back on the next launch.
    expect(await listDrafts()).toEqual([]);
  });

  it('still counts a genuinely separate attempt as a second one', async () => {
    const { challenge, slots } = await seed();
    const slot = slots[0]!;
    const weak: WorkoutPerformance = {
      sets: [{ index: 1, effectiveTarget: slot.targetTotal, actual: 1 }],
      actualTotal: 1,
      adjustmentType: 'none',
      effectiveTotal: slot.targetTotal,
    };

    const first = await logWorkout({ challenge, slot, performance: weak, workoutId: newId('wo') });
    const second = await logWorkout({ challenge, slot, performance: weak, workoutId: newId('wo') });

    expect(first.workout.attemptNo).toBe(1);
    expect(second.workout.attemptNo).toBe(2);
    expect(second.written).toBe(true);
  });

  it('mints an id when none is supplied, exactly as it always did', async () => {
    const { challenge, slots } = await seed();
    const slot = slots[0]!;
    const { workout, written } = await logWorkout({
      challenge,
      slot,
      performance: performanceFrom(slot),
    });
    expect(written).toBe(true);
    expect(workout.id).toMatch(/^wo_/);
  });
});
