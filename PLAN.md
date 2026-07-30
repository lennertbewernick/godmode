# Fitness Companion — Plan

A local-first, open-source, single-tenant fitness companion PWA. Replaces the "Just 6
Weeks" freemium push-up challenge, built so camera-based rep counting can be added later
without a rewrite.

Status: planning. Nothing implemented yet.
License: AGPL-3.0.
Source material: one CSV export of 29 logged sessions (committed at
`example/incumbent-history-sample.csv`), six screenshots of the incumbent app, and the
confirmed baseline max test of **18**.

The screenshots are **not in this repository and never will be** — they are captures of another
company's proprietary interface, and of a personal phone. They stay on the author's machine. What
they showed is recorded below claim by claim, so a reader can see exactly which assertions rest on
an artifact they cannot inspect. That is a real limit on independent verification and is stated
rather than hidden: the CSV is reproducible evidence, a screenshot citation is testimony.

> **Epistemic status.** This document distinguishes three tiers throughout:
> **[VERIFIED]** — confirmed against the committed CSV, or against a screenshot held locally
> (see the note on source material: screenshot-only claims are testimony, not reproducible).
> **[INFERRED]** — a reasonable reading of the data, not proven.
> **[OUR CHOICE]** — a transparent design decision of ours, *not* recovered from the
> incumbent. Earlier drafts of this plan blurred these; an adversarial design review
> (2026-07-30) forced the separation. Do not re-blur them.

---

## 1. The progression model

### 1.1 One percentage table [VERIFIED at two points]

`Ziel: 100` is a **single-set** goal — 100 push-ups in one go, not per session. The program
ramps an *estimated current max* from baseline toward that goal and prescribes each session
as percentages of wherever the estimate sits.

```
SET_PERCENTAGES = [0.37, 0.47, 0.37, 0.33, 0.51]     // sums to 2.05
```

Set 5 is a floor, displayed `N+`. The percentages sum to **205%**, which is why terminal
volume lands at ~2× the headline goal. This answers "why did it target over 200": the
program never asks for 100 in one set — it builds toward a session whose best set is `51+`.

| | Est. max | 37% | 47% | 37% | 33% | 51%+ | Total |
|---|---|---|---|---|---|---|---|
| **W1D1** | 18 | 7 | 8 | 7 | 6 | 9+ | 37 |
| **W6D3** | 100 | 37 | 47 | 37 | 33 | 51+ | 205 |

Both rows reproduce observed cards exactly. `0.37×18=6.66→7`, `0.47×18=8.46→8`,
`0.33×18=5.94→6`, `0.51×18=9.18→9`. At goal 100 the prescribed sets *are* the percentages.

**Scope of this verification.** Two endpoints, one of which (W6D3) is the *only* card we
have from a screenshot. Every other row in the CSV is **actual reps, not prescribed
targets**. They coincide when the user hit the prescription, but that is an inference.

### 1.2 Set shape — "medium, big, medium, small, biggest+"

| Set | Role | % of est. max |
|-----|------|---------------|
| 1 | medium | 37 |
| 2 | **big** | 47 |
| 3 | medium | 37 |
| 4 | *small* | 33 |
| 5 | **biggest+** (AMRAP) | 51 |

Set 4 dips deliberately below the medium sets so something is banked for the AMRAP set.

**Invariant — non-strict.** [OUR CHOICE, corrected]

```
set5 >= set2 >= set1 == set3 >= set4      // plus: AMRAP asserted via metadata, not ordering
```

A strict version is **unsatisfiable at ordinary baselines** — integer rounding collapses
adjacent roles:

```
M=14 → 5,7,5,5,7    set5>set2 fails
M=20 → 7,9,7,7,10   set3>set4 fails
M=21 → 8,10,8,7,11  strict holds
```

M(2) of the reference program is 19.9, generating `7,9,7,7,10` — a strict assertion would
fail on **slot 2 of the very program this model was derived from**. Strictness holds only
from M≥21 for this table, and gating pull-ups behind a baseline of 21 would be absurd.
Do not "repair" rounded output to satisfy an ordering; that changes the prescription.

