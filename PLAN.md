# Fitness Companion — Plan

A local-first, single-tenant, open-source replacement for the "Just 6 Weeks" push-up
challenge, built so that camera-based rep counting can be added later without a rewrite.

Status: planning. Nothing implemented yet.
Source material: `example/` (one CSV export, six screenshots of the incumbent app),
plus the confirmed baseline max test of **18**.

---

## 1. Reverse-engineered mechanism

Derived from `example/incumbent-history-sample.csv` (29 logged sessions, 6 weeks,
3134 reps), the workout cards in the screenshots, and the known baseline of 18.

### 1.1 One percentage table drives everything

`Ziel: 100` is a **single-set** goal — 100 push-ups in one go, not per session. The
program works by ramping an *estimated current max* from your baseline to that goal, and
prescribing each session as fixed percentages of wherever that estimate currently sits.

```
SET_PERCENTAGES = [0.37, 0.47, 0.37, 0.33, 0.51]     // sums to 2.05
```

Set 5 is a floor, displayed as `N+`. The percentages sum to **205%**, which is why the
terminal session volume lands at ~2× the headline goal. This resolves the "it targeted
over 200 for me" confusion: the program never asks for 100 in one set. It builds you to a
session whose best set is `51+`, on the theory that the 100-rep test is then in reach.

The table is confirmed at both endpoints of the observed challenge:

| | Estimated max | 37% | 47% | 37% | 33% | 51%+ | Total |
|---|---|---|---|---|---|---|---|
| **W1D1** (baseline) | 18 | 7 | 8 | 7 | 6 | 9+ | 37 |
| **W6D3** (goal) | 100 | 37 | 47 | 37 | 33 | 51+ | 205 |

Both rows reproduce the logged/screenshotted cards exactly. Note that at goal = 100 the
prescribed sets *are* the percentages, which is almost certainly how the incumbent
implements it.

### 1.2 Set shape — "medium, big, medium, small, biggest+"

| Set | Role | % of est. max |
|-----|------|---------------|
| 1 | medium | 37 |
| 2 | **big** | 47 |
| 3 | medium | 37 |
| 4 | *small* | 33 |
| 5 | **biggest+** (AMRAP) | 51 |

The shape is scale-free: `7·8·7·6·9+` and `37·47·37·33·51+` are the same curve at
different magnitudes. Set 4 dips deliberately below the medium sets so something is banked
for the AMRAP set.

**Invariant to assert on every generated session:**

```
set5 > set2 > set1 == set3 > set4
```

Naive rounding at small estimated maxima will collapse `set1 == set3` or lift `set4` above
`set1`. The assertion catches that class of bug immediately. It is also the reason the
generator must round each set independently rather than distributing a total.

### 1.3 The estimated-max ramp

The estimate grows **geometrically from baseline to goal** across the N sessions
(6 weeks × 3 days = 18):

```
M(n) = baseline × (goal / baseline) ^ ((n − 1) / (N − 1))

r = (100 / 18) ^ (1/17) = 1.1061      // ≈ 10.6% per session
```

Validation — exact to the rep, across the entire back half:

| Session | Est. max | Model | Observed card |
|---------|----------|-------|---------------|
| W4D3 | 54.6 | 20 · 26 · 20 · 18 · 28 (112) | 20 · 26 · 20 · 18 · 28 ✓ |
| W5D1 | 60.5 | 22 · 28 · 22 · 20 · 31 (123) | 22 · 28 · 22 · 20 · 31 ✓ |
| W5D2 | 66.9 | 25 · 32 · 25 · 22 · 34 (138) | 25 · 32 · 25 · 22 · 34 ✓ |
| W6D1 | 81.8 | 30 · 38 · 30 · 27 · 42 (167) | 30 · 38 · 30 · 27 · 42 ✓ |
| W6D3 | 100 | 37 · 47 · 37 · 33 · 51 (205) | 37 · 47 · 37 · 33 · 51+ ✓ |

