/**
 * First run: either bring existing history across, or start from a fresh max test.
 *
 * Import is presented first and framed as the default, because migration fidelity is the
 * point — an app that starts empty gives a group member no reason to switch.
 *
 * The forms themselves live in NewWorkout.tsx, shared with the add-another-exercise flow.
 */

import { useState } from 'react';
import type { ImportReport } from '../import/pipeline.js';
import {
  createFromImport,
  createFromMaxTest,
  CsvDropCard,
  FreshStart,
  ImportReview,
  readCsv,
  type NewWorkoutMode,
} from './NewWorkout.js';
import { Banner, Button, Card } from './kit.js';

export function Welcome({
  revision,
  onReady,
}: {
  /** The snapshot revision these screens were composed against. Sent with the command. */
  revision: number;
  onReady: () => void;
}) {
  const [mode, setMode] = useState<NewWorkoutMode>('choose');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    try {
      setReport(await readCsv(file));
      setMode('import-review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read.');
    }
  }

  return (
    <div className="mx-auto w-full px-4 pb-10 md:max-w-2xl safe-t">
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
          <CsvDropCard onFile={(file) => void handleFile(file)} />

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
            Your data lives on your own server. No account, nothing to pay for.
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
              await createFromImport(
                report,
                baselineValue,
                accepted,
                goal,
                weeks,
                daysPerWeek,
                revision,
              );
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
              await createFromMaxTest(label, testedMax, goal, weeks, daysPerWeek, revision);
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

/**
 * Adding a second (or fifth) exercise once one already exists.
 *
 * Same two paths as first run. Import stays offered because someone migrating usually has more
 * than one exercise's history sitting in the old app.
 */
export function AddWorkout({
  revision,
  onDone,
  onCancel,
}: {
  revision: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<NewWorkoutMode>('choose');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    try {
      setReport(await readCsv(file));
      setMode('import-review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read.');
    }
  }

  return (
    <div className="mx-auto w-full px-4 pb-10 md:max-w-2xl safe-t">
      <header className="flex items-start justify-between gap-3 py-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-100">Add a workout</h2>
          <p className="mt-1 text-sm text-slate-400">
            Its own plan, its own history. Nothing you already have is touched.
          </p>
        </div>
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
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
            <h3 className="text-lg font-semibold text-slate-100">From a max test</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
              One rested set to failure, then a target to build toward.
            </p>
            <Button className="mt-4 w-full" onClick={() => setMode('fresh')}>
              Take a max test
            </Button>
          </Card>

          <CsvDropCard
            title="From another CSV"
            blurb="If you have history for this exercise in your old app too, import it the same way."
            onFile={(file) => void handleFile(file)}
          />
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
              await createFromImport(
                report,
                baselineValue,
                accepted,
                goal,
                weeks,
                daysPerWeek,
                revision,
              );
              onDone();
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
          defaultLabel=""
          onBack={() => setMode('choose')}
          onConfirm={async (label, testedMax, goal, weeks, daysPerWeek) => {
            setBusy(true);
            setError(null);
            try {
              await createFromMaxTest(label, testedMax, goal, weeks, daysPerWeek, revision);
              onDone();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'The workout could not be created.');
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}
