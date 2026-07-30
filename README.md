# GodMode

**No More Later.**

A progressive bodyweight challenge planner. Give it one honest max test and a target, and it
builds the plan, runs the workout set by set, repeats the days you miss, and keeps the whole
history. It runs entirely on your phone — no account, no server, nothing paywalled.

Built to replace the free tier of a freemium challenge app, and to keep going after the six
weeks are over.

## What it does

- **Imports your existing history.** Drop in the CSV your current app exports and every
  session, repeat and rep comes across.
- **Builds a plan** from your baseline and your goal, three sessions a week.
- **Runs the session** — set by set, with a rest timer that grows as the sessions get bigger.
- **Repeats the days you miss.** You do not move on until you hit the number.
- **Lets you adjust.** Shuffle reps between sets, or scale a day up or down when life happens.
- **Keeps going afterwards.** Retest, set a new target, and your history carries over.
- **Exports everything** as CSV or a full JSON backup. Nothing is locked in.

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # 130 tests
npm run build    # production build + service worker
```

Open the built app on your phone and add it to your home screen. It works offline.

## How the progression works

Each session prescribes five sets as fixed percentages of an estimated max:

| Set | Share of max |
|-----|--------------|
| 1 | 37% |
| 2 | 47% |
| 3 | 37% |
| 4 | 33% |
| 5 | 51%, open-ended |

Those percentages add up to **205%**, which is why a goal of 100 produces a final session of
205 reps rather than 100. You are never asked for 100 in a single set — the last set of the
last day asks for 51 or more, on the theory that the 100 is then within reach.

The estimated max climbs geometrically from your baseline to your goal across the plan, about
10.6% per session for a six-week block starting at 18.

The fifth set is the one that matters. It is the only open-ended one, it is the largest, and
everything before it is scaffolding.

### Where the numbers came from

The percentage table was reverse-engineered from a real 29-session export plus screenshots of
the source app, and it is exact at both ends of a six-week block:

- baseline 18 → `7 · 8 · 7 · 6 · 9+` (37 total)
- goal 100 → `37 · 47 · 37 · 33 · 51+` (205 total)

The curve *between* those two points is our own. It reproduces 5 of the 18 reference sessions
exactly and runs high on the early ones. The original app's interior progression is not
recoverable from a single export — most likely it ships a lookup table — so this uses an
explicit, adjustable curve instead of guessing. `PLAN.md` documents the full derivation and
marks every claim as verified, inferred, or a design choice of ours.

### A distinction that matters

Three numbers get confused with each other, and the app keeps them apart:

- **Goal** — an input to the plan. Setting a goal of 100 says "build the last day from 100".
  It does not claim you can do 100.
- **Best set** — reps on an open-ended set, performed after everything before it. A real
  measurement, but a tired one.
- **Max test** — one rested set to failure. The only honest basis for a new plan.

So when a block ends, the app asks you to retest rather than assuming your goal was reached.

## Data

Everything lives in IndexedDB on your device. There is no server and no account, which also
means the device holds the only copy — the app will nag you to export a backup, and iOS does
sometimes clear storage for web apps you have not opened in a while.

The JSON backup contains the full dataset including plan versions and provenance, so a
restore reconstructs the database rather than just a rep log.

## Stack

Vite · TypeScript · React · Tailwind · IndexedDB (`idb`) · Vitest. No backend, no charting
library, no component library, no exercise artwork.

## Licence

AGPL-3.0-or-later. See `LICENSE`.
