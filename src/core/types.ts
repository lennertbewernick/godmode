/**
 * Core domain types. Pure — no DOM, no storage, no React.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL DISTINCTION — three facts that are NOT interchangeable:
 *
 *   generationMax      A pattern's internal coordinate. `percentage-ramp` multiplies
 *                      coefficients by it. Saying M(18)=100 asserts nothing about what
 *                      the athlete can do; it only says "derive the last card from 100".
 *
 *   observedAmrapReps  Reps actually performed on an open-ended set, under whatever
 *                      fatigue preceded it. The reference user's final AMRAP was 48 —
 *                      after 154 preceding reps in the same session.
 *
 *   testedMax          A rested, single-set maximum. The only defensible baseline for
 *                      generating a new program.
 *
 * Conflating these is how a continuation flow confidently seeds a new challenge from
 * invalid performance data. Every baseline therefore carries provenance.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** What a set is for within a session's shape. Presentation hint only. */
export type SetRole = 'medium' | 'big' | 'small' | 'amrap' | 'custom';

/**
 * Discriminator on how a target is expressed. Only `reps` ships today; the field exists
 * so RPE / duration / velocity targets do not require a schema migration.
 */
export type TargetKind = 'reps';

/** One prescribed set within a session. */
export interface SetTarget {
  /** 1-based position in the session. */
  index: number;
  targetKind: TargetKind;
  /** Prescribed repetitions. For an AMRAP set this is a floor, not a cap. */
  reps: number;
  role: SetRole;
  /**
   * True when the set is open-ended ("N+"). Never inferred from set ordering — ordering is
   * unreliable at low maxima. Zero, one, or several AMRAP sets are all valid.
   */
  isAmrap: boolean;
  /** Prescribed rest after this set. Frozen at generation time. */
  restAfterSeconds?: number;
}

/**
 * One generated session. Immutable once persisted; an unattempted future slot may be
 * superseded (a new row) but never mutated.
 */
export interface PlanSlotSpec {
  /** 1-based session number within the challenge. Always present. */
  ordinal: number;
  /** Display coordinates. Optional — an open-ended pattern has no meaningful week/day. */
  week?: number;
  day?: number;
  /** Human label when week/day are absent, e.g. "Session 47". */
  cycleLabel?: string;
  targets: SetTarget[];
  /** Sum of prescribed reps. Meaningful for rep-based evaluation policies. */
  targetTotal: number;
  /** Slot-level rest default; individual targets may override. */
  restSeconds: number;
  /**
   * Pattern-specific diagnostics — for `percentage-ramp`, `{ generationMax }`. Deliberately
   * loose: it is metadata for display and audit, never a cross-pattern contract.
   */
  patternMetrics?: Record<string, number>;
}

/** Where a baseline number came from. Drives whether it can be trusted as capability. */
export type BaselineSource =
  | 'tested'        // a rested single-set max test performed in-app
  | 'user_entered'  // the user typed a number; provenance unknown
  | 'imported'      // read from an external export
  | 'estimated';    // produced by a named, versioned estimator

export interface Baseline {
  value: number;
  source: BaselineSource;
  /** Links to a `performance_test` row when `source === 'tested'`. */
  evidenceId?: string;
  recordedAt: string;
}

/** A rested max test, representable independently of any workout. */
export interface PerformanceTest {
  id: string;
  exerciseId: string;
  challengeId?: string;
  performedAt: string;
  /** e.g. 'single-set-max-v1' — a protocol, so future tests are comparable. */
  protocolId: string;
  protocolVersion: number;
  value: number;
  unit: 'reps';
  note?: string;
}

/** How a challenge ended. `completed_at` alone cannot express these. */
export type ChallengeEndReason =
  | 'goal_reached'
  | 'closed_manually'
  | 'abandoned'
  | 'superseded';

export type ChallengeStatus = 'active' | 'ended';

/** How a successor challenge derives its baseline. */
export type SeedStrategy =
  | 'retest'         // recommended: a fresh rested max test
  | 'user_entered'   // the user supplies a number
  | 'repeat_program'; // rerun the same params, no new baseline claim

export interface ChallengeOutcome {
  /** Best single AMRAP result. A fatigued measurement — NOT a demonstrated max. */
  bestObservedAmrapReps: number;
  bestSessionTotal: number;
  slotsAdvanced: number;
  /** Undefined for open-ended patterns, where "total slots" has no meaning. */
  slotsTotal?: number;
}

/** Result of applying an evaluation policy to a performed session. */
export interface EvaluationResult {
  /** Did the performance meet the prescription? */
  satisfied: boolean;
  /**
   * Should the program move on? Deliberately separate from `satisfied` — a deliberate
   * deload is not satisfied but is honest work, and a manual override advances without
   * having satisfied anything.
   */
  advances: boolean;
  reason: string;
  /** Policy-specific measured values, for display and audit. */
  measured: Record<string, number>;
}

/** What the user did to a prescription before performing it. */
export type AdjustmentType = 'none' | 'redistributed' | 'scaled_up' | 'scaled_down';

/** History classification of an attempt. Not the same as `EvaluationResult`. */
export type WorkoutOutcome =
  | 'completed_as_planned'
  | 'scaled_up'
  | 'deload'
  | 'failed'
  | 'advanced_manually';

export interface PerformedSet {
  index: number;
  /** What was prescribed for this attempt, after any adjustment. */
  effectiveTarget: number;
  actual: number;
  startedAt?: string;
  endedAt?: string;
  restAfterSeconds?: number;
}

export interface WorkoutPerformance {
  sets: PerformedSet[];
  /** Sum of actual reps. */
  actualTotal: number;
  adjustmentType: AdjustmentType;
  /** Effective total after adjustment; equals the slot's targetTotal when unadjusted. */
  effectiveTotal: number;
}
