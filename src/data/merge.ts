/**
 * Merge planning — pure.
 *
 * Takes what is on this device plus what a backup file holds, and returns a plan: which
 * records would be added, which are already here, which differ, and which cannot be stored
 * because something they point at is missing. It writes nothing and reads nothing.
 *
 * This module is shared with the future sync layer (`.planning/DESIGN-multi-device-sync.md`),
 * which is the whole reason it takes data in and returns a plan rather than touching the
 * database itself. **It must stay free of storage and DOM imports** — no `idb`, no
 * `../db/repo.js`, no `window`. Types only, plus the import-profile canonicaliser.
 *
 * The one thing merge never does is delete. A record on this device and not in the file is
 * not in the plan at all: there is nothing the plan could say about it that would remove it.
 */

import { canonicalProfileId } from '../import/profiles.js';
import type { PerformanceTest } from '../core/types.js';
import type { BackupFile } from './exchange.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  PlanSlotRecord,
  WorkoutRecord,
} from '../db/schema.js';

/**
 * The stores a merge touches.
 *
 * D-4: `settings` is deliberately absent. It is a singleton (`id: 'settings'`), so a union by
 * id could only ever call it identical or divergent — never add anything. Its contents are
 * device preferences: bodyweight, the kcal coefficient, a rest override, `lastBackupAt`, and
 * `selectedChallengeId`, which may well name a challenge this device does not have. Leaving it
 * out of this list is what makes "merge does not touch your settings" a property of the code
 * rather than a promise someone has to keep.
 */
export const MERGE_STORES = [
  'exercises',
  'challenges',
  'performanceTests',
  'planSlots',
  'workouts',
] as const;

export type MergeStore = (typeof MERGE_STORES)[number];

/** One array per merge store. Used both for the local snapshot and for the additions. */
export interface DatabaseSnapshot {
  exercises: ExerciseRecord[];
  challenges: ChallengeRecord[];
  performanceTests: PerformanceTest[];
  planSlots: PlanSlotRecord[];
  workouts: WorkoutRecord[];
}

export interface MergeCounts {
  added: number;
  identical: number;
  divergent: number;
  skipped: number;
}

/**
 * Why a record that exists on both sides differs.
 *
 * The two challenge endings get their own reasons rather than being folded into `content`,
 * because "this file would have reopened a workout you ended" is a different sentence from
 * "this record differs", and the user needs the first one said out loud.
 */
export type DivergenceReason = 'content' | 'local-ended' | 'file-ended';

export interface MergePlan {
  counts: Record<MergeStore, MergeCounts>;
  /** Exactly the records to `put`, already normalised. Nothing else may be written. */
  additions: DatabaseSnapshot;
  divergent: Array<{ store: MergeStore; id: string; reason: DivergenceReason }>;
  /** `missing` names what could not be resolved, e.g. `challenge cha-7`. */
  skipped: Array<{ store: MergeStore; id: string; missing: string }>;
  /** A dangling *optional* reference. Reported, never skipped, never rewritten. */
  warnings: Array<{ store: MergeStore; id: string; note: string }>;
  /** A literal, so nothing downstream can claim settings were merged. */
  settingsMerged: false;
  totals: MergeCounts;
}

/**
 * Canonical serialisation for content comparison (D-6).
 *
 * Raw `JSON.stringify` compares key *insertion order*, so a record built by the app and the
 * same record round-tripped through a file would compare unequal and every one of them would
 * be reported as a conflict. Keys are therefore sorted, and a property whose value is
 * explicitly `undefined` is treated as absent — a JSON file cannot carry one, so the two are
 * the same record. Array order is preserved: `targets`, `sets` and the pattern coefficients
 * are ordered data, not sets.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const inner = source[key];
      if (inner === undefined) continue;
      out[key] = canonicalise(inner);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

/** A reference that must resolve, or the record cannot be rendered by the app. */
interface HardRef {
  store: MergeStore;
  id: string;
  /** How to name it to a human: `exercise`, `challenge`. */
  label: string;
}

