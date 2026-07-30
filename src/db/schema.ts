/**
 * IndexedDB schema.
 *
 * A note on "child rows": PLAN.md §4 calls for set targets to be child rows rather than five
 * fixed columns, so a variable set count never needs a migration. That requirement is
 * relational in origin. IndexedDB is a document store, so a variable-length `targets: []`
 * array *is* the child-row representation — no join table needed, and set count is free.
 *
 * Immutability rules that the repository layer enforces:
 *   - `planSlots` records are never mutated after creation. A future unattempted slot may be
 *     superseded by a new record pointing back via `supersedesId`; the old one is marked
 *     `superseded` and kept.
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
 * renamed (see `canonicalProfileId` in `src/import/profiles.ts`).
 */
export const DB_VERSION = 2;

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
  effectiveTotal: number;
  outcome: WorkoutOutcome;
  evaluation?: EvaluationResult;
  evaluationPolicyId?: string;
  evaluationPolicyVersion?: number;
  kcal?: KcalRecord;
  note?: string;
  /** Set when the row came from an import rather than being performed in-app. */
  importSource?: string;
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
  settings: { key: string; value: SettingsRecord };
}

export type Database = IDBPDatabase<FitnessDB>;

export function openFitnessDB(name = DB_NAME): Promise<Database> {
  return openDB<FitnessDB>(name, DB_VERSION, {
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
    },
  });
}

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: 'settings',
  // ~0.003 kcal per rep per kg: bodyweight * 0.65 lifted through ~0.4m at ~22% efficiency.
  kcalCoefficient: 0.003,
};

export const KCAL_ESTIMATOR_VERSION = 1;
