# GodMode

**No More Later.**

A push-up (and sit-up, and squat) challenge planner that runs on your phone. You tell it how
many you can do right now and what you want to get to. It builds the plan, counts you through
each workout, makes you repeat the days you miss, and keeps every rep you have ever done.

No account. No subscription. Nothing hidden behind "Premium". Your data never leaves your
phone.

It exists because the app most of us started this challenge on is free until it isn't, and
because it simply stops after six weeks — and we wanted to keep going.

---

# Part 1 — For everyone

## Getting it on your phone

There is nothing to install from an app store. GodMode is a web page that behaves like an app
once you add it to your home screen.

### iPhone / iPad

1. Open **Safari** and go to the link you were sent. It has to be Safari — Chrome on iPhone
   cannot add proper home-screen apps.
2. Tap the **Share** button at the bottom of the screen (the square with an arrow pointing up).
3. Scroll down the list and tap **Add to Home Screen**.
4. Tap **Add** in the top-right corner.

You now have a GodMode icon on your home screen. Open it from there, not from Safari — that way
it runs full screen, with no browser bars, and it works without signal.

### Android

1. Open **Chrome** and go to the link.
2. Either tap the **Install** prompt that appears at the bottom, or tap the **⋮** menu in the
   top-right and choose **Install app** / **Add to Home screen**.
3. Confirm.

### On a computer

Just open the link in any modern browser. Everything works, it is simply designed for a phone
held in one hand.

## Bringing your history across

If you have been using Just 6 Weeks, you do not have to start from zero.

**Step 1 — get your data out of the old app.**

1. Open Just 6 Weeks.
2. Tap **Statistics** in the bottom bar.
3. Tap the small **CSV** icon in the top-right corner.
4. Save or send the file to yourself — AirDrop, email, WhatsApp to yourself, Files app,
   whatever is easiest. You just need to be able to find it again on your phone.

**Step 2 — put it into GodMode.**

1. Open GodMode. On first launch it offers **Bring your history across**.
2. Tap the file picker and choose the CSV you just saved.
3. You will see a summary: how many sessions it found, your total reps, how many planned days
   there were, and how many were repeats.
4. Check the **baseline max** it suggests. It works this out backwards from your very first
   session, and it is usually right — but if you remember the number you actually managed on
   your first test, type that instead.
5. Tap **Import my history**.

That is it. Every session, every repeat, every rep is now in GodMode, and it picks up exactly
where you left off.

### If you have never done the challenge

Choose **Take a max test** instead. Do one honest set of push-ups: rested, good form, stop when
you stop. Enter that number, pick what you want to get to, and GodMode builds your plan.

## Using it day to day

**Today** shows the session you owe. Something like:

```
Week 6 · Day 3                    205
37   47   37   33   51+       reps to pass
```

Five sets. Do 37, rest, 47, rest, 37, rest, 33, rest, then as many as you can manage on the
last one — at least 51. Tap **Start** and it counts you through, running the rest timer between
sets and beeping when it is time to go again.

If you tap a number wrong, fix it at the end — the review screen lets you correct every set
before you save.

**You have to hit the total to move on.** If the plan says 205 and you do 202, that day comes
round again. That is the entire engine of the thing: it is why you go from 18 push-ups to a
hundred instead of plateauing at whatever felt comfortable.

### When you cannot manage the full session

Tap **Adjust** before you start. Two different things you can do:

- **Move reps between sets.** Same total, different shape. Maybe 40·40·40·40·45 suits you
  better than 37·47·37·33·51 today. This changes nothing about passing.
- **Change the total.** An easier day when you are ill, travelling, or wrecked — or a harder one
  when you feel good.

An easier day still counts. It goes in your history, your reps, your time, your streak. It just
does not move you on to the next day, because you have not done the next day's work yet. The app
calls that a **deload**, not a failure.

If you get properly stuck on one day, after a few attempts GodMode offers to move you on anyway.
It records that you skipped, so your numbers stay honest, but it stops blocking you.

### After the six weeks

When you finish the last day, GodMode does not just congratulate you and stop. It asks you to
**test your max again**, then set a new target, and builds the next block. Your whole history
carries over — the chart keeps climbing across every block you ever do.

You can also set the new target equal to your current max, which gives you a hold-steady block
rather than a climb.

## Your numbers

**History** shows three things that are deliberately kept apart, because they are not the same
achievement:

| | What it means |
|---|---|
| **Streak** | Days in a row you showed up at all |
| **Compliance** | How often you actually hit the prescribed number |
| **Progress** | How far through the plan you are |

