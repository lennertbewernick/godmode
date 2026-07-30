/**
 * The persistence matrix, as types.
 *
 * `server/PERSISTENCE.md` is the prose version of this file. This is the version the compiler
 * checks. Each `SpecFor<R>` map is required to name **every** property of `R`, name **no**
 * property `R` does not have, and mark a property optional **exactly** when the TypeScript
 * property is optional. Add a field to `WorkoutRecord` and `npm run typecheck` fails here until
 * the field is described — which is the whole point, because the previous draft of this design
 * silently omitted `evaluation`, `evaluationPolicyId`, `evaluationPolicyVersion` and `note` from
 * workouts, `supersedesId` from slots, and treated `kcal` as a scalar.
 *
 * Pure. No DOM, no `node:sqlite`, no filesystem — the encoders and the validator both read from
 * here, and both must be testable without a database.
 */

import type {
  AdjustmentType,
  Baseline,
  BaselineSource,
  ChallengeEndReason,
  ChallengeStatus,
  EvaluationResult,
  PerformanceTest,
  PerformedSet,
  SetRole,
  SetTarget,
  TargetKind,
  WorkoutOutcome,
} from '../src/core/types.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  KcalRecord,
  PlanSlotRecord,
  PlanSlotStatus,
  SettingsRecord,
  WorkoutRecord,
} from '../src/db/schema.js';

// ── Enumerations ────────────────────────────────────────────────────────────────────────────
//
// Each list is checked in BOTH directions against its union: `satisfies readonly X[]` rejects a
// member the union does not have, and `ExactlyCovers` rejects a union member the list is missing.
// One direction alone is a trap — a list that is merely a valid subset compiles happily and then
// makes the validator reject a value the app can legitimately produce.

export const SET_ROLES = ['medium', 'big', 'small', 'amrap', 'custom'] as const satisfies readonly SetRole[];
export const TARGET_KINDS = ['reps'] as const satisfies readonly TargetKind[];
export const BASELINE_SOURCES = ['tested', 'user_entered', 'imported', 'estimated'] as const satisfies readonly BaselineSource[];
export const CHALLENGE_STATUSES = ['active', 'ended'] as const satisfies readonly ChallengeStatus[];
export const CHALLENGE_END_REASONS = ['goal_reached', 'closed_manually', 'abandoned', 'superseded'] as const satisfies readonly ChallengeEndReason[];
export const PLAN_SLOT_STATUSES = ['available', 'attempted', 'completed', 'superseded', 'cancelled'] as const satisfies readonly PlanSlotStatus[];
export const ADJUSTMENT_TYPES = ['none', 'redistributed', 'scaled_up', 'scaled_down'] as const satisfies readonly AdjustmentType[];
export const WORKOUT_OUTCOMES = ['completed_as_planned', 'scaled_up', 'deload', 'failed', 'advanced_manually'] as const satisfies readonly WorkoutOutcome[];
export const KCAL_SOURCES = ['external', 'estimated'] as const satisfies readonly KcalRecord['source'][];
export const UNITS = ['reps'] as const satisfies readonly ExerciseRecord['unit'][];

/**
 * The other direction: every member of the union must appear in the list.
 *
 * `satisfies readonly SetRole[]` above only proves the list contains nothing the union does not.
 * A list that is merely a valid *subset* compiles happily and then makes the validator reject a
 * value the app legitimately produces — silently, and only for the member that was forgotten.
 * `satisfies` cannot express this direction because it cannot infer the tuple, so the check is a
 * type-level assertion instead: add a member to any union in `src/core/types.ts` and the
 * corresponding line below fails to compile, naming what is missing.
 */
type Assert<T extends true> = T;
type Complete<Union extends string, Members extends readonly string[]> = [
  Exclude<Union, Members[number]>,
] extends [never]
  ? true
  : { ENUM_LIST_IS_MISSING: Exclude<Union, Members[number]> };

export type EnumListsAreComplete = [
  Assert<Complete<SetRole, typeof SET_ROLES>>,
  Assert<Complete<TargetKind, typeof TARGET_KINDS>>,
  Assert<Complete<BaselineSource, typeof BASELINE_SOURCES>>,
  Assert<Complete<ChallengeStatus, typeof CHALLENGE_STATUSES>>,
  Assert<Complete<ChallengeEndReason, typeof CHALLENGE_END_REASONS>>,
  Assert<Complete<PlanSlotStatus, typeof PLAN_SLOT_STATUSES>>,
  Assert<Complete<AdjustmentType, typeof ADJUSTMENT_TYPES>>,
  Assert<Complete<WorkoutOutcome, typeof WORKOUT_OUTCOMES>>,
  Assert<Complete<KcalRecord['source'], typeof KCAL_SOURCES>>,
  Assert<Complete<ExerciseRecord['unit'], typeof UNITS>>,
];