Sessions 1 and 12–18 land exactly. Sessions 2–11 run ~8–10% *below* this curve (observed
W2D2 total was 49, curve says 55). Most likely the incumbent recalibrates the remaining
ramp from AMRAP performance rather than holding a fixed curve. Not distinguishable from a
single export — and deliberately **not** replicated here: this project ships the explicit
curve plus manual per-session adjustment (§2.2), which is inspectable and gives the user
the control an opaque adaptation algorithm takes away.

### 1.4 Repeat-on-miss

A session **passes when the sum of actual reps ≥ the session's target total**. The
criterion is the total, not the individual sets:

- 2026-06-09: `10·13·10·9·13` = 55 → repeated.
  2026-06-11: `10·13·10·9·14` = 56 → passed.
  Sets 1–4 byte-identical; only the AMRAP set differed by one rep.
- W4D2 repeated four times, marching `92 → 98 → 104 → 108`, passing exactly at 108.

A failed session still counts and is still logged. The same `(week, day)` slot simply
produces another attempt with the same targets.

Note: the final logged session was 202 against a 205 target (48 on a `51+` set), which by
this rule should repeat.

### 1.5 Rest between sets

Not directly recoverable from the CSV — the `Zeit` column bundles work and rest. Derived
from the two known endpoints (30 s at baseline 18, ~150 s at goal 100):

```
rest_s = clamp(round_to_5(1.46 × M(n) + 4), 30, 180)
```

Cross-validated: solving the recorded session durations for a constant rep pace yields
~2.2 s/rep and ~77–99 s effective rest through the middle of the program, against this
formula's 83 s (W4D3) and 91 s (W5D1). Two independent derivations agree.

Rest is skippable in-workout via −/+ controls, which is why observed durations sit below
what the ladder implies.

### 1.6 Calories — not reproducible, and that is the finding

The incumbent's kcal column is **not a function of reps or duration**: 37 reps → 13 kcal,
but 44 reps → 9 kcal. That noise signature indicates measured HealthKit / watch energy,
not arithmetic. (The app paywalls the column behind `Premium` in the UI and shows `–`, yet
ships the values in the CSV export anyway.)

This project computes a transparent estimate instead. A push-up lifts ~65% of bodyweight
through ~0.4 m; counting the eccentric at ~22% metabolic efficiency:

```
kcal ≈ reps × bodyweight_kg × 0.003
```

≈ 0.25 kcal/rep at 80 kg, so a 202-rep session ≈ 50 kcal. **Required body data:
bodyweight only.** Height/age/sex add negligible accuracy for this movement; heart rate
would help materially if a watch feed is ever added. Always labelled an estimate, never
gated.

### 1.7 Remaining unknown

Only one: **the early-session divergence** described in §1.3. Everything else in this
section is confirmed against observed data at both endpoints.

---

## 2. MVP definition

The MVP is not "a push-up app". It is **the smallest thing that lets a challenge-group
member delete the incumbent without losing anything.**

### 2.1 Must-have

1. **CSV import with a mapping layer** (§4.3). Group members have months of history in the
   incumbent, possibly in different locales. An app that starts empty offers no reason to
   switch.
2. **Plan generator as a pure, inspectable function.**
   `(baseline_max, goal, weeks, days_per_week) → N sessions`, seedable from imported
   history as well as a fresh baseline test.
3. **Adjustable segments** (§2.2).
4. **Workout runner.** Set-by-set, rest timer with audio cue, correctable actual reps.
   Set 5 is the screen that matters — the other four are countdown.
5. **Repeat-on-miss.** Target missed ⇒ same slot again, still logged, showing how far
   short ("3 reps short").
6. **History.** List view, cumulative line chart, lifetime totals (time / reps / kcal).
7. **Export.** Canonical JSON + CSV that round-trips the import.
8. **Settings.** Exercise label, bodyweight, rest curve override.

### 2.2 Adjustable segments

Every prescribed set is editable, before or during a session. Two distinct operations,
which must not be conflated:

- **Redistribute** — move reps between sets, keeping the session total. Same stimulus,
  different shape. Never affects pass/fail.
- **Rescale** — change the session total itself. An easier or harder day.

