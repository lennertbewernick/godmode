/**
 * IndexedDB schema.
 *
 * ## What this database is, since the cutover
 *
 * It is **no longer the dataset**. The exercises, challenges, plan slots, workouts,
 * performance tests and settings live in a server-owned SQLite file and reach the client as
 * one `GET /api/snapshot` — see `.planning/DESIGN-server-sqlite.md` §4. What is left here is a
 * write-ahead buffer with exactly two jobs:
 *
 *   - `workoutDrafts` — the workout being performed right now, written after every material
 *     action so a killed tab does not cost the user their reps.
 *   - `workoutOutbox` — finished workouts whose `POST /api/workouts` did not succeed. Each
 *     entry is deleted the moment the server acknowledges it.
 *
 * The five original stores are **deliberately still declared and still populated with whatever
 * they held before the cutover**. Nothing in this work deletes them and nothing calls
 * `indexedDB.deleteDatabase`: the owner's months of history sat in this database, the SQLite
 * file was seeded from a backup of it, and the browser copy stays as a fallback until the
 * server has proved itself. They are read by no production code any more.
 *
 * A note on "child rows": PLAN.md §4 calls for set targets to be child rows rather than five
 * fixed columns, so a variable set count never needs a migration. That requirement is
 * relational in origin. IndexedDB is a document store, so a variable-length `targets: []`
 * array *is* the child-row representation — no join table needed, and set count is free.
 *
 * Immutability rules the server now enforces (`server/routes.ts`):
 *   - `planSlots` records are never mutated after creation beyond their lifecycle status.
 *   - Per-attempt adjustments live on `workouts`, never on `planSlots`, because one slot can
 *     accumulate attempts that were each adjusted differently.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { canonicalProfileId } from '../import/profiles.js';
import type {
  AdjustmentType,
  Baseline,
  ChallengeEndReason,
  ChallengeStatus,
  EvaluationResult,
  PerformanceTest,
  PerformedSet,
  SetTarget,
  WorkoutOutcome,
} from '../core/types.js';

export const DB_NAME = 'fitness-companion';

/**
 * Bump this and add a guarded branch in `upgrade` below. Never edit an existing branch:
 * a database that already ran it will not run it again, so a retroactive edit only ever
 * applies to some users.
 *
 * v1 created the stores. v2 normalised the persisted import-profile id after the profile was
 * renamed (see `canonicalProfileId` in `src/import/profiles.ts`). v3 added `workoutDrafts`,
 * the in-progress workout buffer. v4 added `workoutOutbox`, the queue of finished workouts the
 * server has not accepted yet.
 *
 * v4 creates a store and touches nothing else. No branch here has ever deleted a store and none
 * will in this work: the five original stores still hold the owner's pre-cutover history and
 * that copy is the fallback.
 */
export const DB_VERSION = 4;

export interface ExerciseRecord {
  id: string;
  /** Free-text label. Exercises are an identifier only — no artwork, no demo media. */
  label: string;
  unit: 'reps';
  createdAt: string;
}

export interface ChallengeRecord {
  id: string;
  exerciseId: string;
  /** Groups a continuation chain so charts and totals span it without recursive traversal. */
  chainId: string;
  previousChallengeId?: string;
  /** Which progression scheme, and which version of it, produced this plan. */
  patternId: string;
  patternVersion: number;
  /** Canonical pattern parameters. Future patterns will not share percentage-ramp fields. */
  patternParams: Record<string, unknown>;
  restPolicyId: string;
  restPolicyVersion: number;
  restPolicyParams: Record<string, unknown>;
  evaluationPolicyId: string;
  evaluationPolicyVersion: number;
  /** Baseline with provenance. A number alone cannot say whether it was ever tested. */
  baseline: Baseline;
  /** Generation coordinate for the final session. NOT a capability claim. */
  goalValue?: number;
  status: ChallengeStatus;
  startedAt: string;
  endedAt?: string;
  endReason?: ChallengeEndReason;
}

export type PlanSlotStatus = 'available' | 'attempted' | 'completed' | 'superseded' | 'cancelled';

export interface PlanSlotRecord {
  id: string;
  challengeId: string;
  ordinal: number;
  /** Optional: an open-ended pattern has no meaningful week/day. */
  week?: number;
  day?: number;
  cycleLabel?: string;
  patternId: string;
  patternVersion: number;
  generatedAt: string;
  /** Why this prescription was chosen. Immutable audit trail. */
  decision?: Record<string, unknown>;
  patternMetrics?: Record<string, number>;
  /** Variable-length prescribed sets. Immutable. */
  targets: SetTarget[];
  targetTotal: number;
  restSeconds: number;
  status: PlanSlotStatus;
  supersedesId?: string;
}

