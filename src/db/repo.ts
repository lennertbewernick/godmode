/**
 * Repository layer. Owns the immutability rules the schema comments describe.
 */

import { materialize } from '../core/contracts.js';
import { percentageRampPattern, type PercentageRampParams } from '../core/patterns/percentageRamp.js';
import {
  DEFAULT_VOLUME_REST_PARAMS,
  volumeDerivedRestPolicy,
} from '../core/policies/rest.js';
import {
  TOTAL_REPS_POLICY_ID,
  TOTAL_REPS_POLICY_VERSION,
  classifyOutcome,
  manualAdvance,
  totalRepsAtLeastTargetPolicy,
} from '../core/policies/evaluation.js';
import type {
  Baseline,
  ChallengeEndReason,
  EvaluationResult,
  PerformanceTest,
  PlanSlotSpec,
  SeedStrategy,
  WorkoutPerformance,
} from '../core/types.js';
import {
  DEFAULT_SETTINGS,
  KCAL_ESTIMATOR_VERSION,
  openFitnessDB,
  type ChallengeRecord,
  type Database,
  type ExerciseRecord,
  type PlanSlotRecord,
  type SettingsRecord,
  type WorkoutRecord,
} from './schema.js';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

const nowIso = () => new Date().toISOString();

let dbPromise: Promise<Database> | null = null;

export function getDB(): Promise<Database> {
  dbPromise ??= openFitnessDB();
  return dbPromise;
}

/** Test seam — lets suites point at a fresh database. */
export function __setDB(promise: Promise<Database> | null): void {
  dbPromise = promise;
}

// ── Settings ────────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<SettingsRecord> {
  const db = await getDB();
  return (await db.get('settings', 'settings')) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<SettingsRecord>): Promise<SettingsRecord> {
  const db = await getDB();
  const next = { ...(await getSettings()), ...patch, id: 'settings' as const };
  await db.put('settings', next);
  return next;
}

// ── Exercises ───────────────────────────────────────────────────────────────────

export async function createExercise(label: string): Promise<ExerciseRecord> {
  const db = await getDB();
  const record: ExerciseRecord = {
    id: newId('ex'),
    label: label.trim() || 'Exercise',
    unit: 'reps',
    createdAt: nowIso(),
  };
  await db.put('exercises', record);
  return record;
}

export async function listExercises(): Promise<ExerciseRecord[]> {
  const db = await getDB();
  return db.getAll('exercises');
}

// ── Performance tests (rested max) ──────────────────────────────────────────────

export async function recordMaxTest(
  exerciseId: string,
  value: number,
  challengeId?: string,
): Promise<PerformanceTest> {
  const db = await getDB();
  const test: PerformanceTest = {
    id: newId('test'),
    exerciseId,
    performedAt: nowIso(),
    protocolId: 'single-set-max-v1',
    protocolVersion: 1,
    value,
    unit: 'reps',
    ...(challengeId === undefined ? {} : { challengeId }),
  };
  await db.put('performanceTests', test);
  return test;
}

// ── Challenges ──────────────────────────────────────────────────────────────────

export interface CreateChallengeInput {
  exerciseId: string;
  params: PercentageRampParams;
  baseline: Baseline;
  /** Continues an existing chain. Omit to start a new one. */
  previousChallengeId?: string;
  chainId?: string;
}

export async function createChallenge(input: CreateChallengeInput): Promise<{
  challenge: ChallengeRecord;
  slots: PlanSlotRecord[];
}> {
  const db = await getDB();
  const id = newId('ch');
  const generatedAt = nowIso();

  const challenge: ChallengeRecord = {
    id,
    exerciseId: input.exerciseId,
    chainId: input.chainId ?? input.previousChallengeId ?? id,
    patternId: percentageRampPattern.id,
    patternVersion: percentageRampPattern.version,
    patternParams: { ...input.params } as unknown as Record<string, unknown>,
    restPolicyId: volumeDerivedRestPolicy.id,
    restPolicyVersion: volumeDerivedRestPolicy.version,
    restPolicyParams: { ...DEFAULT_VOLUME_REST_PARAMS },
    evaluationPolicyId: TOTAL_REPS_POLICY_ID,
    evaluationPolicyVersion: TOTAL_REPS_POLICY_VERSION,
    baseline: input.baseline,
    goalValue: input.params.goalMax,
    status: 'active',
    startedAt: generatedAt,
    ...(input.previousChallengeId === undefined
      ? {}
      : { previousChallengeId: input.previousChallengeId }),
  };

  const specs = materialize(percentageRampPattern, input.params);
  const slots = specs.map((spec) => specToRecord(spec, id, generatedAt));

  const tx = db.transaction(['challenges', 'planSlots'], 'readwrite');
  await tx.objectStore('challenges').put(challenge);
  for (const slot of slots) await tx.objectStore('planSlots').put(slot);
  await tx.done;

  return { challenge, slots };
}

