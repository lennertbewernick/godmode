/**
 * Export and restore.
 *
 * The JSON backup is the complete dataset including pattern ids/versions, policy versions,
 * chain links, baseline provenance, and generation decisions — everything needed to
 * reconstruct the database, not just a rep log. Without the versions a restore into a future
 * build could silently reinterpret history.
 *
 * The CSV export deliberately matches the incumbent's dialect so a round trip is possible and
 * so nobody is locked in here either.
 */

import { getDB } from '../db/repo.js';
import { canonicalProfileId } from '../import/profiles.js';
import { MERGE_STORES, planMerge, type MergePlan } from './merge.js';
import { DB_VERSION, DEFAULT_SETTINGS, type SettingsRecord } from '../db/schema.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  PlanSlotRecord,
  WorkoutRecord,
} from '../db/schema.js';
import type { PerformanceTest } from '../core/types.js';

// The filename builders live in their own dependency-free module so the UI can name a share
// card without importing the database. Re-exported so existing import sites keep working.
export { backupFilename, csvFilename, shareImageFilename, slugLabel } from './filenames.js';

export const BACKUP_FORMAT_VERSION = 1;

export interface BackupFile {
  format: 'godmode-backup';
  formatVersion: number;
  dbVersion: number;
  exportedAt: string;
  exercises: ExerciseRecord[];
  challenges: ChallengeRecord[];
  performanceTests: PerformanceTest[];
  planSlots: PlanSlotRecord[];
  workouts: WorkoutRecord[];
  settings: SettingsRecord;
}

export async function buildBackup(): Promise<BackupFile> {
  const db = await getDB();
  const [exercises, challenges, performanceTests, planSlots, workouts, settings] =
    await Promise.all([
      db.getAll('exercises'),
      db.getAll('challenges'),
      db.getAll('performanceTests'),
      db.getAll('planSlots'),
      db.getAll('workouts'),
      db.get('settings', 'settings'),
    ]);

  return {
    format: 'godmode-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    exercises,
    challenges,
    performanceTests,
    planSlots,
    workouts,
    settings: settings ?? DEFAULT_SETTINGS,
  };
}

export interface RestoreResult {
  exercises: number;
  challenges: number;
  planSlots: number;
  workouts: number;
  performanceTests: number;
}

/**
 * The collections a backup must carry. Absence is rejected rather than defaulted to empty:
 * restore clears the database first, so treating a missing collection as "zero records" turns
 * a truncated or hand-edited file into total, silent data loss on the only copy that exists.
 */
const REQUIRED_COLLECTIONS = [
  'exercises',
  'challenges',
  'performanceTests',
  'planSlots',
  'workouts',
] as const;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject anything that is not a structurally intact backup, before the database is touched.
 *
 * This is deliberately more than a header check. A file carrying only
 * `{"format":"godmode-backup","formatVersion":1}` is well-formed JSON and passes any
 * header-only guard, and restoring it would clear every store and commit successfully.
 */
export function validateBackup(json: unknown): BackupFile {
  if (!isRecordObject(json)) {
    throw new Error('That file is not a GodMode backup.');
  }
  const backup = json as Partial<BackupFile>;
  if (backup.format !== 'godmode-backup') {
    throw new Error('That file is not a GodMode backup.');
  }
  if (typeof backup.formatVersion !== 'number' || !Number.isFinite(backup.formatVersion)) {
    throw new Error('The backup is missing a usable format version.');
  }
  if (backup.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `That backup was written by a newer version of GodMode ` +
        `(format ${backup.formatVersion}, this build reads ${BACKUP_FORMAT_VERSION}). ` +
        'Update the app before restoring, so nothing is silently dropped.',
    );
  }

  for (const key of REQUIRED_COLLECTIONS) {
    const value = backup[key];
    if (!Array.isArray(value)) {
      throw new Error(
        `The backup is incomplete: "${key}" is missing or is not a list. ` +
          'Nothing has been changed. Restoring it would have erased what is on this device.',
      );
    }
    if (value.some((record) => !isRecordObject(record) || typeof record['id'] !== 'string')) {
      throw new Error(
        `The backup is damaged: "${key}" contains an entry without an id. ` +
          'Nothing has been changed.',
      );
    }
  }

  if (backup.settings !== undefined && !isRecordObject(backup.settings)) {
    throw new Error('The backup is damaged: "settings" is not an object. Nothing has been changed.');
  }

  return backup as BackupFile;
}

/**
 * A restore that would leave the device with no history at all, from a file that claims to be
 * a backup, is far more likely to be a damaged file than an intentional wipe.
 */
