/**
 * History: totals, the three metrics, the cumulative chart, and the session list.
 *
 * Nothing here is gated. The incumbent paywalled its calorie column and showed a dash — this
 * shows the number and says plainly that it is an estimate.
 */

import { useMemo } from 'react';
import {
  computeMetrics,
  cumulativeSeries,
  formatDuration,
  lifetimeTotals,
  type StatSlot,
  type StatWorkout,
} from '../core/stats.js';
import type { WorkoutOutcome } from '../core/types.js';
import type { PlanSlotRecord, WorkoutRecord } from '../db/schema.js';
import { CumulativeChart } from './Chart.js';
import { Button, Card, Stat } from './kit.js';

const OUTCOME_LABEL: Record<WorkoutOutcome, string> = {
  completed_as_planned: 'as planned',
  scaled_up: 'scaled up',
  deload: 'deload',
  failed: 'missed',
  advanced_manually: 'moved on',
};

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
  onExportCsv,
  onExportJson,
}: {
  workouts: WorkoutRecord[];
  slots: PlanSlotRecord[];
  onExportCsv: () => void;
  onExportJson: () => void;
}) {
  const statWorkouts: StatWorkout[] = useMemo(
    () =>
      workouts.map((w) => ({
        performedAt: w.performedAt,
        actualTotal: w.actualTotal,
        outcome: w.outcome,
        ...(w.durationSeconds === undefined ? {} : { durationSeconds: w.durationSeconds }),
        ...(w.planSlotId === undefined ? {} : { planSlotId: w.planSlotId }),
        ...(w.kcal === undefined ? {} : { kcal: { value: w.kcal.value, source: w.kcal.source } }),
      })),
    [workouts],
  );

  const statSlots: StatSlot[] = useMemo(
    () => slots.map((s) => ({ id: s.id, ordinal: s.ordinal, targetTotal: s.targetTotal, status: s.status })),
    [slots],
  );

  const totals = lifetimeTotals(statWorkouts);
  const metrics = computeMetrics(statWorkouts, statSlots);
  const series = cumulativeSeries(statWorkouts, statSlots);
  const slotById = useMemo(() => new Map(slots.map((s) => [s.id, s])), [slots]);

  const kcalNote = totals.hasExternalKcal && totals.hasEstimatedKcal
    ? 'mixed: imported + estimated'
    : totals.hasExternalKcal
      ? 'imported'
      : 'estimated';

  return (
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
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-100">Progress</h3>
        <div className="mt-3">
          <CumulativeChart points={series} />
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-100">How it's going</h3>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Stat
            label="Streak"
            value={`${metrics.activityStreak}d`}
            sub={`best ${metrics.longestActivityStreak}d`}
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

      <Card>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-100">Sessions</h3>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onExportCsv}>
              CSV
            </Button>
            <Button variant="ghost" onClick={onExportJson}>
              Backup
            </Button>
          </div>
        </div>

        {workouts.length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">Nothing logged yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-[#26324b]">
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
