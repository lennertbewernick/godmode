/**
 * Draining, against a stubbed `fetch`.
 *
 * The four questions this has to answer: does it send oldest first, can two drainers overlap,
 * does a failure it cannot fix block the queue behind it, and does anything get deleted that
 * the server did not confirm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import { __forgetDiscardedDrafts } from '../db/drafts.js';
import { __setDB } from '../db/local.js';
import { enqueueWorkout, listOutbox } from '../db/outbox.js';
import { buildChallenge, buildExercise, buildWorkout, newId } from '../db/records.js';
import {
  DEFAULT_SETTINGS,
  openFitnessDB,
  type ChallengeRecord,
  type PlanSlotRecord,
} from '../db/schema.js';
import { drainOutbox } from './drain.js';

let dbCounter = 0;
beforeEach(() => {
  dbCounter += 1;
  __setDB(openFitnessDB(`drain-test-db-${dbCounter}`));
  __forgetDiscardedDrafts();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function seed(): { challenge: ChallengeRecord; slots: PlanSlotRecord[] } {
  const exercise = buildExercise('Push-ups');
  return buildChallenge({
    exerciseId: exercise.id,
    baseline: { value: 18, source: 'tested', recordedAt: '2026-01-01T00:00:00.000Z' },
    params: pushupParams(18, 100, 6, 3),
  });
}

function finished(challenge: ChallengeRecord, slot: PlanSlotRecord) {
  return buildWorkout({
    workoutId: newId('wo'),
    challenge,
    slot,
    performance: {
      sets: [{ index: 1, effectiveTarget: slot.targetTotal, actual: slot.targetTotal }],
      actualTotal: slot.targetTotal,
      adjustmentType: 'none',
      effectiveTotal: slot.targetTotal,
    },
    settings: DEFAULT_SETTINGS,
  }).workout;
}

const SNAPSHOT = {
  apiVersion: 1,
  schemaVersion: 1,
  revision: 7,
  exercises: [],
  challenges: [],
  planSlots: [],
  workouts: [],
  performanceTests: [],
  settings: DEFAULT_SETTINGS,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Queue three sessions, in this order. */
async function queueThree(): Promise<string[]> {
  const { challenge, slots } = seed();
  const ids: string[] = [];
  for (const slot of slots.slice(0, 3)) {
    const workout = finished(challenge, slot);
    await enqueueWorkout(workout, slot.id);
    ids.push(workout.id);
  }
  return ids;
}

describe('order and completion', () => {
  it('sends oldest first and empties the queue', async () => {
    const ids = await queueThree();
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { workout: { id: string } };
        sent.push(body.workout.id);
        return jsonResponse(201, { workout: {}, attemptNo: 1, duplicate: false, snapshot: SNAPSHOT });
      }),
    );

    const result = await drainOutbox();

    expect(sent).toEqual(ids);
    expect(result.sent).toBe(3);
    expect(result.remaining).toBe(0);
    expect(result.snapshot?.revision).toBe(7);
    expect(await listOutbox()).toEqual([]);
  });

  it('treats a duplicate as sent — an earlier attempt did land', async () => {
    await queueThree();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(201, { workout: {}, attemptNo: 2, duplicate: true, snapshot: SNAPSHOT }),
      ),
    );

    const result = await drainOutbox();
    expect(result.sent).toBe(3);
    expect(await listOutbox()).toEqual([]);
  });
});

describe('failures', () => {
  it('stops at the first entry it could not send, and keeps the rest in order', async () => {
    const ids = await queueThree();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse(201, {
            workout: {},
            attemptNo: 1,
            duplicate: false,
            snapshot: SNAPSHOT,
          });
        }
        throw new TypeError('Failed to fetch');
      }),
    );

    const result = await drainOutbox();

    expect(result.sent).toBe(1);
    expect(result.stoppedBy?.kind).toBe('unreachable');
    // The third was never attempted: stopping is what preserves the order.
    expect(calls).toBe(2);
    expect((await listOutbox()).map((e) => e.id)).toEqual([ids[1], ids[2]]);
  });

  it('keeps a workout the server refuses, and steps over it rather than blocking the queue', async () => {
    const ids = await queueThree();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { workout: { id: string } };
        if (body.workout.id === ids[0]) {
          return jsonResponse(409, {
            error: 'unknown_plan_slot',
            message: 'No plan slot "slot_x" exists. The workout has not been stored.',
          });
        }
        return jsonResponse(201, {
          workout: {},
          attemptNo: 1,
          duplicate: false,
          snapshot: SNAPSHOT,
        });
      }),
    );

    const first = await drainOutbox();
    expect(first.sent).toBe(2);
    expect(first.blocked).toBe(1);

    // Kept, not dropped: it is training that was actually performed.
    const left = await listOutbox();
    expect(left.map((e) => e.id)).toEqual([ids[0]]);
    expect(left[0]!.blockedReason).toMatch(/No plan slot/);

    // And it is not retried on the next pass, so it cannot hold anything up.
    const second = await drainOutbox();
    expect(second.sent).toBe(0);
    expect(second.blocked).toBe(1);
  });

  it('stops on a 401 and reports it, without losing anything', async () => {
    const ids = await queueThree();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(401, { error: 'unauthenticated', message: 'Sign in with the shared token.' }),
      ),
    );

    const result = await drainOutbox();
    expect(result.sent).toBe(0);
    expect(result.stoppedBy?.kind).toBe('unauthorised');
    expect((await listOutbox()).map((e) => e.id)).toEqual(ids);
  });
});

describe('serialisation', () => {
  it('two drainers started together do not send the same workout twice', async () => {
    await queueThree();
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { workout: { id: string } };
        // A real network reorders; the point is that the second drainer must not even start
        // until the first has finished with the queue.
        await new Promise((resolve) => setTimeout(resolve, 1));
        sent.push(body.workout.id);
        return jsonResponse(201, {
          workout: {},
          attemptNo: 1,
          duplicate: false,
          snapshot: SNAPSHOT,
        });
      }),
    );

    const [a, b] = await Promise.all([drainOutbox(), drainOutbox()]);

    expect(sent).toHaveLength(3);
    expect(new Set(sent).size).toBe(3);
    expect(a.sent + b.sent).toBe(3);
    expect(await listOutbox()).toEqual([]);
  });
});