export function backupIsEmpty(json: unknown): boolean {
  try {
    const backup = validateBackup(json);
    return backup.workouts.length === 0 && backup.challenges.length === 0;
  } catch {
    return false;
  }
}

/** Validate and load a backup, replacing everything currently stored. */
export async function restoreBackup(json: unknown): Promise<RestoreResult> {
  const backup = validateBackup(json);

  // An older backup can carry the retired import-source id; the v2 database migration only
  // reaches records already stored, so normalise on the way in too.
  const workouts = backup.workouts.map((workout) =>
    workout.importSource === undefined
      ? workout
      : { ...workout, importSource: canonicalProfileId(workout.importSource) },
  );

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

  // Issue every request up front and await them together with `tx.done`, rather than awaiting
  // each one in sequence. Sequentially awaiting hundreds of writes risks the transaction
  // auto-committing between them — which on iOS Safari, the platform this app is built for,
  // surfaces as TransactionInactiveError partway through a restore.
  await Promise.all([
    ...stores.map((store) => tx.objectStore(store).clear()),
    ...backup.exercises.map((r) => tx.objectStore('exercises').put(r)),
    ...backup.challenges.map((r) => tx.objectStore('challenges').put(r)),
    ...backup.performanceTests.map((r) => tx.objectStore('performanceTests').put(r)),
    ...backup.planSlots.map((r) => tx.objectStore('planSlots').put(r)),
    ...workouts.map((r) => tx.objectStore('workouts').put(r)),
    tx.objectStore('settings').put(backup.settings ?? DEFAULT_SETTINGS),
    tx.done,
  ]);

  return {
    exercises: backup.exercises.length,
    challenges: backup.challenges.length,
    planSlots: backup.planSlots.length,
    workouts: workouts.length,
    performanceTests: backup.performanceTests.length,
  };
}

// ── Merge ───────────────────────────────────────────────────────────────────────
//
// Merge is a *sibling* of restore, never a refactor of it. `restoreBackup` above clears every
// store before writing, which is correct for disaster recovery and catastrophic anywhere else;
// a regression in it is a wiped device. So nothing below reaches into it, and nothing below
// clears or deletes anything: `put` is the only write these functions make.

/** What a merge did. The plan, minus the records themselves. */
export interface MergeResult {
  counts: MergePlan['counts'];
  totals: MergePlan['totals'];
  divergent: MergePlan['divergent'];
  skipped: MergePlan['skipped'];
  warnings: MergePlan['warnings'];
  settingsMerged: false;
}

/**
 * What a merge *would* do. Display only — it writes nothing, and the plan it returns is
 * deliberately not carried into `mergeBackup`, which recomputes its own.
 */
export async function previewMergeBackup(json: unknown): Promise<MergePlan> {
  const backup = validateBackup(json);

  const db = await getDB();
  const tx = db.transaction(MERGE_STORES, 'readonly');
  const [exercises, challenges, performanceTests, planSlots, workouts] = await Promise.all([
    tx.objectStore('exercises').getAll(),
    tx.objectStore('challenges').getAll(),
    tx.objectStore('performanceTests').getAll(),
    tx.objectStore('planSlots').getAll(),
    tx.objectStore('workouts').getAll(),
  ]);
  await tx.done;

  return planMerge({ exercises, challenges, performanceTests, planSlots, workouts }, backup);
}

/**
 * Validate and load a backup, adding what this device does not already have.
 *
 * Nothing is cleared and nothing is deleted. A record that exists here and not in the file is
 * untouched; a record that exists in both and differs keeps the version stored here.
 */