interface StoreRules<T> {
  /** Applied before comparison *and* before writing, so the two cannot disagree. */
  normalise: (record: T) => T;
  hardRefs: (record: T) => HardRef[];
  reason: (mine: T, theirs: T) => DivergenceReason;
}

function emptyCounts(): MergeCounts {
  return { added: 0, identical: 0, divergent: 0, skipped: 0 };
}

/**
 * Classify one store's incoming records and return the ones to write.
 *
 * `accepted` holds every id that will exist after the merge — the local ids plus the
 * additions accepted so far. Stores are processed in dependency order, so a file bringing a
 * challenge *and* its sessions resolves against itself, and a challenge skipped for a missing
 * exercise takes its slots and sessions with it.
 */
function classify<T extends { id: string }>(
  store: MergeStore,
  incoming: readonly T[],
  localRecords: readonly T[],
  accepted: Record<MergeStore, Set<string>>,
  plan: MergePlan,
  rules: StoreRules<T>,
): T[] {
  const localById = new Map(localRecords.map((record) => [record.id, record] as const));
  const counts = plan.counts[store];
  const additions: T[] = [];

  for (const raw of incoming) {
    const record = rules.normalise(raw);
    const mine = localById.get(record.id);

    if (mine !== undefined) {
      if (canonicalJson(mine) === canonicalJson(record)) {
        counts.identical += 1;
        continue;
      }
      // D-1: the local copy wins and the file's copy is dropped from the write set. It is not
      // quarantined — there is no store for that, and adding one means a DB_VERSION bump on
      // the only copy of real data. Nothing is lost by not storing it: the user still holds
      // the JSON file, which is a better thing to inspect than a hidden store. The id is
      // reported so the preview can name it.
      counts.divergent += 1;
      plan.divergent.push({ store, id: record.id, reason: rules.reason(mine, record) });
      continue;
    }

    // D-2: a record whose *required* reference resolves nowhere is skipped rather than
    // blocking the whole merge, so one orphan cannot cost the user every other new session.
    // Skipping is not deletion — the file still holds it, and merging the parent first then
    // merging again picks it up.
    const missing = rules.hardRefs(record).filter((ref) => !accepted[ref.store].has(ref.id));
    if (missing.length > 0) {
      counts.skipped += 1;
      plan.skipped.push({
        store,
        id: record.id,
        missing: missing.map((ref) => `${ref.label} ${ref.id}`).join(', '),
      });
      continue;
    }

    counts.added += 1;
    additions.push(record);
    accepted[store].add(record.id);
  }

  return additions;
}

/**
 * D-5: an older backup can carry the retired import-source id. Replace normalises on the way
 * in for the same reason; without it here, every pre-v2 session would compare divergent
 * against its already-migrated local twin and the preview would report the user's whole
 * history as a conflict.
 */
function normaliseWorkout(workout: WorkoutRecord): WorkoutRecord {
  return workout.importSource === undefined
    ? workout
    : { ...workout, importSource: canonicalProfileId(workout.importSource) };
}