You can deload every session and keep a perfect streak. That is fine — showing up matters — but
it should not look like you are hitting your numbers, so it doesn't.

The chart has two lines. The solid one is every rep you actually did. The dashed one is what the
plan asked for. Yours will probably sit *above* the plan, because repeated days mean extra work.

**Calories** are a rough estimate, not a measurement. Set your bodyweight in Settings and it
works out roughly how much energy the work took. It is shown because there is no reason to hide
it, but treat it as a ballpark.

## Backups — please read this one

Your data is stored on your phone and nowhere else. That is the point: no account, no server,
nobody's database but yours.

It also means **if you lose the phone, or iOS clears the storage, the data is gone.** iOS does
sometimes wipe storage for web apps you have not opened in a while.

So: every so often, go to **Settings → Export backup**. It saves one file. Put it somewhere that
is not your phone — cloud drive, email to yourself, anywhere. If you ever need it, **Settings →
Restore from a backup** puts everything back.

GodMode will nag you about this. Let it.

You can also export a **CSV** at any time, in the same format the old app used. Nothing here is
locked in.

## Stuck? Ask an AI

If you would rather be walked through it than read this, paste the app's link into ChatGPT,
Claude, or whatever you use, and ask it to help you install it. The site serves a file at
**`/llms.txt`** written specifically for that — the install steps, the CSV export path, the
vocabulary, and the mistakes people actually make. Assistants read it automatically.

---

# Part 2 — How it works

This part explains the actual mechanism. You do not need it to use the app, but it is the
interesting bit.

## The plan

Every session prescribes five sets, as fixed percentages of an *estimated max*:

| Set | Share of max | Character |
|-----|--------------|-----------|
| 1 | 37% | medium |
| 2 | 47% | **big** |
| 3 | 37% | medium |
| 4 | 33% | *small* |
| 5 | 51%, open-ended | **biggest** |

Two things fall out of that table.

**It adds up to 205%.** That is why a goal of 100 produces a final session of 205 reps rather
than 100. You are never asked for 100 in one go — the last set of the last day asks for 51 or
more, on the theory that a hundred is then within reach. This is the single most confusing thing
about the original app, and it is just this.

**Set 4 dips below sets 1 and 3 on purpose**, so you have something left for the open-ended set.
Set 5 is the only one that is uncapped, it is the largest, and everything before it is
scaffolding.

The estimated max climbs geometrically from your baseline to your goal across the block — about
10.6% per session for a six-week, three-day-a-week block starting at 18.

```
M(n) = baseline × (goal / baseline) ^ ((n − 1) / (sessions − 1))
set_i = round(M(n) × coefficient_i)
```

## Where those numbers came from

They were reverse-engineered from one real 29-session CSV export plus six screenshots of the
original app. The table is **exact at both ends** of a six-week block:

| | Estimated max | Sets | Total |
|---|---|---|---|
| First day | 18 | `7 · 8 · 7 · 6 · 9+` | 37 |
| Last day | 100 | `37 · 47 · 37 · 33 · 51+` | 205 |

Both match the source data to the rep. At a goal of 100, the prescribed sets literally *are* the
percentages, which is almost certainly how the original is implemented.

**The curve between those two points is ours, not theirs.** It reproduces 5 of the 18 reference
sessions exactly and runs high on the early ones. A calendar-based model was tested and
disproven. The original most likely ships a hand-tuned lookup table with no formula to find, so
GodMode uses an explicit, inspectable, adjustable curve instead of pretending to have recovered
something it hasn't.

`PLAN.md` has the full derivation, and marks every claim as **verified**, **inferred**, or **our
own design choice**. That distinction is maintained deliberately — an earlier draft blurred it
and overstated how much had actually been recovered.

## Three numbers that are not the same thing

This one matters, and getting it wrong would quietly corrupt every future block:

- **Goal** — an input to the plan. Setting a goal of 100 says *"build the last day from 100"*.
  It makes no claim about what you can do.
- **Best set** — reps on an open-ended set. A real measurement, but a tired one: 48 reps at the
  end of a session that already contained 154 is not the same as 48 fresh.
- **Max test** — one rested set to failure. The only honest basis for building a new plan.

The original app's framing invites you to think finishing a "100 push-ups" challenge means you
can do 100 push-ups. It doesn't. So when a block ends, GodMode asks you to retest rather than
assuming, and every baseline it stores records where the number came from — tested, typed in,
imported, or estimated.

## Passing, and the five outcomes

A session passes when **the sum of your actual reps meets or beats the target total.** Not
per-set — the total. That is verified from the source data: one session came in at 55 against
56, with the first four sets identical to the successful retry, and it repeated.

