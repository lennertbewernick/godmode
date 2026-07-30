/**
 * App shell: loads state, routes between screens, and owns the write paths.
 *
 * More than one exercise can be on the go at once. The shell resolves which challenge is
 * showing (a stored preference with a fall-back), and everything below it is scoped to that
 * one challenge's chain.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdjustmentType, WorkoutPerformance } from '../core/types.js';
import {
  backupFilename,
  backupIsEmpty,
  buildBackup,
  buildCsv,
  csvFilename,
  downloadFile,
  mergeBackup,
  previewMergeBackup,
  restoreBackup,
  shouldPromptBackup,
} from '../data/exchange.js';
import type { MergePlan } from '../data/merge.js';
import {
  countAllWorkouts,
  countAttempts,
  deleteDraft,
  endChallenge,
  exerciseLabels,
  getCurrentSlot,
  getDB,
  getSettings,
  listActiveChallenges,
  listDrafts,
  listSlots,
  listWorkouts,
  logWorkout,
  newId,
  resolveSelectedChallenge,
  saveDraft,
  saveSettings,
  startNextBlock,
} from '../db/repo.js';
import type {
  ChallengeRecord,
  DatabaseConflict,
  PlanSlotRecord,
  SettingsRecord,
  WorkoutDraftRecord,
  WorkoutRecord,
} from '../db/schema.js';
import { onDatabaseConflict } from '../db/schema.js';
import { ExportSheet } from './ExportSheet.js';
import { History } from './History.js';
import { RestoreDialog } from './RestoreDialog.js';
import { Runner } from './Runner.js';
import { LeaveRunnerDialog, ResumeDialog } from './ResumeDialog.js';
import { Settings } from './Settings.js';
import { Today } from './Today.js';
import { AddWorkout, Welcome } from './Welcome.js';
import { chooseDraftOffer, draftProgress, newDraft } from './draft.js';
import { TABS, shouldShowWorkoutBar, type Tab } from './nav.js';
import { buildShareCard, toStatWorkouts } from './shareCardData.js';
import { Banner, Button, Card, NumberField, Segmented, Spinner } from './kit.js';
// The update seam only. Nothing here imports ../pwa/lifecycle.js: that module owns the
// `virtual:pwa-register` import, which does not resolve under Vitest, and pulling it into this
// file's module graph would take every App test down with it.
import { shouldOfferUpdate } from '../pwa/policy.js';
import { applyUpdate, subscribeUpdateReady } from '../pwa/updateStore.js';

type View =
  | { kind: 'tab'; tab: Tab }
  | { kind: 'runner' }
  | { kind: 'continue' }
  | { kind: 'add-workout' };

const TAB_KEY = 'godmode.tab';

/**
 * Whether the workout row offers "add a workout".
 *
 * Off deliberately, 2026-07-30. Everything behind this flag works — the flow builds a real
 * challenge — but it can only ever build ONE shape of plan: `percentage-ramp`, parameterised by
 * goal, weeks and days per week. `repo.ts` names that pattern directly rather than resolving the
 * `patternId` it already stores, and the form's fields are that pattern's parameters, not
 * universal ones. A general-looking "+" therefore promises a generality the app does not have.
 *
 * Turning this back to `true` is the whole change. What should come first is in
 * `.planning/BACKLOG.md` → "Richer workouts and plans": the pattern registry, then a second
 * pattern worth choosing between.
 *
 * While this is false there is NO way to add a second workout in the UI. That is intended and
 * was asked for — do not "fix" it without asking.
 */
const ADD_WORKOUT_ENABLED = false;

/**
 * The open tab survives a reload. localStorage rather than the settings record because it is a
 * UI position, not user data — it should not travel in a backup or overwrite the tab on another
 * device when one is restored.
 */
function storedTab(): Tab {
  try {
    const raw = window.localStorage.getItem(TAB_KEY);
    return TABS.includes(raw as Tab) ? (raw as Tab) : 'today';
  } catch {
    // Private mode, or storage disabled. Not worth failing over.
    return 'today';
  }
}

/**
 * How often the plan expects you to train, from the challenge's own pattern params.
 *
 * `patternParams` is deliberately an opaque record — a future pattern will not share the
 * percentage ramp's fields — so this reads defensively rather than casting.
 */
