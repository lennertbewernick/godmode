import { describe, expect, it } from 'vitest';
import {
  activityStreaks,
  computeMetrics,
  cumulativeSeries,
  formatClock,
  formatDuration,
  lifetimeTotals,
  type StatSlot,
  type StatWorkout,
} from './stats.js';
import type { WorkoutOutcome } from './types.js';

const w = (
  day: string,
  actualTotal: number,
  outcome: WorkoutOutcome = 'completed_as_planned',
  planSlotId?: string,
  extra: Partial<StatWorkout> = {},
): StatWorkout => ({
  performedAt: `${day}T09:00:00`,
  actualTotal,
  outcome,
  ...(planSlotId === undefined ? {} : { planSlotId }),
  ...extra,
});

const slot = (id: string, ordinal: number, targetTotal: number, status = 'completed'): StatSlot => ({
  id,
  ordinal,
  targetTotal,
  status,
});

describe('STAT-04 — lifetime totals', () => {
  it('sums reps, time, and calories', () => {
    const totals = lifetimeTotals([
      w('2026-01-01', 37, 'completed_as_planned', 's1', {
        durationSeconds: 391,
        kcal: { value: 13, source: 'external' },
      }),
      w('2026-01-03', 39, 'completed_as_planned', 's2', {
        durationSeconds: 359,
        kcal: { value: 10, source: 'estimated' },
      }),
    ]);
    expect(totals).toMatchObject({ workouts: 2, reps: 76, seconds: 750, kcal: 23 });
  });

  it('flags when external and estimated calories are mixed', () => {
    const mixed = lifetimeTotals([
      w('2026-01-01', 10, 'completed_as_planned', undefined, {
        kcal: { value: 5, source: 'external' },
      }),
      w('2026-01-02', 10, 'completed_as_planned', undefined, {
        kcal: { value: 5, source: 'estimated' },
      }),
    ]);
    expect(mixed.hasExternalKcal).toBe(true);
    expect(mixed.hasEstimatedKcal).toBe(true);
  });

  it('handles an empty history', () => {
    expect(lifetimeTotals([])).toMatchObject({ workouts: 0, reps: 0, seconds: 0, kcal: 0 });
  });
});

describe('STAT-05 — three metrics that must not be conflated', () => {
  it('counts a deload toward activity but not toward compliance', () => {
    const workouts = [
      w('2026-01-01', 100, 'completed_as_planned', 's1'),
      w('2026-01-02', 60, 'deload', 's2'),
    ];
    const metrics = computeMetrics(workouts, [slot('s1', 1, 100), slot('s2', 2, 100, 'attempted')]);

    expect(metrics.totalAttempts).toBe(2);
    expect(metrics.activityStreak).toBe(2); // showing up counts
    expect(metrics.compliantWorkouts).toBe(1); // hitting the number does not
    expect(metrics.planCompliance).toBe(0.5);
    expect(metrics.slotsAdvanced).toBe(1); // and the slot did not advance
    expect(metrics.challengeProgress).toBe(0.5);
  });

  it('excludes a manual advance from compliance even though it advances the slot', () => {
    const metrics = computeMetrics(
      [w('2026-01-01', 60, 'advanced_manually', 's1')],
      [slot('s1', 1, 100)],
    );
    expect(metrics.compliantWorkouts).toBe(0);
    expect(metrics.planCompliance).toBe(0);
    expect(metrics.slotsAdvanced).toBe(1);
  });

  it('counts scaling up as compliant', () => {
    const metrics = computeMetrics(
      [w('2026-01-01', 130, 'scaled_up', 's1')],
      [slot('s1', 1, 100)],
    );
    expect(metrics.planCompliance).toBe(1);
  });

  it('reports no challenge progress when there are no slots (open-ended)', () => {
    const metrics = computeMetrics([w('2026-01-01', 50)], []);
    expect(metrics.challengeProgress).toBeUndefined();
    expect(metrics.slotsTotal).toBeUndefined();
  });

  it('returns zero compliance for an empty history rather than dividing by zero', () => {
    expect(computeMetrics([], []).planCompliance).toBe(0);
  });
});

describe('activity streaks', () => {
  it('counts consecutive calendar days', () => {
    expect(
      activityStreaks([w('2026-01-01', 10), w('2026-01-02', 10), w('2026-01-03', 10)]),
    ).toEqual({ current: 3, longest: 3 });
  });

  it('breaks on a gap and keeps the longest run', () => {
    const streaks = activityStreaks([
      w('2026-01-01', 10),
      w('2026-01-02', 10),
      w('2026-01-03', 10),
      w('2026-01-10', 10),
    ]);
    expect(streaks.current).toBe(1);
    expect(streaks.longest).toBe(3);
  });

  it('treats two workouts on one day as a single day', () => {
    expect(activityStreaks([w('2026-01-01', 10), w('2026-01-01', 20)])).toEqual({
      current: 1,
      longest: 1,
    });
  });

  it('handles a month boundary', () => {
    expect(activityStreaks([w('2026-01-31', 10), w('2026-02-01', 10)]).longest).toBe(2);
  });

  it('handles an empty history', () => {
    expect(activityStreaks([])).toEqual({ current: 0, longest: 0 });
  });
});

describe('STAT-02/STAT-03 — cumulative series', () => {
  const slots = [slot('s1', 1, 100), slot('s2', 2, 110)];

  it('accumulates actual reps across every attempt', () => {
    const series = cumulativeSeries(
      [
        w('2026-01-01', 90, 'failed', 's1'),
        w('2026-01-02', 100, 'completed_as_planned', 's1'),
        w('2026-01-03', 110, 'completed_as_planned', 's2'),
      ],
      slots,
    );
    expect(series.map((p) => p.actual)).toEqual([90, 190, 300]);
  });

  it('advances the planned line once per slot, not once per attempt', () => {
    const series = cumulativeSeries(
      [
        w('2026-01-01', 90, 'failed', 's1'),
        w('2026-01-02', 100, 'completed_as_planned', 's1'),
        w('2026-01-03', 110, 'completed_as_planned', 's2'),
      ],
      slots,
    );
    // Failed attempt contributes nothing; the slot's 100 lands exactly once.
    expect(series.map((p) => p.planned)).toEqual([0, 100, 210]);
  });

  it('never advances the planned line for a deload', () => {
    const series = cumulativeSeries([w('2026-01-01', 60, 'deload', 's1')], slots);
    expect(series[0]!.planned).toBe(0);
    expect(series[0]!.actual).toBe(60);
  });

  it('sorts by date regardless of input order', () => {
    const series = cumulativeSeries(
      [w('2026-01-03', 30), w('2026-01-01', 10), w('2026-01-02', 20)],
      [],
    );
    expect(series.map((p) => p.actualTotal)).toEqual([10, 20, 30]);
    expect(series.map((p) => p.actual)).toEqual([10, 30, 60]);
  });

  it('ignores unlinked workouts for the planned line but counts them as actual', () => {
    const series = cumulativeSeries([w('2026-01-01', 50)], slots);
    expect(series[0]!.planned).toBe(0);
    expect(series[0]!.actual).toBe(50);
  });
});

describe('formatting', () => {
  it('formats short durations as m:ss and long ones as hours', () => {
    expect(formatDuration(391)).toBe('6:31');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(16_920)).toBe('4.7 h'); // the incumbent showed 4.7 STD.
  });

  it('formats a countdown clock', () => {
    // Regression: Math.round(150/60) is 3, so a naive implementation renders "3:30".
    expect(formatClock(150)).toBe('2:30');
    expect(formatClock(210)).toBe('3:30');
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(0)).toBe('0:00');
  });
});