export async function mergeBackup(json: unknown): Promise<MergeResult> {
  // Before the database is opened, as restore does — a damaged file is rejected without a
  // transaction ever existing.
  const backup = validateBackup(json);

  const db = await getDB();
  // `settings` is deliberately absent from this list. That is what makes "merge never touches
  // your bodyweight, rest override or selected workout" structural: the transaction has no
  // handle on the store, so no future edit to this function can write to it by accident.
  const tx = db.transaction(MERGE_STORES, 'readwrite');

  // One await, on five requests that all belong to `tx`. Awaiting them together keeps the
  // transaction alive across the pause — the same reasoning the guarded v2 migration relies on
  // in `schema.ts`. Awaiting anything *outside* the transaction here would let it auto-commit
  // out from under the writes below.
  const [exercises, challenges, performanceTests, planSlots, workouts] = await Promise.all([
    tx.objectStore('exercises').getAll(),
    tx.objectStore('challenges').getAll(),
    tx.objectStore('performanceTests').getAll(),
    tx.objectStore('planSlots').getAll(),
    tx.objectStore('workouts').getAll(),
  ]);

  // Planned here, inside the write transaction, rather than carried over from the preview:
  // a plan computed minutes ago could otherwise overwrite a session logged in between.
  const plan = planMerge(
    { exercises, challenges, performanceTests, planSlots, workouts },
    backup,
  );

  // Issue every write up front and await them with `tx.done`, as restore does. Sequential
  // awaits risk the transaction auto-committing partway through, which on iOS Safari surfaces
  // as TransactionInactiveError.
  await Promise.all([
    ...plan.additions.exercises.map((r) => tx.objectStore('exercises').put(r)),
    ...plan.additions.challenges.map((r) => tx.objectStore('challenges').put(r)),
    ...plan.additions.performanceTests.map((r) => tx.objectStore('performanceTests').put(r)),
    ...plan.additions.planSlots.map((r) => tx.objectStore('planSlots').put(r)),
    ...plan.additions.workouts.map((r) => tx.objectStore('workouts').put(r)),
    tx.done,
  ]);

  return {
    counts: plan.counts,
    totals: plan.totals,
    divergent: plan.divergent,
    skipped: plan.skipped,
    warnings: plan.warnings,
    settingsMerged: plan.settingsMerged,
  };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** `mm:ss`, matching the incumbent's duration column. */
function formatDurationCell(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/** `d.M.yyyy HH:mm`, matching the incumbent's unpadded date format. */
function formatDateCell(iso: string): string {
  const [date, time] = iso.split('T');
  const [y, m, d] = (date ?? '').split('-');
  const hm = (time ?? '').slice(0, 5);
  return `${Number(d)}.${Number(m)}.${y} ${hm}`;
}

export interface CsvExportInput {
  exerciseLabel: string;
  goal: number | undefined;
  challengeLength: string;
  workouts: WorkoutRecord[];
  slotsById: Map<string, PlanSlotRecord>;
}

/**
 * Emit the incumbent's 14-column dialect, including its two identically-named `Zeit`
 * columns, so an export can be re-imported by our own positional profile.
 */
export function buildCsv(input: CsvExportInput): string {
  const header = [
    'Datum',
    'Workout',
    'Ziel',
    'Zeit',
    'Woche',
    'Tag',
    'Zeit',
    'Set 1',
    'Set 2',
    'Set 3',
    'Set 4',
    'Set 5',
    'Summe der Sets',
    'Kcal',
  ].join(';');

  const rows = [...input.workouts]
    .sort((a, b) => a.performedAt.localeCompare(b.performedAt))
    .map((wo) => {
      const slot = wo.planSlotId === undefined ? undefined : input.slotsById.get(wo.planSlotId);
      const sets = wo.sets.map((s) => s.actual);
      const padded = [0, 1, 2, 3, 4].map((i) => (sets[i] === undefined ? '' : String(sets[i])));
      return [
        formatDateCell(wo.performedAt),
        input.exerciseLabel,
        input.goal === undefined ? '' : String(input.goal),
        input.challengeLength,
        slot?.week === undefined ? '' : String(slot.week),
        slot?.day === undefined ? '' : String(slot.day),
        formatDurationCell(wo.durationSeconds),
        ...padded,
        String(wo.actualTotal),
        wo.kcal === undefined ? '-' : String(wo.kcal.value),
      ]
        .map(csvField)
        .join(';');
    });

  return [header, ...rows].join('\n');
}

/**
 * Quote a field that would otherwise break the row.
 *
 * The exercise label is free text the user typed. "Push-ups; wide" silently became two
 * columns, shifting every later value one place and corrupting the export — and the parser
 * we ship would then reject or misread the file on the way back in.
 */
function csvField(value: string): string {
  if (!/[;"\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** The object-URL-plus-anchor dance, for content that is already a Blob (the share card). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadFile(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: `${mime};charset=utf-8` }));
}

/** Days since the last export, or null if there has never been one. */
export function daysSinceBackup(settings: SettingsRecord, now = new Date()): number | null {
  if (!settings.lastBackupAt) return null;
  const then = new Date(settings.lastBackupAt).getTime();
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/** DIST-03: nag after a week, or as soon as there is history and no backup at all. */
export function shouldPromptBackup(
  settings: SettingsRecord,
  workoutCount: number,
  now = new Date(),
): boolean {
  if (workoutCount === 0) return false;
  const days = daysSinceBackup(settings, now);
  return days === null || days >= 7;
}