Storage keeps both the generated and the effective values (`target_*` +
nullable `override_*`), so the canonical plan is always visible and revertible, and the
history can honestly mark a session as deviating from plan.

**Open decision:** when a session is rescaled *down*, does the pass rule follow the
adjusted total or the original? Following the adjusted total makes the plan trivially
passable; following the original makes the adjustment pointless. Current lean: follow the
adjusted total, but mark the session `deviated` in history and exclude it from any
"completed as planned" count.

### 2.3 Explicitly out of MVP

Multiple concurrent challenges · exercises beyond a free-text label · accounts · sync ·
social/leaderboard features · vision rep counting · notifications · watch app.

### 2.4 No exercise illustrations

Exercises are a **label/identifier only**. No artwork, animation, or demo video. This
removes the largest asset-production cost and is the main reason the MVP is finishable.

---

## 3. Architecture

**Local-first PWA. No backend, ever.**

| Concern | Choice | Why |
|---------|--------|-----|
| Build | Vite + TypeScript | Fast, boring, no config drift |
| UI | React + Tailwind | Largest body of MediaPipe examples for phase 5 |
| Storage | IndexedDB (via `idb`), versioned schema | Reliable on iOS Safari; SQLite-wasm/OPFS still dicey there |
| Charts | Hand-rolled SVG | One line chart does not justify a dependency |
| Tests | Vitest | Generator is pure — heavily unit-tested |
| Offline | Service worker, installable | Must work mid-workout with no signal |
| Backend | none | Keeps "single tenant, local app" true at every stage |

Phase 5 decision: **browser-side pose detection** (MediaPipe Tasks Vision), *not* Python.
Python + MediaPipe cannot run on an iPhone, and the phone propped against a wall is the
actual use case. The browser path uses the same underlying model family, runs on-device,
and preserves the offline property. Python stays available later for desktop offline video
analysis, off the critical path.

The plan generator, pass rule, and rest curve live in a pure `core/` module with no DOM and
no storage imports. That module is the part worth getting right.

### 3.1 Distributing to the challenge group

One static deployment at a URL. Each member opens it, installs to home screen, imports
their own CSV. Storage is per-device, so "single tenant" and "shareable with the group"
are not in tension — there are N isolated local datasets and zero accounts.

Requirements this imposes:

- Must work for a non-technical user on a fresh iPhone with no setup beyond opening a link
- Import must tolerate locale variation in their exports (§4.3)
- Baseline and goal must be settable per person; nothing hardcoded to push-ups or to 100
- Full JSON export/import, so a phone change does not lose history

---

## 4. Data model

```
exercise      id, label, unit='reps', created_at

challenge     id, exercise_id, goal, weeks, days_per_week,
              baseline_max, growth_rate, started_at, completed_at, status

plan_slot     id, challenge_id, ordinal, week, day, estimated_max,
              target_set1..target_set5, target_total, rest_s,
              override_set1..override_set5, override_total, deviated

workout       id, challenge_id, plan_slot_id, attempt_no,
              performed_at, duration_s, kcal_estimate, note

workout_set   id, workout_id, index, target, actual,
              started_at, ended_at, rest_after_s

settings      bodyweight_kg, rest_curve_override, locale, ...
```

### 4.1 The one modelling decision that matters

`plan_slot → workout` is **1:N**, not 1:1. Repeats mean a single `(week, day)` slot
accumulates multiple attempts. Conflating plan with log is the mistake that forces a
schema migration later. Targets live on the slot; actuals live on the workout.

### 4.2 Improvement over the incumbent

`workout_set` records per-set timestamps. The incumbent stores one aggregate duration,
which is why rest had to be reverse-engineered at all (§1.5). Capturing it is free at
write time and makes real rest analysis possible.

### 4.3 Import: a four-stage pipeline

Parsing and committing are separated by an explicit serialized intermediate, so import is
testable, reviewable, and shareable.

```
raw file  →  [1] parse  →  rows
          →  [2] map (profile)  →  canonical JSON
          →  [3] validate  →  report
          →  [4] commit  →  DB
```

