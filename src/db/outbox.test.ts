/**
 * The outbox, and the two properties the offline promise rests on: it does not reorder, and it
 * does not duplicate.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import { __forgetDiscardedDrafts, saveDraft, listDrafts } from './drafts.js';
import { __setDB } from './local.js';
import {
  countOutbox,
  enqueueWorkout,
  listOutbox,
  recordSendFailure,
  removeFromOutbox,
  unblockAll,
} from './outbox.js';
import { buildChallenge, buildExercise, buildWorkout, newId } from './records.js';
import { newDraft } from '../ui/draft.js';
import {
  DEFAULT_SETTINGS,
  openFitnessDB,
  type ChallengeRecord,
  type PlanSlotRecord,
} from './schema.js';

let dbCounter = 0;
beforeEach(() => {
  dbCounter += 1;
  __setDB(openFitnessDB(`outbox-test-db-${dbCounter}`));
  __forgetDiscardedDrafts();
});

function seed(): { challenge: ChallengeRecord; slots: PlanSlotRecord[] } {
  const exercise = buildExercise('Push-ups');
  return buildChallenge({
    exerciseId: exercise.id,
    baseline: { value: 18, source: 'tested', recordedAt: '2026-01-01T00:00:00.000Z' },
    params: pushupParams(18, 100, 6, 3),
  });
}

function finished(
  challenge: ChallengeRecord,
  slot: PlanSlotRecord,
  workoutId = newId('wo'),
  actual = slot.targetTotal,
) {
  const targets = slot.targets.map((t) => t.reps);
  return buildWorkout({
    workoutId,
    challenge,
    slot,
    performance: {
      sets: targets.map((t, i) => ({ index: i + 1, effectiveTarget: t, actual: i === 0 ? actual : 0 })),
      actualTotal: actual,
      adjustmentType: 'none',
      effectiveTotal: slot.targetTotal,
    },
    settings: DEFAULT_SETTINGS,
  }).workout;
}

describe('order', () => {
  it('hands entries back in the order they were finished, not the order they are keyed', async () => {
    const { challenge, slots } = seed();
    // Ids are UUIDs, so key order is effectively random. Three sessions, finished in this order.
    const first = await enqueueWorkout(finished(challenge, slots[0]!), slots[0]!.id);
    const second = await enqueueWorkout(finished(challenge, slots[1]!), slots[1]!.id);
    const third = await enqueueWorkout(finished(challenge, slots[2]!), slots[2]!.id);

    expect((await listOutbox()).map((e) => e.id)).toEqual([first.id, second.id, third.id]);
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  });

  it('keeps the queue in order after the front of it drains', async () => {
    const { challenge, slots } = seed();
    const first = await enqueueWorkout(finished(challenge, slots[0]!), slots[0]!.id);
    const second = await enqueueWorkout(finished(challenge, slots[1]!), slots[1]!.id);

    await removeFromOutbox(first.id);
    const third = await enqueueWorkout(finished(challenge, slots[2]!), slots[2]!.id);

    // `MAX(seq) + 1`, never `count + 1`: a count would reuse 2 here and put the new entry level
    // with one that is already waiting.
    expect(third.seq).toBe(3);
    expect((await listOutbox()).map((e) => e.id)).toEqual([second.id, third.id]);
  });
});

describe('no duplicate', () => {
  it('queueing the same workout twice leaves one entry', async () => {
    const { challenge, slots } = seed();
    const id = newId('wo');
    await enqueueWorkout(finished(challenge, slots[0]!, id, 10), slots[0]!.id);
    await enqueueWorkout(finished(challenge, slots[0]!, id, 20), slots[0]!.id);

    const queued = await listOutbox();
    expect(queued).toHaveLength(1);
    // The later composition wins — it is the same session, saved again.
    expect(queued[0]!.workout.actualTotal).toBe(20);
  });

  it('carries no attemptNo, because the server assigns it', async () => {
    const { challenge, slots } = seed();
    const entry = await enqueueWorkout(finished(challenge, slots[0]!), slots[0]!.id);
    expect(Object.hasOwn(entry.workout, 'attemptNo')).toBe(false);
  });
});

describe('no loss', () => {
  it('keeps an entry the server refused, and marks why', async () => {
    const { challenge, slots } = seed();
    const entry = await enqueueWorkout(finished(challenge, slots[0]!), slots[0]!.id);

    await recordSendFailure(entry.id, 'No plan slot "slot_x" exists.');

    const [stored] = await listOutbox();
    expect(stored!.blockedReason).toMatch(/No plan slot/);
    expect(stored!.attempts).toBe(1);
    expect(await countOutbox()).toBe(1);
  });

  it('counts a retryable failure without blocking the entry', async () => {
    const { challenge, slots } = seed();
    const entry = await enqueueWorkout(finished(challenge, slots[0]!), slots[0]!.id);

    await recordSendFailure(entry.id);
    await recordSendFailure(entry.id);

    const [stored] = await listOutbox();
    expect(stored!.attempts).toBe(2);
    expect(stored!.blockedReason).toBeUndefined();
  });

  it('a failure against an entry that is already gone is not an error', async () => {
    await expect(recordSendFailure('wo_nothing')).resolves.toBeUndefined();
  });

  it('lets a blocked entry be tried again once the cause is put right', async () => {
    // The way back out of "the server will not take this". Without it the entry is kept for
    // ever and unreachable, which is barely better than losing it.
    const { challenge, slots } = seed();
    const blocked = await enqueueWorkout(finished(challenge, slots[0]!), slots[0]!.id);
    const fine = await enqueueWorkout(finished(challenge, slots[1]!), slots[1]!.id);
    await recordSendFailure(blocked.id, 'No plan slot exists.');

    expect(await unblockAll()).toBe(1);

    const after = await listOutbox();
    expect(after.map((e) => e.id)).toEqual([blocked.id, fine.id]);
    expect(after[0]!.blockedReason).toBeUndefined();
    // The attempt count is history and is deliberately kept.
    expect(after[0]!.attempts).toBe(1);
  });

  it('clearing blocks when none are blocked changes nothing', async () => {
    const { challenge, slots } = seed();
    await enqueueWorkout(finished(challenge, slots[0]!), slots[0]!.id);
    expect(await unblockAll()).toBe(0);
    expect(await countOutbox()).toBe(1);
  });
});

describe('queueing and the draft it came from', () => {
  it('is one transaction: the draft is retired exactly when the workout is queued', async () => {
    const { challenge, slots } = seed();
    const slot = slots[0]!;
    const draft = newDraft({
      id: newId('wo'),
      challengeId: challenge.id,
      chainId: challenge.chainId,
      slot,
      attemptNo: 1,
      effectiveTargets: slot.targets.map((t) => t.reps),
      adjustmentType: 'none',
      nowMs: Date.now(),
    });
    await saveDraft(draft);

    await enqueueWorkout(finished(challenge, slot, draft.id), slot.id);

    expect(await listDrafts()).toEqual([]);
    expect(await countOutbox()).toBe(1);
  });
});