/**
 * The timestamp shape the dataset actually contains.
 *
 * NOT `Date.prototype.toISOString()` output. Imported sessions carry a **zone-less local**
 * timestamp — `2026-05-29T08:34:00`, nineteen characters, no `Z` — because `toIso()` in
 * `src/import/pipeline.ts:175-178` assembles it from the CSV's wall-clock fields and has no
 * offset to apply. Requiring a `Z`, or a minimum length of 20, would have rejected all 29 real
 * sessions at the migration gate. Fractional seconds and an explicit offset are accepted too,
 * because in-app records are minted with `new Date().toISOString()`.
 */
export const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A timestamp with a real calendar date behind it.
 *
 * The shape regex alone is not enough: `2026-02-30T25:61:00` matches it, and `Date.parse` is
 * specified to be implementation-defined for non-conforming input, so leaning on it would make
 * acceptance depend on the runtime. Every component is therefore range-checked here, including
 * the length of the month in the given year.
 */
export function isTimestamp(value: string): boolean {
  const match = TIMESTAMP_RE.exec(value);
  if (match === null) return false;
  const [, y, mo, d, h, mi, s, , offsetHour, offsetMinute] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (offsetHour !== undefined && (Number(offsetHour) > 14 || Number(offsetMinute) > 59)) {
    return false;
  }
  return true;
}

// ── Field specification vocabulary ──────────────────────────────────────────────────────────

export type FieldSpec =
  /** TEXT. `minLength` guards ids, which must never be empty. */
  | { readonly kind: 'string'; readonly optional?: boolean; readonly minLength?: number }
  /** TEXT matching `TIMESTAMP_RE`. */
  | { readonly kind: 'timestamp'; readonly optional?: boolean }
  /** INTEGER. Rejects non-integers outright rather than rounding them. */
  | { readonly kind: 'integer'; readonly optional?: boolean; readonly min?: number }
  /** REAL. Any finite number. */
  | { readonly kind: 'real'; readonly optional?: boolean; readonly min?: number; readonly exclusiveMin?: number }
  /** INTEGER 0/1. */
  | { readonly kind: 'boolean'; readonly optional?: boolean }
  /** TEXT constrained to a closed set. */
  | { readonly kind: 'enum'; readonly optional?: boolean; readonly values: readonly string[] }
  /** JSON object, contents deliberately opaque — `patternParams` and friends. */
  | { readonly kind: 'opaqueObject'; readonly optional?: boolean }
  /** JSON object whose every value is a finite number — `patternMetrics`, `measured`. */
  | { readonly kind: 'numberMap'; readonly optional?: boolean }
  /** A nested record with its own field map. */
  | { readonly kind: 'object'; readonly optional?: boolean; readonly fields: FieldSpecMap }
  /** A JSON array of nested records — `targets`, `sets`. */
  | { readonly kind: 'objectArray'; readonly optional?: boolean; readonly fields: FieldSpecMap };

export type FieldSpecMap = Readonly<Record<string, FieldSpec>>;

/**
 * The spec kinds that can legitimately describe a value of type `V`.
 *
 * Without this, `kcalCoefficient: { kind: 'string' }` satisfies a map that only checks key
 * presence — the matrix would claim a TEXT column for a number and nobody would notice until
 * the round trip. The order of the branches matters: `boolean` before `string`, and
 * `Record<string, number>` before `Record<string, unknown>`, because the first is assignable to
 * the second. An interface without an index signature — `Baseline`, `KcalRecord`,
 * `EvaluationResult` — is not assignable to `Record<string, unknown>` at all, so it falls
 * through to `object`, which is exactly right.
 */
type AllowedSpec<V> = [V] extends [boolean]
  ? Extract<FieldSpec, { kind: 'boolean' }>
  : [V] extends [string]
    ? Extract<FieldSpec, { kind: 'string' | 'timestamp' | 'enum' }>
    : [V] extends [number]
      ? Extract<FieldSpec, { kind: 'integer' | 'real' }>
      : [V] extends [readonly unknown[]]
        ? Extract<FieldSpec, { kind: 'objectArray' }>
        : [V] extends [Record<string, number>]
          ? Extract<FieldSpec, { kind: 'numberMap' | 'opaqueObject' }>
          : [V] extends [Record<string, unknown>]
            ? Extract<FieldSpec, { kind: 'opaqueObject' }>
            : Extract<FieldSpec, { kind: 'object' }>;

