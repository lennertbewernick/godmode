/**
 * Datasets the persistence tests share.
 *
 * Two of them, and the pair is the point:
 *
 *   `MAXIMAL_BACKUP` — every optional property present on every record shape, including the
 *   awkward ones: a challenge whose baseline cites a performance test that in turn cites the
 *   challenge (a genuine foreign-key cycle), and a plan slot that supersedes another.
 *
 *   `MINIMAL_BACKUP` — every optional property absent. This is the one that catches a decoder
 *   that turns a NULL column into `{field: undefined}` instead of omitting the key.
 *
 * Typed as `BackupFile`, so they cannot drift from the record types either.
 */

import type { BackupFile } from '../src/data/exchange.js';

export const MAXIMAL_BACKUP: BackupFile = {
  format: 'godmode-backup',
  formatVersion: 1,
  dbVersion: 2,
  exportedAt: '2026-07-30T18:12:04.221Z',
  exercises: [
    { id: 'ex_1', label: 'Liegestütze', unit: 'reps', createdAt: '2026-05-29T08:00:00.000Z' },
  ],
  performanceTests: [
    {
      id: 'test_1',
      exerciseId: 'ex_1',
      challengeId: 'ch_1',
      performedAt: '2026-07-10T07:15:00.000Z',
      protocolId: 'single-set-max-v1',
      protocolVersion: 1,
      value: 42,
      unit: 'reps',
      note: 'rested, morning',
    },
  ],
  challenges: [
    {
      id: 'ch_0',
      exerciseId: 'ex_1',
      chainId: 'ch_0',
      patternId: 'percentage-ramp',
      patternVersion: 1,
      patternParams: { coefficients: [0.5, 0.6], roles: ['medium', 'big'], amrapIndices: [1] },
      restPolicyId: 'volume-derived',
      restPolicyVersion: 1,
      restPolicyParams: { baseSeconds: 60 },
      evaluationPolicyId: 'total-reps-at-least-target',
      evaluationPolicyVersion: 1,
      baseline: { value: 18, source: 'user_entered', recordedAt: '2026-05-29T08:00:00.000Z' },
      status: 'ended',
      startedAt: '2026-05-29T08:00:00.000Z',
    },
    {
      id: 'ch_1',
      exerciseId: 'ex_1',
      chainId: 'ch_0',
      previousChallengeId: 'ch_0',
      patternId: 'percentage-ramp',
      patternVersion: 1,
      // Nested arrays and objects inside an opaque blob, on purpose: the JSON column has to
      // carry them untouched, and the canonical encoder has to keep the array order.
      patternParams: {
        coefficients: [0.5, 0.6, 0.4, 0.4, 1],
        roles: ['medium', 'big', 'small', 'small', 'amrap'],
        amrapIndices: [4],
        baselineMax: 42,
        goalMax: 100,
        weeks: 6,
        daysPerWeek: 3,
        nested: { deep: { flag: true, list: [1, 2, 3], nothing: null } },
      },
      restPolicyId: 'volume-derived',
      restPolicyVersion: 1,
      restPolicyParams: { baseSeconds: 60, perRepSeconds: 1.5 },
      evaluationPolicyId: 'total-reps-at-least-target',
      evaluationPolicyVersion: 1,
      baseline: {
        value: 42,
        source: 'tested',
        evidenceId: 'test_1',
        recordedAt: '2026-07-10T07:15:00.000Z',
      },
      goalValue: 100,
      status: 'active',
      startedAt: '2026-07-10T07:20:00.000Z',
      endedAt: '2026-07-29T19:00:00.000Z',
      endReason: 'goal_reached',
    },
  ],
  planSlots: [
    {
      id: 'slot_0',
      challengeId: 'ch_1',
      ordinal: 1,
      patternId: 'percentage-ramp',
      patternVersion: 1,
      generatedAt: '2026-07-10T07:20:00.000Z',
      targets: [{ index: 1, targetKind: 'reps', reps: 21, role: 'medium', isAmrap: false }],
      targetTotal: 21,
      restSeconds: 60,
      status: 'superseded',
    },
    {
      id: 'slot_1',
      challengeId: 'ch_1',
      ordinal: 1,
      week: 1,
      day: 1,
      cycleLabel: 'Session 1',
      patternId: 'percentage-ramp',
      patternVersion: 1,
      generatedAt: '2026-07-10T07:21:00.000Z',
      decision: { reason: 'regenerated after retest', previousGenerationMax: 18 },
      patternMetrics: { generationMax: 42.5 },
      targets: [
        { index: 1, targetKind: 'reps', reps: 21, role: 'medium', isAmrap: false, restAfterSeconds: 60 },
        { index: 2, targetKind: 'reps', reps: 25, role: 'big', isAmrap: false, restAfterSeconds: 90 },
        { index: 3, targetKind: 'reps', reps: 17, role: 'amrap', isAmrap: true },
      ],
      targetTotal: 63,
      restSeconds: 60,
      status: 'completed',
      supersedesId: 'slot_0',
    },
  ],
  workouts: [
    {
      id: 'wo_1',
      challengeId: 'ch_1',
      chainId: 'ch_0',
      planSlotId: 'slot_1',
      attemptNo: 1,
      performedAt: '2026-07-11T09:03:00.000Z',
      durationSeconds: 391,
      sets: [
        {
          index: 1,
          effectiveTarget: 21,
          actual: 21,
          startedAt: '2026-07-11T09:03:00.000Z',
          endedAt: '2026-07-11T09:03:44.000Z',
          restAfterSeconds: 60,
        },
        { index: 2, effectiveTarget: 25, actual: 25 },
        { index: 3, effectiveTarget: 17, actual: 31 },
      ],
      actualTotal: 77,
      adjustmentType: 'redistributed',
      effectiveTotal: 63,
      outcome: 'completed_as_planned',
      evaluation: {
        satisfied: true,
        advances: true,
        reason: 'total reps met the prescription',
        measured: { actualTotal: 77, targetTotal: 63, surplus: 14 },
      },
      evaluationPolicyId: 'total-reps-at-least-target',
      evaluationPolicyVersion: 1,
      kcal: { value: 18.5, source: 'estimated', estimatorVersion: 1 },
      note: 'felt strong',
      importSource: 'incumbent-csv-v1',
    },
    {
      // The shape the real import produces: no slot, no prescription, no evaluation.
      // Zone-less local timestamp, exactly as `toIso()` in src/import/pipeline.ts:177 writes it.
      id: 'wo_2',
      challengeId: 'ch_1',
      chainId: 'ch_0',
      attemptNo: 1,
      performedAt: '2026-05-29T08:34:00',
      sets: [
        { index: 1, actual: 12 },
        { index: 2, actual: 10 },
      ],
      actualTotal: 22,
      adjustmentType: 'none',
      outcome: 'failed',
      kcal: { value: 7, source: 'external', estimatorVersion: 1 },
      importSource: 'incumbent-csv-v1',
    },
  ],
  settings: {
    id: 'settings',
    bodyweightKg: 82.5,
    kcalCoefficient: 0.003,
    restOverrideSeconds: 45,
    lastBackupAt: '2026-07-30T18:00:00.000Z',
    onboardedAt: '2026-05-29T07:59:00.000Z',
    selectedChallengeId: 'ch_1',
  },
};

