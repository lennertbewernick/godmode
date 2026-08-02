/**
 * The API. Endpoints match transactions, not repository functions.
 *
 * ## Why not one endpoint per `repo.ts` function
 *
 * `src/db/repo.ts` has thirty exports but far fewer *transactions*. `startNextBlock`
 * (`repo.ts:343`) ends a challenge, records a max test, creates the successor and its slots and
 * moves the selection — one IndexedDB transaction, because a failure halfway leaves the owner
 * with an ended plan and no next session. Mirroring thirty functions as thirty endpoints would
 * put those boundaries on the wrong side of the wire, where a dropped connection between two
 * calls is not a rare event but the normal one. So each endpoint here is exactly one
 * transaction that is already atomic today.
 *
 * ## Optimistic concurrency
 *
 * Two devices is the entire point of this work, and transactions do nothing about a stale
 * client overwriting a fresh one: `saveSettings` is a read-merge-write (`repo.ts:72`) and
 * `endChallenge` reads a record and writes a derived replacement (`repo.ts:283`). So every
 * ordinary command carries `expectedRevision`, compared against `meta.revision` **inside** its
 * write transaction, and a mismatch is `409` carrying the fresh snapshot — never a silent
 * overwrite. Every accepted command bumps the revision exactly once.
 *
 * `POST /api/workouts` is deliberately exempt, and that exemption is the design, not an
 * oversight: a workout finished offline is drained from the outbox at some unknowable later
 * time, by which point the revision it was composed against is stale by definition. Refusing it
 * would throw away the training the app exists to record. It is append-only and idempotent on a
 * client-generated id instead, and it still validates every record it references.
 *
 * ## `attempt_no` is a sequence, not a chronology
 *
 * `attempt_no` is an **immutable server-acceptance sequence** for a plan slot. It says "this
 * was the nth attempt this server accepted for that slot" and nothing else. It is assigned as
 * `MAX(attempt_no) + 1` — not `COUNT + 1`, which would collide the moment an attempt were ever
 * removed — and existing attempts are **never renumbered**, because a number that changes is a
 * number no other record can safely reference.
 *
 * Two devices finishing offline and reconnecting in the other order will therefore produce
 * attempt numbers that do not match the order the workouts were performed in. That is
 * acceptable and it is why **display order is `performed_at`**, which is what the snapshot
 * orders workouts by. Nothing in the UI may present `attempt_no` as chronology.
 *
 * ## Every command is retry-safe
 *
 * Records are written through `insertOrVerify`: an id that is absent is inserted, an id that is
 * present with byte-identical content is a no-op, and an id that is present with *different*
 * content aborts the whole command. A lost response can therefore always be retried, and a
 * genuine collision is reported rather than silently resolved in someone's favour.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokenMatches } from './auth.js';
import type { AttemptLimiter } from './auth.js';
import { canonicallyEqual } from './canonical.js';
import {
  bumpRevision,
  findRecord,
  inReadTransaction,
  inWriteTransaction,
  insertRecord,
  listRecords,
  readRevision,
  readSettings,
  writeSettings,
} from './db.js';
import {
  CHALLENGE_FIELDS,
  EXERCISE_FIELDS,
  PERFORMANCE_TEST_FIELDS,
  PLAN_SLOT_FIELDS,
  SETTINGS_FIELDS,
  SETTINGS_ROW_ID,
  WORKOUT_FIELDS,
  type FieldSpecMap,
} from './fields.js';
import {
  HttpError,
  MAX_BODY_BYTES,
  MAX_IMPORT_BODY_BYTES,
  readJsonBody,
  sendEmpty,
  sendError,
  sendJson,
} from './http.js';
import {
  CHALLENGES,
  EXERCISES,
  PERFORMANCE_TESTS,
  PLAN_SLOTS,
  WORKOUTS,
  bindValues,
  type TableMapping,
} from './rows.js';
import { SCHEMA_VERSION } from './schema.js';
import { clearedSessionCookie, readSessionId, sessionCookie } from './session.js';
import type { SessionStore } from './session.js';
import { hashPassword, passwordTooShort, verifyPassword } from './passwords.js';
import { evaluate as evaluateGate } from './registration.js';
import type { RegistrationGate } from './registration.js';
import { BOOTSTRAP_USER_ID, findUserByEmail, registerUser } from './users.js';
import { removeSubscription, storeSubscription } from './push.js';
import { BackupValidationError, validateOne } from './validate.js';
import type { PerformanceTest } from '../src/core/types.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  PlanSlotRecord,
  SettingsRecord,
  WorkoutRecord,
} from '../src/db/schema.js';

/**
 * Bumped when a client written against an older shape would misread this one.
 *
 * The snapshot carries it so an out-of-date installed PWA can say "update required" instead of
 * failing one request at a time in six different ways.
 */
export const API_VERSION = 1;

export interface ApiContext {
  readonly db: DatabaseSync;
  readonly sessions: SessionStore;
  /**
   * The digest of the dev/global token, present only when the token login is enabled.
   *
   * Production leaves this `undefined`: real accounts replaced the single shared token (LBV-1480).
   * The tests and an explicit `GODMODE_DEV_TOKEN` deployment set it, and only then does
   * `POST /api/session` accept a `{ token }` body — for the bootstrap owner and no one else.
   */
  readonly devTokenDigest?: Buffer | undefined;
  readonly limiter: AttemptLimiter;
  /** The single registration policy, consulted when a password account is created. */
  readonly registration: RegistrationGate;
  /** Epoch milliseconds. Injectable so session expiry and rate limits are testable. */
  readonly now: () => number;
}

export interface Snapshot {
  readonly apiVersion: number;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly exercises: readonly ExerciseRecord[];
  readonly challenges: readonly ChallengeRecord[];
  readonly planSlots: readonly PlanSlotRecord[];
  readonly workouts: readonly WorkoutRecord[];
  readonly performanceTests: readonly PerformanceTest[];
  readonly settings: SettingsRecord;
}

