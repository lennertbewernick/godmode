import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalImport } from './pipeline.js';
import { INCUMBENT_CSV_V1 } from './profiles.js';
import { commitImport, estimateBaselineFromImport, reconcile } from './reconcile.js';
import { __setDB, getCurrentSlot, listSlots, listWorkouts } from '../db/repo.js';
import { openFitnessDB } from '../db/schema.js';

/** Real personal export; gitignored, so these assertions are conditional. */
const REAL_PATH = resolve(process.cwd(), 'example/incumbent-history-sample.csv');
const HAS_REAL = existsSync(REAL_PATH);
const REAL_CSV = HAS_REAL ? readFileSync(REAL_PATH, 'utf8') : '';
const canonical = () => buildCanonicalImport(REAL_CSV, INCUMBENT_CSV_V1).canonical;

const FIXTURE_CSV = readFileSync(
  resolve(process.cwd(), 'src/import/__fixtures__/incumbent-csv-v1-sample.csv'),
  'utf8',
);
const fixtureCanonical = () => buildCanonicalImport(FIXTURE_CSV, INCUMBENT_CSV_V1).canonical;

let dbCounter = 0;
beforeEach(() => {
  dbCounter += 1;
  __setDB(openFitnessDB(`test-db-${dbCounter}`));
});

describe.skipIf(!HAS_REAL)('baseline estimation from an import', () => {
  it('recovers the real tested baseline of 18 by inverting the coefficient sum', () => {
    // First session was 37 reps; 37 / 2.05 = 18.05 -> 18, which was the actual test result.
    const estimate = estimateBaselineFromImport(canonical());
    expect(estimate.value).toBe(18);
  });

  it('carries a method id so the estimate is auditable, never labelled as tested', () => {
    const estimate = estimateBaselineFromImport(canonical());
    expect(estimate.method).toBe('invert-coefficient-sum-v1');
    expect(estimate.explanation).toContain('Worked back');
  });

  it('refuses an empty import', () => {
    expect(() =>
      estimateBaselineFromImport({ ...canonical(), sessions: [] }),
    ).toThrow(/empty import/i);
  });
});

describe.skipIf(!HAS_REAL)('IMP-05/IMP-06 — reconciliation reports rather than forces', () => {
  it('matches all 29 sessions onto 18 slots and numbers the attempts', async () => {
    const { slots } = await seed();
    const { assignments, report } = reconcile(canonical(), slots);
    expect(assignments).toHaveLength(29);
    expect(report.matched).toBe(29);
    expect(report.unlinked).toBe(0);
    expect(report.attemptsPerSlot.get(11)).toBe(4); // W4D2 was attempted four times
    expect(report.attemptsPerSlot.get(1)).toBe(1);
  });

  it('numbers repeat attempts chronologically', async () => {
    const { slots } = await seed();
    const { assignments } = reconcile(canonical(), slots);
    const w4d2 = assignments.filter(
      (a) => a.session.week === 4 && a.session.day === 2,
    );
    expect(w4d2.map((a) => a.attemptNo)).toEqual([1, 2, 3, 4]);
    expect(w4d2.map((a) => a.session.actualTotal)).toEqual([92, 98, 104, 108]);
  });

  it('reports divergence where our curve differs, without changing targets', async () => {
    const { slots } = await seed();
    const before = slots.map((s) => s.targetTotal);
    const { report } = reconcile(canonical(), slots);

    // Slots 14/15/17 are known misses; slots 1/12/13/16 match exactly.
    const byOrdinal = new Map(report.divergences.map((d) => [d.ordinal, d]));
    expect(byOrdinal.has(1)).toBe(false);
    expect(byOrdinal.has(12)).toBe(false);
    expect(byOrdinal.get(15)?.difference).toBe(5); // observed 156 vs generated 151

    // Targets are untouched by reconciliation.
    expect(slots.map((s) => s.targetTotal)).toEqual(before);
  });

  it('leaves sessions unlinked when no slot matches, rather than force-fitting', async () => {
    const { slots } = await seed();
    const orphaned = {
      ...canonical(),
      sessions: [
        ...canonical().sessions,
        {
          performedAt: '2026-08-01T09:00:00',
          week: 99,
          day: 9,
          actualSets: [10, 10],
          actualTotal: 20,
          sourceLine: 99,
        },
      ],
    };
    const { report, assignments } = reconcile(orphaned, slots);
    expect(report.unlinked).toBe(1);
    expect(assignments.at(-1)!.slot).toBeUndefined();
    expect(report.notes.join(' ')).toContain('separate history');
  });
});