export interface KcalRecord {
  value: number;
  /** `external` values came from an import and are never merged with our estimates. */
  source: 'external' | 'estimated';
  /** Bumped when the estimation formula changes, so history is not silently rewritten. */
  estimatorVersion: number;
}

export interface WorkoutRecord {
  id: string;
  challengeId: string;
  chainId: string;
  /** Nullable: an imported row that cannot be reconciled to a slot stays unlinked. */
  planSlotId?: string;
  attemptNo: number;
  performedAt: string;
  durationSeconds?: number;
  sets: PerformedSet[];
  actualTotal: number;
  /** Per-attempt adjustment. Lives here, never on the slot. */
  adjustmentType: AdjustmentType;
  /** Prescribed total for this attempt. Absent when no prescription is known — see PerformedSet. */
  effectiveTotal?: number;
  outcome: WorkoutOutcome;
  evaluation?: EvaluationResult;
  evaluationPolicyId?: string;
  evaluationPolicyVersion?: number;
  kcal?: KcalRecord;
  note?: string;
  /** Set when the row came from an import rather than being performed in-app. */
  importSource?: string;
}

/** The runner's three phases. Persisted, so it lives with the record rather than in the view. */
export type RunnerPhase = 'set' | 'rest' | 'review';

export interface DraftSetStamp {
  startedAt: string;
  endedAt: string;
}

/**
 * Format version of `WorkoutDraftRecord` itself, independent of `DB_VERSION`.
 *
 * A draft is written by one build and read by the next — a service-worker update can land
 * between the two. `DB_VERSION` cannot express that: the store does not change shape when the
 * record does. So the reader checks this integer and simply declines to resume a draft it does
 * not understand, rather than reconstructing a workout from fields it is guessing at.
 */
export const WORKOUT_DRAFT_VERSION = 1;

/**
 * A workout that has been started and not yet logged.
 *
 * This is a write-ahead buffer, not history. It exists because `Runner.tsx` used to hold the
 * whole session in React state: a crashed tab, an iOS reclaim of the PWA, or a service-worker
 * activation destroyed every rep the user had already done.
 *
 * Two properties are load-bearing:
 *
 *   - `id` is the id the workout will be given when it is logged. Generating it up front makes
 *     saving idempotent — the same draft finished twice writes one workout — and it is the
 *     idempotency key the server command will carry later.
 *   - everything from `effectiveTargets` to `restSecondsPerSet` is an IMMUTABLE snapshot taken
 *     when the session started. The plan slot, the rest override in settings, even the
 *     challenge can change underneath a session that is already in progress; a resumed workout
 *     must finish against the prescription its user was actually shown.
 */
export interface WorkoutDraftRecord {
  id: string;
  draftVersion: number;
  challengeId: string;
  chainId: string;
  planSlotId: string;
  /** Display only. The authoritative attempt number is counted inside `logWorkout`'s transaction. */
  attemptNo: number;
  /** Snapshot: prescribed reps per set, after any adjustment the user made before starting. */
  effectiveTargets: number[];
  /** Snapshot: which of those sets are open-ended. */
  amrapFlags: boolean[];
  /** Snapshot: the slot's prescribed total, for the review screen's shortfall line. */
  targetTotal: number;
  /** Snapshot: resolved rest after each set, with any settings override already applied. */
  restSecondsPerSet: number[];
  adjustmentType: AdjustmentType;
  /** Reps recorded so far. Pre-filled with the targets, exactly as the runner does. */
  actuals: number[];
  /** Per-set stamps. `null` until that set is completed — never a sparse array, which does not survive a structured clone intact. */
  stamps: (DraftSetStamp | null)[];
  /** Index of the set being performed or rested before. */
  index: number;
  phase: RunnerPhase;
  restTotalSeconds: number;
  /**
   * When the current rest ends, as an absolute instant — not a countdown.
   *
   * A countdown would have to be written once a second to stay true, which is a write per
   * second for the length of every rest. A deadline is written only when rest starts, is
   * adjusted, or is skipped, and a resumed session computes what is left from the clock.
   */
  restEndsAt: string | null;
  /** Start of the set currently in progress, so a resumed set still has an honest stamp. */
  setStartedAt: string;
  startedAt: string;
  updatedAt: string;
}

/**
 * A finished workout the server has not accepted yet.
 *
 * `attemptNo` is absent by construction — the type is `Omit<WorkoutRecord, 'attemptNo'>` —
 * because the server assigns it as an acceptance sequence and refuses a command that tries to
 * supply one (`server/routes.ts:317`). A queued workout composed offline cannot know what the
 * sequence will be, and inventing one would be inventing history.
 */
export type PendingWorkout = Omit<WorkoutRecord, 'attemptNo'>;

