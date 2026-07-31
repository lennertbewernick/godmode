# Persistence matrix — every field, every column

**Written:** 2026-07-30 · **Schema version:** 2 · **Backup format read:** 1

This is the field-by-field contract between the record types in `src/` and the SQLite schema in
`server/schema.sql`. It is exhaustive, not illustrative. Every property of every persisted record
and every nested type appears below exactly once.

## 0. Multi-user tenancy (schema v2, LBV-1478)

Version 2 turned the single-tenant server multi-user **without adding a field to any record
type**. The record types in `src/db/schema.ts` are shared with the local-first IndexedDB client and
the backup/export format; they carry no `userId` and must not. So tenancy lives entirely in the
server layer:

- **`user_id` is a server-side tenancy column, not a domain property.** It is added to the four
  per-user tables — `challenges`, `performance_tests`, `plan_slots`, `workouts` — as
  `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`, indexed on the child side
  (`idx_<table>_user`). The domain encoders (`server/rows.ts`) never produce it; `server/db.ts`
  and `server/dataset.ts` inject it on write and filter on read. Because it is not a record field,
  it does **not** appear in the tables below — it has no source property to map. `server/verify.ts`
  skips it in its column oracle for the same reason.
- **`exercises` stays GLOBAL / shared** — no `user_id`. It is an identity catalog
  (`{id, label, unit}`) with no personal data, referenced by `challenges.exercise_id` and
  `performance_tests.exercise_id`. Per-user exercises would force every user to re-create
  "push-ups" and fragment the shared vocabulary. If a private exercise is ever needed, that is an
  additive `user_id NULL = global` change, not a rework.
- **`settings` is one row per user**, keyed by `user_id` — the `id = 'settings'` singleton is gone
  (see §7).
- **`revision` is per user**, in the new `user_revisions` table, so one user's write never bumps
  the revision another user's client is holding (which would 409 their next command). `meta` keeps
  only the file-global `schema_version` and timestamps; it no longer has a `revision` column.

Two infra tables are new and are **not** part of the backup/import matrix (they are never
exported): `users` and `sessions`.

| Table | Columns | Notes |
|---|---|---|
| `users` | `id` PK, `email` (unique, ci via `idx_users_email` on `lower(email)`), `display_name`, `password_hash` NULL, `google_sub` NULL (unique-when-present), `created_at` | The auth ticket adds credentials; this ticket only needs the table to exist. A `UserRecord` compile guard lives in `server/fields.ts` (`USER_FIELDS`). |
| `sessions` | `id` PK, `user_id` FK→`users`, `created_at` INTEGER (epoch ms), `last_seen_at` INTEGER | Persisted so a deploy no longer logs everyone out. Epoch-ms, not ISO, because expiry is arithmetic. |
| `user_revisions` | `user_id` PK FK→`users`, `revision` INTEGER ≥ 0, `updated_at` | The per-user optimistic-concurrency counter. Every user gets a row (revision 0) at creation. |

Until the auth ticket lands there is one **bootstrap owner** (`server/users.ts`,
`BOOTSTRAP_USER_ID`); the token exchange mints sessions for them and the v1→v2 migration
(`server/migrate-schema.ts`) carries the existing single-tenant history onto their row.

It exists because the previous draft of this design shipped a table that omitted `evaluation`,
`evaluationPolicyId`, `evaluationPolicyVersion` and `note` from workouts, `supersedesId` from plan
slots, `challengeId` and `note` from performance tests, and typed `kcal` as a scalar when it is a
nested `KcalRecord`. Taken as an implementation brief, that table would have thrown away part of
29 real training sessions on the only device that holds them.

**Sources of truth, read field by field to build this:**
`src/db/schema.ts` (ExerciseRecord, ChallengeRecord, PlanSlotRecord, KcalRecord, WorkoutRecord,
SettingsRecord), `src/core/types.ts` (SetTarget, PerformedSet, Baseline, EvaluationResult,
PerformanceTest and every enum), `src/data/exchange.ts` (BackupFile).

## How exhaustiveness is enforced, rather than promised

Prose drifts. `server/fields.ts` carries the same matrix as types, and each map is declared
`satisfies SpecFor<R>`, which makes all three drift modes a compile error:

| Drift | Result of `npm run typecheck` |
|---|---|
| A property of `R` with no entry | `Property 'note' is missing in type … but required in type 'SpecFor<WorkoutRecord>'` |
| An entry for a property `R` does not have | `Object literal may only specify known properties, and 'bogusExtra' does not exist …` |
| A required property described as optional, or the reverse | `Type 'true' is not assignable to type 'never'` |
| A storage kind the TypeScript type cannot be (`kcalCoefficient` as a string) | `Type '"string"' is not assignable to type '"integer" \| "real"'` |
| A nested record described as an opaque blob | `Type '"opaqueObject"' is not assignable to type '"object"'` |
| A union member missing from an enum list | `Type '{ ENUM_LIST_IS_MISSING: "custom"; }' does not satisfy the constraint 'true'` |

All six were induced deliberately and observed to fail before this was written down. The last two
matter as much as the first three: a matrix that names every field but types one of them wrongly
is a matrix that will corrupt exactly one column, and an enum list that is merely a valid *subset*
of its union compiles happily and then rejects a value the app can legitimately produce.
`server/db.test.ts` closes the remaining gap between this file and the DDL by asserting every
mapping's column list against `PRAGMA table_info` for its table.

## Conventions used in the tables

- **Optional?** — `yes` means the TypeScript property is optional. Under
  `exactOptionalPropertyTypes` that is a real distinction. Top-level optionality maps to column
  nullability one for one. The exception is a *required member of an optional flattened group*:
  `EvaluationResult.satisfied` is required within an evaluation, but a workout need not have an
  evaluation at all, so `evaluation_satisfied` is nullable — collectively, held consistent by an
  all-or-nothing `CHECK` so that half a group cannot exist. §8.4 and §8.5 mark those columns.
