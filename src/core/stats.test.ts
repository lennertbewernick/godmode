import { describe, expect, it } from 'vitest';
import {
  activityStreaks,
  computeMetrics,
  DEFAULT_RHYTHM_GAP_DAYS,
  cumulativeSeries,
  formatClock,
  formatDuration,
  lifetimeTotals,
  rhythmGapDays,
  sessionSeries,
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

describe('rhythm tolerance', () => {
  it('allows a four-day gap on a three-day-a-week plan', () => {
    // ceil(7/3) = 3 days between sessions, plus one day of slack.
    expect(rhythmGapDays(3)).toBe(4);
  });

  it('tightens as the plan gets more frequent and loosens as it gets rarer', () => {
    expect(rhythmGapDays(7)).toBe(2);
    expect(rhythmGapDays(4)).toBe(3);
    expect(rhythmGapDays(2)).toBe(5);
    expect(rhythmGapDays(1)).toBe(8);
  });

  it('falls back rather than dividing by zero or worse', () => {
    expect(rhythmGapDays(0)).toBe(DEFAULT_RHYTHM_GAP_DAYS);
    expect(rhythmGapDays(-3)).toBe(DEFAULT_RHYTHM_GAP_DAYS);
    expect(rhythmGapDays(Number.NaN)).toBe(DEFAULT_RHYTHM_GAP_DAYS);
  });
});

describe('activity streaks — sessions in rhythm, not calendar days', () => {
  /**
   * The regression this metric exists to fix. Across the 29-session reference history every gap
   * is 2, 3 or 4 days and there is not one instance of two consecutive days — so a
   * calendar-day streak reads "1, best 1" for a user who never missed a session.
   */
  it('does not collapse to 1 on a three-a-week schedule that was followed perfectly', () => {
    const monWedFri = [
      '2026-01-05', '2026-01-07', '2026-01-09',
      '2026-01-12', '2026-01-14', '2026-01-16',
      '2026-01-19', '2026-01-21', '2026-01-23',
    ].map((d) => w(d, 100));

    const streaks = activityStreaks(monWedFri, rhythmGapDays(3));
    expect(streaks.current).toBe(9);
    expect(streaks.longest).toBe(9);
  });

  it('survives the exact gap pattern of the real 29-session history', () => {
    // Gaps observed in the reference export: 2, 3 and one 4. None should break the run.
    const gaps = [2, 2, 3, 2, 2, 2, 3, 2, 4, 2, 2, 2];
    let day = new Date(Date.UTC(2026, 4, 29));
    const workouts = [w(day.toISOString().slice(0, 10), 100)];
    for (const gap of gaps) {
      day = new Date(day.getTime() + gap * 86_400_000);
      workouts.push(w(day.toISOString().slice(0, 10), 100));
    }

    expect(activityStreaks(workouts, rhythmGapDays(3)).current).toBe(gaps.length + 1);
  });

  it('breaks when a whole week goes missing', () => {
    const streaks = activityStreaks(
      [w('2026-01-05', 100), w('2026-01-07', 100), w('2026-01-19', 100)],
      rhythmGapDays(3),
    );
    expect(streaks.current).toBe(1);
    expect(streaks.longest).toBe(2);
  });

  it('breaks a five-day gap on a three-a-week plan — that is a skipped session', () => {
    expect(
      activityStreaks([w('2026-01-05', 100), w('2026-01-10', 100)], rhythmGapDays(3)).current,
    ).toBe(1);
  });

  it('holds a daily plan together across one rest day but not two', () => {
    expect(
      activityStreaks([w('2026-01-05', 10), w('2026-01-07', 10)], rhythmGapDays(7)).current,
    ).toBe(2);
    expect(
      activityStreaks([w('2026-01-05', 10), w('2026-01-08', 10)], rhythmGapDays(7)).current,
    ).toBe(1);
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

describe('per-session series', () => {
  const slots = [slot('s1', 1, 100), slot('s2', 2, 110)];

  it('reports each session on its own, not as a running total', () => {
    const series = sessionSeries(
      [
        w('2026-01-01', 90, 'failed', 's1'),
        w('2026-01-02', 100, 'completed_as_planned', 's1'),
        w('2026-01-03', 110, 'completed_as_planned', 's2'),
      ],
      slots,
    );
    expect(series.map((p) => p.actualTotal)).toEqual([90, 100, 110]);
  });

  it('pairs each session with the total its own day asked for', () => {
    const series = sessionSeries(
      [w('2026-01-01', 90, 'failed', 's1'), w('2026-01-03', 110, 'completed_as_planned', 's2')],
      slots,
    );
    expect(series.map((p) => p.targetTotal)).toEqual([100, 110]);
  });

  it('leaves the target undefined for an unlinked session rather than inventing one', () => {
    const series = sessionSeries([w('2026-01-01', 50)], slots);
    expect(series[0]!.targetTotal).toBeUndefined();
    expect(series[0]!.actualTotal).toBe(50);
  });

  it('shows the dip a repeated day produces, which a running total cannot', () => {
    const series = sessionSeries(
      [
        w('2026-01-01', 100, 'completed_as_planned', 's1'),
        w('2026-01-03', 60, 'deload', 's2'),
        w('2026-01-05', 110, 'completed_as_planned', 's2'),
      ],
      slots,
    );
    const actuals = series.map((p) => p.actualTotal);
    expect(actuals).toEqual([100, 60, 110]);
    // The point of the series: it is not monotonic.
    expect(actuals[1]!).toBeLessThan(actuals[0]!);

    // The same history as a running total only ever climbs, which is why it looked featureless.
    const running = cumulativeSeries(
      [
        w('2026-01-01', 100, 'completed_as_planned', 's1'),
        w('2026-01-03', 60, 'deload', 's2'),
        w('2026-01-05', 110, 'completed_as_planned', 's2'),
      ],
      slots,
    ).map((p) => p.actual);
    expect(running).toEqual([100, 160, 270]);
  });

  it('sorts by date regardless of input order', () => {
    const series = sessionSeries([w('2026-01-03', 30), w('2026-01-01', 10)], []);
    expect(series.map((p) => p.actualTotal)).toEqual([10, 30]);
  });

  it('handles an empty history', () => {
    expect(sessionSeries([], slots)).toEqual([]);
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
