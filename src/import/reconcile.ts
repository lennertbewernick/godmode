/**
 * Stage 4: reconcile a canonical import against a generated plan, then commit.
 *
 * The hard rule (IMP-07): imported rows carry ACTUAL reps only. We never write them into
 * `plan_slot.targets`. The generated plan is produced independently from baseline and goal,
 * and where the two disagree we *report* it — because our own interior curve provably
 * diverges from the reference data, so forcing agreement would fabricate history.
 *
 * Rows that cannot be matched to a slot are committed with `planSlotId` undefined rather
 * than being force-fitted (IMP-06).
 */

import { pushupParams, PUSHUP_5SET_TEMPLATE } from '../core/patterns/percentageRamp.js';
import type { Baseline } from '../core/types.js';
import { createChallenge, createExercise, newId, putImportedWorkout, putSlots } from '../db/repo.js';
import { KCAL_ESTIMATOR_VERSION, type PlanSlotRecord, type WorkoutRecord } from '../db/schema.js';
import type { CanonicalImport, CanonicalSession } from './pipeline.js';

/** Sum of the reference template's coefficients — 2.05 for the 5-set push-up shape. */
const COEFFICIENT_SUM = PUSHUP_5SET_TEMPLATE.coefficients.reduce((s, c) => s + c, 0);

export interface BaselineEstimate {
  value: number;
  /** Always 'estimated' — an import cannot establish a rested max test. */
  method: string;
  explanation: string;
}

/**
 * Estimate the original baseline by inverting our own model on the earliest session.
 *
 * A session's target total is `coefficientSum * generationMax`, so the first session's total
 * implies `M ≈ total / coefficientSum`. For the reference file: 37 / 2.05 ≈ 18.0, which
 * matches the user's actual tested baseline of 18.
 *
 * This is an ESTIMATE and is labelled as such. It inverts *our* curve, not the incumbent's,
 * and it uses an actual performance rather than a rested test. The user is shown the number
 * and can correct it — at which point provenance becomes `user_entered`.
 */
export function estimateBaselineFromImport(canonical: CanonicalImport): BaselineEstimate {
  const earliest = [...canonical.sessions].sort((a, b) =>
    a.performedAt.localeCompare(b.performedAt),
  )[0];
  if (!earliest) throw new Error('Cannot estimate a baseline from an empty import.');
  const value = Math.max(1, Math.round(earliest.actualTotal / COEFFICIENT_SUM));
  return {
    value,
    method: 'invert-coefficient-sum-v1',
    explanation:
      `Estimated from your first session (${earliest.actualTotal} reps ÷ ` +
      `${COEFFICIENT_SUM.toFixed(2)}). This is a guess from performance data, not a rested ` +
      'max test — correct it if you remember your actual starting number.',
  };
}

export interface SlotDivergence {
  ordinal: number;
  week: number;
  day: number;
  generatedTotal: number;
  /** Highest total actually performed on this slot. */
  observedBestTotal: number;
  difference: number;
}

export interface ReconciliationReport {
  matched: number;
  unlinked: number;
  attemptsPerSlot: Map<number, number>;
  divergences: SlotDivergence[];
  notes: string[];
}

interface Matched {
  session: CanonicalSession;
  slot?: PlanSlotRecord;
  attemptNo: number;
}

/** Group imported sessions onto generated slots by (week, day). */
export function reconcile(
  canonical: CanonicalImport,
  slots: PlanSlotRecord[],
): { assignments: Matched[]; report: ReconciliationReport } {
  const byWeekDay = new Map<string, PlanSlotRecord>();
  for (const slot of slots) {
    if (slot.week !== undefined && slot.day !== undefined) {
      byWeekDay.set(`${slot.week}-${slot.day}`, slot);
    }
  }

  const ordered = [...canonical.sessions].sort((a, b) =>
    a.performedAt.localeCompare(b.performedAt),
  );

  const attemptCounters = new Map<string, number>();
  const assignments: Matched[] = ordered.map((session) => {
    const key = `${session.week}-${session.day}`;
    const attemptNo = (attemptCounters.get(key) ?? 0) + 1;
    attemptCounters.set(key, attemptNo);
    const slot = byWeekDay.get(key);
    return slot === undefined ? { session, attemptNo } : { session, slot, attemptNo };
  });

  const attemptsPerSlot = new Map<number, number>();
  const bestByOrdinal = new Map<number, number>();
  for (const a of assignments) {
    if (!a.slot) continue;
    attemptsPerSlot.set(a.slot.ordinal, (attemptsPerSlot.get(a.slot.ordinal) ?? 0) + 1);
    bestByOrdinal.set(
      a.slot.ordinal,
      Math.max(bestByOrdinal.get(a.slot.ordinal) ?? 0, a.session.actualTotal),
    );
  }

  const divergences: SlotDivergence[] = [];
  for (const slot of slots) {
    const best = bestByOrdinal.get(slot.ordinal);
    if (best === undefined || slot.week === undefined || slot.day === undefined) continue;
    if (best !== slot.targetTotal) {
      divergences.push({
        ordinal: slot.ordinal,
        week: slot.week,
        day: slot.day,
        generatedTotal: slot.targetTotal,
        observedBestTotal: best,
        difference: best - slot.targetTotal,
      });
    }
  }

  const unlinked = assignments.filter((a) => !a.slot).length;
  const notes: string[] = [];
  if (divergences.length > 0) {
    notes.push(
      `${divergences.length} of ${slots.length} sessions differ from what this app would ` +
        'prescribe. That is expected: the original app\'s interior progression could not be ' +
        'recovered from a single export, so your history is kept exactly as performed and ' +
        'the generated plan is left untouched.',
    );
  }
  if (unlinked > 0) {
    notes.push(
      `${unlinked} imported session(s) did not match any planned day and were kept as ` +
        'standalone history rather than being forced onto a slot.',
    );
  }

  return {
    assignments,
    report: { matched: assignments.length - unlinked, unlinked, attemptsPerSlot, divergences, notes },
  };
}