**Rounding must be specified, not inherited.** The invariant is sensitive at `.5`
boundaries, so the generator pins one rule explicitly (half-up on the exact decimal, not
`Math.round` on a float, not banker's rounding) and tests it.

### 1.3 The estimated-max ramp [OUR CHOICE]

```
M(n) = baseline × (goal / baseline) ^ ((n − 1) / (N − 1))
r = (100 / 18) ^ (1/17) = 1.1061        // ≈ 10.6% per session
```

**This is our transparent approximation, not a recovered algorithm.** Honest scorecard
against the reference data — 5 of 18 slots reproduce exactly:

| Slot | Model total | Observed | |
|---|---|---|---|
| 1 | 37 | 37 | exact ✓ |
| 2–11 | — | — | 2–13% **low** |
| 12 | 112 | 112 | exact ✓ |
| 13 | 123 | 123 | exact ✓ |
| 14 | 137 (`25·31·25·22·34`) | 138 (`25·32·25·22·34`) | −1 |
| 15 | 151 | 156 | −5 |
| 16 | 167 | 167 | exact ✓ |
| 17 | 184 | 187 | −3 |
| 18 | 205 | 205 (screenshot) | exact ✓ |

Alternative models were evaluated and rejected:

- **Calendar-position ramp** — *disproven.* The 11 repeat sessions stretched elapsed time,
  so calendar interpolation gives M≈47.4 at W4D3 (total ~98 vs observed 112) and ~105 at
  W5D1 (vs 123). Substantially too low mid-program.
- **AMRAP-driven recalibration** — unsupported. Would require two trajectories to
  distinguish; we have one. Fittable after the fact, which is not reverse engineering.
- **Two-segment ramp** — approximates it (18→41 over slots 1–10 is ~9.6%/slot, 41→100 over
  11–18 is ~11.8%/slot) but adds parameters with no mechanistic evidence.
- **Precomputed nonlinear table** — the most likely explanation for the incumbent. Consumer
  fitness apps typically ship a lookup table, in which case the endpoints tell us little
  about the interior and no closed form exists to find.

We ship the explicit geometric curve because it is inspectable and adjustable, not because
it is what the incumbent does.

### 1.4 Repeat-on-miss [VERIFIED]

A session **passes when sum(actual) ≥ target total** — the total, not individual sets:

- 2026-06-09 `10·13·10·9·13` = 55 → repeated; 2026-06-11 `10·13·10·9·14` = 56 → passed.
  Sets 1–4 byte-identical; only the AMRAP set differed by one rep.
- W4D2 repeated four times, marching `92 → 98 → 104 → 108`, passing exactly at 108.

A failed session still counts and is still logged. The slot produces another attempt.
The final logged session was 202 against 205, which by this rule repeats.

### 1.5 Rest between sets [OUR CHOICE]

What ships (`src/core/policies/rest.ts`):

```
rest_s = clamp(round_to_5(0.71 × sessionVolume + 4), 30, 180)
```

This is **algebra through two assumed endpoints** (30 s at volume 37, 150 s at volume 205),
giving slope `(150−30)/(205−37) ≈ 0.714`. It is not independent evidence. The duration
cross-check is underidentified: one aggregate `Zeit` per session cannot separate rep pace
from rest from UI transitions from skipped timers. A configurable product default, nothing
more.

> **Note, 2026-07-30.** Earlier drafts of this section wrote the same line against the
> generation max instead of session volume: `1.46 × M(n) + 4`, through the endpoints
> M=18 and M=100. The two are near-identical by construction, since volume ≈ 2.05 × M and
> `0.71 × 2.05 ≈ 1.4555`, but they are not the same function — rounding to 5 s lands
> differently, and slots 2 and 6 come out 5 s apart. The volume form is what the code
> computes, so it is what this section now documents. Rest is a product default either way;
> the point of recording the discrepancy is that the plan and the code must not be allowed
> to drift apart silently.

### 1.6 Calories [OUR CHOICE]

The incumbent's kcal column is **not explained by any simple monotonic function of reps or
duration** — 37 reps → 13 kcal but 44 reps → 9 kcal. An external sensor feed (HealthKit /
watch) is one plausible hypothesis, not an established finding. (Separately: the app
paywalls the column behind `Premium` and shows `–`, yet ships values in the CSV export.)

Our own coarse estimate, order-of-magnitude only:

```
mechanical ≈ bodyweight_kg × 0.65 × 9.81 × 0.4 m   ≈ 204 J/rep at 80 kg
metabolic  ≈ mechanical / 0.22                     ≈ 0.22 kcal/rep at 80 kg
kcal       ≈ reps × bodyweight_kg × 0.003
```

The 0.65 and 0.4 m terms depend on body geometry and technique, so the coefficient is
**configurable**, and displacement is not claimed to be height-independent. Bodyweight is
the only required input. Always labelled an estimate, never gated.

Imported kcal and computed kcal must never be conflated: store `value`, `source`
(`external` | `estimated`), and `estimator_version` separately so a formula change does not
silently rewrite history.

---

## 2. MVP definition

**The smallest thing that lets a challenge-group member delete the incumbent without losing
anything.**

### 2.1 Must-have

1. **CSV import** with a locale-tolerant mapping layer (§4.3)
2. **Plan generator** — pure, inspectable, `(baseline, goal, weeks, days_per_week) → N slots`
3. **Adjustable segments** (§2.2)
4. **Workout runner** — set-by-set, rest timer + audio cue, correctable reps. Set 5 is the
   screen that matters; the others are countdown
5. **Repeat-on-miss** with explicit outcome states (§2.2)
6. **History** — list, cumulative chart, lifetime totals
7. **Export** — canonical JSON + CSV round-trip, with active backup prompting (§3)
8. **Settings** — exercise label, bodyweight, rest curve override

### 2.2 Adjustable segments and outcome states

Two distinct operations:

- **Redistribute** — move reps between sets, total unchanged. Never affects pass/fail.
- **Rescale** — change the session total. An easier or harder day.

Every attempt carries **one outcome**:

| Outcome | Counted in history | Advances slot |
|---|---|---|
| `completed_as_planned` | yes | yes |
| `scaled_up` | yes | yes |
| `deload` (rescaled down) | yes | **no** |
| `failed` (missed target) | yes | no |
| `advanced_manually` | yes | yes — explicit, confirmed, recorded |

**Rationale.** The repeat-on-miss ratchet is the engine of the program; if lowering a total
advanced the plan, the ratchet is gone. But calling a session done while ill a "failure" is
wrong — the work happened. So a deload is fully counted and simply does not advance.

**`advanced_manually` is the required escape hatch.** Without it a user who deloads
repeatedly is stuck on one slot forever. It demands explicit confirmation and is recorded,
never inferred from a deload.

**Three separate metrics, never conflated** — otherwise deloading inflates a streak while
dodging failure:

- **Activity streak** — any logged workout
- **Plan compliance** — `completed_as_planned` + `scaled_up` only
- **Challenge progress** — advanced slots / total slots

On the cumulative chart, the *planned* line advances once per slot; the *actual* line
includes every attempt and deload. Both labelled.

### 2.3 Explicitly out of MVP

Multiple concurrent challenges · accounts · sync · leaderboard · vision rep counting ·
notifications · watch app · i18n (English UI only) · user-defined set counts (phase 2).

### 2.4 No exercise illustrations

Exercises are a **label/identifier only** — no artwork, animation, or demo video. This
removes the largest asset cost and is the main reason the MVP is finishable.

---

## 3. Architecture

**Local-first PWA. No backend in the MVP.**

(Not "no backend ever" — a future group-comparison feature may need one. The defensible
scope statement is MVP-bounded.)

| Concern | Choice | Why |
|---|---|---|
| Build | Vite + TypeScript | Boring, no config drift |
| UI | React + Tailwind | Largest body of MediaPipe examples for phase 5 |
| Storage | IndexedDB (`idb`), versioned schema | Reliable on iOS Safari; SQLite-wasm/OPFS still dicey there |
| Charts | Hand-rolled SVG | One line chart needs no dependency |
| Tests | Vitest | Generator is pure — heavily unit-tested |
| Offline | Service worker, installable | Must work mid-workout with no signal |

**Storage durability is a real risk.** iOS evicts IndexedDB for unused sites, and the device
is the only copy. JSON export existing is not sufficient — onboarding must explain it, and
the app must actively prompt for a backup on a cadence. Treat data loss as a product
concern, not a footnote.

Phase 5 uses **browser-side pose detection** (MediaPipe Tasks Vision), not Python: Python
can't run on an iPhone, and the phone propped against a wall is the actual use case.

The generator, pass rule, and rest curve live in a pure `core/` module with no DOM and no
storage imports.

### 3.1 Distributing to the challenge group

One static deployment. Each member opens it, installs to home screen, imports their own
CSV. Storage is per-device, so "single tenant" and "shareable" are not in tension — N
isolated datasets, zero accounts. Requires: works unaided on a fresh iPhone from a link;
per-person baseline and goal; nothing hardcoded to push-ups or to 100.

Group comparison, if built, is a **manual share card** (export an image or JSON summary to
paste into the group chat). Post-MVP.

---

## 4. Data model

```
exercise        id, label, unit='reps', created_at

exercise_template  id, exercise_id, set_count,
                   coefficients[]        -- ordered, e.g. [.37,.47,.37,.33,.51]
                   roles[]               -- medium|big|small|amrap
                   -- data, not code. Phase 0 ships exactly one: 5-set push-up.

challenge       id, exercise_id, template_id, goal, weeks, days_per_week,
                baseline_max, growth_rate, started_at, completed_at, status

plan_slot       id, challenge_id, ordinal, week, day, estimated_max, rest_s
                -- IMMUTABLE generated targets only

plan_slot_target  id, plan_slot_id, index, reps, role, is_amrap
                  -- child rows, NOT fixed columns

workout         id, challenge_id, plan_slot_id (nullable), attempt_no,
                performed_at, duration_s, note,
                outcome, adjustment_type, scale_factor, effective_total
                -- effective targets + deviation live HERE, per attempt

workout_set     id, workout_id, index, effective_target, actual,
                started_at, ended_at, rest_after_s

kcal_record     workout_id, value, source, estimator_version

settings        bodyweight_kg, kcal_coefficient, rest_curve_override, ...
```

### 4.1 The decisions that matter

**`plan_slot → workout` is 1:N.** Repeats mean one `(week, day)` slot accumulates attempts.

**Overrides live on `workout`, not `plan_slot`.** Each attempt can adjust differently —
attempt 1 redistributes, attempt 2 deloads, attempt 3 scales up. A single override field on
the slot overwrites history and makes past pass/fail decisions unreconstructable. `plan_slot`
targets are immutable once generated.

**Targets are child rows, not five columns.** This is what makes variable set counts a
later feature rather than a migration.

**`plan_slot_id` is nullable.** Imported workouts that don't reconcile to a generated slot
are stored unlinked rather than force-fitted.

**`(week, day)` is not globally unique** — reconciliation keys on challenge identity too.

### 4.2 Improvement over the incumbent

`workout_set` records per-set timestamps. The incumbent stores one aggregate duration,
which is exactly why rest had to be guessed (§1.5). Free at write time.

### 4.3 Import: a four-stage pipeline

```
raw file → [1] parse → rows → [2] map (profile) → canonical JSON
         → [3] validate → report → [4] commit → DB
```

**Positional mapping profiles.** Because mapping is positional, translated headers do *not*
require separate profiles — only differing value formats do. So one tolerant
`incumbent-csv-v1` profile covers the 14-column semicolon layout across languages, with date
format detected rather than assumed:

```json
{
  "id": "incumbent-csv-v1",
  "delimiter": ";",
  "dateFormats": ["d.M.yyyy HH:mm", "M/d/yyyy HH:mm"],
  "durationFormat": "mm:ss",
  "columns": {
    "date": 0, "exercise": 1, "goal": 2, "challengeLength": 3,
    "week": 4, "day": 5, "duration": 6,
    "sets": [7, 8, 9, 10, 11], "total": 12, "kcal": 13
  }
}
```

**Why positional.** The export has **two columns both named `Zeit`** — index 3 is the
challenge length (`"6 Wochen"`), index 6 is the session duration (`mm:ss`). Header-keyed
parsing risks collapsing them depending on the library's duplicate-header behaviour; some
return row arrays or support header transforms, so this is a concrete hazard rather than a
universal failure. Positional mapping removes the question.

**Canonical JSON** is the real interchange format: what exports produce, what fixtures are
written in, and what a group member sends when reporting an import bug.

**Reconciliation.** Attach imported workouts to generated slots by `(challenge, week, day)`
and report disagreements. **Never manufacture prescribed targets from actual reps** — the
CSV contains actuals only, and the model's own slots 2–11 diverge from the reference data
(§1.3), so forcing agreement would fabricate history. Unreconcilable rows stay unlinked.

Other dialect facts: dates unpadded (`29.5.2026 08:34`); rows ascend by date; repeated
`(week, day)` pairs are attempts; `kcal` imported with `source=external`.

---

## 5. Roadmap

MVP is phases 0–4.

| Phase | Scope | Done when |
|---|---|---|
| **0** | Repo, TS, `core/` generator + pass rule + rest curve + explicit rounding; template-as-data with one 5-set push-up template | Reproduces §1.1 endpoints exactly; §1.2 non-strict invariant asserted across M=1..200; rounding rule tested at `.5` |
| **1** | Import pipeline, `incumbent-csv-v1` profile, canonical JSON, IndexedDB schema | The real 29-session CSV imports and round-trips; unreconciled rows land unlinked |
| **2** | Runner, rest timer, audio, rep correction, outcome states, segment adjustment | A full session logs offline on a phone; all five outcomes reachable |
| **3** | History list, cumulative chart (planned vs actual), three metrics, kcal | Matches the incumbent's stats screen, minus the paywall |
| **4** | PWA polish, backup prompting, deploy for the group | A group member goes link → imported history unaided |
| **5** | *Post-MVP:* MediaPipe rep counting; manual share card; user-defined set counts | — |

### Phase 5 sketch

`PoseLandmarker` in a Web Worker; rep counting as an elbow-angle state machine with
hysteresis to reject partials; form checks via shoulder–hip–ankle collinearity (hip sag)
and elbow depth. Behind a `RepSource` interface (`manual` | `vision`) so the runner doesn't
care which is active. Defining that interface in phase 2 is the only phase-5 concession the
MVP makes.

---

## 6. Resolved decisions

| Decision | Choice |
|---|---|
| Exercises | Template/coefficients as per-exercise data; only 5-set push-ups ships in phase 0 |
| Set count | Generic storage now (child rows); user-defined counts post-MVP |
| Downward rescale | Counted, does not advance; `advanced_manually` is the escape hatch |
| Group comparison | Manual share card, post-MVP. No backend in MVP |
| UI language | English only, no i18n |
| Import locale | One tolerant positional profile; date format detected |
| License | AGPL-3.0 |

## 7. Remaining unknowns

1. **The incumbent's true interior progression.** Slots 2–11 are unexplained (§1.3). Most
   likely a precomputed table with no closed form. We do not need to solve this — we ship
   our own transparent curve — but no future claim should assert we recovered it.
2. **Low-rep exercises.** A pull-up-style challenge (baseline ~5) needs its own template
   and progression, not a threshold switch into another unvalidated table. Blocked on a
   real use case and fixtures.
3. **English export format.** No English CSV sample exists. The `dateFormats` list is a
   guess until someone supplies a real file.