/**
 * The whole dataset, as one coherent read.
 *
 * At 29 workouts — and at 500 — one snapshot is smaller and far simpler than a set of
 * paginated, individually-stale reads, and it is the only shape that lets the client render a
 * history without holes. Must be called inside a transaction; every caller here does.
 *
 * Workouts come back in `performed_at` order because that is the order they happened in.
 */
export function readSnapshot(db: DatabaseSync, userId: string): Snapshot {
  return {
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    revision: readRevision(db, userId),
    // `exercises` is global (`server/schema.sql`), so `listRecords` returns the shared catalog for
    // every user; the rest are filtered to this user's rows.
    exercises: listRecords(db, EXERCISES, 'created_at, id', userId),
    challenges: listRecords(db, CHALLENGES, 'started_at, id', userId),
    planSlots: listRecords(db, PLAN_SLOTS, 'challenge_id, ordinal, id', userId),
    workouts: listRecords(db, WORKOUTS, 'performed_at, id', userId),
    performanceTests: listRecords(db, PERFORMANCE_TESTS, 'performed_at, id', userId),
    settings: readSettings(db, userId),
  };
}

// ── Request parsing helpers ─────────────────────────────────────────────────────────────────

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_body', `${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Reject unknown top-level keys.
 *
 * The same reasoning as `checkObject` in `server/validate.ts`: a key this build does not know
 * is a key it would drop, and a command that silently drops half of what it was sent is worse
 * than one that fails.
 */
function requireKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new HttpError(400, 'unknown_field', `${what} does not accept "${key}".`);
    }
  }
}

function requireExpectedRevision(body: Record<string, unknown>): number {
  const value = body['expectedRevision'];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HttpError(
      400,
      'invalid_revision',
      'expectedRevision must be the whole number from the snapshot this command was composed ' +
        'against.',
    );
  }
  return value;
}

function requireString(body: Record<string, unknown>, key: string, what: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid_field', `${what} requires a non-empty "${key}".`);
  }
  return value;
}

function requireArray(body: Record<string, unknown>, key: string, what: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'invalid_field', `${what} requires "${key}" to be an array.`);
  }
  return value;
}

/** Run the strict validator and turn its issue list into a 422 the client can display. */
function validateRecord<T>(value: unknown, fields: FieldSpecMap, path: string): T {
  try {
    return validateOne<T>(value, fields, path);
  } catch (cause) {
    if (cause instanceof BackupValidationError) {
      throw new HttpError(422, 'invalid_record', cause.message, cause.issues);
    }
    throw cause;
  }
}

function checkRevision(db: DatabaseSync, userId: string, expected: number): void {
  const actual = readRevision(db, userId);
  if (actual !== expected) {
    throw new HttpError(
      409,
      'revision_conflict',
      `This command was composed against revision ${String(expected)} but the dataset is at ` +
        `${String(actual)}. Nothing has been changed; reload and try again.`,
    );
  }
}

// ── Record writing primitives ───────────────────────────────────────────────────────────────

type WriteOutcome = 'inserted' | 'identical';

/**
 * Insert a record, tolerate an identical one, refuse a different one.
 *
 * This is what makes every command retryable. Never `INSERT OR REPLACE`: SQLite's REPLACE
 * deletes the conflicting row and inserts a new one, firing `ON DELETE` actions on the way —
 * a delete nobody asked for, on the only copy of the data.
 */
function insertOrVerify<R extends { id: string }>(
  db: DatabaseSync,
  mapping: TableMapping<R>,
  record: R,
  userId: string,
): WriteOutcome {
  const existing = findRecord(db, mapping, record.id, userId);
  if (existing === undefined) {
    insertRecord(db, mapping, record, userId);
    return 'inserted';
  }
  if (canonicallyEqual(existing, record)) return 'identical';
  throw new HttpError(
    409,
    'record_conflict',
    `${mapping.table} already holds a different record under id "${record.id}". ` +
      'Nothing has been changed.',
  );
}

/**
 * Overwrite every non-id column from a validated record, within the user's scope.
 *
 * The `AND user_id = ?` on a `perUser` table is defence in depth: the record was already fetched
 * through a user-scoped `findRecord`, so it cannot name another user's row, but stating the tenant
 * on the write too means no update can ever cross users even if a future caller skips the read.
 */
function updateRecord<R extends { id: string }>(
  db: DatabaseSync,
  mapping: TableMapping<R>,
  record: R,
  userId: string,
): void {
  const columns = mapping.columns.filter((column) => column !== 'id');
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const row = mapping.encode(record);
  const all = bindValues(mapping, row);
  const byColumn = new Map(mapping.columns.map((column, index) => [column, all[index]]));
  const values = columns.map((column) => byColumn.get(column) ?? null);
  if (mapping.perUser) {
    db.prepare(`UPDATE ${mapping.table} SET ${assignments} WHERE id = ? AND user_id = ?`).run(
      ...values,
      record.id,
      userId,
    );
    return;
  }
  db.prepare(`UPDATE ${mapping.table} SET ${assignments} WHERE id = ?`).run(...values, record.id);
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  readonly [key: string]: unknown;
}

/**
 * Append a finished workout.
 *
 * The command carries a **client-generated id** — the id the draft was promised when the
 * workout started (`src/db/repo.ts:592-599`). Everything below happens inside one transaction,
 * in this order, because every other order has a window:
 *
 * 1. Look the id up. If it is already stored, return the **original** stored workout: do not
 *    recount attempts, do not re-apply the ratchet, do not bump the revision. A retried POST
 *    must be indistinguishable from the first one that succeeded.
 * 2. Validate the records it references, which a snapshot-stale outbox entry may no longer
 *    match.
 * 3. Assign `attempt_no` as `MAX + 1` for the slot.
 * 4. Insert, then ratchet the slot.
 *
 * The ratchet is the rule from `repo.ts:698`: `completed` never falls back to `attempted`. A
 * late-arriving failed attempt from the other device, or a deload logged against a day already
 * cleared, must not re-lock a day the owner has finished and send him back to repeat it. Slots
 * that are `superseded` or `cancelled` keep their status too — the workout is still stored,
 * because throwing away performed training is never the right answer, but a slot that is no
 * longer part of the plan does not re-enter it.
 */