/**
 * Exhaustive in both directions, with optionality **and** storage kind checked.
 *
 * `-?` forces every key of `T` to appear. Excess-property checking on the object literal rejects
 * any key `T` does not have. `{} extends Pick<T, K>` is true exactly for optional properties, so
 * a required field described as optional (or the reverse) is a compile error rather than a
 * NOT NULL column that turns out to be nullable in practice. `AllowedSpec` then holds the
 * declared storage kind to something the TypeScript type can actually be.
 */
export type SpecFor<T> = {
  // eslint-disable-next-line @typescript-eslint/ban-types -- `{}` is the optional-property probe.
  [K in keyof T]-?: {} extends Pick<T, K>
    ? AllowedSpec<Exclude<T[K], undefined>> & { readonly optional: true }
    : AllowedSpec<Exclude<T[K], undefined>> & { readonly optional?: never };
};

// ── Nested types ────────────────────────────────────────────────────────────────────────────

/** `src/core/types.ts:33` — 6 fields. */
export const SET_TARGET_FIELDS = {
  index: { kind: 'integer', min: 1 },
  targetKind: { kind: 'enum', values: TARGET_KINDS },
  reps: { kind: 'integer', min: 0 },
  role: { kind: 'enum', values: SET_ROLES },
  isAmrap: { kind: 'boolean' },
  restAfterSeconds: { kind: 'real', min: 0, optional: true },
} as const satisfies SpecFor<SetTarget>;

/** `src/core/types.ts:152` — 6 fields. */
export const PERFORMED_SET_FIELDS = {
  index: { kind: 'integer', min: 1 },
  effectiveTarget: { kind: 'integer', min: 0, optional: true },
  actual: { kind: 'integer', min: 0 },
  startedAt: { kind: 'timestamp', optional: true },
  endedAt: { kind: 'timestamp', optional: true },
  restAfterSeconds: { kind: 'real', min: 0, optional: true },
} as const satisfies SpecFor<PerformedSet>;

/** `src/core/types.ts:80` — 4 fields. Flattened into `challenges.baseline_*`. */
export const BASELINE_FIELDS = {
  value: { kind: 'real', min: 0 },
  source: { kind: 'enum', values: BASELINE_SOURCES },
  evidenceId: { kind: 'string', minLength: 1, optional: true },
  recordedAt: { kind: 'timestamp' },
} as const satisfies SpecFor<Baseline>;

/** `src/db/schema.ts:101` — 3 fields. Flattened into `workouts.kcal_*`. NOT a scalar. */
export const KCAL_FIELDS = {
  value: { kind: 'real', min: 0 },
  source: { kind: 'enum', values: KCAL_SOURCES },
  estimatorVersion: { kind: 'integer', min: 1 },
} as const satisfies SpecFor<KcalRecord>;

/** `src/core/types.ts:127` — 4 fields. Flattened into `workouts.evaluation_*`. */
export const EVALUATION_FIELDS = {
  satisfied: { kind: 'boolean' },
  advances: { kind: 'boolean' },
  reason: { kind: 'string' },
  measured: { kind: 'numberMap' },
} as const satisfies SpecFor<EvaluationResult>;

// ── Top-level records ───────────────────────────────────────────────────────────────────────

/** `src/db/schema.ts:43` — 4 fields. */
export const EXERCISE_FIELDS = {
  id: { kind: 'string', minLength: 1 },
  label: { kind: 'string' },
  unit: { kind: 'enum', values: UNITS },
  createdAt: { kind: 'timestamp' },
} as const satisfies SpecFor<ExerciseRecord>;

/** `src/db/schema.ts:51` — 18 fields. */
export const CHALLENGE_FIELDS = {
  id: { kind: 'string', minLength: 1 },
  exerciseId: { kind: 'string', minLength: 1 },
  chainId: { kind: 'string', minLength: 1 },
  previousChallengeId: { kind: 'string', minLength: 1, optional: true },
  patternId: { kind: 'string', minLength: 1 },
  patternVersion: { kind: 'integer', min: 1 },
  patternParams: { kind: 'opaqueObject' },
  restPolicyId: { kind: 'string', minLength: 1 },
  restPolicyVersion: { kind: 'integer', min: 1 },
  restPolicyParams: { kind: 'opaqueObject' },
  evaluationPolicyId: { kind: 'string', minLength: 1 },
  evaluationPolicyVersion: { kind: 'integer', min: 1 },
  baseline: { kind: 'object', fields: BASELINE_FIELDS },
  goalValue: { kind: 'real', min: 0, optional: true },
  status: { kind: 'enum', values: CHALLENGE_STATUSES },
  startedAt: { kind: 'timestamp' },
  endedAt: { kind: 'timestamp', optional: true },
  endReason: { kind: 'enum', values: CHALLENGE_END_REASONS, optional: true },
} as const satisfies SpecFor<ChallengeRecord>;

