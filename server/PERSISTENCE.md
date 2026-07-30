# Persistence matrix — every field, every column

**Written:** 2026-07-30 · **Schema version:** 1 · **Backup format read:** 1

This is the field-by-field contract between the record types in `src/` and the SQLite schema in
`server/schema.sql`. It is exhaustive, not illustrative. Every property of every persisted record
and every nested type appears below exactly once.

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

`actualTotal` is **not** constrained to equal the sum of `sets[].actual`. It is a recorded fact
from the source export's own total column, not a derived one, and a constraint that recomputed it
would reject any session where the incumbent's arithmetic differs from ours.

---

## 7. `settings` — `SettingsRecord` (`src/db/schema.ts:134`) — 7 fields

One row: `CHECK (id = 'settings')`.

| Property | TS type | Optional? | SQL column | SQL type | Nullable | Validation rule | Index / FK |
|---|---|---|---|---|---|---|---|
| `id` | `'settings'` | no | `id` | TEXT | no | `CHECK (id = 'settings')` | PRIMARY KEY |
| `bodyweightKg` | `number \| undefined` | **yes** | `bodyweight_kg` | REAL | yes | finite, `> 0` | — |
| `kcalCoefficient` | `number` | no | `kcal_coefficient` | REAL | no | finite, `>= 0` (default `0.003`) | — |
| `restOverrideSeconds` | `number \| undefined` | **yes** | `rest_override_seconds` | REAL | yes | finite ≥ 0. Typed into a number input (`Settings.tsx:202`) | — |
| `lastBackupAt` | `string` | **yes** | `last_backup_at` | TEXT | yes | `ts` | — |
| `onboardedAt` | `string` | **yes** | `onboarded_at` | TEXT | yes | `ts` | — |
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

- The importer itself, the temp-file-then-atomic-rename procedure, and the count/id-set
  comparisons against the source. That is the next step; this one is its foundation.
- The server, its routes, and how `meta.revision` is bumped per accepted command.
- The in-progress workout draft, which stays in IndexedDB as a write-ahead buffer and is not part
  of this schema.

One thing is **unverified**: nobody has read the live IndexedDB on the device that holds the only
copy. Everything above is derived from the types and from the code that writes them, not from the
bytes. That is the reason the REAL-versus-INTEGER rule leans the way it does, and the reason the
migration imports into a temporary file and verifies before anything is renamed into place.
