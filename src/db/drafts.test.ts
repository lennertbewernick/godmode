/**
 * The in-progress workout buffer, and the one question it must answer without hedging:
 * can a draft put back a workout that has already been saved or queued?
 *
 * The attempt-numbering and ratchet tests that used to live beside these have moved to
 * `server/api.test.ts`, because that is where those transactions now happen.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import type { Baseline } from '../core/types.js';
import { newDraft } from '../ui/draft.js';
import {
  __forgetDiscardedDrafts,
  deleteDraft,
  getDraft,
  listDrafts,
  saveDraft,
} from './drafts.js';
import { __setDB } from './local.js';
import { enqueueWorkout, listOutbox } from './outbox.js';
import { buildChallenge, buildExercise, buildWorkout, newId } from './records.js';
import {
  DEFAULT_SETTINGS,
  openFitnessDB,
  type ChallengeRecord,
  type PlanSlotRecord,
} from './schema.js';

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

function seed(): { challenge: ChallengeRecord; slots: PlanSlotRecord[] } {
  const exercise = buildExercise('Push-ups');
  return buildChallenge({
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

/** The record the finish path composes and hands to the outbox. */
function finished(challenge: ChallengeRecord, slot: PlanSlotRecord, workoutId: string) {
  const targets = slot.targets.map((t) => t.reps);
  return buildWorkout({
    workoutId,
    challenge,
    slot,
    performance: {
      sets: targets.map((t, i) => ({ index: i + 1, effectiveTarget: t, actual: t })),
      actualTotal: slot.targetTotal,
      adjustmentType: 'none',
      effectiveTotal: slot.targetTotal,
    },
    settings: DEFAULT_SETTINGS,
  }).workout;
}

describe('draft round trip', () => {
  it('survives being written and read back', async () => {
    const { challenge, slots } = seed();
    const slot = slots[0]!;
    const draft = draftFor(challenge, slot);

    await saveDraft(draft);
    expect(await getDraft(draft.id)).toEqual(draft);
    expect(await listDrafts()).toHaveLength(1);
  });

  it('overwrites in place rather than accumulating a version per tap', async () => {
    const { challenge, slots } = seed();
    const draft = draftFor(challenge, slots[0]!);

    await saveDraft(draft);
    await saveDraft({ ...draft, actuals: [1, 2, 3], updatedAt: new Date().toISOString() });

    const stored = await listDrafts();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.actuals).toEqual([1, 2, 3]);
  });

  it('deletes idempotently — a second delete is not an error', async () => {
    const { challenge, slots } = seed();
    const draft = draftFor(challenge, slots[0]!);
    await saveDraft(draft);

    await deleteDraft(draft.id);
    await deleteDraft(draft.id);
    expect(await listDrafts()).toEqual([]);
  });
});

describe('queueing a workout clears its draft', () => {
  it('retires the draft in the same transaction that queues the workout', async () => {
    const { challenge, slots } = seed();
    const slot = slots[0]!;
    const draft = draftFor(challenge, slot);
    await saveDraft(draft);

    await enqueueWorkout(finished(challenge, slot, draft.id), slot.id);

    expect(await listDrafts()).toEqual([]);
    expect((await listOutbox()).map((e) => e.id)).toEqual([draft.id]);
  });

  it('clears every draft for that slot, not only the one it was given', async () => {
    const { challenge, slots } = seed();
    const slot = slots[0]!;
    const abandoned = draftFor(challenge, slot);
    const current = draftFor(challenge, slot);
    await saveDraft(abandoned);
    await saveDraft(current);

    await enqueueWorkout(finished(challenge, slot, current.id), slot.id);

    expect(await listDrafts()).toEqual([]);
  });

  it('leaves a draft for a different slot alone', async () => {
    const { challenge, slots } = seed();
    const other = draftFor(challenge, slots[1]!);
    await saveDraft(other);

    await enqueueWorkout(finished(challenge, slots[0]!, newId('wo')), slots[0]!.id);

    expect((await listDrafts()).map((d) => d.id)).toEqual([other.id]);
  });
});

describe('a write that would undo a decision is refused', () => {
  it('refuses to write back a draft that was discarded', async () => {
    const { challenge, slots } = seed();
    const draft = draftFor(challenge, slots[0]!);
    await saveDraft(draft);
    await deleteDraft(draft.id);

    // The runner's debounce still had an edit in hand when the user discarded, and its unmount
    // flushed it. Without this guard the record comes straight back while the screen says it
    // is gone.
    expect(await saveDraft({ ...draft, actuals: [99, 99, 99] })).toBe('refused-gone');
    expect(await listDrafts()).toEqual([]);
  });

  it('refuses to write a draft whose workout is already queued for the server', async () => {
    const { challenge, slots } = seed();
    const slot = slots[0]!;
    const draft = draftFor(challenge, slot);
    await saveDraft(draft);
    await enqueueWorkout(finished(challenge, slot, draft.id), slot.id);

    // A second tab, still holding the session, writes it again. The check is inside the write
    // transaction rather than in this tab's memory, which is the only way it can see the
    // other tab's work.
    __forgetDiscardedDrafts();
    expect(await saveDraft(draft)).toBe('refused-gone');
    expect(await listDrafts()).toEqual([]);
  });

  it('refuses a write that has completed fewer sets than the one already stored', async () => {
    const { challenge, slots } = seed();
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
    const { challenge, slots } = seed();
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
