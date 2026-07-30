/**
 * The three pluggable seams: how the next session is chosen, how rest is prescribed, and
 * how a performance is judged. Exactly one implementation of each ships today.
 *
 * The seams exist because the owner asked for flexibility across workout patterns. They are
 * intentionally narrow — no plugin registry, no user-authored patterns, no expression
 * language. Just an id, a version, and a pure function.
 */

import type {
  EvaluationResult,
  PlanSlotSpec,
  SetTarget,
  WorkoutPerformance,
} from './types.js';

/** What a pattern learns from a completed session, to decide the next one. */
export interface PatternObservation {
  ordinal: number;
  actualTotal: number;
  /** Reps on each open-ended set, in set order. */
  observedAmrapReps: number[];
  evaluation: EvaluationResult;
}

export interface NextSlot<S> {
  slot: PlanSlotSpec;
  nextState: S;
  /** Canonical snapshot of why this prescription was chosen. Persisted for audit. */
  decision?: Record<string, unknown>;
}

/**
 * A progression scheme.
 *
 * `next()` is incremental rather than returning the whole plan, so an adaptive pattern
 * (RPE-driven, AMRAP-recalibrating, open-ended) can decide session N+1 from what happened
 * in session N. Deterministic patterns lose nothing: `materialize()` runs `next()` in a
 * loop and produces the entire plan up front, which is what `percentage-ramp` does.
 *
 * Returns `null` when the program is finished.
 */
export interface ProgramPattern<P, S = unknown> {
  readonly id: string;
  readonly version: number;
  /** Total sessions, when knowable. Undefined for open-ended patterns. */
  plannedSessionCount(params: P): number | undefined;
  initialState(params: P): S;
  next(input: {
    params: P;
    state: S;
    history: readonly PatternObservation[];
  }): NextSlot<S> | null;
}

/** Context a rest policy gets to work with. */
export interface RestContext {
  ordinal: number;
  targets: SetTarget[];
  targetTotal: number;
}

export interface RestPrescription {
  /** Slot-level default rest, in seconds. */
  restSeconds: number;
  /** Optional per-set rest, aligned to `targets` by index. */
  restAfterSeconds?: number[];
}

export interface RestPolicy<P> {
  readonly id: string;
  readonly version: number;
  prescribe(context: RestContext, params: P): RestPrescription;
}

/**
 * Judges a performed session against its prescription.
 *
 * Separate from the pattern because "did this count?" is a product rule that varies
 * independently: a strength scheme requires every set, an RPE scheme checks an effort band,
 * a fixed-load scheme may have no pass concept at all.
 */
export interface EvaluationPolicy {
  readonly id: string;
  readonly version: number;
  evaluate(prescription: PlanSlotSpec, performance: WorkoutPerformance): EvaluationResult;
}

/** Run a deterministic pattern to completion (or to `limit` sessions). */
export function materialize<P, S>(
  pattern: ProgramPattern<P, S>,
  params: P,
  limit = 1000,
): PlanSlotSpec[] {
  const slots: PlanSlotSpec[] = [];
  let state = pattern.initialState(params);
  const history: PatternObservation[] = [];

  for (let i = 0; i < limit; i += 1) {
    const result = pattern.next({ params, state, history });
    if (result === null) break;
    slots.push(result.slot);
    state = result.nextState;
  }

  if (slots.length === limit) {
    throw new RangeError(
      `materialize() hit its ${limit}-slot limit for pattern ${pattern.id}; ` +
        'the pattern may be open-ended and must be generated incrementally',
    );
  }
  return slots;
}