export const MINIMAL_BACKUP: BackupFile = {
  format: 'godmode-backup',
  formatVersion: 1,
  dbVersion: 2,
  exportedAt: '2026-07-30T18:12:04.221Z',
  exercises: [
    { id: 'ex_1', label: 'Push-ups', unit: 'reps', createdAt: '2026-05-29T08:00:00.000Z' },
  ],
  performanceTests: [],
  challenges: [
    {
      id: 'ch_1',
      exerciseId: 'ex_1',
      chainId: 'ch_1',
      patternId: 'percentage-ramp',
      patternVersion: 1,
      patternParams: {},
      restPolicyId: 'volume-derived',
      restPolicyVersion: 1,
      restPolicyParams: {},
      evaluationPolicyId: 'total-reps-at-least-target',
      evaluationPolicyVersion: 1,
      baseline: { value: 18, source: 'imported', recordedAt: '2026-05-29T08:00:00.000Z' },
      status: 'active',
      startedAt: '2026-05-29T08:00:00.000Z',
    },
  ],
  planSlots: [
    {
      id: 'slot_1',
      challengeId: 'ch_1',
      ordinal: 1,
      patternId: 'percentage-ramp',
      patternVersion: 1,
      generatedAt: '2026-05-29T08:00:00.000Z',
      targets: [],
      targetTotal: 0,
      restSeconds: 0,
      status: 'available',
    },
  ],
  workouts: [
    {
      id: 'wo_1',
      challengeId: 'ch_1',
      chainId: 'ch_1',
      attemptNo: 1,
      performedAt: '2026-05-29T08:34:00',
      sets: [],
      actualTotal: 0,
      adjustmentType: 'none',
      outcome: 'failed',
    },
  ],
  settings: { id: 'settings', kcalCoefficient: 0.003 },
};

/** Structured-clone deep copy, so a test that mutates a fixture cannot infect its neighbours. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