function specToRecord(
  spec: PlanSlotSpec,
  challengeId: string,
  generatedAt: string,
): PlanSlotRecord {
  return {
    id: newId('slot'),
    challengeId,
    ordinal: spec.ordinal,
    patternId: percentageRampPattern.id,
    patternVersion: percentageRampPattern.version,
    generatedAt,
    targets: spec.targets,
    targetTotal: spec.targetTotal,
    restSeconds: spec.restSeconds,
    status: 'available',
    ...(spec.week === undefined ? {} : { week: spec.week }),
    ...(spec.day === undefined ? {} : { day: spec.day }),
    ...(spec.cycleLabel === undefined ? {} : { cycleLabel: spec.cycleLabel }),
    ...(spec.patternMetrics === undefined ? {} : { patternMetrics: spec.patternMetrics }),
  };
}

export async function getActiveChallenge(): Promise<ChallengeRecord | undefined> {
  const db = await getDB();
  const active = await db.getAllFromIndex('challenges', 'byStatus', 'active');
  return active.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export async function listChallenges(): Promise<ChallengeRecord[]> {
  const db = await getDB();
  return (await db.getAll('challenges')).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function endChallenge(
  challengeId: string,
  endReason: ChallengeEndReason,
): Promise<void> {
  const db = await getDB();
  const challenge = await db.get('challenges', challengeId);
  if (!challenge) throw new Error(`challenge ${challengeId} not found`);
  await db.put('challenges', { ...challenge, status: 'ended', endedAt: nowIso(), endReason });
}

/**
 * Continue a chain after a challenge ends.
 *
 * The baseline for the successor is the caller's explicit decision, carrying provenance.
 * We deliberately do NOT default it to the previous goal or to the best AMRAP result:
 * a goal is a generation coordinate, and an AMRAP performed after 150 preceding reps is a
 * fatigued measurement. Neither is a rested max.
 */
export async function continueChallenge(input: {
  previous: ChallengeRecord;
  strategy: SeedStrategy;
  baselineValue: number;
  goalValue: number;
  weeks: number;
  daysPerWeek: number;
  evidenceId?: string;
}): Promise<{ challenge: ChallengeRecord; slots: PlanSlotRecord[] }> {
  const previousParams = input.previous.patternParams as unknown as PercentageRampParams;
  const baseline: Baseline = {
    value: input.baselineValue,
    source: input.strategy === 'retest' ? 'tested' : 'user_entered',
    recordedAt: nowIso(),
    ...(input.evidenceId === undefined ? {} : { evidenceId: input.evidenceId }),
  };

  return createChallenge({
    exerciseId: input.previous.exerciseId,
    previousChallengeId: input.previous.id,
    chainId: input.previous.chainId,
    baseline,
    params: {
      coefficients: [...previousParams.coefficients],
      roles: [...previousParams.roles],
      amrapIndices: [...previousParams.amrapIndices],
      baselineMax: input.baselineValue,
      goalMax: input.goalValue,
      weeks: input.weeks,
      daysPerWeek: input.daysPerWeek,
    },
  });
}

// ── Plan slots ──────────────────────────────────────────────────────────────────

export async function listSlots(challengeId: string): Promise<PlanSlotRecord[]> {
  const db = await getDB();
  const slots = await db.getAllFromIndex('planSlots', 'byChallenge', challengeId);
  return slots
    .filter((s) => s.status !== 'superseded' && s.status !== 'cancelled')
    .sort((a, b) => a.ordinal - b.ordinal);
}

/** The next slot the user should attempt: the lowest ordinal not yet completed. */
export async function getCurrentSlot(challengeId: string): Promise<PlanSlotRecord | undefined> {
  const slots = await listSlots(challengeId);
  return slots.find((s) => s.status !== 'completed');
}

// ── Workouts ────────────────────────────────────────────────────────────────────

export async function listWorkouts(chainId?: string): Promise<WorkoutRecord[]> {
  const db = await getDB();
  const all = chainId
    ? await db.getAllFromIndex('workouts', 'byChain', chainId)
    : await db.getAll('workouts');
  return all.sort((a, b) => a.performedAt.localeCompare(b.performedAt));
}

export async function countAttempts(planSlotId: string): Promise<number> {
  const db = await getDB();
  return (await db.getAllFromIndex('workouts', 'bySlot', planSlotId)).length;
}

export function estimateKcal(
  totalReps: number,
  bodyweightKg: number | undefined,
  coefficient: number,
): number | undefined {
  if (!bodyweightKg || bodyweightKg <= 0) return undefined;
  return Math.round(totalReps * bodyweightKg * coefficient);
}

export interface LogWorkoutInput {
  challenge: ChallengeRecord;
  slot: PlanSlotRecord;
  performance: WorkoutPerformance;
  durationSeconds?: number;
  /** Explicit user override: advance despite not satisfying the prescription. */
  manuallyAdvance?: boolean;
  performedAt?: string;
  note?: string;
}

export async function logWorkout(input: LogWorkoutInput): Promise<{
  workout: WorkoutRecord;
  evaluation: EvaluationResult;
}> {
  const db = await getDB();
  const spec: PlanSlotSpec = {
    ordinal: input.slot.ordinal,
    targets: input.slot.targets,
    targetTotal: input.slot.targetTotal,
    restSeconds: input.slot.restSeconds,
  };

  const manual = input.manuallyAdvance === true;
  const evaluation = manual
    ? manualAdvance(spec, input.performance)
    : totalRepsAtLeastTargetPolicy.evaluate(spec, input.performance);

  const settings = await getSettings();
  const kcalValue = estimateKcal(
    input.performance.actualTotal,
    settings.bodyweightKg,
    settings.kcalCoefficient,
  );

  const attemptNo = (await countAttempts(input.slot.id)) + 1;

  const workout: WorkoutRecord = {
    id: newId('wo'),
    challengeId: input.challenge.id,
    chainId: input.challenge.chainId,
    planSlotId: input.slot.id,
    attemptNo,
    performedAt: input.performedAt ?? nowIso(),
    sets: input.performance.sets,
    actualTotal: input.performance.actualTotal,
    adjustmentType: input.performance.adjustmentType,
    effectiveTotal: input.performance.effectiveTotal,
    outcome: classifyOutcome(evaluation, input.performance.adjustmentType, manual),
    evaluation,
    evaluationPolicyId: TOTAL_REPS_POLICY_ID,
    evaluationPolicyVersion: TOTAL_REPS_POLICY_VERSION,
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(kcalValue === undefined
      ? {}
      : {
          kcal: {
            value: kcalValue,
            source: 'estimated' as const,
            estimatorVersion: KCAL_ESTIMATOR_VERSION,
          },
        }),
  };

  const tx = db.transaction(['workouts', 'planSlots'], 'readwrite');
  await tx.objectStore('workouts').put(workout);
  // The slot record itself is never edited beyond its lifecycle status.
  await tx.objectStore('planSlots').put({
    ...input.slot,
    status: evaluation.advances ? 'completed' : 'attempted',
  });
  await tx.done;

  return { workout, evaluation };
}

/** Insert an imported workout, which may be unlinked from any generated slot. */
export async function putImportedWorkout(record: WorkoutRecord): Promise<void> {
  const db = await getDB();
  await db.put('workouts', record);
}

export async function putSlots(slots: PlanSlotRecord[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('planSlots', 'readwrite');
  for (const slot of slots) await tx.store.put(slot);
  await tx.done;
}
