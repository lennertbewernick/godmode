/**
 * Records to SQL rows and back.
 *
 * Hand-written rather than generated from `server/fields.ts`, because three of the shapes are
 * not one-property-one-column: `Baseline`, `KcalRecord` and `EvaluationResult` are flattened
 * into column groups, and six properties are JSON columns. A mapping that pretended otherwise
 * would need an escape hatch for every one of them.
 *
 * The rule that makes the round trip exact:
 *
 *   **NULL decodes to an absent key.** Never `{field: undefined}`. An own property holding
 *   `undefined` is reported by `Object.keys`, breaks structural equality against the record that
 *   was encoded, and is rejected outright by `exactOptionalPropertyTypes`. `optional()` in
 *   `server/canonical.ts` is how that is enforced at every site.
 *
 * Every decode ends by re-validating the assembled record against its field map, so a row that
 * has drifted from the schema fails here — loudly, with a path — instead of downstream.
 *
 * Pure. No `node:sqlite` import: this module builds and reads plain objects, so it is testable
 * without a database, and the database tests can drive it with real rows.
 */

import { canonicalJson, optional } from './canonical.js';
import {
  CHALLENGE_FIELDS,
  EXERCISE_FIELDS,
  PERFORMANCE_TEST_FIELDS,
  PLAN_SLOT_FIELDS,
  SETTINGS_FIELDS,
  WORKOUT_FIELDS,
  type FieldSpecMap,
} from './fields.js';
import { validateOne } from './validate.js';
import type { PerformanceTest } from '../src/core/types.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  PlanSlotRecord,
  SettingsRecord,
  WorkoutRecord,
} from '../src/db/schema.js';

/** What a bound parameter may be. `undefined` is deliberately not one of them. */
export type SqlValue = string | number | null;
export type SqlRow = Readonly<Record<string, SqlValue>>;

export class RowDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowDecodeError';
  }
}

/** SQLite has no boolean type; the schema stores 0/1 in an INTEGER column with a CHECK. */
function toBoolean(value: unknown, path: string): boolean {
  if (value === 0 || value === 1) return value === 1;
  throw new RowDecodeError(`${path}: expected 0 or 1, received ${JSON.stringify(value) ?? 'undefined'}`);
}

function fromBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function parseJson(value: unknown, path: string): unknown {
  if (typeof value !== 'string') {
    throw new RowDecodeError(`${path}: expected JSON text, received ${typeof value}`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new RowDecodeError(`${path}: column does not contain valid JSON`);
  }
}

function parseJsonOrNull(value: unknown, path: string): unknown {
  return value === null || value === undefined ? undefined : parseJson(value, path);
}

/**
 * A table's column list, encoder and decoder, kept together so nothing can use one without the
 * others. `server/db.test.ts` asserts each `columns` array against `PRAGMA table_info`, which is
 * what stops this file and `schema.sql` from drifting apart.
 */
export interface TableMapping<R> {
  readonly table: string;
  readonly columns: readonly string[];
  readonly fields: FieldSpecMap;
  readonly encode: (record: R) => SqlRow;
  readonly decode: (row: Readonly<Record<string, unknown>>) => R;
}

/**
 * `INSERT INTO t (a, b) VALUES (?, ?)` — never `INSERT OR REPLACE`.
 *
 * SQLite's `REPLACE` deletes the conflicting row and inserts a new one, which fires
 * `ON DELETE` actions and can cascade through foreign keys. A re-run of the import must be
 * `insert / no-op / abort`, never a silent delete-and-reinsert.
 */
export function insertSql<R>(mapping: TableMapping<R>): string {
  const columns = mapping.columns.join(', ');
  const placeholders = mapping.columns.map(() => '?').join(', ');
  return `INSERT INTO ${mapping.table} (${columns}) VALUES (${placeholders})`;
}

/** Positional parameters in column order. Positional, so no named-parameter dialect can bite. */
export function bindValues<R>(mapping: TableMapping<R>, row: SqlRow): SqlValue[] {
  return mapping.columns.map((column) => {
    if (!Object.hasOwn(row, column)) {
      throw new RowDecodeError(`${mapping.table}: encoder produced no value for "${column}"`);
    }
    return row[column] as SqlValue;
  });
}

// ── exercises ───────────────────────────────────────────────────────────────────────────────

export const EXERCISES: TableMapping<ExerciseRecord> = {
  table: 'exercises',
  columns: ['id', 'label', 'unit', 'created_at'],
  fields: EXERCISE_FIELDS,
  encode: (record) => ({
    id: record.id,
    label: record.label,
    unit: record.unit,
    created_at: record.createdAt,
  }),
  decode: (row) =>
    validateOne<ExerciseRecord>(
      {
        id: row['id'],
        label: row['label'],
        unit: row['unit'],
        createdAt: row['created_at'],
      },
      EXERCISE_FIELDS,
      'exercises',
    ),
};

// ── challenges ──────────────────────────────────────────────────────────────────────────────

export const CHALLENGES: TableMapping<ChallengeRecord> = {
  table: 'challenges',
  columns: [
    'id',
    'exercise_id',
    'chain_id',
    'previous_challenge_id',
    'pattern_id',
    'pattern_version',
    'pattern_params',
    'rest_policy_id',
    'rest_policy_version',
    'rest_policy_params',
    'evaluation_policy_id',
    'evaluation_policy_version',
    'baseline_value',
    'baseline_source',
    'baseline_evidence_id',
    'baseline_recorded_at',
    'goal_value',
    'status',
    'started_at',
    'ended_at',
    'end_reason',
  ],
  fields: CHALLENGE_FIELDS,
  encode: (record) => ({
    id: record.id,
    exercise_id: record.exerciseId,
    chain_id: record.chainId,
    previous_challenge_id: record.previousChallengeId ?? null,
    pattern_id: record.patternId,
    pattern_version: record.patternVersion,
    pattern_params: canonicalJson(record.patternParams, 'challenges.patternParams'),
    rest_policy_id: record.restPolicyId,
    rest_policy_version: record.restPolicyVersion,
    rest_policy_params: canonicalJson(record.restPolicyParams, 'challenges.restPolicyParams'),
    evaluation_policy_id: record.evaluationPolicyId,
    evaluation_policy_version: record.evaluationPolicyVersion,
    baseline_value: record.baseline.value,
    baseline_source: record.baseline.source,
    baseline_evidence_id: record.baseline.evidenceId ?? null,
    baseline_recorded_at: record.baseline.recordedAt,
    goal_value: record.goalValue ?? null,
    status: record.status,
    started_at: record.startedAt,
    ended_at: record.endedAt ?? null,
    end_reason: record.endReason ?? null,
  }),
  decode: (row) =>
    validateOne<ChallengeRecord>(
      {
        id: row['id'],
        exerciseId: row['exercise_id'],
        chainId: row['chain_id'],
        ...optional('previousChallengeId', row['previous_challenge_id']),
        patternId: row['pattern_id'],
        patternVersion: row['pattern_version'],
        patternParams: parseJson(row['pattern_params'], 'challenges.pattern_params'),
        restPolicyId: row['rest_policy_id'],
        restPolicyVersion: row['rest_policy_version'],
        restPolicyParams: parseJson(row['rest_policy_params'], 'challenges.rest_policy_params'),
        evaluationPolicyId: row['evaluation_policy_id'],
        evaluationPolicyVersion: row['evaluation_policy_version'],
        baseline: {
          value: row['baseline_value'],
          source: row['baseline_source'],
          ...optional('evidenceId', row['baseline_evidence_id']),
          recordedAt: row['baseline_recorded_at'],
        },
        ...optional('goalValue', row['goal_value']),
        status: row['status'],
        startedAt: row['started_at'],
        ...optional('endedAt', row['ended_at']),
        ...optional('endReason', row['end_reason']),
      },
      CHALLENGE_FIELDS,
      'challenges',
    ),
};

// ── performance_tests ───────────────────────────────────────────────────────────────────────

export const PERFORMANCE_TESTS: TableMapping<PerformanceTest> = {
  table: 'performance_tests',
  columns: [
    'id',
    'exercise_id',
    'challenge_id',
    'performed_at',
    'protocol_id',
    'protocol_version',
    'value',
    'unit',
    'note',
  ],
  fields: PERFORMANCE_TEST_FIELDS,
  encode: (record) => ({
    id: record.id,
    exercise_id: record.exerciseId,
    challenge_id: record.challengeId ?? null,
    performed_at: record.performedAt,
    protocol_id: record.protocolId,
    protocol_version: record.protocolVersion,
    value: record.value,
    unit: record.unit,
    note: record.note ?? null,
  }),
  decode: (row) =>
    validateOne<PerformanceTest>(
      {
        id: row['id'],
        exerciseId: row['exercise_id'],
        ...optional('challengeId', row['challenge_id']),
        performedAt: row['performed_at'],
        protocolId: row['protocol_id'],
        protocolVersion: row['protocol_version'],
        value: row['value'],
        unit: row['unit'],
        ...optional('note', row['note']),
      },
      PERFORMANCE_TEST_FIELDS,
      'performance_tests',
    ),
};

// ── plan_slots ──────────────────────────────────────────────────────────────────────────────

export const PLAN_SLOTS: TableMapping<PlanSlotRecord> = {
  table: 'plan_slots',
  columns: [
    'id',
    'challenge_id',
    'ordinal',
    'week',
    'day',
    'cycle_label',
    'pattern_id',
    'pattern_version',
    'generated_at',
    'decision',
    'pattern_metrics',
    'targets',
    'target_total',
    'rest_seconds',
    'status',
    'supersedes_id',
  ],
  fields: PLAN_SLOT_FIELDS,
  encode: (record) => ({
    id: record.id,
    challenge_id: record.challengeId,
    ordinal: record.ordinal,
    week: record.week ?? null,
    day: record.day ?? null,
    cycle_label: record.cycleLabel ?? null,
    pattern_id: record.patternId,
    pattern_version: record.patternVersion,
    generated_at: record.generatedAt,
    decision: record.decision === undefined ? null : canonicalJson(record.decision, 'planSlots.decision'),
    pattern_metrics:
      record.patternMetrics === undefined
        ? null
        : canonicalJson(record.patternMetrics, 'planSlots.patternMetrics'),
    targets: canonicalJson(record.targets, 'planSlots.targets'),
    target_total: record.targetTotal,
    rest_seconds: record.restSeconds,
    status: record.status,
    supersedes_id: record.supersedesId ?? null,
  }),
  decode: (row) =>
    validateOne<PlanSlotRecord>(
      {
        id: row['id'],
        challengeId: row['challenge_id'],
        ordinal: row['ordinal'],
        ...optional('week', row['week']),
        ...optional('day', row['day']),
        ...optional('cycleLabel', row['cycle_label']),
        patternId: row['pattern_id'],
        patternVersion: row['pattern_version'],
        generatedAt: row['generated_at'],
        ...optional('decision', parseJsonOrNull(row['decision'], 'plan_slots.decision')),
        ...optional(
          'patternMetrics',
          parseJsonOrNull(row['pattern_metrics'], 'plan_slots.pattern_metrics'),
        ),
        targets: parseJson(row['targets'], 'plan_slots.targets'),
        targetTotal: row['target_total'],
        restSeconds: row['rest_seconds'],
        status: row['status'],
        ...optional('supersedesId', row['supersedes_id']),
      },
      PLAN_SLOT_FIELDS,
      'plan_slots',
    ),
};

// ── workouts ────────────────────────────────────────────────────────────────────────────────

export const WORKOUTS: TableMapping<WorkoutRecord> = {
  table: 'workouts',
  columns: [
    'id',
    'challenge_id',
    'chain_id',
    'plan_slot_id',
    'attempt_no',
    'performed_at',
    'duration_seconds',
    'sets',
    'actual_total',
    'adjustment_type',
    'effective_total',
    'outcome',
    'evaluation_satisfied',
    'evaluation_advances',
    'evaluation_reason',
    'evaluation_measured',
    'evaluation_policy_id',
    'evaluation_policy_version',
    'kcal_value',
    'kcal_source',
    'kcal_estimator_version',
    'note',
    'import_source',
  ],
  fields: WORKOUT_FIELDS,
  encode: (record) => ({
    id: record.id,
    challenge_id: record.challengeId,
    chain_id: record.chainId,
    plan_slot_id: record.planSlotId ?? null,
    attempt_no: record.attemptNo,
    performed_at: record.performedAt,
    duration_seconds: record.durationSeconds ?? null,
    sets: canonicalJson(record.sets, 'workouts.sets'),
    actual_total: record.actualTotal,
    adjustment_type: record.adjustmentType,
    effective_total: record.effectiveTotal ?? null,
    outcome: record.outcome,
    evaluation_satisfied:
      record.evaluation === undefined ? null : fromBoolean(record.evaluation.satisfied),
    evaluation_advances:
      record.evaluation === undefined ? null : fromBoolean(record.evaluation.advances),
    evaluation_reason: record.evaluation === undefined ? null : record.evaluation.reason,
    evaluation_measured:
      record.evaluation === undefined
        ? null
        : canonicalJson(record.evaluation.measured, 'workouts.evaluation.measured'),
    evaluation_policy_id: record.evaluationPolicyId ?? null,
    evaluation_policy_version: record.evaluationPolicyVersion ?? null,
    kcal_value: record.kcal === undefined ? null : record.kcal.value,
    kcal_source: record.kcal === undefined ? null : record.kcal.source,
    kcal_estimator_version: record.kcal === undefined ? null : record.kcal.estimatorVersion,
    note: record.note ?? null,
    import_source: record.importSource ?? null,
  }),
  decode: (row) => {
    const hasEvaluation = row['evaluation_satisfied'] !== null && row['evaluation_satisfied'] !== undefined;
    const hasKcal = row['kcal_value'] !== null && row['kcal_value'] !== undefined;
    return validateOne<WorkoutRecord>(
      {
        id: row['id'],
        challengeId: row['challenge_id'],
        chainId: row['chain_id'],
        ...optional('planSlotId', row['plan_slot_id']),
        attemptNo: row['attempt_no'],
        performedAt: row['performed_at'],
        ...optional('durationSeconds', row['duration_seconds']),
        sets: parseJson(row['sets'], 'workouts.sets'),
        actualTotal: row['actual_total'],
        adjustmentType: row['adjustment_type'],
        ...optional('effectiveTotal', row['effective_total']),
        outcome: row['outcome'],
        ...optional(
          'evaluation',
          hasEvaluation
            ? {
                satisfied: toBoolean(row['evaluation_satisfied'], 'workouts.evaluation_satisfied'),
                advances: toBoolean(row['evaluation_advances'], 'workouts.evaluation_advances'),
                reason: row['evaluation_reason'],
                measured: parseJson(row['evaluation_measured'], 'workouts.evaluation_measured'),
              }
            : null,
        ),
        ...optional('evaluationPolicyId', row['evaluation_policy_id']),
        ...optional('evaluationPolicyVersion', row['evaluation_policy_version']),
        ...optional(
          'kcal',
          hasKcal
            ? {
                value: row['kcal_value'],
                source: row['kcal_source'],
                estimatorVersion: row['kcal_estimator_version'],
              }
            : null,
        ),
        ...optional('note', row['note']),
        ...optional('importSource', row['import_source']),
      },
      WORKOUT_FIELDS,
      'workouts',
    );
  },
};

// ── settings ────────────────────────────────────────────────────────────────────────────────

export const SETTINGS: TableMapping<SettingsRecord> = {
  table: 'settings',
  columns: [
    'id',
    'bodyweight_kg',
    'kcal_coefficient',
    'rest_override_seconds',
    'last_backup_at',
    'onboarded_at',
    'selected_challenge_id',
  ],
  fields: SETTINGS_FIELDS,
  encode: (record) => ({
    id: record.id,
    bodyweight_kg: record.bodyweightKg ?? null,
    kcal_coefficient: record.kcalCoefficient,
    rest_override_seconds: record.restOverrideSeconds ?? null,
    last_backup_at: record.lastBackupAt ?? null,
    onboarded_at: record.onboardedAt ?? null,
    selected_challenge_id: record.selectedChallengeId ?? null,
  }),
  decode: (row) =>
    validateOne<SettingsRecord>(
      {
        id: row['id'],
        ...optional('bodyweightKg', row['bodyweight_kg']),
        kcalCoefficient: row['kcal_coefficient'],
        ...optional('restOverrideSeconds', row['rest_override_seconds']),
        ...optional('lastBackupAt', row['last_backup_at']),
        ...optional('onboardedAt', row['onboarded_at']),
        ...optional('selectedChallengeId', row['selected_challenge_id']),
      },
      SETTINGS_FIELDS,
      'settings',
    ),
};

/** Every table, in an order that satisfies the foreign keys without relying on deferral. */
export const TABLE_MAPPINGS = [
  EXERCISES,
  CHALLENGES,
  PERFORMANCE_TESTS,
  PLAN_SLOTS,
  WORKOUTS,
  SETTINGS,
] as const;