function daysPerWeek(challenge: ChallengeRecord): number {
  const raw = challenge.patternParams['daysPerWeek'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 3;
}

function rememberTab(tab: Tab): void {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Ignored, as above.
  }
}

interface State {
  /** Every active challenge, so the switcher can list them. */
  active: ChallengeRecord[];
  challenge: ChallengeRecord | undefined;
  labels: Map<string, string>;
  slots: PlanSlotRecord[];
  workouts: WorkoutRecord[];
  currentSlot: PlanSlotRecord | undefined;
  attemptNo: number;
  settings: SettingsRecord;
  exerciseLabel: string;
  /** Across every exercise and every ended chain — durability is a whole-database property. */
  totalWorkouts: number;
  /** In-progress workouts found on this device. Normally none, or exactly one. */
  drafts: WorkoutDraftRecord[];
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<View>(() => ({ kind: 'tab', tab: storedTab() }));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The session the runner is driving. Its `id` is the id the workout will be logged under. */
  const [run, setRun] = useState<WorkoutDraftRecord | null>(null);
  /** A draft the user has been shown and left alone. Offering it again on every render would nag. */
  const [dismissedDraftId, setDismissedDraftId] = useState<string | null>(null);
  const [leavePrompt, setLeavePrompt] = useState(false);
  /** Writing the draft is failing. The runner says so rather than promising a durability it has lost. */
  const [draftBroken, setDraftBroken] = useState(false);
  /** The last save attempt threw. The runner re-arms its save button on this. */
  const [saveFailed, setSaveFailed] = useState(false);
  const [dbConflict, setDbConflict] = useState<DatabaseConflict | null>(null);
  /**
   * A chosen backup file, read and planned but not applied. Holding the parsed file alongside
   * the plan is what lets the confirmed action work from the file itself — `mergeBackup` plans
   * again inside its own write transaction, so what is shown here is a report, never a
   * commitment.
   */
  const [restorePrompt, setRestorePrompt] = useState<{
    plan: MergePlan;
    parsed: unknown;
    fileName: string;
  } | null>(null);
  const [backupDismissed, setBackupDismissed] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);

  const load = useCallback(async () => {
    const [active, challenge, settings, totalWorkouts, drafts] = await Promise.all([
      listActiveChallenges(),
      resolveSelectedChallenge(),
      getSettings(),
      countAllWorkouts(),
      listDrafts(),
    ]);
    const labels = await exerciseLabels(active);

    if (!challenge) {
      setState({
        active,
        challenge: undefined,
        labels,
        slots: [],
        workouts: [],
        currentSlot: undefined,
        attemptNo: 1,
        settings,
        exerciseLabel: '',
        totalWorkouts,
        drafts,
      });
      return;
    }

    const [slots, workouts, currentSlot] = await Promise.all([
      listSlots(challenge.id),
      listWorkouts(challenge.chainId),
      getCurrentSlot(challenge.id),
    ]);
    const attemptNo = currentSlot ? (await countAttempts(currentSlot.id)) + 1 : 1;

    setState({
      active,
      challenge,
      labels,
      slots,
      workouts,
      currentSlot,
      attemptNo,
      settings,
      exerciseLabel: labels.get(challenge.exerciseId) ?? 'Exercise',
      totalWorkouts,
      drafts,
    });
  }, []);

  useEffect(() => {
    void load().catch((e) =>
      setError(e instanceof Error ? e.message : 'Could not open your data.'),
    );
  }, [load]);

  // Fires immediately with the current value, so an update that landed before React mounted
  // is not lost.
  useEffect(() => subscribeUpdateReady(setUpdateReady), []);

  // Two tabs disagreeing about the database version. Nothing is done about it automatically —
  // closing this tab's connection could interrupt a workout — but the user is told, because
  // otherwise the other tab simply appears to hang on a blank screen.
  useEffect(() => onDatabaseConflict(setDbConflict), []);

  /**
   * Is there a workout to pick back up?
   *
   * Computed rather than stored, so it cannot go stale behind a refresh of the app's state.
   * Two filters do the work, and both are needed: the draft must belong to the session on
   * screen, and its id must not already be a logged workout. The second is what actually stops
   * a draft offering to redo finished work — see `chooseDraftOffer`.
   */
  const offer = useMemo(
    () =>
      chooseDraftOffer({
        drafts: state?.drafts ?? [],
        currentSlot: state?.currentSlot,
        // A draft whose workout is already in the history describes finished work. Matching
        // the current slot does not rule that out: a failed attempt leaves its slot current.
        loggedWorkoutIds: new Set((state?.workouts ?? []).map((w) => w.id)),
        nowMs: Date.now(),
      }),
    [state],
  );

  /**
   * Write the in-progress workout.
   *
   * A failure here is reported, never thrown: the workout carries on in memory, exactly as it
   * always used to, and the runner tells the user that closing the app would now cost them the
   * session.
   */
  const persistDraft = useCallback(async (draft: WorkoutDraftRecord) => {
    try {
      await saveDraft(draft);
      setDraftBroken(false);
    } catch {
      setDraftBroken(true);
    }
    // Keep the shell's copy in step with the runner's, so the "leave this workout?" dialog
    // counts the reps that are actually on disk. Guarded on the id: a write that lands after
    // the workout was saved must not put the session back on screen.
    setRun((prev) => (prev !== null && prev.id === draft.id ? draft : prev));
  }, []);

  const startRun = useCallback(
    async (targets: number[], adjustment: AdjustmentType) => {
      if (!state?.challenge || !state.currentSlot) return;
      // The workout's id is minted here, before a single rep is recorded, and it travels with
      // the draft all the way to `logWorkout`. That is what makes saving idempotent.
      const draft = newDraft({
        id: newId('wo'),
        challengeId: state.challenge.id,
        chainId: state.challenge.chainId,
        slot: state.currentSlot,
        attemptNo: state.attemptNo,
        effectiveTargets: targets,
        adjustmentType: adjustment,
        restOverrideSeconds: state.settings.restOverrideSeconds,
        nowMs: Date.now(),
      });
      setDraftBroken(false);
      setSaveFailed(false);
      await persistDraft(draft);
      setRun(draft);
      setMessage(null);
      setView({ kind: 'runner' });
    },
    [state, persistDraft],
  );

  const resumeRun = useCallback((draft: WorkoutDraftRecord) => {
    setDismissedDraftId(null);
    setDraftBroken(false);
    setSaveFailed(false);
    setRun(draft);
    setMessage(null);
    setView({ kind: 'runner' });
  }, []);

  const discardRun = useCallback(
    async (draft: WorkoutDraftRecord) => {
      await deleteDraft(draft.id);
      setRun(null);
      setLeavePrompt(false);
      setDismissedDraftId(null);
      setView({ kind: 'tab', tab: 'today' });
      await load();
      setMessage('That workout was discarded. Nothing was added to your history.');
    },
    [load],
  );

  /**
   * The card's data, assembled from state the shell already holds. Built here rather than in
   * the sheet so the sheet stays a menu and the card stays a pure function of the history.
   */
  const card = useMemo(() => {
    if (!state?.challenge) return undefined;
    return buildShareCard({
      exerciseLabel: state.exerciseLabel,
      workouts: toStatWorkouts(state.workouts),
      slots: state.slots.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        targetTotal: s.targetTotal,
        status: s.status,
      })),
      daysPerWeek: daysPerWeek(state.challenge),
    });
  }, [state]);

  const goToTab = useCallback((tab: Tab) => {
    rememberTab(tab);
    setView({ kind: 'tab', tab });
  }, []);

  const selectChallenge = useCallback(
    async (challengeId: string) => {
      await saveSettings({ selectedChallengeId: challengeId });
      setMessage(null);
      await load();
    },
    [load],
  );

  const exportJson = useCallback(async () => {
    const backup = await buildBackup();
    // Name it from the very data being written, so the breadth in the filename cannot drift
    // from the breadth in the file.
    downloadFile(
      backupFilename(backup.exercises.map((e) => e.label)),
      JSON.stringify(backup, null, 2),
      'application/json',
    );
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
    downloadFile(csvFilename(state.exerciseLabel), csv, 'text/csv');
  }, [state]);

  const handleRestore = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const parsed = JSON.parse(await file.text());

        // A well-formed but empty backup landing on a device that has history is almost
        // always the wrong file, and restore is not undoable — it clears every store first.
        if (backupIsEmpty(parsed) && (state?.totalWorkouts ?? 0) > 0) {
          setError(
            'That backup contains no sessions, and this device has history that restoring ' +
              'would erase. Nothing has been changed. Check you picked the right file.',
          );
          return;
        }

        // Read and counted, written nowhere. The choice between adding and replacing belongs
        // to the user, and it cannot be made honestly without these numbers.
        const plan = await previewMergeBackup(parsed);
        setRestorePrompt({ plan, parsed, fileName: file.name });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That backup could not be restored.');
      }
    },
    [state],
  );

  const applyMerge = useCallback(async () => {
    if (!restorePrompt) return;
    setError(null);
    try {
      const result = await mergeBackup(restorePrompt.parsed);
      setRestorePrompt(null);
      await load();
      goToTab('today');
      // A silent "done" would defeat the point of showing the preview, so the numbers that
      // actually landed are reported — including the ones that did not.
      const parts = [
        result.totals.added === 0
          ? 'Nothing new in that backup — everything in it was already here.'
          : `Added ${result.totals.added} record(s). Nothing here was changed or removed.`,
      ];
      if (result.totals.skipped > 0) {
        parts.push(
          `${result.totals.skipped} were left out: they point at something neither this ` +
            'device nor the file has.',
        );
      }
      if (result.totals.divergent > 0) {
        parts.push(
          `${result.totals.divergent} exist here in a different version; this device's copy ` +
            'was kept.',
        );
      }
      setMessage(parts.join(' '));
    } catch (e) {
      setRestorePrompt(null);
      setError(e instanceof Error ? e.message : 'That backup could not be merged.');
    }
  }, [restorePrompt, load, goToTab]);

  const applyReplace = useCallback(async () => {
    if (!restorePrompt) return;
    setError(null);
    try {
      const result = await restoreBackup(restorePrompt.parsed);
      setRestorePrompt(null);
      await load();
      goToTab('today');
      setMessage(
        `Restored ${result.workouts} sessions across ${result.challenges} challenge(s).`,
      );
    } catch (e) {
      setRestorePrompt(null);
      setError(e instanceof Error ? e.message : 'That backup could not be restored.');
    }
  }, [restorePrompt, load, goToTab]);

  const finishWorkout = useCallback(
    async (
      performance: WorkoutPerformance,
      durationSeconds: number,
      options: { manual?: boolean; workoutId?: string } = {},
    ) => {
      if (!state?.challenge || !state.currentSlot) return;
      setSaveFailed(false);
      try {
        // `logWorkout` deletes the draft in the same transaction that writes the workout, so
        // there is no window in which the session exists twice or not at all. Passing the
        // draft's id also makes a retry safe: the second attempt finds the first one's row and
        // returns it rather than logging the session again.
        const { evaluation } = await logWorkout({
          challenge: state.challenge,
          slot: state.currentSlot,
          performance,
          durationSeconds,
          manuallyAdvance: options.manual === true,
          ...(options.workoutId === undefined ? {} : { workoutId: options.workoutId }),
        });
        setRun(null);
        goToTab('today');
        setMessage(evaluation.reason);
      } catch (e) {
        // The runner stays where it is, with its numbers, and its save button comes back. The
        // draft is still on the device — the failed transaction did not delete it.
        setSaveFailed(true);
        setError(
          e instanceof Error
            ? `That workout was not saved: ${e.message} Your reps are still here — try again.`
            : 'That workout was not saved. Your reps are still here — try again.',
        );
        return;
      }
      await load();
    },
    [state, load, goToTab],
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
      { manual: true },
    );
  }, [state, finishWorkout]);

  const endWorkout = useCallback(
    async (challengeId: string) => {
      await endChallenge(challengeId, 'closed_manually');
      // The ended one may have been the selection; clear it and let the fall-back choose.
      const settings = await getSettings();
      if (settings.selectedChallengeId === challengeId) {
        await saveSettings({ selectedChallengeId: undefined });
      }
      await load();
      setMessage('Workout ended. Its history stays in your backups.');
    },
    [load],
  );

  if (error && !state) {
    return (
      <div className="mx-auto w-full px-4 py-10 md:max-w-lg">
        <Banner tone="warn">{error}</Banner>
      </div>
    );
  }
  if (!state) return <Spinner label="Loading…" />;

  if (!state.challenge) {
    return <Welcome onReady={() => void load()} />;
  }

  if (view.kind === 'runner' && state.currentSlot && run) {
    return (
      <>
        <Runner
          // Keyed by the workout id so resuming a different session remounts rather than
          // reusing the previous one's frozen prescription.
          key={run.id}
          draft={run}
          slot={state.currentSlot}
          persistFailed={draftBroken}
          saveFailed={saveFailed}
          onPersist={(draft) => void persistDraft(draft)}
          onFinish={(performance, duration) =>
            void finishWorkout(performance, duration, { workoutId: run.id })
          }
          onCancel={() => setLeavePrompt(true)}
        />
        {error ? (
          <div className="fixed inset-x-0 bottom-0 mx-auto w-full px-4 pb-4 md:max-w-lg safe-b">
            <Banner tone="warn" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </div>
        ) : null}
        {leavePrompt ? (
          <LeaveRunnerDialog
            progress={draftProgress(run)}
            onStay={() => setLeavePrompt(false)}
            onKeep={() => {
              setLeavePrompt(false);
              setRun(null);
              // Shown once and left alone: Today's Start button brings the offer back.
              setDismissedDraftId(run.id);
              goToTab('today');
              void load();
            }}
            onDiscard={() => void discardRun(run)}
          />
        ) : null}
      </>
    );
  }

  if (view.kind === 'add-workout') {
    return (
      <AddWorkout
        onCancel={() => goToTab('today')}
        onDone={() => {
          goToTab('today');
          setMessage('Workout added.');
          void load();
        }}
      />
    );
  }

  if (view.kind === 'continue') {
    return (
      <ContinueBlock
        challenge={state.challenge}
        workouts={state.workouts}
        onCancel={() => goToTab('today')}
        onConfirm={async (baselineValue, tested, goal, weeks, daysPerWeek) => {
          // One transaction: ending the old block, recording the max test, creating the
          // successor and its slots, and moving the selection all land together or not at all.
          try {
            await startNextBlock({
              previous: state.challenge!,
              strategy: tested ? 'retest' : 'user_entered',
              baselineValue,
              goalValue: goal,
              weeks,
              daysPerWeek,
              tested,
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : 'The next block could not be started.');
            return;
          }
          goToTab('today');
          setMessage('New block started.');
          await load();
        }}
      />
    );
  }

  const activeTab = view.kind === 'tab' ? view.tab : 'today';
  const showBackupNag =
    !backupDismissed && shouldPromptBackup(state.settings, state.totalWorkouts);

  const tabOptions = TABS.map((tab) => ({
    value: tab,
    label: <span className="capitalize">{tab}</span>,
  }));

  return (
    <div className="mx-auto flex min-h-screen w-full flex-col px-4 md:max-w-3xl lg:max-w-6xl safe-t">
      <header className="flex items-center justify-between gap-3 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-slate-100">
          GODMODE
          <span className="ml-2 text-xs font-normal uppercase tracking-[0.18em] text-teal-300">
            No More Later
          </span>
        </h1>

        {/*
          Below md this wrapper holds only the share icon, so it lands top-right on a phone;
          from md up the tab row sits beside it. The sheet it opens is a bottom sheet, which is
          what puts the actions back under the thumb.
        */}
        <div className="flex items-center gap-2">
          {/* Desktop keeps navigation at the top; the phone keeps it under the thumb. */}
          <nav className="hidden md:block">
            <Segmented
              ariaLabel="Sections"
              value={activeTab}
              onChange={goToTab}
              options={tabOptions}
            />
          </nav>
          <Button
            variant="subtle"
            ariaLabel="Share and export"
            className="min-h-11 px-2"
            onClick={() => setShareOpen(true)}
          >
            <ShareGlyph />
          </Button>
        </div>
      </header>

      {shouldShowWorkoutBar({ tab: activeTab, activeCount: state.active.length }) ? (
        <div className="pb-3">
          <WorkoutBar
            active={state.active}
            labels={state.labels}
            selectedId={state.challenge.id}
            onSelect={(id) => void selectChallenge(id)}
            onAddWorkout={() => setView({ kind: 'add-workout' })}
          />
        </div>
      ) : null}

      {error ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {/*
        Two tabs, two versions of the app. Nothing is closed or reloaded automatically — a
        workout could be running in either one — so the only honest thing to do is name it.
      */}
      {dbConflict !== null ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setDbConflict(null)}>
            {dbConflict === 'blocked'
              ? 'This app is open in another tab on an older version. Close that tab and reload here.'
              : 'Another tab is waiting to update this app. Close this one when you are finished.'}
          </Banner>
        </div>
      ) : null}

      {/*
        This app never reloads itself. Runner.tsx now persists a draft as it goes, so a reload
        no longer destroys the reps — but it still throws away the running session: the rest
        clock, the set the user is standing in, and anything typed but not yet committed. The
        reload is always the user's tap.

        `workoutInProgress` is passed even though this render site already sits after the
        `view.kind === 'runner'` early return, so the banner is structurally unreachable during
        a workout. Stating the guarantee in code — and pinning it in policy.test.ts — is worth
        more than trusting the ordering of early returns in a 700-line file to stay put.

        No onDismiss: a dismissed update is an update the user never gets, and this app is
        handed out once as a link.
      */}
      {shouldOfferUpdate({ updateReady, workoutInProgress: view.kind === 'runner' }) ? (
        <div className="pb-3">
          <Banner tone="info">
            A newer version is ready.{' '}
            <button type="button" className="underline" onClick={() => applyUpdate()}>
              Reload to update
            </button>
            .
          </Banner>
        </div>
      ) : null}

      {showBackupNag ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setBackupDismissed(true)}>
            No backup yet.{' '}
            <button type="button" className="underline" onClick={() => void exportJson()}>
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
              // An unfinished session for this very day is not something to start over
              // silently. Put the choice back in front of the user instead.
              if (offer.kind === 'offer') {
                setDismissedDraftId(null);
                return;
              }
              void startRun(targets, adjustment);
            }}
            onAdvanceManually={() => void advanceManually()}
            onContinueChain={() => setView({ kind: 'continue' })}
            onShare={() => setShareOpen(true)}
          />
        ) : null}

        {activeTab === 'history' ? (
          <History
            workouts={state.workouts}
            slots={state.slots}
            exerciseLabel={state.exerciseLabel}
            scopedToOneWorkout={state.active.length > 1}
            daysPerWeek={daysPerWeek(state.challenge)}
            onShare={() => setShareOpen(true)}
          />
        ) : null}

        {activeTab === 'settings' ? (
          <Settings
            settings={state.settings}
            exerciseLabel={state.exerciseLabel}
            workoutCount={state.workouts.length}
            active={state.active}
            labels={state.labels}
            onEndWorkout={(id) => void endWorkout(id)}
            onSave={(patch) => {
              void saveSettings(patch).then(() => {
                void load();
                setMessage('Saved.');
              });
            }}
            onOpenExport={() => setShareOpen(true)}
            onRestoreFile={(file) => void handleRestore(file)}
            onResetAll={() => void wipeAll().then(() => window.location.reload())}
          />
        ) : null}
      </main>

      <nav className="sticky bottom-0 -mx-4 border-t border-[#26324b] bg-[#0b1220]/95 px-4 backdrop-blur md:hidden safe-b">
        <div className="flex gap-1 pt-2">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => goToTab(tab)}
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

      {/*
        The recovered workout. Offered, never applied — and offered here, over Today, rather
        than by dropping the user into a runner they did not ask for.
      */}
      {offer.kind === 'offer' && offer.draft.id !== dismissedDraftId && !restorePrompt ? (
        <ResumeDialog
          draft={offer.draft}
          progress={offer.progress}
          stale={offer.stale}
          nowMs={Date.now()}
          onResume={() => resumeRun(offer.draft)}
          onDiscard={() => void discardRun(offer.draft)}
          onDismiss={() => setDismissedDraftId(offer.draft.id)}
        />
      ) : null}

      {restorePrompt ? (
        <RestoreDialog
          plan={restorePrompt.plan}
          fileName={restorePrompt.fileName}
          onMerge={() => void applyMerge()}
          onReplace={() => void applyReplace()}
          onCancel={() => setRestorePrompt(null)}
        />
      ) : null}

      {shareOpen ? (
        <ExportSheet
          onClose={() => setShareOpen(false)}
          onExportCsv={exportCsv}
          onExportJson={() => void exportJson()}
          canExportCsv={state.challenge !== undefined}
          {...(card === undefined ? {} : { card })}
        />
      ) : null}
    </div>
  );
}