- **Absent is the sole canonical representation of an optional.** JSON has no `undefined`; SQL
  adds `NULL`. On read, a `NULL` column **omits the key entirely** — never `{field: undefined}`,
  which would be an own property, would appear in `Object.keys`, and is rejected by
  `exactOptionalPropertyTypes` anyway. On write, an absent key and an explicit `undefined` both
  become `NULL`. Enforced by `optional()` in `server/canonical.ts` and asserted by the
  "omits the key for a NULL column" test.
- **JSON path** — a value stored inside a JSON column. The column holds canonical JSON: object
  keys sorted recursively, `undefined` properties dropped, `-0` normalised to `0`. Canonical form
  makes "is this re-import identical to what is stored" a text comparison.
- **INTEGER vs REAL** follows one rule: **INTEGER only where the value is structurally
  integral** — an index, an ordinal, a version, an attempt number, a duration from `Math.round`,
  or a total that is a sum of integers. **REAL everywhere a number is typed by a human or
  computed by a policy from real-valued parameters.** `baseline_value`, `goal_value` and
  `performance_tests.value` look like rep counts and are REAL for exactly this reason: nothing in
  the codebase enforces whole numbers there — `recordMaxTest` stores its argument verbatim
  (`repo.ts:103-105`), `startNextBlock` checks only finiteness and positivity (`repo.ts:348-356`)
  — and a device holding `18.5` would have been refused at the migration gate for no benefit.
- **`ts` (timestamp)** is `TEXT` with
  `CHECK (x GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*')`
  and, at runtime, `isTimestamp()` in `server/fields.ts`: the same shape plus an explicit
  calendar check — month 1–12, day within the month for that year, hour ≤ 23, minute and second
  ≤ 59, offset ≤ 14:59. The `GLOB` is a coarse shape guard only; the runtime rule is the real
  one. **See §10 — this is deliberately not "ISO with a Z".**

---

## 1. Backup envelope — `BackupFile` (`src/data/exchange.ts:31`) — 10 fields

Not a table. It is the wire format the migration reads, so it is validated with the same rigour.

| Property | TS type | Optional? | SQL column / JSON path | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `format` | `'godmode-backup'` | no | — (envelope) | — | — | must equal `godmode-backup` | — |
| `formatVersion` | `number` | no | — (envelope) | — | — | integer ≥ 1 and ≤ 1; a higher value is refused, never partially read | — |
| `dbVersion` | `number` | no | — (envelope) | — | — | integer ≥ 1 | — |
| `exportedAt` | `string` | no | — (envelope) | — | — | `ts` | — |
| `exercises` | `ExerciseRecord[]` | no | table `exercises` | — | — | array; each element per §2; ids unique | — |
| `challenges` | `ChallengeRecord[]` | no | table `challenges` | — | — | array; each element per §3; ids unique | — |
| `performanceTests` | `PerformanceTest[]` | no | table `performance_tests` | — | — | array; each element per §4; ids unique | — |
| `planSlots` | `PlanSlotRecord[]` | no | table `plan_slots` | — | — | array; each element per §5; ids unique | — |
| `workouts` | `WorkoutRecord[]` | no | table `workouts` | — | — | array; each element per §6; ids unique | — |
| `settings` | `SettingsRecord` | no | table `settings` | — | — | object per §7 | — |

A missing collection is rejected rather than defaulted to empty, for the reason already written
into `exchange.ts:78-82`: treating absence as "zero records" turns a truncated file into total
silent loss. An unknown top-level key is rejected too — this build does not know what it means,
and importing around it would drop it.

---

## 2. `exercises` — `ExerciseRecord` (`src/db/schema.ts:43`) — 4 fields

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `id` | `string` | no | `id` | TEXT | no | non-empty | PRIMARY KEY |
| `label` | `string` | no | `label` | TEXT | no | any string, including empty (free text the user typed) | — |
| `unit` | `'reps'` | no | `unit` | TEXT | no | `CHECK (unit = 'reps')` | — |
| `createdAt` | `string` | no | `created_at` | TEXT | no | `ts` | — |

---

## 3. `challenges` — `ChallengeRecord` (`src/db/schema.ts:51`) — 18 fields

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `id` | `string` | no | `id` | TEXT | no | non-empty | PRIMARY KEY |
| `exerciseId` | `string` | no | `exercise_id` | TEXT | no | non-empty; target must exist | FK → `exercises(id)` RESTRICT, deferred; `idx_challenges_exercise` |
| `chainId` | `string` | no | `chain_id` | TEXT | no | non-empty; **reference deliberately not enforced** (see §9) | `idx_challenges_chain` |
| `previousChallengeId` | `string` | **yes** | `previous_challenge_id` | TEXT | yes | non-empty; target must exist; must not be this record's own id (validator **and** `CHECK (<> id)`) | FK → `challenges(id)` RESTRICT, deferred; `idx_challenges_previous` |
| `patternId` | `string` | no | `pattern_id` | TEXT | no | non-empty | — |
| `patternVersion` | `number` | no | `pattern_version` | INTEGER | no | integer ≥ 1 | — |
| `patternParams` | `Record<string, unknown>` | no | `pattern_params` | TEXT (JSON) | no | plain object; opaque contents, but every value must survive JSON; `CHECK (json_valid AND json_type = 'object')` | — |
| `restPolicyId` | `string` | no | `rest_policy_id` | TEXT | no | non-empty | — |
| `restPolicyVersion` | `number` | no | `rest_policy_version` | INTEGER | no | integer ≥ 1 | — |
| `restPolicyParams` | `Record<string, unknown>` | no | `rest_policy_params` | TEXT (JSON) | no | as `pattern_params` | — |
| `evaluationPolicyId` | `string` | no | `evaluation_policy_id` | TEXT | no | non-empty | — |
| `evaluationPolicyVersion` | `number` | no | `evaluation_policy_version` | INTEGER | no | integer ≥ 1 | — |
| `baseline` | `Baseline` | no | flattened → `baseline_*` | (4 columns) | no | object per §8.3 | — |
| `goalValue` | `number` | **yes** | `goal_value` | REAL | yes | finite ≥ 0. A generation coordinate, not a capability claim, and not constrained to be whole | — |
| `status` | `ChallengeStatus` | no | `status` | TEXT | no | `CHECK IN ('active','ended')` | `idx_challenges_status` |
| `startedAt` | `string` | no | `started_at` | TEXT | no | `ts` | — |
| `endedAt` | `string` | **yes** | `ended_at` | TEXT | yes | `ts` | — |
| `endReason` | `ChallengeEndReason` | **yes** | `end_reason` | TEXT | yes | `CHECK IN ('goal_reached','closed_manually','abandoned','superseded')` | — |