Every attempt gets exactly one outcome:

| Outcome | Counts in history | Moves you on |
|---|---|---|
| Completed as planned | yes | yes |
| Scaled up | yes | yes |
| **Deload** (you lowered the total) | yes | **no** |
| Missed | yes | no |
| Moved on anyway | yes | yes — recorded as a skip |

"Counts" and "moves you on" being separate columns is what lets a deload be honest work without
being a free pass.

## Rest

Rest grows with the size of the session — roughly 30 seconds at the start of a block, about two
and a half minutes by the end.

This is a sensible default, not recovered behaviour: the source export bundles work and rest into
a single duration per session, so the two cannot be separated from it. Override it with one fixed
number in Settings if you prefer.

## Calories

The original app paywalls this column and shows a dash — while still writing the values into its
CSV export.

Its numbers are not reproducible from any simple formula (37 reps → 13 kcal, but 44 reps → 9),
which suggests they come from a watch or HealthKit rather than arithmetic. So GodMode computes
its own, transparently:

```
kcal ≈ reps × bodyweight_kg × 0.003
```

That comes from lifting roughly 65% of bodyweight through about 0.4 m at around 22% metabolic
efficiency — about 0.25 kcal per rep at 80 kg. Bodyweight is the only body measurement needed;
height and age add nothing worth having for this movement.

Imported calorie values are kept separate from computed ones and never mixed, and each estimate
records which version of the formula produced it, so changing the formula later cannot silently
rewrite your history.

## What it does not do

Deliberately absent:

- **Exercise pictures, animations, demo videos.** An exercise is a label. This was the single
  biggest cost in the project and cutting it is why the app exists at all.
- **Accounts, sync, a server.** All three would break the one property that matters most.
- **A leaderboard.** Comparing with the group is a share card you paste into the chat, and it is
  not built yet.
- **Multiple challenges at once.**
- **Other languages.** English only. The *importer* handles other languages; the interface
  doesn't.

---

# Part 3 — For developers

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # 130 tests
npm run typecheck
npm run build      # production bundle + service worker into dist/
```

## Deploying it

`npm run build` produces a `dist/` folder of static files. Serve it from anywhere — nginx, Caddy,
a static host, a subfolder. There is no backend, no environment variables, and no build-time
configuration. `base: './'` in `vite.config.ts` means it works from a subpath too.

Then send people the URL and point them at the install instructions above.

## Stack

Vite · TypeScript (strict, `exactOptionalPropertyTypes`) · React · Tailwind · IndexedDB via
`idb` · Vitest. No backend, no charting library, no component library.

## Layout

```
src/core/         pure domain logic — no DOM, no storage, no React
  types.ts          domain types and the three-different-numbers distinction
  rounding.ts       explicitly pinned rounding (see below)
  contracts.ts      the three pluggable seams
  stats.ts          totals, streaks, metrics, cumulative series
  patterns/         percentage-ramp: the Just 6 Weeks progression
  policies/         rest and evaluation policies
