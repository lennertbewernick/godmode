-- GodMode — server-owned SQLite schema, version 2.
--
-- Authority: this file is generated from nothing. It is written by hand against
-- `src/db/schema.ts` and `src/core/types.ts`, and every column here has a row in
-- `server/PERSISTENCE.md`. A field added to a record type without a row in that matrix and a
-- column here is silently dropped on import — which, on the only copy of the training history,
-- is data loss. `server/fields.ts` makes that failure a compile error rather than a surprise.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- VERSION 2 — MULTI-USER TENANCY (LBV-1478).
--
-- Version 1 was single-tenant: every table was global, `meta`/`settings` were single-row, and
-- one global `revision` served optimistic concurrency for the whole file. Version 2 adds
-- tenancy without swapping engines — still native `node:sqlite`.
--
-- `user_id` is a SERVER-SIDE tenancy column, not a domain field. The record types in
-- `src/db/schema.ts` are shared with the local-first IndexedDB client and the backup/export
-- format; they carry no `userId` and must not. So the server injects `user_id` on write and
-- filters on read (`server/db.ts`, `server/routes.ts`); `server/rows.ts` mappings stay pure
-- domain records. A workout is the same workout whoever owns it — ownership is metadata.
--
-- `exercises` stays GLOBAL/shared: it is an identity catalog (`{id,label,unit}`) with no
-- personal data, referenced by `challenges.exercise_id` and `performance_tests.exercise_id`.
-- Per-user exercises would force every user to re-create "push-ups" and fragment the shared
-- vocabulary. See `server/PERSISTENCE.md` §11.
--
-- `revision` is now PER USER (`user_revisions`), so one user's write never bumps the revision
-- another user's client is holding and never 409s it. `settings` is now one row per user, keyed
-- by `user_id` — the `id = 'settings'` singleton is gone.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PRAGMA foreign_keys IS PER CONNECTION.
--
-- SQLite defaults it OFF and does not store it in the file. Running this script once does NOT
-- arm the FOREIGN KEY clauses below for any later connection: every connection that opens this
-- database must issue `PRAGMA foreign_keys = ON;` itself, or every reference below is inert
-- documentation.
--
-- Verified, because the safe assumption and the true one differ here: `node:sqlite`'s
-- `DatabaseSync` sets `enableForeignKeyConstraints` to true by default, so the server's own
-- connections arrive armed. Nothing else does — the `sqlite3` CLI, `better-sqlite3`, a restore
-- script or a future driver all open this file with the keys off. `armConnection()` in
-- `server/schema.ts` therefore states it rather than inheriting it, and `db.test.ts` proves
-- both halves.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- Every foreign key is DEFERRABLE INITIALLY DEFERRED. Two of them are genuinely cyclic —
-- `challenges.baseline_evidence_id` -> `performance_tests` and `performance_tests.challenge_id`
-- -> `challenges` — so no single insert order satisfies both. Deferring to COMMIT lets a whole
-- dataset land in one transaction in any order and still be fully checked.
--
-- All tables are STRICT: a value whose type does not match the column's declared type is
-- rejected rather than coerced. Binding 18.5 into an INTEGER column raises
-- `cannot store REAL value in INTEGER column` instead of silently rounding.
--
-- What STRICT does NOT do, and it matters: it still converts a value whose conversion is
-- lossless and reversible. The string '77' bound to an INTEGER column is stored as the integer
-- 77 without complaint. So the DDL cannot promise that a JavaScript *number* was written — only
-- that whatever is stored has the declared type. The runtime validator in `server/validate.ts`
-- is what enforces the JavaScript side of that boundary, and it rejects '77'.
--
-- INTEGER vs REAL follows one rule, and it is deliberately conservative in the direction of
-- accepting the data that exists:
--
--   INTEGER only where the value is *structurally* integral — an index, an ordinal, a version,
--   an attempt number, a duration from `Math.round`, or a total that is a sum of integers.
--
--   REAL everywhere a number is typed by a human or computed by a policy from real-valued
--   parameters: `baseline_value`, `goal_value`, `performance_tests.value`, `rest_seconds`,
--   `rest_override_seconds`, `bodyweight_kg`, `kcal_coefficient`, `kcal_value`.
--
-- Those first three look like rep counts and were INTEGER in the first draft. Nothing in the
-- codebase enforces that: `recordMaxTest` stores its argument verbatim (`repo.ts:103-105`) and
-- `startNextBlock` checks only finiteness and positivity (`repo.ts:348-356`). A device holding
-- a baseline of 18.5 would have been refused at the migration gate for no benefit — a fractional
-- rep max is odd, not dangerous, and refusing to store it does not make it not exist.