function appendWorkout(
  ctx: ApiContext,
  userId: string,
  body: Record<string, unknown>,
): CommandResult {
  requireKeys(body, ['workout'], 'POST /api/workouts');
  const submitted = asObject(body['workout'], 'workout');

  if (Object.hasOwn(submitted, 'attemptNo')) {
    throw new HttpError(
      400,
      'attempt_no_not_accepted',
      'attemptNo is assigned by the server and must not be sent. It is an acceptance sequence, ' +
        'not a property of the workout.',
    );
  }
  const workoutId = requireString(submitted, 'id', 'A workout');
  const planSlotId = requireString(submitted, 'planSlotId', 'A finished workout');

  return inWriteTransaction(ctx.db, (): CommandResult => {
    const stored = findRecord(ctx.db, WORKOUTS, workoutId, userId);
    if (stored !== undefined) {
      return {
        workout: stored,
        attemptNo: stored.attemptNo,
        duplicate: true,
        snapshot: readSnapshot(ctx.db, userId),
      };
    }

    const slot = findRecord(ctx.db, PLAN_SLOTS, planSlotId, userId);
    if (slot === undefined) {
      throw new HttpError(
        409,
        'unknown_plan_slot',
        `No plan slot "${planSlotId}" exists. The workout has not been stored.`,
      );
    }
    const challengeId = requireString(submitted, 'challengeId', 'A workout');
    const challenge = findRecord(ctx.db, CHALLENGES, challengeId, userId);
    if (challenge === undefined) {
      throw new HttpError(
        409,
        'unknown_challenge',
        `No challenge "${challengeId}" exists. The workout has not been stored.`,
      );
    }
    if (slot.challengeId !== challenge.id) {
      throw new HttpError(
        409,
        'slot_challenge_mismatch',
        `Plan slot "${planSlotId}" belongs to challenge "${slot.challengeId}", not ` +
          `"${challenge.id}". The workout has not been stored.`,
      );
    }
    if (submitted['chainId'] !== challenge.chainId) {
      throw new HttpError(
        409,
        'chain_mismatch',
        `The workout claims chain "${String(submitted['chainId'])}" but challenge ` +
          `"${challenge.id}" is on chain "${challenge.chainId}". The workout has not been stored.`,
      );
    }

    // Scoped by user as well as slot: attempt numbers are a sequence per this user's slot. A slot
    // id belongs to one user already, so this is belt-and-braces, but it keeps the query honest.
    const highest = ctx.db
      .prepare('SELECT MAX(attempt_no) AS highest FROM workouts WHERE plan_slot_id = ? AND user_id = ?')
      .get(planSlotId, userId) as { highest: number | null } | undefined;
    const attemptNo = (highest?.highest ?? 0) + 1;

    const workout = validateRecord<WorkoutRecord>(
      { ...submitted, attemptNo },
      WORKOUT_FIELDS,
      'workout',
    );
    insertRecord(ctx.db, WORKOUTS, workout, userId);

    const nextStatus = ratchet(slot.status, workout.evaluation?.advances === true);
    if (nextStatus !== slot.status) {
      updateRecord(ctx.db, PLAN_SLOTS, { ...slot, status: nextStatus }, userId);
    }

    bumpRevision(ctx.db, userId, isoNow(ctx));
    return {
      workout,
      attemptNo,
      duplicate: false,
      snapshot: readSnapshot(ctx.db, userId),
    };
  });
}

/** `completed` is a one-way door; slots outside the plan are left alone. See `repo.ts:694`. */
export function ratchet(
  current: PlanSlotRecord['status'],
  advances: boolean,
): PlanSlotRecord['status'] {
  if (current === 'completed' || current === 'superseded' || current === 'cancelled') return current;
  return advances ? 'completed' : 'attempted';
}

/**
 * Create a challenge and its plan — `repo.ts:176`, plus the two records onboarding needs.
 *
 * `exercise` and `performanceTest` are optional because the first challenge is created in the
 * same breath as the exercise it trains and the rested max that seeded it. Today that is three
 * separate IndexedDB transactions and a failure between them leaves an orphan; here it is one.
 */
function createChallenge(
  ctx: ApiContext,
  userId: string,
  body: Record<string, unknown>,
): CommandResult {
  requireKeys(
    body,
    ['expectedRevision', 'exercise', 'performanceTest', 'challenge', 'slots', 'select'],
    'POST /api/challenges',
  );
  const expected = requireExpectedRevision(body);
  const select = body['select'] === true;

  const exercise =
    body['exercise'] === undefined
      ? undefined
      : validateRecord<ExerciseRecord>(body['exercise'], EXERCISE_FIELDS, 'exercise');
  const performanceTest =
    body['performanceTest'] === undefined
      ? undefined
      : validateRecord<PerformanceTest>(
          body['performanceTest'],
          PERFORMANCE_TEST_FIELDS,
          'performanceTest',
        );
  const challenge = validateRecord<ChallengeRecord>(
    body['challenge'],
    CHALLENGE_FIELDS,
    'challenge',
  );
  const slots = requireArray(body, 'slots', 'POST /api/challenges').map((slot, index) =>
    validateRecord<PlanSlotRecord>(slot, PLAN_SLOT_FIELDS, `slots[${String(index)}]`),
  );
  assertSlotsBelongTo(slots, challenge);
  assertFreshPlan(slots);
  if (challenge.status !== 'active') {
    throw new HttpError(422, 'challenge_not_active', 'A challenge is created active.');
  }
  if (performanceTest !== undefined && performanceTest.exerciseId !== challenge.exerciseId) {
    throw new HttpError(
      422,
      'test_exercise_mismatch',
      'The seeding max test must be for the exercise the challenge trains.',
    );
  }

  return inWriteTransaction(ctx.db, (): CommandResult => {
    checkRevision(ctx.db, userId, expected);
    if (exercise !== undefined) insertOrVerify(ctx.db, EXERCISES, exercise, userId);
    if (performanceTest !== undefined)
      insertOrVerify(ctx.db, PERFORMANCE_TESTS, performanceTest, userId);
    insertOrVerify(ctx.db, CHALLENGES, challenge, userId);
    for (const slot of slots) insertOrVerify(ctx.db, PLAN_SLOTS, slot, userId);
    if (select) selectChallenge(ctx.db, userId, challenge.id);
    bumpRevision(ctx.db, userId, isoNow(ctx));
    return { challengeId: challenge.id, snapshot: readSnapshot(ctx.db, userId) };
  });
}