/**
 * One entry in the outbox.
 *
 * Keyed by the workout's own id, which was minted when the session started
 * (`WorkoutDraftRecord.id`). That is the idempotency key the server dedupes on, so queueing the
 * same finished workout twice overwrites one entry rather than producing two sessions.
 */
export interface OutboxEntry {
  /** The workout id. Primary key, and the server's idempotency key. */
  id: string;
  /** Monotonic within the queue: assigned as `max(seq) + 1` inside the enqueueing transaction. */
  seq: number;
  queuedAt: string;
  /** How many times a send has been attempted. Display only; the server dedupes regardless. */
  attempts: number;
  /**
   * Set when the server refused this workout for a reason retrying cannot fix — a plan slot it
   * no longer knows, a challenge ended on another device. The entry is kept, never dropped, and
   * the drainer steps over it so one unacceptable workout cannot block every later one.
   */
  blockedReason?: string;
  workout: PendingWorkout;
}

export interface SettingsRecord {
  id: 'settings';
  bodyweightKg?: number | undefined;
  /** kcal per rep per kg. Configurable because it depends on body geometry and technique. */
  kcalCoefficient: number;
  restOverrideSeconds?: number | undefined;
  /** ISO timestamp of the last successful data export, for backup nagging. */
  lastBackupAt?: string;
  /** Whether the user has seen the "this data lives only on this device" explanation. */
  onboardedAt?: string;
  /**
   * The "why do you do this" the user wrote during onboarding (LBV-1481). Free text, their own
   * words. Captured here so Phase 1's reminder copy can reflect it back — a reminder that names
   * the reason lands harder than a generic nudge. Optional: a user who skipped the prompt has none.
   * Bounded by {@link GOAL_TEXT_MAX_LENGTH}, enforced by the server validator and the client field.
   * `| undefined` like the other clearable settings: emptying the textarea patches it to `null`,
   * which the server normalises back to absent.
   */
  goalText?: string | undefined;
  /**
   * Which of several active challenges the app is currently showing.
   *
   * A preference, not a source of truth: if it names a challenge that has since ended or been
   * deleted, the app falls back to the most recently started active one. That keeps restoring
   * an old backup — or deleting a workout on another device — from producing an empty screen.
   */
  selectedChallengeId?: string | undefined;
}

export interface FitnessDB extends DBSchema {
  exercises: { key: string; value: ExerciseRecord };
  challenges: {
    key: string;
    value: ChallengeRecord;
    indexes: { byChain: string; byStatus: string };
  };
  performanceTests: {
    key: string;
    value: PerformanceTest;
    indexes: { byExercise: string };
  };
  planSlots: {
    key: string;
    value: PlanSlotRecord;
    indexes: { byChallenge: string; byChallengeOrdinal: [string, number] };
  };
  workouts: {
    key: string;
    value: WorkoutRecord;
    indexes: { byChallenge: string; bySlot: string; byChain: string; byPerformedAt: string };
  };
  workoutDrafts: {
    key: string;
    value: WorkoutDraftRecord;
    indexes: { bySlot: string };
  };
  workoutOutbox: {
    key: string;
    value: OutboxEntry;
    indexes: { bySeq: number };
  };
  settings: { key: string; value: SettingsRecord };
}

export type Database = IDBPDatabase<FitnessDB>;

/**
 * Two connections to the same database disagreeing about its version.
 *
 * `blocked`  — this tab wants to upgrade and an older connection is holding the database open.
 * `blocking` — this tab holds the old connection and another one is waiting to upgrade.
 */
export type DatabaseConflict = 'blocked' | 'blocking';

type ConflictListener = (kind: DatabaseConflict) => void;

const conflictListeners = new Set<ConflictListener>();

/** Subscribe to version conflicts so the UI can say what is happening. Returns an unsubscribe. */
export function onDatabaseConflict(listener: ConflictListener): () => void {
  conflictListeners.add(listener);
  return () => conflictListeners.delete(listener);
}

function reportConflict(kind: DatabaseConflict): void {
  for (const listener of conflictListeners) listener(kind);
}

export interface OpenOptions {
  /**
   * The connection died under us. The caller caches its handle, and every call on a dead one
   * rejects forever, so it needs telling to throw the handle away rather than keep using it.
   */
  onTerminated?: () => void;
}