`status = 'ended'` is **not** constrained to imply `ended_at IS NOT NULL`. `endChallenge`
(`repo.ts:283`) always writes both, but a record restored from an older backup need not, and a
constraint that refuses to store real history is worse than a gap.

---

## 4. `performance_tests` — `PerformanceTest` (`src/core/types.ts:89`) — 9 fields

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `id` | `string` | no | `id` | TEXT | no | non-empty | PRIMARY KEY |
| `exerciseId` | `string` | no | `exercise_id` | TEXT | no | non-empty; target must exist | FK → `exercises(id)` RESTRICT, deferred; `idx_performance_tests_exercise` |
| `challengeId` | `string` | **yes** | `challenge_id` | TEXT | yes | non-empty; target must exist | FK → `challenges(id)` RESTRICT, deferred; `idx_performance_tests_challenge` |
| `performedAt` | `string` | no | `performed_at` | TEXT | no | `ts` | — |
| `protocolId` | `string` | no | `protocol_id` | TEXT | no | non-empty | — |
| `protocolVersion` | `number` | no | `protocol_version` | INTEGER | no | integer ≥ 1 | — |
| `value` | `number` | no | `value` | REAL | no | finite ≥ 0 (a rested rep max; not constrained to be whole — see the INTEGER/REAL rule) | — |
| `unit` | `'reps'` | no | `unit` | TEXT | no | `CHECK (unit = 'reps')` | — |
| `note` | `string` | **yes** | `note` | TEXT | yes | any string | — |

---

## 5. `plan_slots` — `PlanSlotRecord` (`src/db/schema.ts:79`) — 16 fields

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `id` | `string` | no | `id` | TEXT | no | non-empty | PRIMARY KEY |
| `challengeId` | `string` | no | `challenge_id` | TEXT | no | non-empty; target must exist | FK → `challenges(id)` RESTRICT, deferred; `idx_plan_slots_challenge` |
| `ordinal` | `number` | no | `ordinal` | INTEGER | no | integer ≥ 1 | `idx_plan_slots_challenge_ordinal` (**not unique** — see below) |
| `week` | `number` | **yes** | `week` | INTEGER | yes | integer ≥ 1 | — |
| `day` | `number` | **yes** | `day` | INTEGER | yes | integer ≥ 1 | — |
| `cycleLabel` | `string` | **yes** | `cycle_label` | TEXT | yes | any string | — |
| `patternId` | `string` | no | `pattern_id` | TEXT | no | non-empty | — |
| `patternVersion` | `number` | no | `pattern_version` | INTEGER | no | integer ≥ 1 | — |
| `generatedAt` | `string` | no | `generated_at` | TEXT | no | `ts` | — |
| `decision` | `Record<string, unknown>` | **yes** | `decision` | TEXT (JSON) | yes | plain object, opaque, JSON-safe; `CHECK (json_type = 'object')` | — |
| `patternMetrics` | `Record<string, number>` | **yes** | `pattern_metrics` | TEXT (JSON) | yes | plain object; **every value a finite number**; `CHECK (json_type = 'object')` | — |
| `targets` | `SetTarget[]` | no | `targets` | TEXT (JSON) | no | array of §8.1; `index` unique within the array; `CHECK (json_type = 'array')` | — |
| `targetTotal` | `number` | no | `target_total` | INTEGER | no | integer ≥ 0 | — |
| `restSeconds` | `number` | no | `rest_seconds` | REAL | no | finite ≥ 0. Computed by a rest policy from real-valued params | — |
| `status` | `PlanSlotStatus` | no | `status` | TEXT | no | `CHECK IN ('available','attempted','completed','superseded','cancelled')` | — |
| `supersedesId` | `string` | **yes** | `supersedes_id` | TEXT | yes | non-empty; target must exist; must not be this record's own id (validator **and** `CHECK (<> id)`) | FK → `plan_slots(id)` RESTRICT, deferred; `idx_plan_slots_supersedes` |

`(challenge_id, ordinal)` is indexed but **not unique**: a superseded slot and its replacement
share an ordinal by design (`src/db/schema.ts:10-12`). `week`/`day` are not constrained to be
present or absent together, because nothing in the code guarantees it and a slot missing one of
them is still perfectly renderable.

`targets` is a JSON array rather than a `set_targets` child table. PLAN.md §4 asks for child rows
so that a variable set count never needs a migration; a JSON array delivers exactly that, and the
targets are immutable, always read whole, and never filtered on. Normalising them would multiply
the round-trip surface where a field can be lost, which is the risk this document exists to close.

---

