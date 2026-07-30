/**
 * First run: either bring existing history across, or start from a fresh max test.
 *
 * Import is presented first and framed as the default, because migration fidelity is the
 * point — an app that starts empty gives a group member no reason to switch.
 */

import { useState } from 'react';
import { buildCanonicalImport, type ImportReport } from '../import/pipeline.js';
import { INCUMBENT_CSV_V1 } from '../import/profiles.js';
import { commitImport, estimateBaselineFromImport } from '../import/reconcile.js';
import { createChallenge, createExercise, recordMaxTest } from '../db/repo.js';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import { Banner, Button, Card, NumberField, TextField } from './kit.js';

type Mode = 'choose' | 'import-review' | 'fresh';

export function Welcome({ onReady }: { onReady: () => void }) {
  const [mode, setMode] = useState<Mode>('choose');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      setReport(buildCanonicalImport(text, INCUMBENT_CSV_V1));
      setMode('import-review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read.');
    }
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-10 safe-t">
      <header className="py-8">
        <h1 className="text-3xl font-bold tracking-tight text-slate-100">GODMODE</h1>
        <p className="mt-1 text-sm uppercase tracking-[0.2em] text-teal-300">No More Later</p>
      </header>

      {error ? (
        <div className="pb-4">
          <Banner tone="warn" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {mode === 'choose' ? (
        <div className="flex flex-col gap-4">
          <Card>
            <h2 className="text-lg font-semibold text-slate-100">Bring your history across</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
              Export the CSV from your current app and drop it here.
            </p>
            <label className="mt-4 block">
              <span className="sr-only">Choose a CSV file</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
                className="block w-full cursor-pointer rounded-xl border border-dashed border-[#3b4a68] bg-[#0f1728] px-3 py-4 text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-teal-300 file:px-3 file:py-2 file:font-semibold file:text-[#08111f]"
              />
            </label>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-slate-100">Or start fresh</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
              One set to failure, then pick your target.
            </p>
            <Button variant="ghost" className="mt-4 w-full" onClick={() => setMode('fresh')}>
              Take a max test
            </Button>
          </Card>

          <p className="px-1 text-xs leading-relaxed text-slate-500">
            Your data stays on this device. No account, nothing to pay for.
          </p>
        </div>
      ) : null}

      {mode === 'import-review' && report ? (
        <ImportReview
          report={report}
          busy={busy}
          onBack={() => {
            setReport(null);
            setMode('choose');
          }}
          onConfirm={async (baselineValue, accepted, goal, weeks, daysPerWeek) => {
            setBusy(true);
            setError(null);
            try {
              await commitImport({
                canonical: report.canonical,
                baseline: {
                  value: baselineValue,
                  source: accepted ? 'estimated' : 'user_entered',
                  recordedAt: new Date().toISOString(),
                },
                goal,
                weeks,
                daysPerWeek,
              });
              onReady();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'The import could not be saved.');
              setBusy(false);
            }
          }}
        />
      ) : null}

      {mode === 'fresh' ? (
        <FreshStart
          busy={busy}
          onBack={() => setMode('choose')}
          onConfirm={async (label, testedMax, goal, weeks, daysPerWeek) => {
            setBusy(true);
            setError(null);
            try {
              const exercise = await createExercise(label);
              const test = await recordMaxTest(exercise.id, testedMax);
              await createChallenge({
                exerciseId: exercise.id,
                baseline: {
                  value: testedMax,
                  source: 'tested',
                  evidenceId: test.id,
                  recordedAt: test.performedAt,
                },
                params: pushupParams(testedMax, goal, weeks, daysPerWeek),
              });
              onReady();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'The challenge could not be created.');
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ImportReview({
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
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
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

function FreshStart({
  busy,
  onBack,
  onConfirm,
}: {
  busy: boolean;
  onBack: () => void;
  onConfirm: (
    label: string,
    testedMax: number,
    goal: number,
    weeks: number,
    daysPerWeek: number,
  ) => void;
}) {
  const [label, setLabel] = useState('Push-ups');
  const [tested, setTested] = useState<number | ''>('');
  const [goal, setGoal] = useState<number | ''>(100);
  const [weeks, setWeeks] = useState<number | ''>(6);
  const [daysPerWeek, setDaysPerWeek] = useState<number | ''>(3);

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
            hint="Whatever you want to call it."
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

      <div className="flex gap-3">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={busy || tested === '' || goal === '' || weeks === '' || daysPerWeek === ''}
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