/** `repo.ts:283`. Ending an already-ended challenge is refused, not silently redone. */
function endChallenge(
  ctx: ApiContext,
  userId: string,
  challengeId: string,
  body: Record<string, unknown>,
): CommandResult {
  requireKeys(body, ['expectedRevision', 'endReason', 'endedAt'], 'POST /api/challenges/:id/end');
  const expected = requireExpectedRevision(body);
  const endReason = requireString(body, 'endReason', 'Ending a challenge');
  const endedAt = requireString(body, 'endedAt', 'Ending a challenge');

  return inWriteTransaction(ctx.db, (): CommandResult => {
    checkRevision(ctx.db, userId, expected);
    const challenge = findRecord(ctx.db, CHALLENGES, challengeId, userId);
    if (challenge === undefined) {
      throw new HttpError(404, 'unknown_challenge', `No challenge "${challengeId}" exists.`);
    }
    if (challenge.status === 'ended') {
      throw new HttpError(
        409,
        'already_ended',
        `Challenge "${challengeId}" ended at ${challenge.endedAt ?? 'an unrecorded time'}. ` +
          'Nothing has been changed.',
      );
    }
    const ended = validateRecord<ChallengeRecord>(
      { ...challenge, status: 'ended', endedAt, endReason },
      CHALLENGE_FIELDS,
      'challenge',
    );
    updateRecord(ctx.db, CHALLENGES, ended, userId);
    bumpRevision(ctx.db, userId, isoNow(ctx));
    return { challengeId, snapshot: readSnapshot(ctx.db, userId) };
  });
}

/**
 * End this block and start the next one — `repo.ts:343`, one transaction as it is today.
 *
 * The successor and its slots are built by the pure generator on the client (`buildChallenge`,
 * `repo.ts:142`, which touches no storage) and validated here. Splitting this into "end" then
 * "create" over HTTP would reintroduce exactly the failure this function was written to remove:
 * an ended plan with no successor, no next session and no obvious way back.
 */
function startNextBlock(
  ctx: ApiContext,
  userId: string,
  body: Record<string, unknown>,
): CommandResult {
  requireKeys(
    body,
    ['expectedRevision', 'previousChallengeId', 'endedAt', 'performanceTest', 'challenge', 'slots'],
    'POST /api/challenges/next-block',
  );
  const expected = requireExpectedRevision(body);
  const previousId = requireString(body, 'previousChallengeId', 'Starting the next block');
  const endedAt = requireString(body, 'endedAt', 'Starting the next block');
  const performanceTest =
    body['performanceTest'] === undefined
      ? undefined
      : validateRecord<PerformanceTest>(
          body['performanceTest'],
          PERFORMANCE_TEST_FIELDS,
          'performanceTest',
        );
  const challenge = validateRecord<ChallengeRecord>(
    body['challenge'],
    CHALLENGE_FIELDS,
    'challenge',
  );
  const slots = requireArray(body, 'slots', 'POST /api/challenges/next-block').map((slot, index) =>
    validateRecord<PlanSlotRecord>(slot, PLAN_SLOT_FIELDS, `slots[${String(index)}]`),
  );
  assertSlotsBelongTo(slots, challenge);
  assertFreshPlan(slots);
  if (challenge.status !== 'active') {
    throw new HttpError(422, 'challenge_not_active', 'The successor block starts active.');
  }
  if (challenge.id === previousId) {
    throw new HttpError(
      422,
      'successor_mismatch',
      'The successor must be a new challenge, not the one it replaces.',
    );
  }

  return inWriteTransaction(ctx.db, (): CommandResult => {
    checkRevision(ctx.db, userId, expected);
    const previous = findRecord(ctx.db, CHALLENGES, previousId, userId);
    if (previous === undefined) {
      throw new HttpError(404, 'unknown_challenge', `No challenge "${previousId}" exists.`);
    }
    if (previous.status === 'ended') {
      throw new HttpError(
        409,
        'already_ended',
        `Challenge "${previousId}" has already ended. Nothing has been changed.`,
      );
    }
    if (challenge.chainId !== previous.chainId) {
      throw new HttpError(
        409,
        'chain_mismatch',
        'The successor must continue the same chain as the block it replaces.',
      );
    }
    if (challenge.previousChallengeId !== previous.id) {
      throw new HttpError(
        409,
        'successor_mismatch',
        'The successor must name the block it replaces in previousChallengeId.',
      );
    }
    if (challenge.exerciseId !== previous.exerciseId) {
      throw new HttpError(
        409,
        'exercise_mismatch',
        'A chain trains one exercise. The successor names a different one.',
      );
    }
    if (performanceTest !== undefined && performanceTest.exerciseId !== previous.exerciseId) {
      throw new HttpError(
        409,
        'test_exercise_mismatch',
        'The retest must be for the exercise this chain trains.',
      );
    }

    const ended = validateRecord<ChallengeRecord>(
      { ...previous, status: 'ended', endedAt, endReason: 'superseded' },
      CHALLENGE_FIELDS,
      'challenge',
    );
    updateRecord(ctx.db, CHALLENGES, ended, userId);
    if (performanceTest !== undefined)
      insertOrVerify(ctx.db, PERFORMANCE_TESTS, performanceTest, userId);
    insertOrVerify(ctx.db, CHALLENGES, challenge, userId);
    for (const slot of slots) insertOrVerify(ctx.db, PLAN_SLOTS, slot, userId);
    selectChallenge(ctx.db, userId, challenge.id);
    bumpRevision(ctx.db, userId, isoNow(ctx));
    return { challengeId: challenge.id, snapshot: readSnapshot(ctx.db, userId) };
  });
}