## 6. `workouts` — `WorkoutRecord` (`src/db/schema.ts:109`) — 18 fields

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `id` | `string` | no | `id` | TEXT | no | non-empty | PRIMARY KEY |
| `challengeId` | `string` | no | `challenge_id` | TEXT | no | non-empty; target must exist; must match the linked slot's challenge | FK → `challenges(id)` RESTRICT, deferred; `idx_workouts_challenge` |
| `chainId` | `string` | no | `chain_id` | TEXT | no | non-empty; **reference deliberately not enforced** (see §9) | `idx_workouts_chain` |
| `planSlotId` | `string` | **yes** | `plan_slot_id` | TEXT | yes | non-empty; target must exist. Absent = an imported session that could not be reconciled | FK → `plan_slots(id)` RESTRICT, deferred; `idx_workouts_slot` |
| `attemptNo` | `number` | no | `attempt_no` | INTEGER | no | integer ≥ 1; unique per linked slot | `idx_workouts_slot_attempt` UNIQUE `WHERE plan_slot_id IS NOT NULL` |
| `performedAt` | `string` | no | `performed_at` | TEXT | no | `ts` | `idx_workouts_performed_at` |
| `durationSeconds` | `number` | **yes** | `duration_seconds` | INTEGER | yes | integer ≥ 0 | — |
| `sets` | `PerformedSet[]` | no | `sets` | TEXT (JSON) | no | array of §8.2; `index` unique within the array; `CHECK (json_type = 'array')` | — |
| `actualTotal` | `number` | no | `actual_total` | INTEGER | no | integer ≥ 0 | — |
| `adjustmentType` | `AdjustmentType` | no | `adjustment_type` | TEXT | no | `CHECK IN ('none','redistributed','scaled_up','scaled_down')` | — |
| `effectiveTotal` | `number` | **yes** | `effective_total` | INTEGER | yes | integer ≥ 0. Absent = no prescription is known; **never** filled in from `actualTotal` | — |
| `outcome` | `WorkoutOutcome` | no | `outcome` | TEXT | no | `CHECK IN ('completed_as_planned','scaled_up','deload','failed','advanced_manually')` | — |
| `evaluation` | `EvaluationResult` | **yes** | flattened → `evaluation_satisfied`, `evaluation_advances`, `evaluation_reason`, `evaluation_measured` | (4 columns) | yes | object per §8.5; all four columns NULL together or non-NULL together (`CHECK`) | — |
| `evaluationPolicyId` | `string` | **yes** | `evaluation_policy_id` | TEXT | yes | non-empty. Independent of `evaluation` — not part of the group `CHECK` | — |
| `evaluationPolicyVersion` | `number` | **yes** | `evaluation_policy_version` | INTEGER | yes | integer ≥ 1. Independent of `evaluation` | — |
| `kcal` | `KcalRecord` | **yes** | flattened → `kcal_value`, `kcal_source`, `kcal_estimator_version` | (3 columns) | yes | object per §8.4; all three NULL together or non-NULL together (`CHECK`) | — |
| `note` | `string` | **yes** | `note` | TEXT | yes | any string | — |
| `importSource` | `string` | **yes** | `import_source` | TEXT | yes | any string; the profile id an import was read with | — |

`kcal` is a nested record, never a scalar column. Collapsing it to one number would erase the
`external` vs `estimated` provenance that keeps imported values from being merged with our own
estimates (`src/db/schema.ts:101-107`), and the estimator version that stops history being
silently rewritten when the formula changes.

`actualTotal` is **not constrained in SQL** to equal the sum of `sets[].actual` — SQLite cannot
express a CHECK over a JSON array's elements without a trigger, and a trigger that recomputed a
stored fact is the wrong shape for an immutable log.

An earlier version of this paragraph went further and said `actualTotal` is "a recorded fact from
the source export's own total column, not a derived one". **That was wrong about the code**, and
Codex caught the contradiction when the migration verifier began enforcing the invariant. Every
write path derives it: `Runner.tsx:310` sums the actuals, `App.tsx:513-515` logs zeros and a zero
total for a manual advance, and the CSV import at `pipeline.ts:389,411` stores `computedTotal` —
the sum of the parsed sets — while merely *warning* when the incumbent file's own stated total
disagrees. Nothing in this codebase stores a total it did not compute.

So the invariant holds, and the migration importer verifies it in JavaScript, where it can. It
holds on all 29 real sessions. `--allow-total-mismatch` is the named way past it, because refusing
to migrate irreplaceable history over an arithmetic disagreement would be the worse failure.

---

## 7. `settings` — `SettingsRecord` (`src/db/schema.ts:134`) — 7 fields

One row **per user**, keyed by `user_id` (v2). The `id = 'settings'` singleton column is gone: `id`
is a constant on the domain record, so `server/rows.ts` does not store it (it is synthesised as
`'settings'` on decode) and it has no physical column. The physical primary key is `user_id`
(`REFERENCES users(id) ON DELETE CASCADE`); a missing row means "defaults".

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `id` | `'settings'` | no | — (synthesised, not stored) | — | — | constant `'settings'`; the physical PK is `user_id` | — |
| `bodyweightKg` | `number \| undefined` | **yes** | `bodyweight_kg` | REAL | yes | finite, `> 0` | — |
| `kcalCoefficient` | `number` | no | `kcal_coefficient` | REAL | no | finite, `>= 0` (default `0.003`) | — |
| `restOverrideSeconds` | `number \| undefined` | **yes** | `rest_override_seconds` | REAL | yes | finite ≥ 0. Typed into a number input (`Settings.tsx:202`) | — |
| `lastBackupAt` | `string` | **yes** | `last_backup_at` | TEXT | yes | `ts` | — |
| `onboardedAt` | `string` | **yes** | `onboarded_at` | TEXT | yes | `ts` | — |
| `goalText` | `string` | **yes** | `goal_text` | TEXT | yes | non-empty, ≤ `GOAL_TEXT_MAX_LENGTH` (1000). The onboarding "why" (LBV-1481) | — |
| `selectedChallengeId` | `string \| undefined` | **yes** | `selected_challenge_id` | TEXT | yes | non-empty; **reference deliberately not enforced** (see §9) | — |

Three of these are declared `?: T | undefined` rather than `?: T`, so under
`exactOptionalPropertyTypes` an explicit `undefined` is a legal value as well as absence. Both
spellings normalise to absent on the way in and to `NULL` in the column.