export interface CommitImportInput {
  canonical: CanonicalImport;
  /** Confirmed by the user; provenance reflects whether they accepted the estimate. */
  baseline: Baseline;
  goal: number;
  weeks: number;
  daysPerWeek: number;
  bodyweightKg?: number;
  kcalCoefficient?: number;
}

export interface CommitImportResult {
  challengeId: string;
  chainId: string;
  report: ReconciliationReport;
  workoutsWritten: number;
}

/**
 * Decide which slots the imported history shows as passed.
 *
 * We deliberately do NOT ask "did the performance meet OUR target?" — our interior curve
 * provably diverges from the reference data (it prescribes 41 for W1D2 where 39 was actually
 * performed and accepted). Judging imported history against it would rewind a finished
 * programme to week 1.
 *
 * Instead we recover the source app's own decisions from the shape of the data: it repeated
 * a day until the day was passed, and only then moved on. So if any strictly later slot has
 * history, every earlier slot must have been passed. Only the furthest slot reached is
 * genuinely undecided, and for that one we apply the verified pass rule.
 *
 * For the reference file this yields slots 1-17 completed and slot 18 available, because the
 * final session was 202 against a 205 target — which is exactly the real state.
 */
function resolveAdvancement(
  assignments: Matched[],
  slots: PlanSlotRecord[],
): Set<number> {
  const withHistory = assignments
    .map((a) => a.slot?.ordinal)
    .filter((o): o is number => o !== undefined);
  if (withHistory.length === 0) return new Set();

  const furthestReached = Math.max(...withHistory);
  const advanced = new Set<number>();

  for (const slot of slots) {
    if (slot.ordinal < furthestReached) {
      // A later day was attempted, so the source app must have passed this one.
      if (withHistory.includes(slot.ordinal)) advanced.add(slot.ordinal);
      continue;
    }
    if (slot.ordinal === furthestReached) {
      const best = Math.max(
        ...assignments
          .filter((a) => a.slot?.ordinal === slot.ordinal)
          .map((a) => a.session.actualTotal),
      );
      if (best >= slot.targetTotal) advanced.add(slot.ordinal);
    }
  }
  return advanced;
}

/**
 * Create the exercise, generate a plan, attach imported history, and mark slots that were
 * demonstrably completed. Slot targets are written once from the generator and never edited.
 */
export async function commitImport(input: CommitImportInput): Promise<CommitImportResult> {
  const exercise = await createExercise(input.canonical.exerciseLabel);

  const { challenge, slots } = await createChallenge({
    exerciseId: exercise.id,
    baseline: input.baseline,
    params: pushupParams(input.baseline.value, input.goal, input.weeks, input.daysPerWeek),
  });

  const { assignments, report } = reconcile(input.canonical, slots);

  const advancedOrdinals = resolveAdvancement(assignments, slots);
  let workoutsWritten = 0;

  // Within a slot, the source app repeated the day until it passed. So every attempt except
  // the last one on an advanced slot was a miss — recoverable from the ordering, without
  // consulting our own (divergent) targets.
  const attemptsBySlot = new Map<number, number>();
  for (const a of assignments) {
    if (a.slot) attemptsBySlot.set(a.slot.ordinal, a.attemptNo);
  }

  for (const { session, slot, attemptNo } of assignments) {
    const isLastAttempt = slot !== undefined && attemptsBySlot.get(slot.ordinal) === attemptNo;
    const satisfied =
      slot !== undefined && isLastAttempt && advancedOrdinals.has(slot.ordinal);

    const record: WorkoutRecord = {
      id: newId('wo'),
      challengeId: challenge.id,
      chainId: challenge.chainId,
      attemptNo,
      performedAt: session.performedAt,
      sets: session.actualSets.map((actual, i) => ({
        index: i + 1,
        effectiveTarget: slot?.targets[i]?.reps ?? actual,
        actual,
      })),
      actualTotal: session.actualTotal,
      adjustmentType: 'none',
      effectiveTotal: slot?.targetTotal ?? session.actualTotal,
      outcome: satisfied ? 'completed_as_planned' : 'failed',
      importSource: input.canonical.sourceProfileId,
      ...(slot === undefined ? {} : { planSlotId: slot.id }),
      ...(session.durationSeconds === undefined
        ? {}
        : { durationSeconds: session.durationSeconds }),
      ...(session.kcalExternal === undefined
        ? {}
        : {
            kcal: {
              value: session.kcalExternal,
              // Never merged with our own estimates.
              source: 'external' as const,
              estimatorVersion: KCAL_ESTIMATOR_VERSION,
            },
          }),
    };
    await putImportedWorkout(record);
    workoutsWritten += 1;
  }

  // Slots the imported history shows as satisfied become completed; the rest stay available.
  const updated = slots.map((slot) =>
    advancedOrdinals.has(slot.ordinal) ? { ...slot, status: 'completed' as const } : slot,
  );
  await putSlots(updated);

  return {
    challengeId: challenge.id,
    chainId: challenge.chainId,
    report,
    workoutsWritten,
  };
}
