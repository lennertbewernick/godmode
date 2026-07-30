/**
 * The share card's data, assembled and nothing more.
 *
 * Pure: no DOM, no storage, no React. It sits in the UI layer rather than in `core/` because
 * shaping a picture is presentation, and `core/` is the domain — but it holds no drawing code
 * either, so the selection rules and the IMP-07 honesty guarantee can be tested without a
 * canvas.
 *
 * The card reports. Every figure on it is something `core/stats` already computes; nothing here
 * recalculates, rounds differently, or invents a statistic of its own.
 */

import {
  computeMetrics,
  lifetimeTotals,
  rhythmGapDays,
  sessionSeries,
  type LifetimeTotals,
  type Metrics,
  type SessionPoint,
  type StatSlot,
  type StatWorkout,
} from '../core/stats.js';
import type { WorkoutOutcome } from '../core/types.js';
import type { WorkoutRecord } from '../db/schema.js';

/** How many sessions the card's table holds. More than this and the type stops being legible. */
export const SHARE_TABLE_ROWS = 6;

export interface RecentRow {
  /** ISO date only — the card has no room for a time and no use for one. */
  date: string;
  actualTotal: number;
  /** Absent when the session belonged to no slot. Never filled in from the actual. */
  targetTotal?: number;
  outcome: WorkoutOutcome;
}

export interface ShareCardInput {
  exerciseLabel: string;
  workouts: StatWorkout[];
  slots: StatSlot[];
  /** Sets the streak's rest-day tolerance. See `rhythmGapDays`. */
  daysPerWeek: number;
  goal?: number;
  currentWeek?: number;
  currentDay?: number;
}

export interface ShareCardData {
  exerciseLabel: string;
  /**
   * Every field optional and omitted rather than defaulted. An open-ended plan genuinely has
   * no week and no day, and a card that prints `W0D0` is stating something false.
   */
  context: { week?: number; day?: number; goal?: number };
  points: SessionPoint[];
  recent: RecentRow[];
  totals: LifetimeTotals;
  metrics: Metrics;
  /** Present only when there is a total worth showing; the note says how it was arrived at. */
  kcal?: { value: number; note: 'imported' | 'estimated' | 'mixed' };
}

/**
 * `WorkoutRecord` → `StatWorkout`. History and the share card both need it, and doing it twice
 * is how the two views of the same history start disagreeing.
 */
export function toStatWorkouts(workouts: WorkoutRecord[]): StatWorkout[] {
  return workouts.map((w) => ({
    performedAt: w.performedAt,
    actualTotal: w.actualTotal,
    outcome: w.outcome,
    ...(w.durationSeconds === undefined ? {} : { durationSeconds: w.durationSeconds }),
    ...(w.planSlotId === undefined ? {} : { planSlotId: w.planSlotId }),
    ...(w.kcal === undefined ? {} : { kcal: { value: w.kcal.value, source: w.kcal.source } }),
  }));
}

export function buildShareCard(input: ShareCardInput): ShareCardData {
  const points = sessionSeries(input.workouts, input.slots);
  const totals = lifetimeTotals(input.workouts);
  const metrics = computeMetrics(input.workouts, input.slots, rhythmGapDays(input.daysPerWeek));

  const recent: RecentRow[] = points
    .slice(-SHARE_TABLE_ROWS)
    .reverse()
    .map((p) => ({
      date: p.performedAt.slice(0, 10),
      actualTotal: p.actualTotal,
      outcome: p.outcome,
      // Copied straight off the point, and left absent when the point has none.
      ...(p.targetTotal === undefined ? {} : { targetTotal: p.targetTotal }),
    }));

  const note =
    totals.hasExternalKcal && totals.hasEstimatedKcal
      ? 'mixed'
      : totals.hasExternalKcal
        ? 'imported'
        : 'estimated';

  return {
    exerciseLabel: input.exerciseLabel,
    context: {
      ...(input.currentWeek === undefined ? {} : { week: input.currentWeek }),
      ...(input.currentDay === undefined ? {} : { day: input.currentDay }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
    },
    points,
    recent,
    totals,
    metrics,
    ...(totals.kcal > 0 ? { kcal: { value: totals.kcal, note } } : {}),
  };
}