export function planMerge(local: DatabaseSnapshot, backup: BackupFile): MergePlan {
  const plan: MergePlan = {
    counts: {
      exercises: emptyCounts(),
      challenges: emptyCounts(),
      performanceTests: emptyCounts(),
      planSlots: emptyCounts(),
      workouts: emptyCounts(),
    },
    additions: {
      exercises: [],
      challenges: [],
      performanceTests: [],
      planSlots: [],
      workouts: [],
    },
    divergent: [],
    skipped: [],
    warnings: [],
    settingsMerged: false,
    totals: emptyCounts(),
  };

  const accepted: Record<MergeStore, Set<string>> = {
    exercises: new Set(local.exercises.map((r) => r.id)),
    challenges: new Set(local.challenges.map((r) => r.id)),
    performanceTests: new Set(local.performanceTests.map((r) => r.id)),
    planSlots: new Set(local.planSlots.map((r) => r.id)),
    workouts: new Set(local.workouts.map((r) => r.id)),
  };

  // Dependency order: exercises → performanceTests → challenges → planSlots → workouts.
  plan.additions.exercises = classify(
    'exercises',
    backup.exercises,
    local.exercises,
    accepted,
    plan,
    { normalise: (r) => r, hardRefs: () => [], reason: () => 'content' },
  );

  plan.additions.performanceTests = classify(
    'performanceTests',
    backup.performanceTests,
    local.performanceTests,
    accepted,
    plan,
    {
      normalise: (r) => r,
      hardRefs: (r) => [{ store: 'exercises', id: r.exerciseId, label: 'exercise' }],
      reason: () => 'content',
    },
  );

  plan.additions.challenges = classify(
    'challenges',
    backup.challenges,
    local.challenges,
    accepted,
    plan,
    {
      normalise: (r) => r,
      hardRefs: (r) => [{ store: 'exercises', id: r.exerciseId, label: 'exercise' }],
      // D-3: there is no reopen operation in this app, so a file must never be able to put an
      // ended workout back on the board. Under D-1 the local copy already wins; this only
      // gives the case its own name, because silently resurrecting a finished challenge is the
      // failure worth saying out loud. The converse — ended in the file, still running here —
      // is left alone too: applying just the ending would write one field into a record that
      // may differ elsewhere, producing a hybrid matching neither copy.
      reason: (mine, theirs) =>
        mine.status === 'ended' && theirs.status === 'active'
          ? 'local-ended'
          : mine.status === 'active' && theirs.status === 'ended'
            ? 'file-ended'
            : 'content',
    },
  );

  plan.additions.planSlots = classify(
    'planSlots',
    backup.planSlots,
    local.planSlots,
    accepted,
    plan,
    {
      normalise: (r) => r,
      hardRefs: (r) => [{ store: 'challenges', id: r.challengeId, label: 'challenge' }],
      reason: () => 'content',
    },
  );

  plan.additions.workouts = classify(
    'workouts',
    backup.workouts,
    local.workouts,
    accepted,
    plan,
    {
      normalise: normaliseWorkout,
      hardRefs: (r) => [{ store: 'challenges', id: r.challengeId, label: 'challenge' }],
      reason: () => 'content',
    },
  );

  // Optional references, resolved once every store has been classified so a forward reference
  // inside the same store does not produce a false warning. These are reported and nothing
  // more: the fields are declared optional and the app already renders their absence, and
  // stripping a dangling id would mutate record content — which merge must never do.
  for (const challenge of plan.additions.challenges) {
    if (
      challenge.previousChallengeId !== undefined &&
      !accepted.challenges.has(challenge.previousChallengeId)
    ) {
      plan.warnings.push({
        store: 'challenges',
        id: challenge.id,
        note: `continues ${challenge.previousChallengeId}, which is not here or in the file`,
      });
    }
    const evidenceId = challenge.baseline.evidenceId;
    if (evidenceId !== undefined && !accepted.performanceTests.has(evidenceId)) {
      plan.warnings.push({
        store: 'challenges',
        id: challenge.id,
        note: `its baseline cites max test ${evidenceId}, which is not here or in the file`,
      });
    }
  }
  for (const workout of plan.additions.workouts) {
    if (workout.planSlotId !== undefined && !accepted.planSlots.has(workout.planSlotId)) {
      plan.warnings.push({
        store: 'workouts',
        id: workout.id,
        note: `no plan slot ${workout.planSlotId} here or in the file; it stays unlinked`,
      });
    }
  }

  for (const store of MERGE_STORES) {
    const counts = plan.counts[store];
    plan.totals.added += counts.added;
    plan.totals.identical += counts.identical;
    plan.totals.divergent += counts.divergent;
    plan.totals.skipped += counts.skipped;
  }

  return plan;
}