---

## 8. Nested types

### 8.1 `SetTarget` (`src/core/types.ts:33`) — 6 fields — JSON array `plan_slots.targets`

| Property | TS type | Optional? | JSON path | Stored as | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `index` | `number` | no | `targets[i].index` | JSON number | n/a | integer ≥ 1; unique within the array | — |
| `targetKind` | `TargetKind` | no | `targets[i].targetKind` | JSON string | n/a | one of `'reps'` | — |
| `reps` | `number` | no | `targets[i].reps` | JSON number | n/a | integer ≥ 0. For an AMRAP set this is a floor, not a cap | — |
| `role` | `SetRole` | no | `targets[i].role` | JSON string | n/a | one of `'medium','big','small','amrap','custom'` | — |
| `isAmrap` | `boolean` | no | `targets[i].isAmrap` | JSON boolean | n/a | boolean. Never inferred from set ordering | — |
| `restAfterSeconds` | `number` | **yes** | `targets[i].restAfterSeconds` | JSON number | n/a (key absent) | finite ≥ 0 | — |

### 8.2 `PerformedSet` (`src/core/types.ts:152`) — 6 fields — JSON array `workouts.sets`

| Property | TS type | Optional? | JSON path | Stored as | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `index` | `number` | no | `sets[i].index` | JSON number | n/a | integer ≥ 1; unique within the array | — |
| `effectiveTarget` | `number` | **yes** | `sets[i].effectiveTarget` | JSON number | n/a (key absent) | integer ≥ 0. Absent means genuinely unknown and **must never be filled in from `actual`** | — |
| `actual` | `number` | no | `sets[i].actual` | JSON number | n/a | integer ≥ 0 | — |
| `startedAt` | `string` | **yes** | `sets[i].startedAt` | JSON string | n/a (key absent) | `ts` | — |
| `endedAt` | `string` | **yes** | `sets[i].endedAt` | JSON string | n/a (key absent) | `ts` | — |
| `restAfterSeconds` | `number` | **yes** | `sets[i].restAfterSeconds` | JSON number | n/a (key absent) | finite ≥ 0 | — |

### 8.3 `Baseline` (`src/core/types.ts:80`) — 4 fields — flattened into `challenges`

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `value` | `number` | no | `baseline_value` | REAL | no | finite ≥ 0; not constrained to be whole | — |
| `source` | `BaselineSource` | no | `baseline_source` | TEXT | no | `CHECK IN ('tested','user_entered','imported','estimated')` | — |
| `evidenceId` | `string` | **yes** | `baseline_evidence_id` | TEXT | yes | non-empty; target must exist | FK → `performance_tests(id)` RESTRICT, deferred; `idx_challenges_baseline_evidence` |
| `recordedAt` | `string` | no | `baseline_recorded_at` | TEXT | no | `ts` | — |

Flattened rather than stored as JSON precisely because of `evidenceId`: a JSON blob cannot carry a
foreign key, and provenance that cannot be checked is provenance that can rot. `source = 'tested'`
is **not** constrained to imply `evidenceId IS NOT NULL` — `continueChallenge` (`repo.ts:301-320`)
records a tested baseline with the evidence id only when the caller supplies one.

### 8.4 `KcalRecord` (`src/db/schema.ts:101`) — 3 fields — flattened into `workouts`

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `value` | `number` | no | `kcal_value` | REAL | yes¹ | finite ≥ 0. REAL, not INTEGER: an imported kcal column may be fractional | — |
| `source` | `'external' \| 'estimated'` | no | `kcal_source` | TEXT | yes¹ | `CHECK IN ('external','estimated')` | — |
| `estimatorVersion` | `number` | no | `kcal_estimator_version` | INTEGER | yes¹ | integer ≥ 1 | — |

¹ The columns are nullable because the *whole record* is optional on a workout. A group `CHECK`
requires all three to be NULL together or non-NULL together, so half a kcal record cannot exist.

### 8.5 `EvaluationResult` (`src/core/types.ts:127`) — 4 fields — flattened into `workouts`

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `satisfied` | `boolean` | no | `evaluation_satisfied` | INTEGER | yes¹ | `CHECK IN (0,1)`; decoded back to a boolean | — |
| `advances` | `boolean` | no | `evaluation_advances` | INTEGER | yes¹ | `CHECK IN (0,1)`; deliberately separate from `satisfied` | — |
| `reason` | `string` | no | `evaluation_reason` | TEXT | yes¹ | any string | — |
| `measured` | `Record<string, number>` | no | `evaluation_measured` | TEXT (JSON) | yes¹ | plain object; **every value a finite number**; `CHECK (json_type = 'object')` | — |

¹ As above: nullable because `evaluation` itself is optional, held consistent by a group `CHECK`.

---

## Field count

| Shape | Fields |
|---|---|
| `BackupFile` envelope | 10 |
| `ExerciseRecord` | 4 |
| `ChallengeRecord` | 18 |
| `PerformanceTest` | 9 |
| `PlanSlotRecord` | 16 |
| `WorkoutRecord` | 18 |
| `SettingsRecord` | 7 |
| `SetTarget` | 6 |
| `PerformedSet` | 6 |
| `Baseline` | 4 |
| `KcalRecord` | 3 |
| `EvaluationResult` | 4 |
| **Total rows above** | **105** |

Record properties alone: 72. Nested-type properties: 23. Envelope: 10.

---

## 9. Deliberate omissions, each one a decision

Three references exist in the data and are **not** foreign keys. Each is deliberate, and each
would refuse to store real history if enforced.