/**
 * `repo.ts:201` — a whole import, or nothing.
 *
 * Its workouts may legitimately carry no `planSlotId` and their own `attemptNo`: a session
 * imported from the incumbent app that could not be reconciled to a generated slot is unlinked
 * (`src/import/reconcile.ts:100-107`), and the partial unique index in `schema.sql` exists
 * precisely so those can coexist.
 */
function commitImport(
  ctx: ApiContext,
  userId: string,
  body: Record<string, unknown>,
): CommandResult {
  requireKeys(
    body,
    ['expectedRevision', 'exercise', 'challenge', 'slots', 'workouts', 'select'],
    'POST /api/import',
  );
  const expected = requireExpectedRevision(body);
  const select = body['select'] === true;
  const exercise = validateRecord<ExerciseRecord>(body['exercise'], EXERCISE_FIELDS, 'exercise');
  const challenge = validateRecord<ChallengeRecord>(
    body['challenge'],
    CHALLENGE_FIELDS,
    'challenge',
  );
  const slots = requireArray(body, 'slots', 'POST /api/import').map((slot, index) =>
    validateRecord<PlanSlotRecord>(slot, PLAN_SLOT_FIELDS, `slots[${String(index)}]`),
  );
  const workouts = requireArray(body, 'workouts', 'POST /api/import').map((workout, index) =>
    validateRecord<WorkoutRecord>(workout, WORKOUT_FIELDS, `workouts[${String(index)}]`),
  );
  assertSlotsBelongTo(slots, challenge);

  if (challenge.exerciseId !== exercise.id) {
    throw new HttpError(
      422,
      'exercise_mismatch',
      'The imported challenge must train the exercise the import carries.',
    );
  }

  return inWriteTransaction(ctx.db, (): CommandResult => {
    checkRevision(ctx.db, userId, expected);
    assertImportedWorkouts(ctx.db, userId, workouts, challenge, slots);
    insertOrVerify(ctx.db, EXERCISES, exercise, userId);
    insertOrVerify(ctx.db, CHALLENGES, challenge, userId);
    for (const slot of slots) insertOrVerify(ctx.db, PLAN_SLOTS, slot, userId);
    for (const workout of workouts) insertOrVerify(ctx.db, WORKOUTS, workout, userId);
    if (select) selectChallenge(ctx.db, userId, challenge.id);
    bumpRevision(ctx.db, userId, isoNow(ctx));
    return {
      exerciseId: exercise.id,
      challengeId: challenge.id,
      workoutCount: workouts.length,
      snapshot: readSnapshot(ctx.db, userId),
    };
  });
}

/**
 * `repo.ts:72` — read, merge, write, now with a revision check around it.
 *
 * **`null` clears an optional field.** JSON has no `undefined`, so the read-merge-write that
 * `{...current, ...patch}` performs in the browser cannot be expressed over the wire without
 * choosing a spelling for "remove this". `null` is that spelling; an absent key means "leave it
 * alone". Sending `undefined` is impossible and sending the string `"null"` is a value.
 */
