/**
 * History statistics.
 *
 * The three metrics are deliberately separate (STAT-05). Collapsing them would let deloading
 * inflate a streak while dodging failure:
 *
 *   activityStreak    any logged workout counts — rewards showing up
 *   planCompliance    only completed_as_planned + scaled_up — rewards hitting the number
 *   challengeProgress advanced slots / total slots — rewards moving through the programme
 *
 * The chart has two shapes. `sessionSeries` is one point per session and is what shows the
 * shape of a block — the climb, the repeats, the deloads. `cumulativeSeries` is the running
 * totals, where `planned` advances once per slot and `actual` includes every attempt and
 * deload (STAT-03); it answers "how much work in total", and is smooth by construction.
 */

import type { WorkoutOutcome } from './types.js';

export interface StatWorkout {
  performedAt: string;
  actualTotal: number;
  durationSeconds?: number;
  outcome: WorkoutOutcome;
  planSlotId?: string;
  kcal?: { value: number; source: 'external' | 'estimated' };
}

export interface StatSlot {
  id: string;
  ordinal: number;
  targetTotal: number;
  status: string;
}

export interface LifetimeTotals {
  workouts: number;
  reps: number;
  seconds: number;
  /** Sum of both external and estimated values — the display labels the mix. */
  kcal: number;
  hasExternalKcal: boolean;
  hasEstimatedKcal: boolean;
}

export function lifetimeTotals(workouts: StatWorkout[]): LifetimeTotals {
  let reps = 0;
  let seconds = 0;
  let kcal = 0;
  let hasExternalKcal = false;
  let hasEstimatedKcal = false;

  for (const w of workouts) {
    reps += w.actualTotal;
    seconds += w.durationSeconds ?? 0;
    if (w.kcal) {
      kcal += w.kcal.value;
      if (w.kcal.source === 'external') hasExternalKcal = true;
      else hasEstimatedKcal = true;
    }
  }

  return { workouts: workouts.length, reps, seconds, kcal, hasExternalKcal, hasEstimatedKcal };
}

const ADVANCING_OUTCOMES: WorkoutOutcome[] = [
  'completed_as_planned',
  'scaled_up',
  'advanced_manually',
];

/** Outcomes that count toward plan compliance. Manual advance does NOT — it skipped. */
const COMPLIANT_OUTCOMES: WorkoutOutcome[] = ['completed_as_planned', 'scaled_up'];

export interface Metrics {
  /**
   * Consecutive sessions kept in rhythm, counting back from the latest. Not calendar days —
   * see `rhythmGapDays` for why that reading is actively misleading here.
   */
  activityStreak: number;
  /** Longest such run anywhere in the history. */
  longestActivityStreak: number;
  /** Fraction of attempts that hit their prescription. */
  planCompliance: number;
  compliantWorkouts: number;
  totalAttempts: number;
  /** Slots advanced / total slots. Undefined when the programme is open-ended. */
  challengeProgress?: number;
  slotsAdvanced: number;
  slotsTotal?: number;
}

/** Local calendar day, so a 23:50 and a 00:10 session are different days. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Rest-day tolerance for a three-day-a-week programme, the common case. */
export const DEFAULT_RHYTHM_GAP_DAYS = 4;

/**
 * The largest gap between sessions that still counts as keeping the rhythm.
 *
 * Counting *consecutive calendar days* is the obvious reading of "streak" and it is wrong for
 * this app. A three-day-a-week programme has rest days built into it, so a user following the
 * plan perfectly trains with two-day gaps and would score a streak of 1 forever — the metric
 * would punish compliance and reward nothing.
 *
 * This is measured, not assumed: across the 29-session reference history the gaps are 2, 3 or 4
 * days and there is not a single instance of two consecutive days. A calendar-day streak on that
 * data reads "1, best 1", which is worse than showing nothing.
 *
 * So a streak here counts consecutive *sessions* whose spacing is consistent with the plan:
 * `ceil(7 / daysPerWeek)` days, plus one day of slack for real life. Three a week tolerates four
 * days; daily training tolerates two. Miss enough that the gap exceeds it and the streak breaks,
 * which is the thing worth knowing.
 */
export function rhythmGapDays(daysPerWeek: number): number {
  if (!Number.isFinite(daysPerWeek) || daysPerWeek <= 0) return DEFAULT_RHYTHM_GAP_DAYS;
  return Math.ceil(7 / daysPerWeek) + 1;
}

