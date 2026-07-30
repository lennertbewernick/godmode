/**
 * Reading a snapshot. These are the queries the whole UI is built on, so they are pinned here
 * rather than discovered by looking at a screen.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ChallengeRecord, type OutboxEntry, type PlanSlotRecord, type WorkoutRecord } from '../db/schema.js';
import type { Snapshot } from './client.js';
import {
  activeChallenges,
  applyPending,
  attemptsOn,
  currentSlot,
  exerciseLabels,
  ratchet,
  resolveSelectedChallenge,
  slotsFor,
  workoutsForChain,
} from './snapshot.js';

function challenge(id: string, over: Partial<ChallengeRecord> = {}): ChallengeRecord {
  return {
    id,
    exerciseId: 'ex_1',
    chainId: id,
    patternId: 'percentage-ramp',
    patternVersion: 1,
    patternParams: { daysPerWeek: 3 },
    restPolicyId: 'volume-derived',
    restPolicyVersion: 1,
    restPolicyParams: {},
    evaluationPolicyId: 'total-reps',
    evaluationPolicyVersion: 1,
    baseline: { value: 18, source: 'tested', recordedAt: '2026-01-01T00:00:00.000Z' },
    status: 'active',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function slot(id: string, ordinal: number, over: Partial<PlanSlotRecord> = {}): PlanSlotRecord {
  return {
    id,
    challengeId: 'ch_1',
    ordinal,
    patternId: 'percentage-ramp',
    patternVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    targets: [{ index: 1, targetKind: 'reps', reps: 10, role: 'medium', isAmrap: false }],
    targetTotal: 10,
    restSeconds: 60,
    status: 'available',
    ...over,
  };
}

function workout(id: string, over: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id,
    challengeId: 'ch_1',
    chainId: 'ch_1',
    planSlotId: 'slot_1',
    attemptNo: 1,
    performedAt: '2026-01-02T00:00:00.000Z',
    sets: [{ index: 1, actual: 10 }],
    actualTotal: 10,
    adjustmentType: 'none',
    outcome: 'completed_as_planned',
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    apiVersion: 1,
    schemaVersion: 1,
    revision: 1,
    exercises: [{ id: 'ex_1', label: 'Push-ups', unit: 'reps', createdAt: '2026-01-01T00:00:00.000Z' }],
    challenges: [challenge('ch_1')],
    planSlots: [slot('slot_1', 1), slot('slot_2', 2)],
    workouts: [],
    performanceTests: [],
    settings: DEFAULT_SETTINGS,
    ...over,
  };
}

describe('selection', () => {
  it('lists active challenges newest first', () => {
    const s = snapshot({
      challenges: [
        challenge('ch_old', { startedAt: '2026-01-01T00:00:00.000Z' }),
        challenge('ch_new', { startedAt: '2026-05-01T00:00:00.000Z' }),
        challenge('ch_done', { status: 'ended' }),
      ],
    });
    expect(activeChallenges(s).map((c) => c.id)).toEqual(['ch_new', 'ch_old']);
  });

  it('shows the stored selection', () => {
    const s = snapshot({
      challenges: [challenge('ch_a'), challenge('ch_b', { startedAt: '2026-06-01T00:00:00.000Z' })],
      settings: { ...DEFAULT_SETTINGS, selectedChallengeId: 'ch_a' },
    });
    expect(resolveSelectedChallenge(s)?.id).toBe('ch_a');
  });

  it('falls back rather than stranding the user when the selection has ended', () => {
    // The other device ended it. An empty screen over intact data would be the worst answer.
    const s = snapshot({
      challenges: [challenge('ch_a', { status: 'ended' }), challenge('ch_b')],
      settings: { ...DEFAULT_SETTINGS, selectedChallengeId: 'ch_a' },
    });
    expect(resolveSelectedChallenge(s)?.id).toBe('ch_b');
  });

  it('names exercises without a second round trip', () => {
    expect(exerciseLabels(snapshot()).get('ex_1')).toBe('Push-ups');
  });
});

describe('the plan', () => {
  it('drops superseded and cancelled slots and orders the rest', () => {
    const s = snapshot({
      planSlots: [
        slot('slot_3', 3),
        slot('slot_1', 1),
        slot('slot_x', 2, { status: 'superseded' }),
        slot('slot_y', 4, { status: 'cancelled' }),
        slot('slot_other', 1, { challengeId: 'ch_other' }),
      ],
    });
    expect(slotsFor(s, 'ch_1').map((x) => x.id)).toEqual(['slot_1', 'slot_3']);
  });

  it('points at the lowest ordinal that is not completed', () => {
    const s = snapshot({
      planSlots: [slot('slot_1', 1, { status: 'completed' }), slot('slot_2', 2, { status: 'attempted' })],
    });
    expect(currentSlot(slotsFor(s, 'ch_1'))?.id).toBe('slot_2');
  });

  it('counts attempts on a slot', () => {
    const s = snapshot({
      workouts: [workout('wo_1'), workout('wo_2'), workout('wo_3', { planSlotId: 'slot_2' })],
    });
    expect(attemptsOn(s, 'slot_1')).toBe(2);
  });

  it('orders history by when it was performed, never by attempt number', () => {
    const s = snapshot({
      workouts: [
        workout('wo_late', { attemptNo: 1, performedAt: '2026-03-01T00:00:00.000Z' }),
        workout('wo_early', { attemptNo: 9, performedAt: '2026-01-01T00:00:00.000Z' }),
      ],
    });
    expect(workoutsForChain(s, 'ch_1').map((w) => w.id)).toEqual(['wo_early', 'wo_late']);
  });
});

describe('workouts still queued on this device', () => {
  function entry(id: string, over: Partial<WorkoutRecord> = {}): OutboxEntry {
    const { attemptNo: _ignored, ...pending } = workout(id, over);
    return { id, seq: 1, queuedAt: '2026-01-03T00:00:00.000Z', attempts: 0, workout: pending };
  }

  it('shows them in the history so an offline session does not vanish', () => {
    const shown = applyPending(snapshot(), [entry('wo_queued')]);
    expect(shown.workouts.map((w) => w.id)).toEqual(['wo_queued']);
  });

  it('numbers them after the attempts the server already holds', () => {
    const s = snapshot({ workouts: [workout('wo_1', { attemptNo: 3 })] });
    const shown = applyPending(s, [entry('wo_queued')]);
    expect(shown.workouts.find((w) => w.id === 'wo_queued')?.attemptNo).toBe(4);
  });

  it('advances the slot, so Today moves on', () => {
    const shown = applyPending(snapshot(), [
      entry('wo_queued', {
        evaluation: { satisfied: true, advances: true, reason: 'Done.', measured: {} },
      }),
    ]);
    expect(shown.planSlots.find((x) => x.id === 'slot_1')?.status).toBe('completed');
  });

  it('leaves the slot short of complete when the session missed', () => {
    const shown = applyPending(snapshot(), [
      entry('wo_queued', {
        evaluation: { satisfied: false, advances: false, reason: 'Short.', measured: {} },
      }),
    ]);
    expect(shown.planSlots.find((x) => x.id === 'slot_1')?.status).toBe('attempted');
  });

  it('does not show a queued workout the server has since accepted', () => {
    // The drain landed but the outbox read had not caught up. Showing it twice would be worse
    // than showing it once.
    const s = snapshot({ workouts: [workout('wo_queued')] });
    const shown = applyPending(s, [entry('wo_queued')]);
    expect(shown.workouts).toHaveLength(1);
  });

  it('returns the snapshot untouched when nothing is queued', () => {
    const s = snapshot();
    expect(applyPending(s, [])).toBe(s);
  });
});

describe('the ratchet', () => {
  it('never takes a completed day back', () => {
    expect(ratchet('completed', false)).toBe('completed');
  });

  it('leaves a slot that is no longer part of the plan alone', () => {
    expect(ratchet('superseded', true)).toBe('superseded');
    expect(ratchet('cancelled', true)).toBe('cancelled');
  });

  it('matches the server: advancing completes, missing attempts', () => {
    expect(ratchet('available', true)).toBe('completed');
    expect(ratchet('available', false)).toBe('attempted');
  });
});
