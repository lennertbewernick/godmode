/**
 * Export.
 *
 * Restore and merge used to live here too and no longer do — see the note further down, and
 * `server/import-backup.ts` for what replaced them.
 *
 * The JSON backup is the complete dataset including pattern ids/versions, policy versions,
 * chain links, baseline provenance, and generation decisions — everything needed to
 * reconstruct the database, not just a rep log. Without the versions a restore into a future
 * build could silently reinterpret history.
 *
 * The CSV export deliberately matches the incumbent's dialect so a round trip is possible and
 * so nobody is locked in here either.
 */

import type { Snapshot } from '../api/client.js';
import { DB_VERSION, type SettingsRecord } from '../db/schema.js';
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

/**
 * The whole dataset as a file, built from one snapshot.
 *
 * It used to read six IndexedDB stores. It now takes the snapshot the app is already holding,
 * which is both simpler and more honest: a backup assembled from six independent reads could
 * straddle a write and describe a state that never existed. One `GET /api/snapshot` is one read
 * transaction on the server (`server/routes.ts:145`), so this file is a real point in time.
 *
 * `dbVersion` still names the IndexedDB schema version this build knows, because that is what
 * the field has always meant and `server/migrate.ts` reads backups written before the cutover
 * alongside ones written after it.
 *
 * **Pass the snapshot the user is being shown, not the raw one from the server.** The app
 * overlays workouts that are finished but still queued on this device (`applyPending`), and a
 * backup is the second copy of the history — omitting the sessions that no server holds yet
 * would leave out precisely the ones with no other copy at all.
 */
export function buildBackup(snapshot: Snapshot): BackupFile {
  return {
    format: 'godmode-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    exercises: [...snapshot.exercises],
    challenges: [...snapshot.challenges],
    performanceTests: [...snapshot.performanceTests],
    planSlots: [...snapshot.planSlots],
    workouts: [...snapshot.workouts],
    settings: snapshot.settings,
  };
}

/**
 * The collections a backup must carry. Absence is rejected rather than defaulted to empty:
 * an importer that treats a missing collection as "zero records" turns a truncated or
 * hand-edited file into total, silent data loss on the only copy that exists.
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

/**
 * Restoring a backup is a server-side operation now, and there is no client path for it.
 *
 * Before the cutover, restore cleared six IndexedDB stores and wrote the file into them, and
 * merge added what was missing. Neither can be done from the browser any more: the dataset is a
 * SQLite file the server owns, and **the API has no restore or merge command** — `/api/import`
 * takes exactly one exercise, one challenge and its history, and refuses a record whose id it
 * already holds with different content.
 *
 * Rather than invent a client-side approximation of a transaction the server does not offer,
 * the app points at the tool that already does this properly and is tested against the owner's
 * real data:
 *
 *     npm run import-backup -- <backup.json> --target <database.sqlite> --dry-run
 *
 * It validates every field of every record, builds a NEW database in a temporary file, verifies
 * it with SQLite's own integrity and foreign-key pragmas plus a record-by-record comparison, and
 * only then renames it into place — keeping a copy of whatever was there before. See
 * `server/import-backup.ts`.
 *
 * `planMerge` in `./merge.js` stays, untouched and still tested. It is pure, it takes a dataset
 * and a backup and returns a plan, and it is exactly what a future `POST /api/merge` would run
 * inside its transaction. It is deliberately not wired to anything today.
 */

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