| Reference | Why it is not a FK |
|---|---|
| `settings.selected_challenge_id` | Documented as a preference and not a source of truth (`src/db/schema.ts:144-151`): when it names a challenge that has ended or was never restored, the app falls back to the newest active one. `RESTRICT` would refuse the restore; `SET NULL` would silently rewrite a preference. Neither is what the field means. |
| `challenges.chain_id` | Names the head of a continuation chain. A partial restore or a merge can legitimately leave the head absent, and the chain still renders. |
| `workouts.chain_id` | Same, denormalised onto the workout so charts can span a chain without a join. |

Two invariants are also left unenforced, for the same reason — a constraint that rejects data the
app produced would block the migration rather than protect it:

- `plan_slots.week` and `.day` present-or-absent together.
- `workouts.actual_total` equal to the sum of `sets[].actual`.

---

## 10. Two behaviours that were verified, not assumed

**Timestamps are not all `toISOString()` output.** Imported sessions carry a **zone-less local**
timestamp — `2026-05-29T08:34:00`, nineteen characters, no `Z` — because `toIso()` in
`src/import/pipeline.ts:175-178` assembles it from the CSV's wall-clock fields and has no offset
to apply. A `CHECK (length(performed_at) >= 20)`, or a validator demanding a trailing `Z`, would
have rejected **all 29 real sessions** at the migration gate. Both spellings are accepted, and the
column stores whichever one the record carried, byte for byte.

**`STRICT` does not stop every coercion.** It rejects `18.5` in an INTEGER column
(`cannot store REAL value in INTEGER column`) and rejects `'seventy-seven'`. It **accepts** the
string `'77'` in an INTEGER column and stores the integer `77`, because that conversion is
lossless and reversible. So the DDL cannot promise a JavaScript `number` was written — only that
what is stored has the declared type. The runtime validator is the other half of that boundary:
it rejects `'77'` for `actualTotal` before any SQL is built. Both halves are asserted in
`server/db.test.ts` and `server/validate.test.ts`.

**`out[key] = value` loses a key named `__proto__`.** `JSON.parse('{"__proto__":{}}')` produces a
genuine own `__proto__` property — the one place JSON.parse deliberately differs from
object-literal syntax — and assigning it back invokes the setter on `Object.prototype` instead, so
the key vanishes. `patternParams`, `restPolicyParams`, `decision`, `patternMetrics` and
`evaluation.measured` all hold caller-supplied keys, so this was a live path to a validator that
accepts a backup and silently returns a copy with a property missing. Every dynamic-key write now
goes through `defineOwn()` in `server/canonical.ts`, and the round trip is asserted through a real
JSON column.

**`node:sqlite` arms foreign keys by default; SQLite does not.** `DatabaseSync` sets
`enableForeignKeyConstraints` to true, so the server's own connections arrive armed — but SQLite
itself defaults the pragma OFF and does not store it in the file, so the `sqlite3` CLI,
`better-sqlite3` or a restore script opens the same file with every foreign key inert.
`armConnection()` states it rather than inheriting it.

**A version number the DDL cannot check itself.** `meta.schema_version >= 1` is all a `CHECK` can
say; it cannot know which build is opening the file. `assertSchemaVersion()` requires exactly one
meta row carrying exactly this build's `SCHEMA_VERSION`, before a single record is read or
written. An older binary opening a newer database is the same class of silent loss as an unknown
property in a backup, but against the live dataset.

---

## 11. Re-import conflict policy

The migration must be repeatable without becoming destructive:

- id absent → `INSERT`
- id present, canonically identical content → no-op
- id present, different content → **abort and report**, writing nothing
- **never** `INSERT OR REPLACE`: SQLite's `REPLACE` deletes the conflicting row and re-inserts,
  which fires `ON DELETE` actions and interacts badly with foreign keys.

"Canonically identical" is `canonicalJson(a) === canonicalJson(b)` — sorted keys, dropped
`undefined`, normalised `-0` — so key order and absent-versus-undefined never register as a
difference. `insertSql()` in `server/rows.ts` emits a plain `INSERT` and has no other mode.

---

## 12. What this does not cover

- The server, its routes, and how `meta.revision` is bumped per accepted command.
- The in-progress workout draft, which stays in IndexedDB as a write-ahead buffer and is not part
  of this schema.

(The importer, the temp-file-then-atomic-rename procedure and the verification checks were the
next step and are now built — see §14. The exclusive-ownership lock the two share is §15.)

## 13. Verified against the real data, 2026-07-30

This section previously recorded that nothing here had been checked against the bytes on the
device holding the only copy — everything was derived from the types and from the code that
writes them. **That gap is now closed.**

A backup was exported from the live database at `http://localhost:5173` (29 workouts, 36 plan
slots, 2 challenges, 2 exercises, 1 max test) and driven through this layer end to end:

1. `validateBackupStrict` accepted it — every record and every nested object, against the field
   specs in `fields.ts`.
2. Every record was inserted into a database built from `schema.sql`, in one transaction.
3. `PRAGMA foreign_key_check` returned no rows.
4. `PRAGMA integrity_check` returned `ok`.
5. Every record was read back and compared **deep-equal, field for field**, against the source —
   exercises, challenges, performance tests, plan slots, workouts and settings.

So the matrix, the DDL, the canonical encoder and the validator all hold against real history,
not only fixtures. In particular the zone-less 19-character timestamps that `toIso()` emits
(`import/pipeline.ts:175-178`) pass, which is the concrete failure this would most plausibly have
had — a stricter ISO rule would have rejected all 29 sessions at the migration gate.

The test that proved it was deliberately **not** kept: it reads an absolute path to an export
outside the repository, so it would fail for anyone else and rot here. It is reproducible from
this description in a few lines against `rows.ts` and `schema.ts`.

What remains genuinely unverified is narrower than before: the REAL-versus-INTEGER rule is still
a judgement about what *future* values could be, not a claim about the 29 sessions, whose numbers
are all integral today. The migration still imports into a temporary file and verifies before
anything is renamed into place.

---

## 14. The importer, and what it proves — 2026-07-30

`server/migrate.ts` + `server/verify.ts` + `server/import-backup.ts`. Run it with:

```
npm run import-backup -- <backup.json> --target <database.sqlite> --dry-run
```

That compiles `server/` first, because Node's type stripping does not rewrite a `./migrate.js`
specifier to the `./migrate.ts` file beside it and every module here uses that spelling. The
compiled command is `node dist-server/server/import-backup.js`.

### The procedure

1. `validateBackupStrict` — every field of every record, unknown format versions refused. Nothing
   is created and no lock is taken, so a rejection here costs nobody anything.
2. Take `<target>.lock` **exclusively** and hold it to the end. The server holds the same lock for
   its whole lifetime, so this is where "you forgot to stop the server" becomes a refusal naming
   the process instead of a lost afternoon. See §15.
3. Read the existing target **read-only**, decoding every row through `rows.ts` (which
   re-validates it). Refuse if a `-wal`, `-shm` or `-journal` sidecar is present.
4. Plan: absent id → insert; present and canonically identical → no-op; present and different →
   **abort, naming the ids and the differing fields**. Never `INSERT OR REPLACE`.
5. Build a **fresh** database in a temporary file inside the target's own directory, holding
   stored ∪ incoming, in one transaction.
6. Verify it — 13 checks, below. Any failure discards the temporary file.
7. `fsync`; copy the old database to `<target>.pre-import-<timestamp>.sqlite` with
   `COPYFILE_EXCL`; re-confirm the lock is still ours; re-check for sidecars; `renameSync`;
   `fsync` the directory.

Nothing is ever deleted. Not the safety copy, not the backup JSON, and not the browser's
IndexedDB — no code in this work calls `indexedDB.deleteDatabase`.

The output is **rebuilt, not patched**: an existing target's records go back in through the same
gate the import came through, rather than being carried forward as bytes. A true no-op — nothing
new in the backup — skips the rename entirely, so the file is not touched at all.

### The 13 checks

| # | Check | What only it can see |
|---|---|---|
| 1 | `PRAGMA integrity_check` | page/B-tree corruption |
| 2 | `PRAGMA foreign_key_check` | a declared reference that does not resolve in SQL |
| 3 | meta | one row, this build's schema version, the expected revision |
| 4 | row counts | a record that did not land |
| 5 | id sets | a *swapped* id, which leaves the count intact |
| 6 | record-by-record canonical equality | a coerced number, a dropped field |
| 7 | **columns physically hold what the record says** | a *symmetric* encode/decode defect |
| 8 | duplicate primary keys | a PRIMARY KEY that went missing from the DDL |
| 9 | references resolve | `chainId` and friends, which have no foreign key |
| 10 | attempt-number uniqueness | a lost unique index |
| 11 | slot belongs to the workout's challenge | a cross-challenge link every FK accepts |
| 12 | totals equal the sum of their parts | a set silently dropped from a JSON array |
| 13 | settings is a single expected row | a lost or duplicated preferences row |

Check 7 is the answer to the hardest form of Codex's original objection. Checks 4–6 all speak
through `rows.ts` and `fields.ts`, so an encoder and a decoder that are wrong **in the same way**
agree with each other and pass — a round trip is symmetric, and symmetry is not meaning. Codex's
example: `encode` writes `chainId` into the `challenge_id` column while `decode` reads it back the
same way round. Integrity passes, the foreign key resolves, the record reconstructs perfectly — and
every SQL query, index and join on `challenge_id` returns the wrong rows. So `COLUMN_ORACLE` in
`server/verify.ts` states the record-to-column mapping a **second time**, independently, and reads
the columns with SQL that never touches `rows.ts`. It also refuses any column it does not name, so
the schema cannot grow past it in silence.

Two checks fail closed with a named door: `--allow-dangling-chain-head` (§9 explains why `chain_id`
has no foreign key) and `--allow-total-mismatch` (§6). Neither is needed for the owner's data.

### Verified against the real data, again

The 29-session export (2 exercises, 2 challenges, 1 max test, 36 plan slots, 29 workouts,
**3134 reps**) was driven through the whole importer:

- a dry run built and verified a complete database and left nothing behind;
- a real import created the file and passed all 13 checks;
- the `sqlite3` CLI — a connection that knows nothing about this codebase — reads 29 workouts and
  3134 reps out of it, and answers `ok` to `integrity_check` and nothing to `foreign_key_check`;
- **re-running with the same file is byte-identical**: nothing inserted, no rename, no safety copy;
- re-running with one session's `actualTotal` altered **aborts**, names the workout id and the two
  differing fields, and leaves the database byte-identical.

The tests in the repository use `server/fixtures.ts`, not that export: a test reading an absolute
path outside the repository would fail for everyone else and rot.

### Still unverified

Crash-recovery behaviour on the eventual deploy filesystem, and the safety copy's collision retry
(guarded by `COPYFILE_EXCL` plus a random suffix, but not exercised by a test).

---

## 15. Exclusive ownership — the gap that is now closed, 2026-07-30

This section previously said **"stop the server before importing"** and admitted the importer could
not enforce it: the sidecar check cannot see an *idle* SQLite connection, and on POSIX a `rename`
over a file a process still has open succeeds — that process keeps writing into an unlinked inode
and those writes are gone. It was recorded as an open gap because closing it needs a contract with
two sides and `server/db.ts` did not exist yet. It exists. The gap is closed.

**`server/lock.ts` is the contract, and both sides now honour it.**

- The server takes `<database>.lock` in `openDatabase` *before* it opens the file, and gives it
  back in `close()` — connection first, then lock, so the file is never advertised as free while
  this process still has it.
- The importer takes the same lock before its first read and holds it through the rename, and
  re-confirms immediately before the rename that the file on disk is still the lock it took.
- So an import cannot begin while a server has the database open, idle or not, and a server cannot
  start on a database an import is rebuilding.

### Why a lock file, and not `flock`