src/db/           IndexedDB schema and repository
src/import/       the four-stage CSV pipeline + mapping profiles
src/data/         backup, restore, CSV export
src/ui/           screens and a small hand-rolled component kit
public/llms.txt   install + setup guide written for AI assistants, served at /llms.txt
```

`src/core/` is where the value is. It has no imports from the rest of the app and is heavily
tested.

## The three seams

The owner asked for flexibility across workout patterns, so there are three narrow, versioned
extension points. **One implementation of each ships** — this is a seam, not a framework.

```ts
interface ProgramPattern<P, S> {
  id: string
  version: number
  plannedSessionCount(params: P): number | undefined
  initialState(params: P): S
  next(input: { params, state, history }): { slot, nextState, decision } | null
}
```

`next()` is **incremental** rather than returning the whole plan. Deterministic patterns lose
nothing — `materialize()` runs it in a loop — but an adaptive pattern (RPE-driven, recalibrating
from your open-ended set, or open-ended with no known end) is not blocked by an interface that
assumes every plan is knowable up front.

`RestPolicy` exists so patterns do not each reimplement clamping and rounding. `EvaluationPolicy`
returns **separate `satisfied` and `advances` flags**, which is precisely what makes "a deload
counts but does not advance" expressible rather than a special case bolted on later.

## Data model notes

Four decisions that would be expensive to change later:

- **One planned day can have many workouts.** Repeats mean a single day accumulates attempts.
  Conflating the plan with the log is the mistake that forces a migration.
- **Adjustments live on the workout, not the day.** Attempt 1 might redistribute and attempt 2
  deload; a single override field on the day would destroy the record of why each attempt passed
  or failed.
- **Set targets are a variable-length array, not five columns.** In a document store that is the
  child-row requirement satisfied for free, and it makes a different set count a feature rather
  than a migration.
- **A workout's planned-day link is optional.** An imported session that cannot be matched is
  kept unlinked rather than force-fitted onto the wrong day.

## Rounding

`src/core/rounding.ts` pins one rule — half away from zero, on the decimal value — and it is not
fussiness:

```
Math.round(-2.5)  === -2     // rounds toward +Infinity
roundHalfUp(-2.5) === -3
1.005 * 100       === 100.49999999999999   // so naive rounding gives 100, not 101
```

The set ordering is sensitive at `.5` boundaries, so an unpinned rule changes prescriptions.

## Import pipeline

```
raw text → parse → rows → map (profile) → canonical JSON → validate → commit
```

The canonical JSON in the middle is the real interchange format: it is what exports produce, what
test fixtures are written in, and what you would send when reporting an import bug.

**Columns are addressed positionally, never by header name.** The Just 6 Weeks export contains
**two columns both named `Zeit`** — index 3 is the challenge length (`"6 Wochen"`), index 6 is the
session duration (`"06:31"`). Building a dictionary from the header collapses 14 columns to 13 and
silently loses one. There is a test that demonstrates exactly that failure.

Because mapping is positional, a translated export does **not** need its own profile — only a
different *value* format does, which in practice means the date. Date format is detected by
trying candidates and preferring the one that yields chronological order, and it reports genuine
ambiguity rather than guessing silently.

Imported rows carry **actual reps only**. Prescribed targets are never manufactured from them.

### One subtlety worth knowing

When importing, GodMode does *not* judge your old sessions against its own targets. Its early-week
curve is higher than the original's, so doing that would mark your finished weeks as failed and
send you back to week 1.

Instead it recovers the original app's own decisions from the shape of the data: that app repeated
a day until you passed it, so history on a later day proves the earlier days passed. Only the
furthest day you reached is genuinely undecided, and there the real pass rule applies. On the
reference file that yields days 1–17 complete and day 18 still open — which is the true state,
because that session came in at 202 against 205.

## Tests

```sh
npm test
```

130 tests, all pure or against a fake IndexedDB. Notable ones:

- Both verified reference cards reproduce exactly.
- The set ordering holds for **every integer max from 1 to 200** — non-strictly, with regression
  guards proving a *strict* version is unsatisfiable (`M=14 → 5,7,5,5,7`, `M=20 → 7,9,7,7,10`).
  A strict assertion would have failed on session 2 of the very data the model came from.
- The rounding boundary cases above.
- The real CSV, where present, asserted down to individual sessions. It is personal data, so those
  blocks skip when the file is absent and a committed synthetic fixture covers the structure — the
  suite is green on a fresh clone either way.

## How this was built

The reverse-engineering, planning, and implementation are all in the repository history, including
the corrections.

- `PLAN.md` — the model, the data model, the import design, with verified/inferred/ours markers.
- `.planning/` — GSD-framework project docs: requirements with stable IDs, a six-phase roadmap,
  and current state.
- `docs/reviews/` — captured verdicts from adversarial Codex design reviews.

Two of those reviews changed the design materially before code existed. The first caught an
overstated validation claim, an unsatisfiable invariant, and per-attempt overrides stored in the
wrong place. The second, prompted by the "continue after six weeks" requirement, caught the
three-different-numbers conflation described above.

Three more bugs were caught only by running the app against real data rather than by tests: a
spurious date-ambiguity warning, rest displaying as `3:30` for 150 seconds, and the import
reconciliation problem described above.

## Status and what's next

Roadmap phases 1–5 are implemented and verified end to end. Phase 6 is a real group member going
from a link to imported history unaided.

Planned, not built:

- **On-device rep counting** with the camera, using MediaPipe pose detection in the browser — plus
  form checks for hip sag and elbow depth. Browser-side, not Python: Python cannot run on an
  iPhone, and a phone propped against a wall is the actual use case. The runner already has a seam
  for it.
- **A share card** to paste into the group chat. No backend.
- **User-defined set counts** (4 or 6). Storage already supports it; the prescriptions for those
  counts would be invented rather than derived, so they wait for a real need.
- **Low-rep exercises** like pull-ups need their own table — at a baseline of 5 the current one
  yields `2,2,2,2,3` and falls apart.

## Licence

AGPL-3.0-or-later. See `LICENSE`. Fork it, run it, change it — derivatives stay open, including
hosted ones. That is deliberate, given what it replaces.