function patchSettings(
  ctx: ApiContext,
  userId: string,
  body: Record<string, unknown>,
): CommandResult {
  requireKeys(body, ['expectedRevision', 'patch'], 'PATCH /api/settings');
  const expected = requireExpectedRevision(body);
  const patch = asObject(body['patch'], 'patch');
  for (const key of Object.keys(patch)) {
    if (key === 'id') {
      throw new HttpError(400, 'unknown_field', 'The settings row id is fixed and cannot be set.');
    }
    if (!Object.hasOwn(SETTINGS_FIELDS, key)) {
      throw new HttpError(400, 'unknown_field', `Settings have no "${key}".`);
    }
  }

  return inWriteTransaction(ctx.db, (): CommandResult => {
    checkRevision(ctx.db, userId, expected);
    const merged: Record<string, unknown> = { ...readSettings(ctx.db, userId) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    merged['id'] = SETTINGS_ROW_ID;
    const settings = validateRecord<SettingsRecord>(merged, SETTINGS_FIELDS, 'settings');
    writeSettings(ctx.db, userId, settings);
    bumpRevision(ctx.db, userId, isoNow(ctx));
    return { snapshot: readSnapshot(ctx.db, userId) };
  });
}

function selectChallenge(db: DatabaseSync, userId: string, challengeId: string): void {
  writeSettings(db, userId, { ...readSettings(db, userId), selectedChallengeId: challengeId });
}

function assertSlotsBelongTo(slots: readonly PlanSlotRecord[], challenge: ChallengeRecord): void {
  for (const slot of slots) {
    if (slot.challengeId !== challenge.id) {
      throw new HttpError(
        422,
        'slot_challenge_mismatch',
        `Plan slot "${slot.id}" names challenge "${slot.challengeId}", not "${challenge.id}".`,
      );
    }
  }
}

/**
 * A freshly generated plan starts every slot `available`, and supersedes nothing.
 *
 * That is what the generator produces (`repo.ts:233`), and requiring it here is what stops a
 * command from installing a plan that already claims days were completed — a state no workout
 * supports, and one that the append path could then never correct, because the ratchet only
 * moves forward. Superseding an existing slot is a different operation and would need its own
 * endpoint carrying the slot it replaces; historical plans arrive through `/api/import`.
 */
function assertFreshPlan(slots: readonly PlanSlotRecord[]): void {
  for (const slot of slots) {
    if (slot.status !== 'available') {
      throw new HttpError(
        422,
        'slot_not_fresh',
        `Plan slot "${slot.id}" arrives as "${slot.status}". A newly generated plan starts every ` +
          'slot available; a plan with history behind it belongs in an import.',
      );
    }
    if (slot.supersedesId !== undefined) {
      throw new HttpError(
        422,
        'slot_not_fresh',
        `Plan slot "${slot.id}" supersedes "${slot.supersedesId}". Regenerating a slot is not ` +
          'part of creating a challenge.',
      );
    }
  }
}

/**
 * Everything an imported workout must agree with before it is written.
 *
 * The import endpoint carries one challenge and its whole history, so each workout must belong
 * to that challenge and that chain. Linked workouts must name a slot that exists — in this
 * command or already stored — and no two may claim the same attempt number on the same slot.
 * The partial unique index in `schema.sql:265` would catch the last one, but as a raw SQLite
 * error rather than a message saying which record is at fault.
 *
 * What is deliberately *not* checked: whether each slot's status agrees with the evaluations of
 * the workouts against it. Import reconciles months of sessions recorded by another app
 * (`src/import/reconcile.ts`); the server recomputing what those sessions "should" have meant
 * would be manufacturing prescription from actuals, which is exactly what this project forbids.
 */
function assertImportedWorkouts(
  db: DatabaseSync,
  userId: string,
  workouts: readonly WorkoutRecord[],
  challenge: ChallengeRecord,
  slots: readonly PlanSlotRecord[],
): void {
  const known = new Map(slots.map((slot) => [slot.id, slot]));
  const claimed = new Set<string>();

  for (const workout of workouts) {
    if (workout.challengeId !== challenge.id) {
      throw new HttpError(
        422,
        'workout_challenge_mismatch',
        `Workout "${workout.id}" names challenge "${workout.challengeId}", not "${challenge.id}".`,
      );
    }
    if (workout.chainId !== challenge.chainId) {
      throw new HttpError(
        422,
        'chain_mismatch',
        `Workout "${workout.id}" names chain "${workout.chainId}", not "${challenge.chainId}".`,
      );
    }
    if (workout.planSlotId === undefined) continue;

    const slot =
      known.get(workout.planSlotId) ?? findRecord(db, PLAN_SLOTS, workout.planSlotId, userId);
    if (slot === undefined) {
      throw new HttpError(
        422,
        'unknown_plan_slot',
        `Workout "${workout.id}" names plan slot "${workout.planSlotId}", which does not exist.`,
      );
    }
    if (slot.challengeId !== workout.challengeId) {
      throw new HttpError(
        422,
        'slot_challenge_mismatch',
        `Workout "${workout.id}" links to a plan slot belonging to another challenge.`,
      );
    }

    const key = `${workout.planSlotId}#${String(workout.attemptNo)}`;
    if (claimed.has(key)) {
      throw new HttpError(
        422,
        'attempt_collision',
        `Two workouts claim attempt ${String(workout.attemptNo)} on plan slot ` +
          `"${workout.planSlotId}". Attempt numbers are unique per slot.`,
      );
    }
    claimed.add(key);
  }
}

function isoNow(ctx: ApiContext): string {
  return new Date(ctx.now()).toISOString();
}

// ── Push subscriptions ────────────────────────────────────────────────────────────────────────
//
// Device state, not domain data: these do NOT carry `expectedRevision`, do NOT bump the revision,
// and return `204` rather than a snapshot. A subscription is the encrypted-delivery address of one
// browser; storing or dropping it changes nothing about the training history the snapshot describes.
// Sending to them, and the VAPID keypair, are a separate DevOps ticket (LBV-1481).

/**
 * Store (or replace) this device's push subscription for the signed-in user.
 *
 * The body is the browser's `PushSubscription`, flattened by the client to `{ endpoint, p256dh,
 * auth }` (`src/push/subscribe.ts`). Idempotent on `endpoint`: re-subscribing the same browser
 * replaces the row rather than adding a second, so a client that resubscribes on every load never
 * accumulates duplicates.
 */
function putPushSubscription(
  ctx: ApiContext,
  userId: string,
  body: Record<string, unknown>,
): void {
  requireKeys(body, ['endpoint', 'p256dh', 'auth'], 'PUT /api/push/subscription');
  const endpoint = requireString(body, 'endpoint', 'A push subscription');
  const p256dh = requireString(body, 'p256dh', 'A push subscription');
  const auth = requireString(body, 'auth', 'A push subscription');
  storeSubscription(ctx.db, userId, { endpoint, p256dh, auth }, isoNow(ctx));
}

/**
 * Drop a subscription by endpoint — what the client calls when the push service answers `410 Gone`,
 * or when the user turns reminders off. Scoped to the owner and idempotent: removing one that is
 * not there (already gone, or never this user's) is a `204`, not an error.
 */
function deletePushSubscription(
  ctx: ApiContext,
  userId: string,
  body: Record<string, unknown>,
): void {
  requireKeys(body, ['endpoint'], 'DELETE /api/push/subscription');
  const endpoint = requireString(body, 'endpoint', 'A push subscription');
  removeSubscription(ctx.db, userId, endpoint);
}

// ── Session endpoints ───────────────────────────────────────────────────────────────────────

/** Long enough for any real address, short enough that scrypt is never handed an abusive input. */
const MAX_EMAIL_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 200;

/**
 * A pragmatic email check: present, one `@` with something either side, within length.
 *
 * Deliberately not RFC 5322 — the only authority on whether an address is real is whether mail
 * reaches it, which this server does not test. What it rejects is the shapes that are certainly
 * not addresses, so a typo fails here rather than as a login that can never succeed.
 */
function requireEmail(body: Record<string, unknown>): string {
  const value = body['email'];
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_field', 'An email address is required.');
  }
  const email = value.trim();
  const at = email.indexOf('@');
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || at <= 0 || at === email.length - 1) {
    throw new HttpError(400, 'invalid_email', 'That does not look like an email address.');
  }
  return email;
}

function requirePassword(body: Record<string, unknown>): string {
  const value = body['password'];
  if (typeof value !== 'string' || value === '') {
    throw new HttpError(400, 'invalid_field', 'A password is required.');
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, 'invalid_field', 'That password is too long.');
  }
  return value;
}

/**
 * Discard whatever session the caller presented, mint a fresh one for `userId`, and answer.
 *
 * A new id is always generated and the presented one dropped first — the two moves that make
 * session fixation impossible (see `server/session.ts`). Shared by password login and
 * registration, so both routes are fixation-safe by construction rather than by each remembering
 * to be.
 */
function establishSession(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  now: number,
  status: number,
): void {
  ctx.sessions.destroy(readSessionId(req));
  const id = ctx.sessions.create(userId, now);
  const expiresAt = ctx.sessions.expiresAt(id) ?? now;
  sendJson(
    res,
    status,
    { authenticated: true, expiresAt: new Date(expiresAt).toISOString(), apiVersion: API_VERSION },
    { 'Set-Cookie': sessionCookie(id, Math.floor((expiresAt - now) / 1000)) },
  );
}