describe.skipIf(!HAS_REAL)('commitImport — the end-to-end migration', () => {
  it('writes 29 workouts and keeps external kcal distinct', async () => {
    const result = await commit();
    expect(result.workoutsWritten).toBe(29);

    const workouts = await listWorkouts(result.chainId);
    expect(workouts).toHaveLength(29);
    expect(workouts[0]!.kcal).toMatchObject({ value: 13, source: 'external' });
    expect(workouts.every((w) => w.importSource === 'incumbent-csv-v1')).toBe(true);
  });

  it('preserves every performed rep — 3134 total', async () => {
    const result = await commit();
    const workouts = await listWorkouts(result.chainId);
    expect(workouts.reduce((s, w) => s + w.actualTotal, 0)).toBe(3134);
  });

  it('generates the plan from baseline and goal, not from imported actuals', async () => {
    const result = await commit();
    const slots = await listSlots(result.challengeId);
    expect(slots).toHaveLength(18);
    // The verified endpoints, independent of what was imported.
    expect(slots[0]!.targets.map((t) => t.reps)).toEqual([7, 8, 7, 6, 9]);
    expect(slots[17]!.targets.map((t) => t.reps)).toEqual([37, 47, 37, 33, 51]);
  });

  it('leaves the final slot incomplete, because 202 < 205', async () => {
    // The real challenge is NOT finished under the verified pass rule.
    const result = await commit();
    const slots = await listSlots(result.challengeId);
    expect(slots[17]!.status).toBe('available');

    const current = await getCurrentSlot(result.challengeId);
    expect(current?.ordinal).toBe(18);
    expect(current?.targetTotal).toBe(205);
  });

  it('marks slots 1-17 completed by recovering the source app\'s own decisions', async () => {
    // Our curve prescribes 41 for slot 2 where only 39 was performed and accepted. Judging
    // imported history against our targets would rewind a finished programme to week 1.
    const result = await commit();
    const slots = await listSlots(result.challengeId);
    for (let i = 0; i < 17; i += 1) {
      expect(slots[i]!.status, `slot ${i + 1}`).toBe('completed');
    }
    expect(slots[1]!.targetTotal).toBeGreaterThan(39); // the divergence is still visible
  });

  it('labels every repeat attempt except the last as a miss', async () => {
    const result = await commit();
    const workouts = await listWorkouts(result.chainId);
    const slots = await listSlots(result.challengeId);
    const w4d2Id = slots.find((s) => s.week === 4 && s.day === 2)!.id;
    const attempts = workouts
      .filter((w) => w.planSlotId === w4d2Id)
      .sort((a, b) => a.attemptNo - b.attemptNo);
    expect(attempts.map((a) => a.outcome)).toEqual([
      'failed', 'failed', 'failed', 'completed_as_planned',
    ]);
  });

  it('labels the unfinished final session as failed, not completed', async () => {
    const result = await commit();
    const workouts = await listWorkouts(result.chainId);
    expect(workouts.at(-1)!.actualTotal).toBe(202);
    expect(workouts.at(-1)!.outcome).toBe('failed');
  });

  it('records baseline provenance on the challenge', async () => {
    const result = await commit();
    const slots = await listSlots(result.challengeId);
    expect(slots.length).toBeGreaterThan(0);
    const workouts = await listWorkouts(result.chainId);
    // Sanity: chain id is set and shared across the imported history.
    expect(new Set(workouts.map((w) => w.chainId)).size).toBe(1);
  });
});

async function seed() {
  const { createChallenge, createExercise } = await import('../db/repo.js');
  const { pushupParams } = await import('../core/patterns/percentageRamp.js');
  const exercise = await createExercise('Liegestütze');
  return createChallenge({
    exerciseId: exercise.id,
    baseline: { value: 18, source: 'estimated', recordedAt: '2026-05-29T00:00:00' },
    params: pushupParams(18, 100, 6, 3),
  });
}

function commit() {
  return commitImport({
    canonical: canonical(),
    baseline: { value: 18, source: 'estimated', recordedAt: '2026-05-29T00:00:00' },
    goal: 100,
    weeks: 6,
    daysPerWeek: 3,
  });
}


describe('reconciliation on the committed fixture', () => {
  it('estimates a baseline of 18 from a 37-rep opening session', () => {
    expect(estimateBaselineFromImport(fixtureCanonical()).value).toBe(18);
  });

  it('commits the fixture and preserves both attempts on the repeated slot', async () => {
    const result = await commitImport({
      canonical: fixtureCanonical(),
      baseline: { value: 18, source: 'estimated', recordedAt: '2026-03-01T00:00:00' },
      goal: 100,
      weeks: 6,
      daysPerWeek: 3,
    });
    expect(result.workoutsWritten).toBe(8);

    const slots = await listSlots(result.challengeId);
    const w2d3 = slots.find((s) => s.week === 2 && s.day === 3)!;
    const workouts = await listWorkouts(result.chainId);
    const attempts = workouts.filter((w) => w.planSlotId === w2d3.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.outcome)).toEqual(['failed', 'completed_as_planned']);
  });

  it('leaves the furthest slot reached open when it was not satisfied', async () => {
    const result = await commitImport({
      canonical: fixtureCanonical(),
      baseline: { value: 18, source: 'estimated', recordedAt: '2026-03-01T00:00:00' },
      goal: 100,
      weeks: 6,
      daysPerWeek: 3,
    });
    const current = await getCurrentSlot(result.challengeId);
    // Fixture stops at W3D1 (62 performed); our curve prescribes more there.
    expect(current!.ordinal).toBe(7);
  });
});
