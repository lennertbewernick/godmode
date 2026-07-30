/**
 * App shell: loads state, routes between screens, and owns the write paths.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdjustmentType, WorkoutPerformance } from '../core/types.js';
import {
  backupFilename,
  buildBackup,
  buildCsv,
  csvFilename,
  downloadFile,
  restoreBackup,
  shouldPromptBackup,
} from '../data/exchange.js';
import {
  continueChallenge,
  countAttempts,
  endChallenge,
  getActiveChallenge,
  getCurrentSlot,
  getDB,
  getSettings,
  listSlots,
  listWorkouts,
  logWorkout,
  recordMaxTest,
  saveSettings,
} from '../db/repo.js';
import type {
  ChallengeRecord,
  PlanSlotRecord,
  SettingsRecord,
  WorkoutRecord,
} from '../db/schema.js';
import { History } from './History.js';
import { Runner } from './Runner.js';
import { Settings } from './Settings.js';
import { Today } from './Today.js';
import { Welcome } from './Welcome.js';
import { Banner, Button, Card, NumberField, Spinner } from './kit.js';

type Tab = 'today' | 'history' | 'settings';
type View = { kind: 'tab'; tab: Tab } | { kind: 'runner' } | { kind: 'continue' };

interface State {
  challenge: ChallengeRecord | undefined;
  slots: PlanSlotRecord[];
  workouts: WorkoutRecord[];
  currentSlot: PlanSlotRecord | undefined;
  attemptNo: number;
  settings: SettingsRecord;
  exerciseLabel: string;
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<View>({ kind: 'tab', tab: 'today' });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runConfig, setRunConfig] = useState<{
    targets: number[];
    adjustment: AdjustmentType;
  } | null>(null);
  const [backupDismissed, setBackupDismissed] = useState(false);

  const load = useCallback(async () => {
    const challenge = await getActiveChallenge();
    const settings = await getSettings();

    if (!challenge) {
      setState({
        challenge: undefined,
        slots: [],
        workouts: [],
        currentSlot: undefined,
        attemptNo: 1,
        settings,
        exerciseLabel: '',
      });
      return;
    }

    const [slots, workouts, currentSlot] = await Promise.all([
      listSlots(challenge.id),
      listWorkouts(challenge.chainId),
      getCurrentSlot(challenge.id),
    ]);
    const attemptNo = currentSlot ? (await countAttempts(currentSlot.id)) + 1 : 1;
    const db = await getDB();
    const exercise = await db.get('exercises', challenge.exerciseId);

    setState({
      challenge,
      slots,
      workouts,
      currentSlot,
      attemptNo,
      settings,
      exerciseLabel: exercise?.label ?? 'Exercise',
    });
  }, []);

  useEffect(() => {
    void load().catch((e) =>
      setError(e instanceof Error ? e.message : 'Could not open your data.'),
    );
  }, [load]);

  const exportJson = useCallback(async () => {
    const backup = await buildBackup();
    downloadFile(backupFilename(), JSON.stringify(backup, null, 2), 'application/json');
    await saveSettings({ lastBackupAt: new Date().toISOString() });
    setBackupDismissed(true);
    await load();
    setMessage('Backup exported.');
  }, [load]);

  const exportCsv = useCallback(() => {
    if (!state?.challenge) return;
    const csv = buildCsv({
      exerciseLabel: state.exerciseLabel,
      goal: state.challenge.goalValue,
      challengeLength: `${state.slots.length} sessions`,
      workouts: state.workouts,
      slotsById: new Map(state.slots.map((s) => [s.id, s])),
    });
    downloadFile(csvFilename(), csv, 'text/csv');
  }, [state]);

  const handleRestore = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const result = await restoreBackup(JSON.parse(await file.text()));
        await load();
        setView({ kind: 'tab', tab: 'today' });
        setMessage(
          `Restored ${result.workouts} sessions across ${result.challenges} challenge(s).`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That backup could not be restored.');
      }
    },
    [load],
  );

  const finishWorkout = useCallback(
    async (performance: WorkoutPerformance, durationSeconds: number, manual = false) => {
      if (!state?.challenge || !state.currentSlot) return;
      const { evaluation } = await logWorkout({
        challenge: state.challenge,
        slot: state.currentSlot,
        performance,
        durationSeconds,
        manuallyAdvance: manual,
      });
      setRunConfig(null);
      setView({ kind: 'tab', tab: 'today' });
      setMessage(evaluation.reason);
      await load();
    },
    [state, load],
  );

  const advanceManually = useCallback(async () => {
    if (!state?.currentSlot) return;
    const targets = state.currentSlot.targets.map((t) => t.reps);
    await finishWorkout(
      {
        sets: targets.map((t, i) => ({ index: i + 1, effectiveTarget: t, actual: 0 })),
        actualTotal: 0,
        adjustmentType: 'none',
        effectiveTotal: state.currentSlot.targetTotal,
      },
      0,
      true,
    );
  }, [state, finishWorkout]);

  if (error && !state) {
    return (
      <div className="mx-auto max-w-lg px-4 py-10">
        <Banner tone="warn">{error}</Banner>
      </div>
    );
  }
  if (!state) return <Spinner label="Loading…" />;

  if (!state.challenge) {
    return <Welcome onReady={() => void load()} />;
  }

  if (view.kind === 'runner' && state.currentSlot && runConfig) {
    return (
      <Runner
        slot={state.currentSlot}
        attemptNo={state.attemptNo}
        effectiveTargets={runConfig.targets}
        adjustmentType={runConfig.adjustment}
        {...(state.settings.restOverrideSeconds === undefined
          ? {}
          : { restOverrideSeconds: state.settings.restOverrideSeconds })}
        onFinish={(performance, duration) => void finishWorkout(performance, duration)}
        onCancel={() => {
          setRunConfig(null);
          setView({ kind: 'tab', tab: 'today' });
        }}
      />
    );
  }

  if (view.kind === 'continue') {
    return (
      <ContinueBlock
        challenge={state.challenge}
        workouts={state.workouts}
        onCancel={() => setView({ kind: 'tab', tab: 'today' })}
        onConfirm={async (baselineValue, tested, goal, weeks, daysPerWeek) => {
          const challenge = state.challenge!;
          await endChallenge(challenge.id, 'closed_manually');
          const evidence = tested
            ? await recordMaxTest(challenge.exerciseId, baselineValue)
            : undefined;
          await continueChallenge({
            previous: challenge,
            strategy: tested ? 'retest' : 'user_entered',
            baselineValue,
            goalValue: goal,
            weeks,
            daysPerWeek,
            ...(evidence === undefined ? {} : { evidenceId: evidence.id }),
          });
          setView({ kind: 'tab', tab: 'today' });
          setMessage('New block started.');
          await load();
        }}
      />
    );
  }

  const activeTab = view.kind === 'tab' ? view.tab : 'today';

  const showBackupNag =
    !backupDismissed && shouldPromptBackup(state.settings, state.workouts.length);

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col px-4 safe-t">
      <header className="flex items-baseline justify-between gap-3 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-slate-100">
          GODMODE
          <span className="ml-2 text-xs font-normal uppercase tracking-[0.18em] text-teal-300">
            No More Later
          </span>
        </h1>
      </header>

      {error ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {showBackupNag ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setBackupDismissed(true)}>
            No backup yet.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => void exportJson()}
            >
              Export a backup
            </button>
            .
          </Banner>
        </div>
      ) : null}

      <main className="flex-1 pb-4">
        {activeTab === 'today' ? (
          <Today
            challenge={state.challenge}
            slot={state.currentSlot}
            attemptNo={state.attemptNo}
            exerciseLabel={state.exerciseLabel}
            slotsAdvanced={state.slots.filter((s) => s.status === 'completed').length}
            slotsTotal={state.slots.length}
            lastMessage={message}
            onDismissMessage={() => setMessage(null)}
            onStart={(targets, adjustment) => {
              setRunConfig({ targets, adjustment });
              setMessage(null);
              setView({ kind: 'runner' });
            }}
            onAdvanceManually={() => void advanceManually()}
            onContinueChain={() => setView({ kind: 'continue' })}
          />
        ) : null}

        {activeTab === 'history' ? (
          <History
            workouts={state.workouts}
            slots={state.slots}
            onExportCsv={exportCsv}
            onExportJson={() => void exportJson()}
          />
        ) : null}

        {activeTab === 'settings' ? (
          <Settings
            settings={state.settings}
            exerciseLabel={state.exerciseLabel}
            workoutCount={state.workouts.length}
            onSave={(patch) => {
              void saveSettings(patch).then(() => {
                void load();
                setMessage('Saved.');
              });
            }}
            onExportJson={() => void exportJson()}
            onExportCsv={exportCsv}
            onRestore={(file) => void handleRestore(file)}
            onResetAll={() => void wipeAll().then(() => window.location.reload())}
          />
        ) : null}
      </main>

      <nav className="sticky bottom-0 -mx-4 border-t border-[#26324b] bg-[#0b1220]/95 px-4 backdrop-blur safe-b">
        <div className="flex gap-1 pt-2">
          {(['today', 'history', 'settings'] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setView({ kind: 'tab', tab })}
              className={[
                'min-h-11 flex-1 rounded-xl py-2 text-sm capitalize transition-colors',
                activeTab === tab
                  ? 'bg-[#1c2740] font-semibold text-teal-300'
                  : 'text-slate-400 hover:text-slate-200',
              ].join(' ')}
            >
              {tab}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

async function wipeAll(): Promise<void> {
  const db = await getDB();
  const stores = [
    'exercises',
    'challenges',
    'performanceTests',
    'planSlots',
    'workouts',
    'settings',
  ] as const;
  const tx = db.transaction(stores, 'readwrite');
  for (const store of stores) await tx.objectStore(store).clear();
  await tx.done;
}

function ContinueBlock({
  challenge,
  workouts,
  onCancel,
  onConfirm,
}: {
  challenge: ChallengeRecord;
  workouts: WorkoutRecord[];
  onCancel: () => void;
  onConfirm: (
    baseline: number,
    tested: boolean,
    goal: number,
    weeks: number,
    daysPerWeek: number,
  ) => void;
}) {
  const bestAmrap = useMemo(() => {
    let best = 0;
    for (const w of workouts) {
      for (const s of w.sets) best = Math.max(best, s.actual);
    }
    return best;
  }, [workouts]);

  const [tested, setTested] = useState<number | ''>('');
  const [goal, setGoal] = useState<number | ''>((challenge.goalValue ?? 100) + 25);
  const [weeks, setWeeks] = useState<number | ''>(6);
  const [daysPerWeek, setDaysPerWeek] = useState<number | ''>(3);
  const [useTest, setUseTest] = useState(true);

  return (
    <div className="mx-auto max-w-lg px-4 pb-10 safe-t">
      <header className="py-6">
        <h2 className="text-2xl font-semibold text-slate-100">Keep going</h2>
        <p className="mt-1 text-sm text-slate-400">Your history carries over.</p>
      </header>

      <div className="flex flex-col gap-4">
        <Card>
          <h3 className="font-semibold text-slate-100">Retest your max</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
            One rested set to failure. Your best single set so far was{' '}
            <span className="tnum font-semibold text-slate-100">{bestAmrap}</span>, but that came
            at the end of a full session — rested you'll manage more.
          </p>
          <div className="mt-4">
            <NumberField
              label={useTest ? 'Rested max test result' : 'Baseline (entered by hand)'}
              value={tested}
              min={1}
              onChange={setTested}
              suffix="reps"
            />
          </div>
          <button
            type="button"
            className="mt-2 text-xs text-slate-400 underline"
            onClick={() => setUseTest((v) => !v)}
          >
            {useTest ? 'I did not test — let me just enter a number' : 'I did test this properly'}
          </button>
        </Card>

        <Card>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <NumberField label="New goal" value={goal} min={1} onChange={setGoal} suffix="reps" />
            <NumberField label="Weeks" value={weeks} min={1} onChange={setWeeks} />
            <NumberField
              label="Days / week"
              value={daysPerWeek}
              min={1}
              onChange={setDaysPerWeek}
            />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            Set the goal to match your baseline to hold steady instead of climbing.
          </p>
        </Card>

        <div className="flex gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Back
          </Button>
          <Button
            className="flex-1"
            disabled={tested === '' || goal === '' || weeks === '' || daysPerWeek === ''}
            onClick={() =>
              onConfirm(
                Number(tested),
                useTest,
                Number(goal),
                Number(weeks),
                Number(daysPerWeek),
              )
            }
          >
            Start the next block
          </Button>
        </div>
      </div>
    </div>
  );
}