/** `src/core/types.ts:89` — 9 fields. */
export const PERFORMANCE_TEST_FIELDS = {
  id: { kind: 'string', minLength: 1 },
  exerciseId: { kind: 'string', minLength: 1 },
  challengeId: { kind: 'string', minLength: 1, optional: true },
  performedAt: { kind: 'timestamp' },
  protocolId: { kind: 'string', minLength: 1 },
  protocolVersion: { kind: 'integer', min: 1 },
  value: { kind: 'real', min: 0 },
  unit: { kind: 'enum', values: UNITS },
  note: { kind: 'string', optional: true },
} as const satisfies SpecFor<PerformanceTest>;

/** `src/db/schema.ts:79` — 16 fields. */
export const PLAN_SLOT_FIELDS = {
  id: { kind: 'string', minLength: 1 },
  challengeId: { kind: 'string', minLength: 1 },
  ordinal: { kind: 'integer', min: 1 },
  week: { kind: 'integer', min: 1, optional: true },
  day: { kind: 'integer', min: 1, optional: true },
  cycleLabel: { kind: 'string', optional: true },
  patternId: { kind: 'string', minLength: 1 },
  patternVersion: { kind: 'integer', min: 1 },
  generatedAt: { kind: 'timestamp' },
  decision: { kind: 'opaqueObject', optional: true },
  patternMetrics: { kind: 'numberMap', optional: true },
  targets: { kind: 'objectArray', fields: SET_TARGET_FIELDS },
  targetTotal: { kind: 'integer', min: 0 },
  restSeconds: { kind: 'real', min: 0 },
  status: { kind: 'enum', values: PLAN_SLOT_STATUSES },
  supersedesId: { kind: 'string', minLength: 1, optional: true },
} as const satisfies SpecFor<PlanSlotRecord>;

/** `src/db/schema.ts:109` — 18 fields. */
export const WORKOUT_FIELDS = {
  id: { kind: 'string', minLength: 1 },
  challengeId: { kind: 'string', minLength: 1 },
  chainId: { kind: 'string', minLength: 1 },
  planSlotId: { kind: 'string', minLength: 1, optional: true },
  attemptNo: { kind: 'integer', min: 1 },
  performedAt: { kind: 'timestamp' },
  durationSeconds: { kind: 'integer', min: 0, optional: true },
  sets: { kind: 'objectArray', fields: PERFORMED_SET_FIELDS },
  actualTotal: { kind: 'integer', min: 0 },
  adjustmentType: { kind: 'enum', values: ADJUSTMENT_TYPES },
  effectiveTotal: { kind: 'integer', min: 0, optional: true },
  outcome: { kind: 'enum', values: WORKOUT_OUTCOMES },
  evaluation: { kind: 'object', fields: EVALUATION_FIELDS, optional: true },
  evaluationPolicyId: { kind: 'string', minLength: 1, optional: true },
  evaluationPolicyVersion: { kind: 'integer', min: 1, optional: true },
  kcal: { kind: 'object', fields: KCAL_FIELDS, optional: true },
  note: { kind: 'string', optional: true },
  importSource: { kind: 'string', optional: true },
} as const satisfies SpecFor<WorkoutRecord>;

/**
 * `src/db/schema.ts:134` — 7 fields.
 *
 * Three of them are declared `?: T | undefined` rather than `?: T`, which under
 * `exactOptionalPropertyTypes` means an explicit `undefined` is a legal *value*. Both spellings
 * are normalised to absent here; see `docs` in `server/rows.ts`.
 */
export const SETTINGS_ROW_ID = 'settings' as const satisfies SettingsRecord['id'];

export const SETTINGS_FIELDS = {
  id: { kind: 'enum', values: [SETTINGS_ROW_ID] },
  bodyweightKg: { kind: 'real', exclusiveMin: 0, optional: true },
  kcalCoefficient: { kind: 'real', min: 0 },
  restOverrideSeconds: { kind: 'real', min: 0, optional: true },
  lastBackupAt: { kind: 'timestamp', optional: true },
  onboardedAt: { kind: 'timestamp', optional: true },
  selectedChallengeId: { kind: 'string', minLength: 1, optional: true },
} as const satisfies SpecFor<SettingsRecord>;