export function activityStreaks(
  workouts: StatWorkout[],
  maxGapDays: number = DEFAULT_RHYTHM_GAP_DAYS,
): { current: number; longest: number } {
  if (workouts.length === 0) return { current: 0, longest: 0 };

  const days = [...new Set(workouts.map((w) => dayKey(w.performedAt)))].sort();
  let longest = 1;
  let run = 1;

  for (let i = 1; i < days.length; i += 1) {
    const prev = new Date(`${days[i - 1]!}T00:00:00Z`).getTime();
    const cur = new Date(`${days[i]!}T00:00:00Z`).getTime();
    const gapDays = Math.round((cur - prev) / 86_400_000);
    run = gapDays <= maxGapDays ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  return { current: run, longest };
}

export function computeMetrics(
  workouts: StatWorkout[],
  slots: StatSlot[],
  maxGapDays: number = DEFAULT_RHYTHM_GAP_DAYS,
): Metrics {
  const streaks = activityStreaks(workouts, maxGapDays);
  const compliant = workouts.filter((w) => COMPLIANT_OUTCOMES.includes(w.outcome)).length;
  const slotsAdvanced = slots.filter((s) => s.status === 'completed').length;
  const slotsTotal = slots.length > 0 ? slots.length : undefined;

  return {
    activityStreak: streaks.current,
    longestActivityStreak: streaks.longest,
    planCompliance: workouts.length === 0 ? 0 : compliant / workouts.length,
    compliantWorkouts: compliant,
    totalAttempts: workouts.length,
    slotsAdvanced,
    ...(slotsTotal === undefined
      ? {}
      : { slotsTotal, challengeProgress: slotsAdvanced / slotsTotal }),
  };
}

export interface SessionPoint {
  performedAt: string;
  /** Reps actually performed in this one session. */
  actualTotal: number;
  /** Prescribed total for the slot this attempt belonged to. Undefined when unlinked. */
  targetTotal?: number;
  outcome: WorkoutOutcome;
}

/**
 * One point per session — what was done that day, against what was asked that day.
 *
 * This is the series that shows the shape of a training block: the climb, the dip where a
 * day was repeated, the deloads. A cumulative series cannot show any of it, because a
 * running total of similar numbers is smooth by construction no matter how uneven the
 * underlying sessions were.
 */
export function sessionSeries(workouts: StatWorkout[], slots: StatSlot[]): SessionPoint[] {
  const targetBySlot = new Map(slots.map((s) => [s.id, s.targetTotal]));

  return [...workouts]
    .sort((a, b) => a.performedAt.localeCompare(b.performedAt))
    .map((w) => {
      const target = w.planSlotId === undefined ? undefined : targetBySlot.get(w.planSlotId);
      return {
        performedAt: w.performedAt,
        actualTotal: w.actualTotal,
        outcome: w.outcome,
        ...(target === undefined ? {} : { targetTotal: target }),
      };
    });
}

export interface CumulativePoint {
  performedAt: string;
  /** Running sum of every attempt, including deloads and failures. */
  actual: number;
  /**
   * Running sum of prescribed totals for slots that advanced — one contribution per slot,
   * never one per attempt.
   */
  planned: number;
  actualTotal: number;
  outcome: WorkoutOutcome;
}

export function cumulativeSeries(
  workouts: StatWorkout[],
  slots: StatSlot[],
): CumulativePoint[] {
  const targetBySlot = new Map(slots.map((s) => [s.id, s.targetTotal]));
  const countedSlots = new Set<string>();
  let actual = 0;
  let planned = 0;

  return [...workouts]
    .sort((a, b) => a.performedAt.localeCompare(b.performedAt))
    .map((w) => {
      actual += w.actualTotal;
      // Planned advances once per slot, on the attempt that advanced it.
      if (
        w.planSlotId !== undefined &&
        !countedSlots.has(w.planSlotId) &&
        ADVANCING_OUTCOMES.includes(w.outcome)
      ) {
        countedSlots.add(w.planSlotId);
        planned += targetBySlot.get(w.planSlotId) ?? 0;
      }
      return {
        performedAt: w.performedAt,
        actual,
        planned,
        actualTotal: w.actualTotal,
        outcome: w.outcome,
      };
    });
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const hours = totalSeconds / 3600;
  return `${hours.toFixed(1)} h`;
}

export function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.max(0, totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
