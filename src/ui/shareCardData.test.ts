/**
 * The card reports; it does not calculate. These tests pin that: every number it carries comes
 * straight from `core/stats`, and the one thing it must never do is invent a prescription for a
 * session that never had one (IMP-07).
 */

import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  lifetimeTotals,
  rhythmGapDays,
  sessionSeries,
  type StatSlot,
  type StatWorkout,
} from '../core/stats.js';
import { SHARE_TABLE_ROWS, buildShareCard, type ShareCardInput } from './shareCardData.js';

function slot(ordinal: number, targetTotal: number): StatSlot {
  return { id: `s${ordinal}`, ordinal, targetTotal, status: 'completed' };
}

function workout(day: number, actualTotal: number, planSlotId?: string): StatWorkout {
  return {
    performedAt: `2026-03-${String(day).padStart(2, '0')}T08:00:00.000Z`,
    actualTotal,
    durationSeconds: 600,
    outcome: 'completed_as_planned',
    ...(planSlotId === undefined ? {} : { planSlotId }),
  };
}

const slots: StatSlot[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => slot(n, 100 + n * 10));
const workouts: StatWorkout[] = [1, 3, 5, 7, 9, 11, 13, 15].map((day, i) =>
  workout(day, 95 + i * 10, `s${i + 1}`),
);

function input(overrides: Partial<ShareCardInput> = {}): ShareCardInput {
  return { exerciseLabel: 'Push-ups', workouts, slots, daysPerWeek: 3, ...overrides };
}

describe('buildShareCard', () => {
  it('charts the whole history, exactly as the app does', () => {
    const card = buildShareCard(input());
    expect(card.points).toEqual(sessionSeries(workouts, slots));
    expect(card.points).toHaveLength(8);
  });

  it('tables only the most recent sessions, newest first', () => {
    const card = buildShareCard(input());
    expect(SHARE_TABLE_ROWS).toBe(6);
    expect(card.recent).toHaveLength(SHARE_TABLE_ROWS);
    expect(card.recent[0]?.date).toBe('2026-03-15');
    expect(card.recent[0]?.actualTotal).toBe(165);
    expect(card.recent.at(-1)?.date).toBe('2026-03-05');
    const dates = card.recent.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('shows every session when there are fewer than the table holds', () => {
    const card = buildShareCard(input({ workouts: workouts.slice(0, 3) }));
    expect(card.recent).toHaveLength(3);
    expect(card.points).toHaveLength(3);
  });

  it('has nothing to show for an empty history', () => {
    const card = buildShareCard(input({ workouts: [] }));
    expect(card.recent).toEqual([]);
    expect(card.points).toEqual([]);
    expect(card.totals.reps).toBe(0);
    expect(card.kcal).toBeUndefined();
  });

  it('never turns an unlinked session into a prescription it did not have', () => {
    // The imported session on the 17th belongs to no slot: the incumbent's own prescription
    // is unrecoverable, so the honest answer is "unknown", not "whatever you happened to do".
    const mixed = [...workouts, workout(17, 173)];
    const card = buildShareCard(input({ workouts: mixed }));

    const row = card.recent[0]!;
    expect(row.date).toBe('2026-03-17');
    expect(row.actualTotal).toBe(173);
    expect(row.targetTotal).toBeUndefined();
    expect(row.targetTotal).not.toBe(row.actualTotal);
    expect('targetTotal' in row).toBe(false);

    const point = card.points.at(-1)!;
    expect(point.targetTotal).toBeUndefined();
    expect('targetTotal' in point).toBe(false);

    // The linked ones still carry their real prescription.
    expect(card.recent[1]?.targetTotal).toBe(180);
  });

  it('reports the numbers core/stats computes, unchanged', () => {
    const card = buildShareCard(input());
    expect(card.totals).toEqual(lifetimeTotals(workouts));
    expect(card.metrics).toEqual(computeMetrics(workouts, slots, rhythmGapDays(3)));
    expect(card.metrics.activityStreak).toBe(8);
  });

  it('takes the streak tolerance from the plan rhythm, not a default', () => {
    // Three-day spacing keeps a three-a-week plan's rhythm and breaks a daily one's, so the
    // same history has to produce two different streaks.
    const spacedOut = [workout(1, 100, 's1'), workout(4, 110, 's2'), workout(7, 120, 's3')];
    expect(buildShareCard(input({ workouts: spacedOut, daysPerWeek: 3 })).metrics.activityStreak)
      .toBe(3);
    expect(buildShareCard(input({ workouts: spacedOut, daysPerWeek: 7 })).metrics.activityStreak)
      .toBe(1);
  });

  it('assembles only what the card draws', () => {
    const card = buildShareCard(input());
    // The week/day/goal context and the per-row outcome were both dropped from the card during
    // its 2026-07-30 revisions. They are gone from here too — an unread field is a field that
    // rots, and the next reader cannot tell it is dead.
    expect(Object.keys(card).sort()).toEqual([
      'exerciseLabel',
      'metrics',
      'points',
      'recent',
      'totals',
    ]);
    expect(Object.keys(card.recent[0]!).sort()).toEqual(['actualTotal', 'date', 'targetTotal']);
  });

  it('leaves the domain alone while trimming the card', () => {
    // The outcome is still on every session point, because History still shows the words. The
    // card not drawing something is no reason for the data underneath to lose it.
    const card = buildShareCard(input());
    expect(card.points.every((p) => typeof p.outcome === 'string')).toBe(true);
  });

  it('reports kcal only when there is some, and labels how it was arrived at', () => {
    const withKcal = workouts.map((w, i) => ({
      ...w,
      kcal: { value: 40, source: (i === 0 ? 'external' : 'estimated') as 'external' | 'estimated' },
    }));

    expect(buildShareCard(input({ workouts: withKcal })).kcal).toEqual({
      value: 320,
      note: 'mixed',
    });
    expect(
      buildShareCard(input({ workouts: withKcal.map((w) => ({ ...w, kcal: { value: 40, source: 'estimated' as const } })) }))
        .kcal,
    ).toEqual({ value: 320, note: 'estimated' });
    expect(
      buildShareCard(input({ workouts: withKcal.map((w) => ({ ...w, kcal: { value: 40, source: 'external' as const } })) }))
        .kcal,
    ).toEqual({ value: 320, note: 'imported' });
    expect(buildShareCard(input()).kcal).toBeUndefined();
  });

  it('passes the exercise label through untouched', () => {
    expect(buildShareCard(input({ exerciseLabel: 'Liegestütze' })).exerciseLabel).toBe(
      'Liegestütze',
    );
  });
});
