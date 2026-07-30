/**
 * History: totals, the three metrics, the chart, and the session list.
 *
 * Nothing here is gated. The incumbent paywalled its calorie column and showed a dash — this
 * shows the number and says plainly that it is an estimate.
 *
 * Everything is scoped to the workout currently showing. Two exercises are not one number, so
 * they are not added together.
 */

import { useMemo, useState } from 'react';
import {
  computeMetrics,
  cumulativeSeries,
  formatDuration,
  lifetimeTotals,
  rhythmGapDays,
  sessionSeries,
  type StatSlot,
  type StatWorkout,
} from '../core/stats.js';
import type { WorkoutOutcome } from '../core/types.js';
import type { PlanSlotRecord, WorkoutRecord } from '../db/schema.js';
import { CumulativeChart, SessionChart } from './Chart.js';
import { OUTCOME_LABEL } from './chartScale.js';
import { toStatWorkouts } from './shareCardData.js';
import { Button, Card, Segmented, Stat } from './kit.js';

const OUTCOME_STYLE: Record<WorkoutOutcome, string> = {
  completed_as_planned: 'text-teal-300',
  scaled_up: 'text-teal-200',
  deload: 'text-amber-300',
  failed: 'text-red-300',
  advanced_manually: 'text-sky-300',
};

export function History({
  workouts,
  slots,
  daysPerWeek,
  onShare,
}: {
  workouts: WorkoutRecord[];
  slots: PlanSlotRecord[];
  /** Sets the streak's rest-day tolerance. See `rhythmGapDays`. */
  daysPerWeek: number;
  /** Opens the one export sheet. History keeps the affordance, not a second implementation. */
  onShare: () => void;
}) {
  // The same mapping the share card uses, so the two views of one history agree.
  const statWorkouts: StatWorkout[] = useMemo(() => toStatWorkouts(workouts), [workouts]);

  const statSlots: StatSlot[] = useMemo(
    () =>
      slots.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        targetTotal: s.targetTotal,
        status: s.status,
      })),
    [slots],
  );

  const totals = lifetimeTotals(statWorkouts);
  const metrics = computeMetrics(statWorkouts, statSlots, rhythmGapDays(daysPerWeek));
  const perSession = sessionSeries(statWorkouts, statSlots);
  const cumulative = cumulativeSeries(statWorkouts, statSlots);
  const slotById = useMemo(() => new Map(slots.map((s) => [s.id, s])), [slots]);
  const [chartView, setChartView] = useState<'session' | 'total'>('session');

  const kcalNote =
    totals.hasExternalKcal && totals.hasEstimatedKcal
      ? 'mixed: imported + estimated'
      : totals.hasExternalKcal
        ? 'imported'
        : 'estimated';

  return (
    // Mobile stacks. From lg the numbers and chart take the wide left column and the session
    // list moves into its own scrolling rail, so a 200-session history stops making the page
    // metres long.
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
      <div className="flex flex-col gap-4">
        <Card>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Time" value={formatDuration(totals.seconds)} />
            <Stat label="Reps" value={totals.reps} sub={`${totals.workouts} sessions`} />
            <Stat
              label="Kcal"
              value={totals.kcal > 0 ? totals.kcal : '—'}
              sub={totals.kcal > 0 ? kcalNote : 'set bodyweight'}
            />
          </div>
          {/*
            No "<exercise> only." caption. The workout row above already names the selected
            exercise, and every number on this screen is scoped to it — restating that under
            the totals is the same fact in a second place.
          */}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-100">Progress</h3>
            <Segmented
              ariaLabel="Chart view"
              size="sm"
              value={chartView}
              onChange={setChartView}
              options={[
                { value: 'session', label: 'Per session' },
                { value: 'total', label: 'Running total' },
              ]}
            />
          </div>
          <div className="mt-3">
            {chartView === 'session' ? (
              <SessionChart points={perSession} />
            ) : (
              <CumulativeChart points={cumulative} />
            )}
          </div>
        </Card>

        <Card>
          <h3 className="font-semibold text-slate-100">How it's going</h3>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Stat
              label="Streak"
              value={metrics.activityStreak}
              sub={`sessions · best ${metrics.longestActivityStreak}`}
            />
            <Stat
              label="Compliance"
              value={`${Math.round(metrics.planCompliance * 100)}%`}
              sub={`${metrics.compliantWorkouts}/${metrics.totalAttempts} attempts`}
            />
            <Stat
              label="Progress"
              value={
                metrics.challengeProgress === undefined
                  ? '—'
                  : `${Math.round(metrics.challengeProgress * 100)}%`
              }
              sub={
                metrics.slotsTotal === undefined
                  ? 'open-ended'
                  : `${metrics.slotsAdvanced}/${metrics.slotsTotal} days`
              }
            />
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-100">Sessions</h3>
          <Button variant="ghost" onClick={onShare}>
            Share
          </Button>
        </div>

        {workouts.length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">Nothing logged yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-[#26324b] lg:max-h-[36rem] lg:overflow-y-auto">
            {[...workouts]
              .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
              .map((w) => {
                const slot = w.planSlotId === undefined ? undefined : slotById.get(w.planSlotId);
                return (
                  <li key={w.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="tnum text-sm text-slate-200">
                        {w.performedAt.slice(0, 10)}
                        {slot?.week !== undefined ? (
                          <span className="ml-2 text-slate-400">
                            W{slot.week}D{slot.day}
                            {w.attemptNo > 1 ? ` · attempt ${w.attemptNo}` : ''}
                          </span>
                        ) : (
                          <span className="ml-2 text-slate-500">unlinked</span>
                        )}
                      </div>
                      <div className="tnum mt-0.5 text-xs text-slate-400">
                        {w.sets.map((s) => s.actual).join(' · ')}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="tnum text-lg font-semibold text-slate-100">
                        {w.actualTotal}
                      </div>
                      <div className={`text-xs ${OUTCOME_STYLE[w.outcome]}`}>
                        {OUTCOME_LABEL[w.outcome]}
                      </div>
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </Card>
    </div>
  );
}