PRAGMA foreign_keys = ON;

-- ── meta ────────────────────────────────────────────────────────────────────────────────────
--
-- One row, FILE-GLOBAL. `schema_version` is the DDL version of this file — genuinely global,
-- one schema per file. `created_at`/`updated_at` are the file's own lifetime.
--
-- The `revision` used for optimistic concurrency is NO LONGER here: in v2 it is per-user, in
-- `user_revisions`. A global counter would make one user's write bump the revision every other
-- user's client is holding, and 409 their next command for a change that was not theirs.

CREATE TABLE meta (
  id             TEXT    NOT NULL PRIMARY KEY CHECK (id = 'meta'),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  created_at     TEXT    NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  updated_at     TEXT    NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*')
) STRICT;

INSERT INTO meta (id, schema_version, created_at, updated_at)
VALUES ('meta', 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ── users ───────────────────────────────────────────────────────────────────────────────────
--
-- One row per person. `email` is unique case-insensitively (`idx_users_email` on `lower(email)`);
-- `google_sub` is unique among the rows that have one (partial UNIQUE index, since SQLite treats
-- NULLs as distinct anyway — the WHERE clause states the intent). `password_hash` and
-- `google_sub` are both nullable: a user may authenticate by password, by Google, or (once the
-- auth ticket lands) both. This ticket only needs the table to exist and every per-user query to
-- be scoped by it; registration/login/SSO is a separate SE ticket that sits on top.

CREATE TABLE users (
  id            TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  email         TEXT NOT NULL CHECK (length(email) > 0),
  display_name  TEXT NOT NULL CHECK (length(display_name) > 0),
  password_hash TEXT     NULL CHECK (password_hash IS NULL OR length(password_hash) > 0),
  google_sub    TEXT     NULL CHECK (google_sub IS NULL OR length(google_sub) > 0),
  created_at    TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*')
) STRICT;

CREATE UNIQUE INDEX idx_users_email      ON users (lower(email));
CREATE UNIQUE INDEX idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;

-- ── sessions ────────────────────────────────────────────────────────────────────────────────
--
-- Persisted, so a deploy or restart does not log everyone out — the in-memory `Map` this
-- replaces died with the process. `id` is the same 256-bit opaque token minted from the CSPRNG
-- that the cookie carries (`server/session.ts`). `created_at`/`last_seen_at` are epoch
-- milliseconds, NOT ISO text: they are compared arithmetically for absolute/idle expiry, and the
-- in-memory store they replace held numbers. This is infra state, not part of the domain dataset
-- (`COLLECTIONS` in `server/dataset.ts` does not include it), so it is free to be shaped for the
-- expiry math rather than for the timestamp convention the training records use.

CREATE TABLE sessions (
  id           TEXT    NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  user_id      TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at   INTEGER NOT NULL CHECK (created_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= created_at)
) STRICT;

CREATE INDEX idx_sessions_user ON sessions (user_id);

-- ── user_revisions ──────────────────────────────────────────────────────────────────────────
--
-- The per-user optimistic-concurrency counter (v1's `meta.revision`, made tenant-scoped). One
-- row per user, created with revision 0 when the user is created. `GET /api/snapshot` returns
-- this user's revision, every ordinary mutation carries the revision it expects, and a mismatch
-- is a 409 — but only against the same user's counter, so two users never conflict. The server
-- bumps it exactly once per accepted command, inside that command's transaction.

CREATE TABLE user_revisions (
  user_id    TEXT    NOT NULL PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  revision   INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT    NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*')
) STRICT;

-- ── push_subscriptions ──────────────────────────────────────────────────────────────────────
--
-- One row per Web Push endpoint a user has granted (LBV-1481). Device state, NOT part of the
-- domain dataset: it is not in `COLLECTIONS` (`server/dataset.ts`), never appears in a snapshot or
-- a backup, and no `user_revisions` bump touches it — exactly like `sessions`. A subscription is
-- re-established by the device on its next visit, so a restore that carries none is correct.
--
-- `endpoint` is the push service URL the browser minted; it is the natural identity of a
-- subscription and is UNIQUE across the whole table, so re-subscribing the same browser replaces
-- the previous row rather than accumulating duplicates (`ON CONFLICT (endpoint)` in
-- `server/push.ts`). `p256dh` and `auth` are the base64url key material the sender (a DevOps
-- ticket, `web-push`) needs to encrypt a payload for this endpoint. `created_at` is when the row
-- was last written.
--
-- `user_id` scopes a subscription to its owner so a send only ever reaches that person's devices,
-- and `ON DELETE CASCADE` drops a user's subscriptions with the user. The unique `endpoint`
-- deliberately spans users: a browser is one device, and if a shared device is re-granted under a
-- second account the endpoint moves to that account rather than being served two people's
-- reminders.

CREATE TABLE push_subscriptions (
  endpoint   TEXT NOT NULL PRIMARY KEY CHECK (length(endpoint) > 0),
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  p256dh     TEXT NOT NULL CHECK (length(p256dh) > 0),
  auth       TEXT NOT NULL CHECK (length(auth) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*')
) STRICT;

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);

-- ── exercises ───────────────────────────────────────────────────────────────────────────────
--
-- GLOBAL / shared across all users (LBV-1478 decision, `server/PERSISTENCE.md` §11). No
-- `user_id`: exercises are an identity catalog, not personal data.

CREATE TABLE exercises (
  id         TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  label      TEXT NOT NULL,
  unit       TEXT NOT NULL CHECK (unit = 'reps'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*')
) STRICT;

-- ── challenges ──────────────────────────────────────────────────────────────────────────────
--
-- `Baseline` is flattened into four columns rather than stored as JSON. It is a fixed four-field
-- struct and one of those fields is a reference to `performance_tests`, which a JSON blob cannot
-- express as a foreign key. `patternParams` / `restPolicyParams` stay JSON because they are
-- explicitly documented as opaque per-pattern blobs (`src/db/schema.ts:60`) and must stay opaque.
--
-- `chain_id` deliberately has NO foreign key. It names the first challenge of a continuation
-- chain, and a partial restore or a merge can legitimately produce a chain whose head is not
-- present. An FK here would refuse to store history that the app can render perfectly well.
--
-- `user_id` (v2) scopes the row to its owner. Indexed on the child side (`idx_challenges_user`).

CREATE TABLE challenges (
  id                        TEXT    NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  user_id                   TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  exercise_id               TEXT    NOT NULL REFERENCES exercises (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  chain_id                  TEXT    NOT NULL CHECK (length(chain_id) > 0),
  previous_challenge_id     TEXT        NULL REFERENCES challenges (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  pattern_id                TEXT    NOT NULL CHECK (length(pattern_id) > 0),
  pattern_version           INTEGER NOT NULL CHECK (pattern_version >= 1),
  pattern_params            TEXT    NOT NULL CHECK (json_valid(pattern_params) AND json_type(pattern_params) = 'object'),
  rest_policy_id            TEXT    NOT NULL CHECK (length(rest_policy_id) > 0),
  rest_policy_version       INTEGER NOT NULL CHECK (rest_policy_version >= 1),
  rest_policy_params        TEXT    NOT NULL CHECK (json_valid(rest_policy_params) AND json_type(rest_policy_params) = 'object'),
  evaluation_policy_id      TEXT    NOT NULL CHECK (length(evaluation_policy_id) > 0),
  evaluation_policy_version INTEGER NOT NULL CHECK (evaluation_policy_version >= 1),
  baseline_value            REAL    NOT NULL CHECK (baseline_value >= 0),
  baseline_source           TEXT    NOT NULL CHECK (baseline_source IN ('tested', 'user_entered', 'imported', 'estimated')),
  baseline_evidence_id      TEXT        NULL REFERENCES performance_tests (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  baseline_recorded_at      TEXT    NOT NULL CHECK (baseline_recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  goal_value                REAL        NULL CHECK (goal_value IS NULL OR goal_value >= 0),
  status                    TEXT    NOT NULL CHECK (status IN ('active', 'ended')),
  started_at                TEXT    NOT NULL CHECK (started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  ended_at                  TEXT        NULL CHECK (ended_at IS NULL OR ended_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  end_reason                TEXT        NULL CHECK (end_reason IS NULL OR end_reason IN ('goal_reached', 'closed_manually', 'abandoned', 'superseded')),
  CHECK (previous_challenge_id IS NULL OR previous_challenge_id <> id)
) STRICT;

-- ── performance_tests ───────────────────────────────────────────────────────────────────────

CREATE TABLE performance_tests (
  id               TEXT    NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  user_id          TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  exercise_id      TEXT    NOT NULL REFERENCES exercises (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  challenge_id     TEXT        NULL REFERENCES challenges (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  performed_at     TEXT    NOT NULL CHECK (performed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  protocol_id      TEXT    NOT NULL CHECK (length(protocol_id) > 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
  value            REAL    NOT NULL CHECK (value >= 0),
  unit             TEXT    NOT NULL CHECK (unit = 'reps'),
  note             TEXT        NULL
) STRICT;

-- ── plan_slots ──────────────────────────────────────────────────────────────────────────────
--
-- `targets` is a JSON array, not a `set_targets` child table. PLAN.md §4 asks for child rows so
-- a variable set count never needs a migration; a JSON array delivers exactly that property.
-- Normalising buys nothing here — targets are immutable, always read whole, and never filtered
-- on — while multiplying the round-trip surface where a field could be dropped.
--
-- (challenge_id, ordinal) is indexed but NOT unique: a superseded slot and the slot that
-- replaced it share an ordinal by design (`src/db/schema.ts:10-12`).

CREATE TABLE plan_slots (
  id              TEXT    NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  user_id         TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  challenge_id    TEXT    NOT NULL REFERENCES challenges (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 1),
  week            INTEGER     NULL CHECK (week IS NULL OR week >= 1),
  day             INTEGER     NULL CHECK (day IS NULL OR day >= 1),
  cycle_label     TEXT        NULL,
  pattern_id      TEXT    NOT NULL CHECK (length(pattern_id) > 0),
  pattern_version INTEGER NOT NULL CHECK (pattern_version >= 1),
  generated_at    TEXT    NOT NULL CHECK (generated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  decision        TEXT        NULL CHECK (decision IS NULL OR (json_valid(decision) AND json_type(decision) = 'object')),
  pattern_metrics TEXT        NULL CHECK (pattern_metrics IS NULL OR (json_valid(pattern_metrics) AND json_type(pattern_metrics) = 'object')),
  targets         TEXT    NOT NULL CHECK (json_valid(targets) AND json_type(targets) = 'array'),
  target_total    INTEGER NOT NULL CHECK (target_total >= 0),
  rest_seconds    REAL    NOT NULL CHECK (rest_seconds >= 0),
  status          TEXT    NOT NULL CHECK (status IN ('available', 'attempted', 'completed', 'superseded', 'cancelled')),
  supersedes_id   TEXT        NULL REFERENCES plan_slots (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
) STRICT;

-- ── workouts ────────────────────────────────────────────────────────────────────────────────
--
-- `EvaluationResult` and `KcalRecord` are flattened into column groups with all-or-nothing
-- CHECKs, so "half an evaluation" cannot be stored. `evaluation_measured` stays JSON: it is a
-- policy-specific open map (`src/core/types.ts:138`).
--
-- `evaluation_policy_id` / `evaluation_policy_version` are separate optional fields on the
-- record, not part of `evaluation` — they are deliberately NOT tied to the evaluation group.
--
-- `kcal` is a nested KcalRecord, never a scalar. A single `kcal` number column would erase the
-- `external` vs `estimated` provenance that keeps imported values from being merged with our
-- own estimates (`src/db/schema.ts:101-107`).

CREATE TABLE workouts (
  id                        TEXT    NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  user_id                   TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  challenge_id              TEXT    NOT NULL REFERENCES challenges (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  chain_id                  TEXT    NOT NULL CHECK (length(chain_id) > 0),
  plan_slot_id              TEXT        NULL REFERENCES plan_slots (id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  attempt_no                INTEGER NOT NULL CHECK (attempt_no >= 1),
  performed_at              TEXT    NOT NULL CHECK (performed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  duration_seconds          INTEGER     NULL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  sets                      TEXT    NOT NULL CHECK (json_valid(sets) AND json_type(sets) = 'array'),
  actual_total              INTEGER NOT NULL CHECK (actual_total >= 0),
  adjustment_type           TEXT    NOT NULL CHECK (adjustment_type IN ('none', 'redistributed', 'scaled_up', 'scaled_down')),
  effective_total           INTEGER     NULL CHECK (effective_total IS NULL OR effective_total >= 0),
  outcome                   TEXT    NOT NULL CHECK (outcome IN ('completed_as_planned', 'scaled_up', 'deload', 'failed', 'advanced_manually')),
  evaluation_satisfied      INTEGER     NULL CHECK (evaluation_satisfied IS NULL OR evaluation_satisfied IN (0, 1)),
  evaluation_advances       INTEGER     NULL CHECK (evaluation_advances IS NULL OR evaluation_advances IN (0, 1)),
  evaluation_reason         TEXT        NULL,
  evaluation_measured       TEXT        NULL CHECK (evaluation_measured IS NULL OR (json_valid(evaluation_measured) AND json_type(evaluation_measured) = 'object')),
  evaluation_policy_id      TEXT        NULL CHECK (evaluation_policy_id IS NULL OR length(evaluation_policy_id) > 0),
  evaluation_policy_version INTEGER     NULL CHECK (evaluation_policy_version IS NULL OR evaluation_policy_version >= 1),
  kcal_value                REAL        NULL CHECK (kcal_value IS NULL OR kcal_value >= 0),
  kcal_source               TEXT        NULL CHECK (kcal_source IS NULL OR kcal_source IN ('external', 'estimated')),
  kcal_estimator_version    INTEGER     NULL CHECK (kcal_estimator_version IS NULL OR kcal_estimator_version >= 1),
  note                      TEXT        NULL,
  import_source             TEXT        NULL,
  CHECK (
    (evaluation_satisfied IS NULL AND evaluation_advances IS NULL AND evaluation_reason IS NULL AND evaluation_measured IS NULL)
    OR
    (evaluation_satisfied IS NOT NULL AND evaluation_advances IS NOT NULL AND evaluation_reason IS NOT NULL AND evaluation_measured IS NOT NULL)
  ),
  CHECK (
    (kcal_value IS NULL AND kcal_source IS NULL AND kcal_estimator_version IS NULL)
    OR
    (kcal_value IS NOT NULL AND kcal_source IS NOT NULL AND kcal_estimator_version IS NOT NULL)
  )
) STRICT;

-- ── settings ────────────────────────────────────────────────────────────────────────────────
--
-- One row PER USER, keyed by `user_id` — v1's `id = 'settings'` singleton is gone (LBV-1478).
-- The domain `SettingsRecord` still carries `id: 'settings'` for the client and the backup
-- format; the server does not store it (it is a constant, synthesised on decode in
-- `server/rows.ts`). A missing row means "defaults", exactly as `src/db/repo.ts:69` treats it,
-- so a fresh user with no saved settings reads `DEFAULT_SETTINGS_ROW`.
--
-- `selected_challenge_id` deliberately has NO foreign key. It is documented as a preference and
-- not a source of truth: when it names a challenge that has ended or was never restored, the app
-- falls back to the newest active one (`src/db/schema.ts:144-151`). A RESTRICT would refuse the
-- restore; a SET NULL would silently rewrite a user preference on someone else's device.

CREATE TABLE settings (
  user_id               TEXT NOT NULL PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  bodyweight_kg         REAL     NULL CHECK (bodyweight_kg IS NULL OR bodyweight_kg > 0),
  kcal_coefficient      REAL NOT NULL CHECK (kcal_coefficient >= 0),
  rest_override_seconds REAL     NULL CHECK (rest_override_seconds IS NULL OR rest_override_seconds >= 0),
  last_backup_at        TEXT     NULL CHECK (last_backup_at IS NULL OR last_backup_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  onboarded_at          TEXT     NULL CHECK (onboarded_at IS NULL OR onboarded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'),
  -- The onboarding "why do you do this" (LBV-1481). Free text in the user's own words, so no GLOB;
  -- length is bounded by the validator (`GOAL_TEXT_MAX_LENGTH`), not the column.
  goal_text             TEXT     NULL CHECK (goal_text IS NULL OR length(goal_text) > 0),
  selected_challenge_id TEXT     NULL
) STRICT;

-- ── indexes ─────────────────────────────────────────────────────────────────────────────────
--
-- The first block mirrors the IndexedDB indexes one for one, so no read path that exists today
-- becomes a table scan. The second block indexes the child side of each foreign key, which is
-- what SQLite scans when a parent row is deleted or updated. The third block indexes the
-- per-user tenancy column, which every scoped read filters on.

CREATE INDEX idx_challenges_chain              ON challenges (chain_id);
CREATE INDEX idx_challenges_status             ON challenges (status);
CREATE INDEX idx_performance_tests_exercise    ON performance_tests (exercise_id);
CREATE INDEX idx_plan_slots_challenge          ON plan_slots (challenge_id);
CREATE INDEX idx_plan_slots_challenge_ordinal  ON plan_slots (challenge_id, ordinal);
CREATE INDEX idx_workouts_challenge            ON workouts (challenge_id);
CREATE INDEX idx_workouts_slot                 ON workouts (plan_slot_id);
CREATE INDEX idx_workouts_chain                ON workouts (chain_id);
CREATE INDEX idx_workouts_performed_at         ON workouts (performed_at);

CREATE INDEX idx_challenges_exercise           ON challenges (exercise_id);
CREATE INDEX idx_challenges_previous           ON challenges (previous_challenge_id);
CREATE INDEX idx_challenges_baseline_evidence  ON challenges (baseline_evidence_id);
CREATE INDEX idx_performance_tests_challenge   ON performance_tests (challenge_id);
CREATE INDEX idx_plan_slots_supersedes         ON plan_slots (supersedes_id);

CREATE INDEX idx_challenges_user               ON challenges (user_id);
CREATE INDEX idx_performance_tests_user        ON performance_tests (user_id);
CREATE INDEX idx_plan_slots_user               ON plan_slots (user_id);
CREATE INDEX idx_workouts_user                 ON workouts (user_id);

-- One attempt number per slot, forever. This is the constraint that makes a retried offline
-- POST safe: a duplicate command cannot quietly become a second attempt.
--
-- The partial predicate is load-bearing. An imported session that could not be reconciled to a
-- slot has plan_slot_id NULL, and there are many of those, each carrying attempt_no 1
-- (`src/import/reconcile.ts:100-107`). SQLite already treats NULLs as distinct in a UNIQUE
-- index, so the WHERE clause changes no behaviour — it states the intent so nobody later
-- "fixes" the index into one that rejects the unlinked history.
--
-- Slots are already scoped to one user (a slot belongs to a challenge, which belongs to a user),
-- so uniqueness on (plan_slot_id, attempt_no) is inherently per-user without naming user_id here.
CREATE UNIQUE INDEX idx_workouts_slot_attempt
  ON workouts (plan_slot_id, attempt_no)
  WHERE plan_slot_id IS NOT NULL;
