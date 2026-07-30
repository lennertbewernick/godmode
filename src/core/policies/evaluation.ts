/**
 * Evaluation policies — "did this session count, and does the program move on?"
 *
 * `satisfied` and `advances` are deliberately separate fields. The reference program's
 * engine is its repeat-on-miss ratchet: you cannot progress until you hit the number. But a
 * session performed while ill, at a deliberately reduced total, is honest work and must not
 * be recorded as a failure. So a deload is `satisfied: false, advances: false` — counted in
 * every history metric, yet the slot stays current.
 */

import type { EvaluationPolicy } from '../contracts.js';
import type { PlanSlotSpec, EvaluationResult, WorkoutPerformance } from '../types.js';

export const TOTAL_REPS_POLICY_ID = 'total-reps-at-least-target';
export const TOTAL_REPS_POLICY_VERSION = 1;

/**
 * The reference rule (PLAN.md §1.4), VERIFIED against the source CSV: a session passes when
 * the sum of actual reps meets or exceeds the target total. Evidence that it is the total
 * and not per-set — 2026-06-09 `10·13·10·9·13`=55 repeated, then `10·13·10·9·14`=56 passed,
 * with sets 1-4 byte-identical.
 */
export const totalRepsAtLeastTargetPolicy: EvaluationPolicy = {
  id: TOTAL_REPS_POLICY_ID,
  version: TOTAL_REPS_POLICY_VERSION,

  evaluate(prescription: PlanSlotSpec, performance: WorkoutPerformance): EvaluationResult {
    const prescribedTotal = prescription.targetTotal;
    const { actualTotal, adjustmentType, effectiveTotal } = performance;
    const shortfall = prescribedTotal - actualTotal;
    const measured = { prescribedTotal, effectiveTotal, actualTotal, shortfall };

    // A downward rescale is judged against the ORIGINAL prescription, never the lowered
    // one. Otherwise the ratchet has a back door: scale down, "pass", advance.
    if (adjustmentType === 'scaled_down') {
      return {
        satisfied: false,
        advances: false,
        reason:
          `Deload logged: ${actualTotal} reps against a prescribed ${prescribedTotal}. ` +
          'Counted in your history; this session stays next.',
        measured,
      };
    }

    if (actualTotal >= prescribedTotal) {
      return {
        satisfied: true,
        advances: true,
        reason: `${actualTotal} of ${prescribedTotal} reps — target met.`,
        measured,
      };
    }

    return {
      satisfied: false,
      advances: false,
      reason: `${shortfall} rep${shortfall === 1 ? '' : 's'} short of ${prescribedTotal}.`,
      measured,
    };
  },
};

/**
 * Explicit user override: advance a slot despite not satisfying it. Requires confirmation
 * at the UI layer and is always recorded, never inferred from a deload. Without this, a
 * user who deloads repeatedly is stranded on one slot forever.
 */
export function manualAdvance(
  prescription: PlanSlotSpec,
  performance: WorkoutPerformance,
): EvaluationResult {
  return {
    satisfied: false,
    advances: true,
    reason: 'Advanced manually with deviation from plan.',
    measured: {
      prescribedTotal: prescription.targetTotal,
      effectiveTotal: performance.effectiveTotal,
      actualTotal: performance.actualTotal,
      shortfall: prescription.targetTotal - performance.actualTotal,
    },
  };
}

/**
 * Derive the history classification from the evaluation plus what the user adjusted.
 * Kept separate from `EvaluationResult` because outcome is a product/history label while
 * evaluation is a policy verdict.
 */
export function classifyOutcome(
  evaluation: EvaluationResult,
  adjustmentType: WorkoutPerformance['adjustmentType'],
  manuallyAdvanced: boolean,
): import('../types.js').WorkoutOutcome {
  if (manuallyAdvanced) return 'advanced_manually';
  if (adjustmentType === 'scaled_down') return 'deload';
  if (!evaluation.satisfied) return 'failed';
  if (adjustmentType === 'scaled_up') return 'scaled_up';
  return 'completed_as_planned';
}