**Stage 2 — mapping profiles.** Declarative, positional, one per source dialect:

```json
{
  "id": "incumbent-csv-de",
  "delimiter": ";",
  "dateFormat": "d.M.yyyy HH:mm",
  "durationFormat": "mm:ss",
  "columns": {
    "date": 0, "exercise": 1, "goal": 2, "challengeLength": 3,
    "week": 4, "day": 5, "duration": 6,
    "sets": [7, 8, 9, 10, 11], "total": 12, "kcal": 13
  }
}
```

Profiles are **data, not code**, so group members on other locales can contribute one
without touching the parser. `incumbent-csv-en` and friends live beside `incumbent-csv-de`.

**Why positional indices, not header names:** the incumbent's export has **two columns both
named `Zeit`** — column 4 is the challenge length (`"6 Wochen"`), column 7 is the session
duration (`mm:ss`). Any name-keyed parser (`csv.DictReader`, most JS libraries with
`header: true`) silently drops one and corrupts the import without erroring. Positional
mapping makes the bug structurally impossible.

**Stage 2 output — canonical JSON.** The serialized intermediate is the project's real
interchange format. It is what gets exported, what test fixtures are written in, what a
group member sends when reporting an import bug, and what survives a schema change.

**Stage 3 — reconciliation.** Generate the canonical plan from `goal` + `baseline`, attach
imported workouts to slots by `(week, day)`, and report where generated targets disagree
with observed set maxima. Observed values are ground truth; disagreement is a warning, not
a failure. Expect disagreement on sessions 2–11 per §1.3.

Other dialect details: dates are unpadded (`29.5.2026 08:34`); rows ascend by date;
repeated `(week, day)` pairs are repeat attempts; `kcal` is imported but flagged
`source=external` and excluded from our own estimates.

---

## 5. Roadmap

MVP is phases 0–4.

| Phase | Scope | Done when |
|-------|-------|-----------|
| **0** | Repo, TS, `core/` generator + pass rule + rest curve, unit tests | Reproduces every card in §1.1 and §1.3 exactly; invariant §1.2 asserted |
| **1** | Import pipeline, mapping profiles, canonical JSON, IndexedDB schema | The existing 29-session CSV imports and re-exports round-trip clean |
| **2** | Workout runner, rest timer, audio cue, rep correction, repeat logic, segment adjustment | A full session can be logged offline on a phone |
| **3** | History list, cumulative chart, lifetime totals, kcal estimate | Matches the incumbent's stats screen, minus the paywall |
| **4** | PWA polish — installable, offline, iOS home screen; deploy for the group | A group member can go from link to imported history unaided |
| **5** | *Post-MVP:* MediaPipe pose rep counting | — |

### Phase 5 sketch (not MVP)

`PoseLandmarker` in a Web Worker; rep counting as an elbow-angle state machine with
hysteresis to reject partials; form checks via shoulder–hip–ankle collinearity (hip sag)
and elbow depth. Behind a `RepSource` interface with `manual` and `vision`
implementations, so the runner does not care which is active. Defining that interface in
phase 2 is the only phase-5 concession the MVP makes.

---

## 6. Open questions

1. **Which exercises does the group do?** The 37/47/37/33/51 table is validated only for
   push-ups at baseline 18 → goal 100. A pull-up challenge at baseline 5 would prescribe
   `2·2·2·2·3+`, where integer rounding dominates and the §1.2 invariant may be
   unsatisfiable. Low-rep movements likely need their own table or a floor rule.
2. **"Segments adjustable" — values only, or also the number of sets?** Editing the five
   values is straightforward. Allowing 4 or 6 sets means the percentage table stops being
   a fixed 5-tuple and becomes a shape function.
3. **Pass rule under downward rescale** — see §2.2.
4. **Locale spread of the group's exports** — determines which mapping profiles ship first.
5. **Progress comparison.** A "challenge group" implies wanting to compare. Fully local
   means no leaderboard without a backend. A manual export/share card is the no-backend
   compromise — is that enough?
6. **License.** MIT vs AGPL.