export function openFitnessDB(name = DB_NAME, options: OpenOptions = {}): Promise<Database> {
  return openDB<FitnessDB>(name, DB_VERSION, {
    /**
     * Another tab is still on the old version, so this tab's upgrade cannot start. The open
     * promise stays pending until that tab closes its connection; saying so is all we can
     * usefully do.
     */
    blocked() {
      console.warn(
        '[fitness-db] Another tab has this app open on an older version. This one cannot ' +
          'finish updating until that tab is closed.',
      );
      reportConflict('blocked');
    },

    /**
     * This tab holds the connection another tab is waiting on.
     *
     * We deliberately do NOT `db.close()` here, and never reload. A workout may be in progress
     * in this tab, and closing the connection out from under it would break exactly the writes
     * that exist to protect it. The other tab waits; the user is told why.
     */
    blocking() {
      console.warn(
        '[fitness-db] Another tab is waiting to update this app. This tab keeps its ' +
          'connection so an in-progress workout is not interrupted — close it when you are done.',
      );
      reportConflict('blocking');
    },

    /**
     * The browser dropped the connection — a crash in the storage process, or eviction.
     *
     * Nothing reopens by itself here. The handle is cached by the caller, and every call on a
     * dead one rejects forever, so the caller is told to discard it; the next database call
     * then opens a new connection. Without that, a mid-workout termination would turn every
     * subsequent draft write into a silent failure for as long as the tab stayed open.
     */
    terminated() {
      console.warn('[fitness-db] The browser closed this database connection unexpectedly.');
      options.onTerminated?.();
    },

    // `oldVersion` is 0 for a brand-new database and the stored version otherwise. Every
    // branch must be guarded: an unguarded `createObjectStore` throws ConstraintError on an
    // existing database, which aborts the upgrade transaction and leaves the app unable to
    // open the database at all. On a device that holds the only copy of the data, that is
    // indistinguishable from data loss.
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('exercises', { keyPath: 'id' });

        const challenges = db.createObjectStore('challenges', { keyPath: 'id' });
        challenges.createIndex('byChain', 'chainId');
        challenges.createIndex('byStatus', 'status');

        const tests = db.createObjectStore('performanceTests', { keyPath: 'id' });
        tests.createIndex('byExercise', 'exerciseId');

        const slots = db.createObjectStore('planSlots', { keyPath: 'id' });
        slots.createIndex('byChallenge', 'challengeId');
        slots.createIndex('byChallengeOrdinal', ['challengeId', 'ordinal']);

        const workouts = db.createObjectStore('workouts', { keyPath: 'id' });
        workouts.createIndex('byChallenge', 'challengeId');
        workouts.createIndex('bySlot', 'planSlotId');
        workouts.createIndex('byChain', 'chainId');
        workouts.createIndex('byPerformedAt', 'performedAt');

        db.createObjectStore('settings', { keyPath: 'id' });
      }

      // v2: the import profile was renamed off the incumbent's brand. Rewrite the provenance
      // string in place so no record is left carrying a retired id.
      //
      // The work runs inside the upgrade transaction: every await is on a request belonging
      // to `tx`, which keeps the transaction alive across them, and `openDB` does not resolve
      // until `tx` completes. So this is atomic — a failure aborts the upgrade and the
      // database stays at v1 rather than half-migrated.
      if (oldVersion >= 1 && oldVersion < 2) {
        const workouts = tx.objectStore('workouts');
        void (async () => {
          for (const record of await workouts.getAll()) {
            if (record.importSource === undefined) continue;
            const canonical = canonicalProfileId(record.importSource);
            if (canonical !== record.importSource) {
              await workouts.put({ ...record, importSource: canonical });
            }
          }
        })();
      }

      // v3: the in-progress workout buffer. Guarded like every other branch — an unguarded
      // `createObjectStore` on a database that already has the store throws ConstraintError,
      // which aborts the upgrade and leaves the app unable to open its own data.
      //
      // Creation only. No existing record is read or rewritten, so this branch cannot fail on
      // a populated database: the five stores from v1 are not touched.
      if (oldVersion < 3) {
        const drafts = db.createObjectStore('workoutDrafts', { keyPath: 'id' });
        drafts.createIndex('bySlot', 'planSlotId');
      }

      // v4: the outbox. Same shape of branch as v3 and for the same reason — creation only,
      // guarded, reading nothing. The five stores that hold the pre-cutover history are not
      // named here at all, so this branch cannot touch them even by accident.
      if (oldVersion < 4) {
        const outbox = db.createObjectStore('workoutOutbox', { keyPath: 'id' });
        outbox.createIndex('bySeq', 'seq');
      }
    },
  });
}

/**
 * A generous ceiling for the onboarding "why" (LBV-1481): long enough for a real paragraph, short
 * enough that it cannot bloat the settings row. The client textarea reads this; the server validator
 * enforces the same bound from its own copy in `server/fields.ts` — must match (see the note there).
 */
export const GOAL_TEXT_MAX_LENGTH = 1000;

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: 'settings',
  // ~0.003 kcal per rep per kg: bodyweight * 0.65 lifted through ~0.4m at ~22% efficiency.
  kcalCoefficient: 0.003,
};

export const KCAL_ESTIMATOR_VERSION = 1;
