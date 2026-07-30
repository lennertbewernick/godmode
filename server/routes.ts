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
  readonly tokenDigest: Buffer;
  readonly limiter: AttemptLimiter;
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
export function readSnapshot(db: DatabaseSync): Snapshot {
  return {
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    revision: readRevision(db),
    exercises: listRecords(db, EXERCISES, 'created_at, id'),
    challenges: listRecords(db, CHALLENGES, 'started_at, id'),
    planSlots: listRecords(db, PLAN_SLOTS, 'challenge_id, ordinal, id'),
    workouts: listRecords(db, WORKOUTS, 'performed_at, id'),
    performanceTests: listRecords(db, PERFORMANCE_TESTS, 'performed_at, id'),
    settings: readSettings(db),
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

function checkRevision(db: DatabaseSync, expected: number): void {
  const actual = readRevision(db);
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
): WriteOutcome {
  const existing = findRecord(db, mapping, record.id);
  if (existing === undefined) {
    insertRecord(db, mapping, record);
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

/** Overwrite every non-id column from a validated record. */
function updateRecord<R extends { id: string }>(
  db: DatabaseSync,
  mapping: TableMapping<R>,
  record: R,
): void {
  const columns = mapping.columns.filter((column) => column !== 'id');
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const row = mapping.encode(record);
  const all = bindValues(mapping, row);
  const byColumn = new Map(mapping.columns.map((column, index) => [column, all[index]]));
  const values = columns.map((column) => byColumn.get(column) ?? null);
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
function appendWorkout(ctx: ApiContext, body: Record<string, unknown>): CommandResult {
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
    const stored = findRecord(ctx.db, WORKOUTS, workoutId);
    if (stored !== undefined) {
      return {
        workout: stored,
        attemptNo: stored.attemptNo,
        duplicate: true,
        snapshot: readSnapshot(ctx.db),
      };
    }

    const slot = findRecord(ctx.db, PLAN_SLOTS, planSlotId);
    if (slot === undefined) {
      throw new HttpError(
        409,
        'unknown_plan_slot',
        `No plan slot "${planSlotId}" exists. The workout has not been stored.`,
      );
    }
    const challengeId = requireString(submitted, 'challengeId', 'A workout');
    const challenge = findRecord(ctx.db, CHALLENGES, challengeId);
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

    const highest = ctx.db
      .prepare('SELECT MAX(attempt_no) AS highest FROM workouts WHERE plan_slot_id = ?')
      .get(planSlotId) as { highest: number | null } | undefined;
    const attemptNo = (highest?.highest ?? 0) + 1;

    const workout = validateRecord<WorkoutRecord>(
      { ...submitted, attemptNo },
      WORKOUT_FIELDS,
      'workout',
    );
    insertRecord(ctx.db, WORKOUTS, workout);

    const nextStatus = ratchet(slot.status, workout.evaluation?.advances === true);
    if (nextStatus !== slot.status) {
      updateRecord(ctx.db, PLAN_SLOTS, { ...slot, status: nextStatus });
    }

    bumpRevision(ctx.db, isoNow(ctx));
    return {
      workout,
      attemptNo,
      duplicate: false,
      snapshot: readSnapshot(ctx.db),
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
function createChallenge(ctx: ApiContext, body: Record<string, unknown>): CommandResult {
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
    checkRevision(ctx.db, expected);
    if (exercise !== undefined) insertOrVerify(ctx.db, EXERCISES, exercise);
    if (performanceTest !== undefined) insertOrVerify(ctx.db, PERFORMANCE_TESTS, performanceTest);
    insertOrVerify(ctx.db, CHALLENGES, challenge);
    for (const slot of slots) insertOrVerify(ctx.db, PLAN_SLOTS, slot);
    if (select) selectChallenge(ctx.db, challenge.id);
    bumpRevision(ctx.db, isoNow(ctx));
    return { challengeId: challenge.id, snapshot: readSnapshot(ctx.db) };
  });
}

/** `repo.ts:283`. Ending an already-ended challenge is refused, not silently redone. */
function endChallenge(
  ctx: ApiContext,
  challengeId: string,
  body: Record<string, unknown>,
): CommandResult {
  requireKeys(body, ['expectedRevision', 'endReason', 'endedAt'], 'POST /api/challenges/:id/end');
  const expected = requireExpectedRevision(body);
  const endReason = requireString(body, 'endReason', 'Ending a challenge');
  const endedAt = requireString(body, 'endedAt', 'Ending a challenge');

  return inWriteTransaction(ctx.db, (): CommandResult => {
    checkRevision(ctx.db, expected);
    const challenge = findRecord(ctx.db, CHALLENGES, challengeId);
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
    updateRecord(ctx.db, CHALLENGES, ended);
    bumpRevision(ctx.db, isoNow(ctx));
    return { challengeId, snapshot: readSnapshot(ctx.db) };
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
function startNextBlock(ctx: ApiContext, body: Record<string, unknown>): CommandResult {
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
    checkRevision(ctx.db, expected);
    const previous = findRecord(ctx.db, CHALLENGES, previousId);
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
    updateRecord(ctx.db, CHALLENGES, ended);
    if (performanceTest !== undefined) insertOrVerify(ctx.db, PERFORMANCE_TESTS, performanceTest);
    insertOrVerify(ctx.db, CHALLENGES, challenge);
    for (const slot of slots) insertOrVerify(ctx.db, PLAN_SLOTS, slot);
    selectChallenge(ctx.db, challenge.id);
    bumpRevision(ctx.db, isoNow(ctx));
    return { challengeId: challenge.id, snapshot: readSnapshot(ctx.db) };
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
function commitImport(ctx: ApiContext, body: Record<string, unknown>): CommandResult {
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
    checkRevision(ctx.db, expected);
    assertImportedWorkouts(ctx.db, workouts, challenge, slots);
    insertOrVerify(ctx.db, EXERCISES, exercise);
    insertOrVerify(ctx.db, CHALLENGES, challenge);
    for (const slot of slots) insertOrVerify(ctx.db, PLAN_SLOTS, slot);
    for (const workout of workouts) insertOrVerify(ctx.db, WORKOUTS, workout);
    if (select) selectChallenge(ctx.db, challenge.id);
    bumpRevision(ctx.db, isoNow(ctx));
    return {
      exerciseId: exercise.id,
      challengeId: challenge.id,
      workoutCount: workouts.length,
      snapshot: readSnapshot(ctx.db),
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
function patchSettings(ctx: ApiContext, body: Record<string, unknown>): CommandResult {
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
    checkRevision(ctx.db, expected);
    const merged: Record<string, unknown> = { ...readSettings(ctx.db) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    merged['id'] = SETTINGS_ROW_ID;
    const settings = validateRecord<SettingsRecord>(merged, SETTINGS_FIELDS, 'settings');
    writeSettings(ctx.db, settings);
    bumpRevision(ctx.db, isoNow(ctx));
    return { snapshot: readSnapshot(ctx.db) };
  });
}

function selectChallenge(db: DatabaseSync, challengeId: string): void {
  writeSettings(db, { ...readSettings(db), selectedChallengeId: challengeId });
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

    const slot = known.get(workout.planSlotId) ?? findRecord(db, PLAN_SLOTS, workout.planSlotId);
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

// ── Session endpoints ───────────────────────────────────────────────────────────────────────

/**
 * Exchange the shared token for a session cookie.
 *
 * A new session id is minted every time and whatever cookie the caller presented is discarded,
 * which is what makes session fixation impossible — see the note in `server/session.ts`.
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
    sendJson(
      res,
      429,
      {
        error: 'too_many_attempts',
        message: 'Too many failed attempts. Wait and try again.',
      },
      { 'Retry-After': String(decision.retryAfterSeconds) },
    );
    return;
  }

  const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
  requireKeys(body, ['token'], 'POST /api/session');
  const token = body['token'];
  const ok = typeof token === 'string' && token !== '' && tokenMatches(token, ctx.tokenDigest);
  if (!ok) {
    ctx.limiter.recordFailure(key, now);
    // Never echo any part of what was sent: a reflected token ends up in a log or a screenshot.
    throw new HttpError(401, 'invalid_token', 'That token is not correct.');
  }

  ctx.limiter.recordSuccess(key);
  // Drop whatever session the caller was carrying before issuing a new one.
  ctx.sessions.destroy(readSessionId(req));
  const id = ctx.sessions.create(now);
  const expiresAt = ctx.sessions.expiresAt(id) ?? now;
  sendJson(
    res,
    200,
    { authenticated: true, expiresAt: new Date(expiresAt).toISOString(), apiVersion: API_VERSION },
    { 'Set-Cookie': sessionCookie(id, Math.floor((expiresAt - now) / 1000)) },
  );
}

function closeSession(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): void {
  // Server-side first: a cleared cookie the server still honours is not a sign-out.
  ctx.sessions.destroy(readSessionId(req));
  sendEmpty(res, 204, { 'Set-Cookie': clearedSessionCookie() });
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────

const PUBLIC_ROUTES = new Set(['POST /session', 'DELETE /session', 'GET /session']);

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

  try {
    if (rest[0] === 'session') {
      if (rest.length !== 1) throw notFound(route);
      if (method === 'POST') return await openSession(ctx, req, res);
      if (method === 'DELETE') return closeSession(ctx, req, res);
      if (method === 'GET') {
        const authenticated = ctx.sessions.validate(readSessionId(req), ctx.now());
        return sendJson(res, 200, { authenticated, apiVersion: API_VERSION });
      }
      throw methodNotAllowed(method, route);
    }

    if (!PUBLIC_ROUTES.has(`${method} ${route}`)) {
      if (!ctx.sessions.validate(readSessionId(req), ctx.now())) {
        throw new HttpError(
          401,
          'unauthenticated',
          'Sign in with the shared token before using this endpoint.',
        );
      }
    }

    if (rest[0] === 'snapshot' && rest.length === 1) {
      if (method !== 'GET') throw methodNotAllowed(method, route);
      const snapshot = inReadTransaction(ctx.db, () => readSnapshot(ctx.db));
      return sendJson(res, 200, snapshot);
    }

    if (rest[0] === 'workouts' && rest.length === 1) {
      if (method !== 'POST') throw methodNotAllowed(method, route);
      const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
      return sendJson(res, 201, appendWorkout(ctx, body));
    }

    if (rest[0] === 'challenges') {
      if (rest.length === 1) {
        if (method !== 'POST') throw methodNotAllowed(method, route);
        const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
        return sendJson(res, 201, createChallenge(ctx, body));
      }
      if (rest.length === 2 && rest[1] === 'next-block') {
        if (method !== 'POST') throw methodNotAllowed(method, route);
        const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
        return sendJson(res, 201, startNextBlock(ctx, body));
      }
      if (rest.length === 3 && rest[2] === 'end') {
        if (method !== 'POST') throw methodNotAllowed(method, route);
        const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
        return sendJson(res, 200, endChallenge(ctx, rest[1] ?? '', body));
      }
      throw notFound(route);
    }

    if (rest[0] === 'import' && rest.length === 1) {
      if (method !== 'POST') throw methodNotAllowed(method, route);
      const body = asObject(await readJsonBody(req, MAX_IMPORT_BODY_BYTES), 'The request body');
      return sendJson(res, 201, commitImport(ctx, body));
    }

    if (rest[0] === 'settings' && rest.length === 1) {
      if (method !== 'PATCH') throw methodNotAllowed(method, route);
      const body = asObject(await readJsonBody(req, MAX_BODY_BYTES), 'The request body');
      return sendJson(res, 200, patchSettings(ctx, body));
    }

    throw notFound(route);
  } catch (cause) {
    respondToFailure(ctx, res, cause);
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
function respondToFailure(ctx: ApiContext, res: ServerResponse, cause: unknown): void {
  if (res.headersSent) return;

  if (cause instanceof HttpError) {
    if (cause.status === 409) {
      const snapshot = inReadTransaction(ctx.db, () => readSnapshot(ctx.db));
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