/**
 * Three nodes, two strokes. Drawn inline rather than pulled from an icon set — this app has no
 * icon dependency and is not acquiring one for a single glyph.
 */
function ShareGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.8 15.8 6.5" />
      <path d="M8.2 13.2 15.8 17.5" />
    </svg>
  );
}

/** Two strokes. Drawn inline, for the same reason as ShareGlyph. */
function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/**
 * A chip per active workout, plus the app's only "add a workout" control.
 *
 * Renders from one workout upward — not only when there is a choice to make — precisely
 * because it hosts that control: hiding the row from a user with a single workout would leave
 * them no route to a second. With one workout the chip stays and the `+` sits beside it. A
 * bare `+` floating above the content would name nothing, and the row's layout would jump the
 * instant a second workout appeared.
 *
 * The add button is a *sibling* of the tablist, never a child. A non-tab inside
 * `role="tablist"` is invalid ARIA and misreads to assistive tech.
 */
function WorkoutBar({
  active,
  labels,
  selectedId,
  onSelect,
  onAddWorkout,
}: {
  active: ChallengeRecord[];
  labels: Map<string, string>;
  selectedId: string;
  onSelect: (challengeId: string) => void;
  onAddWorkout: () => void;
}) {
  // items-stretch, not items-center, and it is there for the add button specifically: that
  // button has no line box of its own, so it would sit at its min-h-9 floor while the chips are
  // pushed past it by their 24px line box. Stretching lets it inherit whatever height the chips
  // settle at instead of restating it. With ADD_WORKOUT_ENABLED false the row is chips only and
  // this makes no visible difference — it is kept so re-enabling the button stays a one-word
  // change rather than a one-word change plus a layout regression.
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Workout">
        {active.map((challenge) => {
          const isSelected = challenge.id === selectedId;
          return (
            <button
              key={challenge.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => onSelect(challenge.id)}
              className={[
                'min-h-9 rounded-xl border px-3 py-1.5 text-sm transition-colors',
                isSelected
                  ? 'border-teal-400/50 bg-teal-300/10 font-semibold text-teal-200'
                  : 'border-[#33405c] text-slate-300 hover:bg-[#1c2740]',
              ].join(' ')}
            >
              {labels.get(challenge.exerciseId) ?? 'Exercise'}
            </button>
          );
        })}
      </div>

      {/*
        Deliberately a plain button carrying the chip's own geometry rather than the kit Button:
        it sits in the chip row and should read as one of them. Its own inline-flex centres the
        glyph inside the height the row hands it. It stays outside the tablist — it selects
        nothing. If the chips wrap, this drops to its own flex line rather than stretching to
        the wrapped block, which is why stretching is safe here.

        Hidden while ADD_WORKOUT_ENABLED is false — see the flag for why, and note that the
        markup is kept rather than deleted so restoring it costs nothing.
      */}
      {ADD_WORKOUT_ENABLED ? (
        <button
          type="button"
          aria-label="Add a workout"
          onClick={onAddWorkout}
          className="inline-flex min-h-9 items-center justify-center rounded-xl border border-[#33405c] px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-[#1c2740]"
        >
          <PlusGlyph />
        </button>
      ) : null}
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
    'workoutDrafts',
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
    <div className="mx-auto w-full px-4 pb-10 md:max-w-2xl safe-t">
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