There is no advisory-locking call in Node's standard library — no `flock`, no `fcntl`, and no
`O_EXLOCK` in `fs.constants` on this platform (BSD and macOS have that flag; Linux does not, so it
was never the portable answer). Reaching `flock(2)` would mean a native addon, and this project
takes no new runtime dependencies. The choice was "lock file or nothing".

That is a fortunate constraint. POSIX `fcntl` record locks are released when **any** file
descriptor for that file is closed anywhere in the process — a `readFileSync` of the lock file in
unrelated code would silently drop a live server's lock. `flock(2)` does not have that flaw but is
not POSIX and is unreachable from here anyway.

### Telling a stale lock from a live one

The lock file is JSON: role, pid, hostname, pid namespace, the host's boot time, an ISO timestamp,
a nonce. A pid number only means something inside one host **and** one pid namespace, so both are
checked before it is probed at all.

| Observation | Verdict |
|---|---|
| hostname differs | **unknowable** — that pid means nothing here |
| pid namespace differs | **unknowable** — two containers, one bind mount, one hostname |
| the file will not parse | **unknowable** |
| pid is not running | **stale** |
| pid is running, boot time matches | **live** |
| pid is running, boot time does not | **unknowable** — a reboot plus pid reuse |

Boot time is `Date.now() - os.uptime()`, which a wall-clock step would move, so it is only ever
allowed to *withhold* a verdict, never to produce one. A dead pid decides staleness alone.

The record parser is deliberately strict — positive integer pid, non-empty host and nonce, parseable
timestamp, known role. Not tidiness: `undefined` means *unknowable*, which means refuse, while
anything that parses gets **judged**, and a judgement is what breaks a lock. Codex found the
concrete instance: `pid: -1` used to parse, `process.kill(-1, 0)` says no such process, and a
hand-mangled lock file was therefore "provably stale".

### Breaking one, and why the two sides differ

- **The server reclaims a provably stale lock itself**, printing what it did and keeping the old
  lock file as `<lock>.stale-<uuid>`. A server that refused to start after a power cut would train
  the owner to delete lock files by hand, which is exactly the habit this must not create.
- **The importer only reclaims when told to**, with `--break-stale-lock` — which is not a
  `--force`: it refuses a live holder and refuses one it cannot judge, so it does nothing at all
  against a running server, and exists for one situation, after a crash.

Reclaiming is not "unlink and take it". Codex's critical finding against the first version of this
was a TOCTOU: importer A judges stale lock S, server B reclaims S and starts using the database, A
then renames *B's* lock aside, takes its own, reads its own nonce back happily, and renames a fresh
database over the one B has open. A pathname is a name for a thing, not the thing.

There is no conditional rename in POSIX and none in Node, so the check happens **after**: the lock
is read through a descriptor that is also `fstat`ed, so the record and its inode arrive together;
`renameSync` preserves the inode; and if what lands at the sideline is not the object that was
judged, it is renamed straight back and the acquisition refuses. The importer never reaches the
database rename.

### Where the guarantee does *not* hold

- **Only processes that take the lock are constrained.** `sqlite3 godmode.sqlite`, a backup tool, a
  file manager — none of them know the lock exists. This is not a mandatory filesystem lock and
  cannot be one. (The sidecar check is kept for exactly this reason: it catches a database left
  mid-write by something that never took the lock.)
- **NFS.** `open(O_CREAT|O_EXCL)` is atomic on NFSv4 and on NFSv3 servers that implement exclusive
  create properly; older NFSv3 emulation can produce two winners or a spurious `EEXIST`, and a
  read-back is a transient observation rather than proof of continuing ownership. Keep the database
  on local storage.
- **Container bind-mounts.** This protocol assumes every participant shares one filesystem **and**
  one pid namespace. Where they do not, the verdict is *unknowable* and nothing is broken
  automatically — correct, but it means a hard-killed container leaves a lock its replacement
  refuses. Deleting that lock in an entrypoint is only safe if the orchestrator guarantees the old
  task is gone before the new one starts, which rolling deployments and multi-replica services do
  **not**. If yours cannot guarantee that, the exclusivity has to come from outside — a
  single-attachment volume, or a single replica — and this lock is a second line rather than the
  guarantee.
- **`release` is not an atomic conditional unlink**, because POSIX has none. It checks the inode
  and the nonce first, which makes "release after somebody already broke and retook this lock" a
  no-op instead of a deletion of a live holder's lock. A mitigation, not a proof.
- **A third acquirer inside the reclaim-and-restore window** can take a lock that the restore then
  overwrites. It finds out at `assertStillHeld`, which runs immediately before every destructive
  operation, so the outcome is a refusal rather than a loss.

### Proved by a real second process

`server/lock.test.ts` spawns an actual `node` child that takes the lock through the real module and
opens a real `DatabaseSync` connection to the target, then sits idle. With it running, the tests
assert that:

- **no `-wal`, `-shm` or `-journal` file exists** — the premise of the whole finding, asserted
  rather than described. This is precisely what the old check could not see;
- the import refuses, naming the holding process id, and the target is **byte-identical by SHA-256
  before and after**;
- a `--dry-run` refuses too, rather than rehearsing against a moving database;
- `--break-stale-lock` is useless against it;
- after `SIGTERM` (clean release) the import succeeds; after `SIGKILL` the leftover lock is refused
  as stale, and only then does `--break-stale-lock` take it.

A second Codex round against this implementation is at `.planning/codex-lock-verdict.txt`; its
findings on the reclaim TOCTOU, pid namespaces, the exit handler, the `openDatabase` failure path,
and record-parser strictness were adopted and are the reason those parts read as they do.

Not covered by a test, and said rather than hidden: the cleanup path when `writeFileSync` fails on
a lock file that was just created (reviewed, not exercised — a write failure on a freshly opened
descriptor cannot be induced portably), and the process `exit` handler, which is reachable only by
killing a real server mid-flight.
