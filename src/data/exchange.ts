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
import { DB_VERSION, DEFAULT_SETTINGS, type SettingsRecord } from '../db/schema.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  PlanSlotRecord,
  WorkoutRecord,
} from '../db/schema.js';
import type { PerformanceTest } from '../core/types.js';

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

/** Validate and load a backup, replacing everything currently stored. */
export async function restoreBackup(json: unknown): Promise<RestoreResult> {
  const backup = json as Partial<BackupFile>;
  if (backup?.format !== 'godmode-backup') {
    throw new Error('That file is not a GodMode backup.');
  }
  if (typeof backup.formatVersion !== 'number') {
    throw new Error('The backup is missing a format version.');
  }
  if (backup.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `That backup was written by a newer version of GodMode ` +
        `(format ${backup.formatVersion}, this build reads ${BACKUP_FORMAT_VERSION}). ` +
        'Update the app before restoring, so nothing is silently dropped.',
    );
  }

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

  for (const r of backup.exercises ?? []) await tx.objectStore('exercises').put(r);
  for (const r of backup.challenges ?? []) await tx.objectStore('challenges').put(r);
  for (const r of backup.performanceTests ?? []) await tx.objectStore('performanceTests').put(r);
  for (const r of backup.planSlots ?? []) await tx.objectStore('planSlots').put(r);
  for (const r of backup.workouts ?? []) await tx.objectStore('workouts').put(r);
  await tx.objectStore('settings').put(backup.settings ?? DEFAULT_SETTINGS);
  await tx.done;

  return {
    exercises: backup.exercises?.length ?? 0,
    challenges: backup.challenges?.length ?? 0,
    planSlots: backup.planSlots?.length ?? 0,
    workouts: backup.workouts?.length ?? 0,
    performanceTests: backup.performanceTests?.length ?? 0,
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
      ].join(';');
    });

  return [header, ...rows].join('\n');
}

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function backupFilename(now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `godmode_backup_${stamp}.json`;
}

export function csvFilename(now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `godmode_stats_${stamp}.csv`;
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