/** The 429 every credential endpoint sends once the attempt limiter has closed the window. */
function tooManyAttempts(res: ServerResponse, retryAfterSeconds: number): void {
  sendJson(
    res,
    429,
    { error: 'too_many_attempts', message: 'Too many failed attempts. Wait and try again.' },
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

/**
 * Sign in: `{ email, password }` for a real account, or `{ token }` for the dev/global token.
 *
 * The single shared token is gone from production (LBV-1480). It survives only as a developer
 * convenience, accepted **exactly when `ctx.devTokenDigest` is set** — by the tests, or by an
 * explicit `GODMODE_DEV_TOKEN` deployment — and even then only for the bootstrap owner. A `token`
 * body against a server without it configured is refused like any other bad credential.
 *
 * Rate limiting is unchanged from the token era: keyed by remote address, a success below the
 * threshold clears the counter, and once the window is closed even a correct credential waits.
 * The same limiter guards registration, so neither passwords nor invite codes can be brute-forced.
 */
async function openSession(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const key = req.socket.remoteAddress ?? 'unknown';
  const now = ctx.now();
  const decision = ctx.limiter.check(key, now);
  if (!decision.allowed) {
    tooManyAttempts(res, decision.retryAfterSeconds);
    return;
  }

  const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');

  // Dev/global token path: only offered when a token is configured, and only for the owner.
  if (Object.hasOwn(body, 'token') && !Object.hasOwn(body, 'email')) {
    requireKeys(body, ['token'], 'POST /api/session');
    const token = body['token'];
    const ok =
      ctx.devTokenDigest !== undefined &&
      typeof token === 'string' &&
      token !== '' &&
      tokenMatches(token, ctx.devTokenDigest);
    if (!ok) {
      ctx.limiter.recordFailure(key, now);
      // Never echo any part of what was sent: a reflected token ends up in a log or a screenshot.
      throw new HttpError(401, 'invalid_token', 'That token is not correct.');
    }
    ctx.limiter.recordSuccess(key);
    establishSession(ctx, req, res, BOOTSTRAP_USER_ID, now, 200);
    return;
  }

  // Real account: email + password.
  requireKeys(body, ['email', 'password'], 'POST /api/session');
  const email = requireEmail(body);
  const password = requirePassword(body);

  const user = findUserByEmail(ctx.db, email);
  // Verify against the found hash, or against a throwaway to keep the timing of "no such user" and
  // "wrong password" indistinguishable — a login form must not double as an email-enumeration
  // oracle. `verifyPassword` on a non-match still runs scrypt, so both branches cost the same.
  const ok =
    user?.passwordHash !== undefined
      ? verifyPassword(password, user.passwordHash)
      : (verifyPassword(password, INVALID_HASH), false);
  if (!ok || user === undefined) {
    ctx.limiter.recordFailure(key, now);
    throw new HttpError(401, 'invalid_credentials', 'That email or password is not correct.');
  }

  ctx.limiter.recordSuccess(key);
  establishSession(ctx, req, res, user.id, now, 200);
}

/**
 * A well-formed scrypt hash of a value nobody has, so the "no such user" branch of login spends
 * the same time as the "wrong password" branch. Its plaintext is irrelevant — it is never matched.
 */
const INVALID_HASH = hashPassword(' invalid-account ');

/**
 * Create an account: `{ email, password, inviteCode?, displayName? }`.
 *
 * Gated by the single registration policy (`ctx.registration`) — open, invite-coded, or closed —
 * so this endpoint on an internet-reachable box is not an open sign-up form. On success it mints a
 * user-bound session immediately, so registering signs you in; there is no separate confirm step.
 *
 * Shares the login rate limiter: a wrong invite code records a failure, so the code cannot be
 * brute-forced any more than a password can. A duplicate email is a `409`, not a limiter failure —
 * it is a user error, not an attack, and penalising it would let one person lock others out by
 * guessing their address.
 */
async function register(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = req.socket.remoteAddress ?? 'unknown';
  const now = ctx.now();
  const decision = ctx.limiter.check(key, now);
  if (!decision.allowed) {
    tooManyAttempts(res, decision.retryAfterSeconds);
    return;
  }

  const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
  requireKeys(body, ['email', 'password', 'inviteCode', 'displayName'], 'POST /api/register');
  const email = requireEmail(body);
  const password = requirePassword(body);
  if (passwordTooShort(password)) {
    throw new HttpError(
      422,
      'password_too_short',
      'That password is too short. Use at least eight characters.',
    );
  }

  const inviteCode = typeof body['inviteCode'] === 'string' ? body['inviteCode'] : undefined;
  const gate = evaluateGate(ctx.registration, inviteCode);
  if (!gate.allowed) {
    // An invalid code is a guess; a closed door or a missing code is not, so only the guess costs
    // an attempt.
    if (gate.reason === 'invite_invalid') ctx.limiter.recordFailure(key, now);
    throw new HttpError(
      gate.reason === 'registration_closed' ? 403 : 422,
      gate.reason ?? 'registration_refused',
      gate.message ?? 'Registration is not allowed.',
    );
  }

  const displayName = resolveDisplayName(body['displayName'], email);
  if (findUserByEmail(ctx.db, email) !== undefined) {
    throw new HttpError(
      409,
      'email_taken',
      'An account with that email already exists. Sign in instead.',
    );
  }

  const user = registerUser(ctx.db, {
    email,
    displayName,
    passwordHash: hashPassword(password),
    now: new Date(now).toISOString(),
  });
  ctx.limiter.recordSuccess(key);
  establishSession(ctx, req, res, user.id, now, 201);
}

/** A display name from the body if it is a usable string, else the local part of the email. */
function resolveDisplayName(raw: unknown, email: string): string {
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  const local = email.slice(0, email.indexOf('@')).trim();
  return local === '' ? email : local.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function closeSession(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): void {
  // Server-side first: a cleared cookie the server still honours is not a sign-out.
  ctx.sessions.destroy(readSessionId(req));
  sendEmpty(res, 204, { 'Set-Cookie': clearedSessionCookie() });
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────

const PUBLIC_ROUTES = new Set([
  'POST /session',
  'DELETE /session',
  'GET /session',
  'POST /register',
]);

/**
 * Route one `/api` request.
 *
 * Unknown paths and unknown methods are answered with a JSON 404/405 rather than falling
 * through to the static handler — an API call that quietly receives `index.html` is the single
 * most confusing failure a same-origin app can have.
 */
export async function handleApi(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = pathname.split('/').filter((part) => part !== '');
  // segments[0] is 'api'; the caller only routes here for /api paths.
  const rest = segments.slice(1);
  const route = `/${rest.join('/')}`;

  // Resolved for the protected routes below: the user this session authenticates, and therefore
  // the tenant every read and write is scoped to. `undefined` for a public route or a request with
  // no live session.
  let userId: string | undefined;

  try {
    if (rest[0] === 'session') {
      if (rest.length !== 1) throw notFound(route);
      if (method === 'POST') return await openSession(ctx, req, res);
      if (method === 'DELETE') return closeSession(ctx, req, res);
      if (method === 'GET') {
        const authenticated = ctx.sessions.validate(readSessionId(req), ctx.now()) !== undefined;
        // The client uses `registrationMode` to decide whether to show the invite field: only in
        // invite mode.
        return sendJson(res, 200, {
          authenticated,
          apiVersion: API_VERSION,
          registrationMode: ctx.registration.mode,
        });
      }
      throw methodNotAllowed(method, route);
    }

    if (rest[0] === 'register') {
      if (rest.length !== 1) throw notFound(route);
      if (method !== 'POST') throw methodNotAllowed(method, route);
      return await register(ctx, req, res);
    }

    if (!PUBLIC_ROUTES.has(`${method} ${route}`)) {
      userId = ctx.sessions.validate(readSessionId(req), ctx.now());
      if (userId === undefined) {
        throw new HttpError(
          401,
          'unauthenticated',
          'Sign in before using this endpoint.',
        );
      }
    }

    if (rest[0] === 'snapshot' && rest.length === 1) {
      if (method !== 'GET') throw methodNotAllowed(method, route);
      const scopedTo = userId!;
      const snapshot = inReadTransaction(ctx.db, () => readSnapshot(ctx.db, scopedTo));
      return sendJson(res, 200, snapshot);
    }

    if (rest[0] === 'workouts' && rest.length === 1) {
      if (method !== 'POST') throw methodNotAllowed(method, route);
      const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
      return sendJson(res, 201, appendWorkout(ctx, userId!, body));
    }

    if (rest[0] === 'challenges') {
      if (rest.length === 1) {
        if (method !== 'POST') throw methodNotAllowed(method, route);
        const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
        return sendJson(res, 201, createChallenge(ctx, userId!, body));
      }
      if (rest.length === 2 && rest[1] === 'next-block') {
        if (method !== 'POST') throw methodNotAllowed(method, route);
        const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
        return sendJson(res, 201, startNextBlock(ctx, userId!, body));
      }
      if (rest.length === 3 && rest[2] === 'end') {
        if (method !== 'POST') throw methodNotAllowed(method, route);
        const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
        return sendJson(res, 200, endChallenge(ctx, userId!, rest[1] ?? '', body));
      }
      throw notFound(route);
    }

    if (rest[0] === 'import' && rest.length === 1) {
      if (method !== 'POST') throw methodNotAllowed(method, route);
      const body = asObject(await readJsonBody(req, MAX_IMPORT_BODY_BYTES), 'The request body');
      return sendJson(res, 201, commitImport(ctx, userId!, body));
    }

    if (rest[0] === 'settings' && rest.length === 1) {
      if (method !== 'PATCH') throw methodNotAllowed(method, route);
      const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
      return sendJson(res, 200, patchSettings(ctx, userId!, body));
    }

    if (rest[0] === 'push' && rest[1] === 'subscription' && rest.length === 2) {
      if (method === 'PUT') {
        const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
        putPushSubscription(ctx, userId!, body);
        return sendEmpty(res, 204);
      }
      if (method === 'DELETE') {
        const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
        deletePushSubscription(ctx, userId!, body);
        return sendEmpty(res, 204);
      }
      throw methodNotAllowed(method, route);
    }

    throw notFound(route);
  } catch (cause) {
    respondToFailure(ctx, res, userId, cause);
  }
}

/**
 * Turn a thrown error into a response.
 *
 * Every 409 carries the fresh snapshot, because a conflict the client cannot see the current
 * state of is a conflict it can only resolve by guessing. Anything that is not an `HttpError`
 * is a bug in this server and is reported as a 500 with a generic message: the details go to
 * stderr, not to the client, so a stack trace or a file path never leaves the process.
 */
function respondToFailure(
  ctx: ApiContext,
  res: ServerResponse,
  userId: string | undefined,
  cause: unknown,
): void {
  if (res.headersSent) return;

  if (cause instanceof HttpError) {
    // Every 409 carries the fresh snapshot. A 409 can only be thrown from a command, which only
    // runs after the session resolved a `userId`, so it is defined here; the guard is belt-only.
    if (cause.status === 409 && userId !== undefined) {
      const scopedTo = userId;
      const snapshot = inReadTransaction(ctx.db, () => readSnapshot(ctx.db, scopedTo));
      const body: Record<string, unknown> = {
        error: cause.code,
        message: cause.message,
        snapshot,
      };
      if (cause.details !== undefined) body['details'] = cause.details;
      sendJson(res, 409, body);
      return;
    }
    sendError(res, cause);
    return;
  }

  console.error('[godmode] unhandled request failure:', cause);
  sendError(
    res,
    new HttpError(500, 'internal_error', 'The server failed to complete that request.'),
  );
}

function notFound(route: string): HttpError {
  return new HttpError(404, 'unknown_route', `There is no API route ${route}.`);
}

function methodNotAllowed(method: string, route: string): HttpError {
  return new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${route}.`);
}
