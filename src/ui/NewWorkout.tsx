/**
 * Creating a workout: either from an imported CSV, or from a fresh max test.
 *
 * Used twice — once on first run (`Welcome`) and once for adding a second exercise later. The
 * two paths are identical, which is the point: someone who has push-up history in the old app
 * probably has sit-up history there too, so import must stay available beyond first run.
 */

import { useState } from 'react';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import { createChallenge, createExercise, recordMaxTest, saveSettings } from '../db/repo.js';
import { buildCanonicalImport, type ImportReport } from '../import/pipeline.js';
import { INCUMBENT_CSV_V1 } from '../import/profiles.js';
import { commitImport, estimateBaselineFromImport } from '../import/reconcile.js';
import { Banner, Button, Card, NumberField, TextField } from './kit.js';

/** Below this baseline the percentage table produces very coarse sets. Worth saying out loud. */
const COARSE_BASELINE = 10;

export type NewWorkoutMode = 'choose' | 'import-review' | 'fresh';

export function CsvDropCard({
  title = 'Bring your history across',
  blurb = 'Export the CSV from your current app and drop it here.',
  onFile,
}: {
  title?: string;
  blurb?: string;
  onFile: (file: File) => void;
}) {
  return (
    <Card>
      <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{blurb}</p>
      <label className="mt-4 block">
        <span className="sr-only">Choose a CSV file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
          }}
          className="block w-full cursor-pointer rounded-xl border border-dashed border-[#3b4a68] bg-[#0f1728] px-3 py-4 text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-teal-300 file:px-3 file:py-2 file:font-semibold file:text-[#08111f]"
        />
      </label>
    </Card>
  );
}

export function ImportReview({
  report,
  busy,
  onBack,
  onConfirm,
}: {
  report: ImportReport;
  busy: boolean;
  onBack: () => void;
  onConfirm: (
    baseline: number,
    acceptedEstimate: boolean,
    goal: number,
    weeks: number,
    daysPerWeek: number,
  ) => void;
}) {
  const estimate = estimateBaselineFromImport(report.canonical);
  const [baseline, setBaseline] = useState<number | ''>(estimate.value);
  const [goal, setGoal] = useState<number | ''>(report.canonical.goal ?? 100);
  const [weeks, setWeeks] = useState<number | ''>(6);
  const [daysPerWeek, setDaysPerWeek] = useState<number | ''>(3);

  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  const repeats = report.stats.sessionsAccepted - report.stats.distinctSlots;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <h2 className="text-lg font-semibold text-slate-100">
          Found {report.stats.sessionsAccepted} sessions
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-slate-400">Exercise</dt>
            <dd className="text-slate-100">{report.canonical.exerciseLabel}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Total reps</dt>
            <dd className="tnum text-slate-100">{report.stats.totalReps}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Planned days</dt>
            <dd className="tnum text-slate-100">{report.stats.distinctSlots}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Repeat attempts</dt>
            <dd className="tnum text-slate-100">{repeats}</dd>
          </div>
        </dl>
      </Card>

      {errors.length > 0 ? (
        <Banner tone="warn">
          {errors.length} row{errors.length === 1 ? '' : 's'} could not be read and will be
          skipped:
          <ul className="mt-1.5 list-inside list-disc">
            {errors.slice(0, 3).map((issue, i) => (
              <li key={i}>
                Line {issue.line}: {issue.message}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {warnings.map((issue, i) => (
        <Banner key={i} tone="info">
          {issue.message}
        </Banner>
      ))}

      <Card>
        <h3 className="font-semibold text-slate-100">Your starting number</h3>
        <div className="mt-3">
          <NumberField
            label="Baseline max"
            value={baseline}
            min={1}
            onChange={setBaseline}
            suffix="reps"
            hint={estimate.explanation}
          />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumberField label="Goal" value={goal} min={1} onChange={setGoal} suffix="reps" />
          <NumberField label="Weeks" value={weeks} min={1} onChange={setWeeks} />
          <NumberField label="Days / week" value={daysPerWeek} min={1} onChange={setDaysPerWeek} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          Your last set on the final day will ask for roughly half your goal in one go.
        </p>
      </Card>

      <div className="flex gap-3">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={busy || baseline === '' || goal === '' || weeks === '' || daysPerWeek === ''}
          onClick={() =>
            onConfirm(
              Number(baseline),
              Number(baseline) === estimate.value,
              Number(goal),
              Number(weeks),
              Number(daysPerWeek),
            )
          }
        >
          {busy ? 'Importing…' : 'Import my history'}
        </Button>
      </div>
    </div>
  );
}

export function FreshStart({
  busy,
  defaultLabel = 'Push-ups',
  onBack,
  onConfirm,
}: {
  busy: boolean;
  defaultLabel?: string;
  onBack: () => void;
  onConfirm: (
    label: string,
    testedMax: number,
    goal: number,
    weeks: number,
    daysPerWeek: number,
  ) => void;
}) {
  const [label, setLabel] = useState(defaultLabel);
  const [tested, setTested] = useState<number | ''>('');
  const [goal, setGoal] = useState<number | ''>(100);
  const [weeks, setWeeks] = useState<number | ''>(6);
  const [daysPerWeek, setDaysPerWeek] = useState<number | ''>(3);

  const coarse = tested !== '' && Number(tested) > 0 && Number(tested) < COARSE_BASELINE;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <h2 className="text-lg font-semibold text-slate-100">Max test</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Rested, one set, good form. Stop when you stop.
        </p>
        <div className="mt-4 flex flex-col gap-4">
          <TextField
            label="Exercise"
            value={label}
            onChange={setLabel}
            placeholder="Push-ups"
            hint="Anything you can count. Sit-ups, squats, pull-ups, dips."
          />
          <NumberField
            label="How many did you manage?"
            value={tested}
            min={1}
            onChange={setTested}
            suffix="reps"
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <NumberField label="Goal" value={goal} min={1} onChange={setGoal} suffix="reps" />
            <NumberField label="Weeks" value={weeks} min={1} onChange={setWeeks} />
            <NumberField label="Days / week" value={daysPerWeek} min={1} onChange={setDaysPerWeek} />
          </div>
        </div>
      </Card>

      {coarse ? (
        <Banner tone="info">
          Starting from {String(tested)} gives you very small sets to begin with — the first
          sessions will be single figures. That works, but the plan was built around push-up
          numbers, so it will feel blunt at this end. Pull-ups and dips are the usual case.
        </Banner>
      ) : null}

      <div className="flex gap-3">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={
            busy ||
            label.trim() === '' ||
            tested === '' ||
            goal === '' ||
            weeks === '' ||
            daysPerWeek === ''
          }
          onClick={() =>
            onConfirm(label, Number(tested), Number(goal), Number(weeks), Number(daysPerWeek))
          }
        >
          {busy ? 'Building your plan…' : 'Build my plan'}
        </Button>
      </div>
    </div>
  );
}

// ── The write paths, shared by both callers ────────────────────────────────────

/**
 * Both creators select the new challenge, so the app lands on the thing that was just made
 * rather than on whatever happened to be newest.
 */
export async function createFromImport(
  report: ImportReport,
  baselineValue: number,
  acceptedEstimate: boolean,
  goal: number,
  weeks: number,
  daysPerWeek: number,
): Promise<void> {
  const { challengeId } = await commitImport({
    canonical: report.canonical,
    baseline: {
      value: baselineValue,
      source: acceptedEstimate ? 'estimated' : 'user_entered',
      recordedAt: new Date().toISOString(),
    },
    goal,
    weeks,
    daysPerWeek,
  });
  await saveSettings({ selectedChallengeId: challengeId });
}

export async function createFromMaxTest(
  label: string,
  testedMax: number,
  goal: number,
  weeks: number,
  daysPerWeek: number,
): Promise<void> {
  const exercise = await createExercise(label);
  const test = await recordMaxTest(exercise.id, testedMax);
  const { challenge } = await createChallenge({
    exerciseId: exercise.id,
    baseline: {
      value: testedMax,
      source: 'tested',
      evidenceId: test.id,
      recordedAt: test.performedAt,
    },
    params: pushupParams(testedMax, goal, weeks, daysPerWeek),
  });
  await saveSettings({ selectedChallengeId: challenge.id });
}

export function readCsv(file: File): Promise<ImportReport> {
  return file.text().then((text) => buildCanonicalImport(text, INCUMBENT_CSV_V1));
}
