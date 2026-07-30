/**
 * Import robustness: the ways a CSV can quietly become wrong data.
 *
 * Every case here was a real defect. The pipeline used to drop a set of 0 and silently
 * renumber the sets after it, round "7.6" to 8, accept 31 February, read "05:99" as 6m39s,
 * and write a session's own actual reps into the field that records what was prescribed.
 */

import { describe, expect, it } from 'vitest';
import { buildCanonicalImport } from './pipeline.js';
import { INCUMBENT_CSV_V1 } from './profiles.js';
import { reconcile } from './reconcile.js';
import { materialize } from '../core/contracts.js';
import { percentageRampPattern, pushupParams } from '../core/patterns/percentageRamp.js';
import { buildCsv } from '../data/exchange.js';
import type { PlanSlotRecord, WorkoutRecord } from '../db/schema.js';

const HEADER =
  'Datum;Workout;Ziel;Zeit;Woche;Tag;Zeit;Set 1;Set 2;Set 3;Set 4;Set 5;Summe der Sets;Kcal';

/** One well-formed row, with the set columns and date overridable. */
function csv(rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

function row(opts: { date?: string; sets?: string; total?: string; duration?: string }): string {
  const date = opts.date ?? '29.5.2026 08:34';
  const sets = opts.sets ?? '7;8;7;6;9';
  const total = opts.total ?? '37';
  const duration = opts.duration ?? '06:31';
  return `${date};Liegestütze;100;6 Wochen;1;1;${duration};${sets};${total};13`;
}

describe('set columns keep their position', () => {
  it('preserves a logged set of zero instead of deleting it', () => {
    const report = buildCanonicalImport(csv([row({ sets: '7;0;7;6;9', total: '29' })]), INCUMBENT_CSV_V1);
    const session = report.canonical.sessions[0];

    expect(session?.actualSets).toEqual([7, 0, 7, 6, 9]);
    // The bug: filtering out the 0 left [7,7,6,9] and made set 3 look like set 2.
    expect(session?.actualSets[2]).toBe(7);
    expect(session?.actualTotal).toBe(29);
  });

  it('treats blank trailing columns as simply fewer sets', () => {
    const report = buildCanonicalImport(csv([row({ sets: '7;8;7;;', total: '22' })]), INCUMBENT_CSV_V1);
    expect(report.canonical.sessions[0]?.actualSets).toEqual([7, 8, 7]);
  });

  // A bad row is paired with a good one: rejecting the whole file would prove nothing about
  // whether the bad row specifically was caught, and `buildCanonicalImport` throws outright
  // when nothing at all survives.
  const goodRow = row({ date: '1.6.2026 09:00' });

  it('rejects a row with a gap between filled set columns rather than guessing', () => {
    const report = buildCanonicalImport(
      csv([row({ sets: '7;;7;6;9', total: '29' }), goodRow]),
      INCUMBENT_CSV_V1,
    );
    expect(report.canonical.sessions).toHaveLength(1);
    expect(report.stats.rowsRejected).toBe(1);
    expect(report.issues.some((i) => /blank between/i.test(i.message))).toBe(true);
  });

  it('rejects a negative set value', () => {
    const report = buildCanonicalImport(
      csv([row({ sets: '7;-3;7;6;9' }), goodRow]),
      INCUMBENT_CSV_V1,
    );
    expect(report.stats.rowsRejected).toBe(1);
    expect(report.issues.some((i) => /negative/i.test(i.message))).toBe(true);
  });

  it('rejects a decimal rep count instead of rounding it', () => {
    const report = buildCanonicalImport(
      csv([row({ sets: '7.6;8;7;6;9' }), goodRow]),
      INCUMBENT_CSV_V1,
    );
    expect(report.stats.rowsRejected).toBe(1);
    expect(report.issues.some((i) => /whole number/i.test(i.message))).toBe(true);
    // Crucially the row was skipped, not silently rounded to a leading 8.
    expect(report.canonical.sessions).toHaveLength(1);
    expect(report.canonical.sessions[0]?.actualSets[0]).toBe(7);
  });
});

describe('dates and durations', () => {
  it('rejects a date that is not on the calendar', () => {
    // 31 February passed the old day<=31 range check and became 3 March.
    expect(() => buildCanonicalImport(csv([row({ date: '31.2.2026 08:34' })]), INCUMBENT_CSV_V1)).toThrow(
      /date column/i,
    );
  });

  it('accepts a real leap day and rejects a fake one', () => {
    const leap = buildCanonicalImport(csv([row({ date: '29.2.2024 08:34' })]), INCUMBENT_CSV_V1);
    expect(leap.canonical.sessions).toHaveLength(1);
    expect(leap.canonical.sessions[0]?.performedAt.startsWith('2024-02-29')).toBe(true);

    // 2026 is not a leap year, so there is no 29 February to parse.
    expect(() => buildCanonicalImport(csv([row({ date: '29.2.2026 08:34' })]), INCUMBENT_CSV_V1)).toThrow(
      /date column/i,
    );
  });

  it('ignores a malformed duration rather than inventing one', () => {
    // "05:99" is not 6m39s. Reading it that way would record a duration never measured.
    const report = buildCanonicalImport(csv([row({ duration: '05:99' })]), INCUMBENT_CSV_V1);
    expect(report.canonical.sessions[0]?.durationSeconds).toBeUndefined();

    const ok = buildCanonicalImport(csv([row({ duration: '06:31' })]), INCUMBENT_CSV_V1);
    expect(ok.canonical.sessions[0]?.durationSeconds).toBe(391);
  });
});

describe('prescriptions are never manufactured from actuals (IMP-07)', () => {
  function slotsFor(baseline: number): PlanSlotRecord[] {
    return materialize(percentageRampPattern, pushupParams(baseline, 100, 6, 3)).map((s, i) => ({
      id: `slot-${i}`,
      challengeId: 'c',
      ordinal: s.ordinal,
      patternId: 'p',
      patternVersion: 1,
      generatedAt: '',
      targets: s.targets,
      targetTotal: s.targetTotal,
      restSeconds: s.restSeconds,
      status: 'available' as const,
      ...(s.week === undefined ? {} : { week: s.week }),
      ...(s.day === undefined ? {} : { day: s.day }),
    }));
  }

  it('leaves a session that matches no plan slot with no prescribed target at all', () => {
    // Week 40 does not exist in a six-week plan, so this row cannot reconcile.
    const unmatchable = `29.5.2026 08:34;Liegestütze;100;6 Wochen;40;1;06:31;7;8;7;6;9;37;13`;
    const report = buildCanonicalImport(csv([unmatchable]), INCUMBENT_CSV_V1);
    expect(report.canonical.sessions).toHaveLength(1);

    const { assignments } = reconcile(report.canonical, slotsFor(18));
    const unlinked = assignments.find((a) => !a.slot);
    expect(unlinked).toBeDefined();

    // The record commitImport would build for it must not claim a prescription.
    const prescribed = unlinked!.session.actualSets.map((_, i) => unlinked!.slot?.targets[i]?.reps);
    expect(prescribed.every((p) => p === undefined)).toBe(true);
  });
});

describe('CSV export cannot be corrupted by a user-typed label', () => {
  const slot: PlanSlotRecord = {
    id: 'slot-1',
    challengeId: 'c',
    ordinal: 1,
    week: 1,
    day: 1,
    patternId: 'p',
    patternVersion: 1,
    generatedAt: '',
    targets: [
      { index: 1, targetKind: 'reps', reps: 7, role: 'medium', isAmrap: false },
    ],
    targetTotal: 15,
    restSeconds: 30,
    status: 'completed',
  };

  const workout: WorkoutRecord = {
    id: 'wo-1',
    challengeId: 'c',
    chainId: 'c',
    planSlotId: slot.id,
    attemptNo: 1,
    performedAt: '2026-05-29T08:34:00',
    sets: [
      { index: 1, actual: 7 },
      { index: 2, actual: 8 },
    ],
    actualTotal: 15,
    adjustmentType: 'none',
    outcome: 'completed_as_planned',
  };

  function exportWith(label: string): string {
    return buildCsv({
      exerciseLabel: label,
      goal: 100,
      challengeLength: '18 sessions',
      workouts: [workout],
      slotsById: new Map([[slot.id, slot]]),
    });
  }

  it('quotes a label containing the delimiter so the columns do not shift', () => {
    const out = exportWith('Push-ups; wide');
    expect(out.split('\n')[1]).toContain('"Push-ups; wide"');
    expect(buildCanonicalImport(out, INCUMBENT_CSV_V1).canonical.exerciseLabel).toBe(
      'Push-ups; wide',
    );
  });

  it('escapes an embedded quote', () => {
    const out = exportWith('Say "go"');
    expect(out).toContain('"Say ""go"""');
    expect(buildCanonicalImport(out, INCUMBENT_CSV_V1).canonical.exerciseLabel).toBe('Say "go"');
  });

  it('does NOT yet round-trip a session with no plan slot — known gap', () => {
    // An unlinked workout exports with blank week/day, which the importer rejects. This is a
    // real hole in "nothing is locked in here either": that history cannot come back through
    // CSV. Pinned so the day it is fixed, this test fails and gets updated rather than the
    // limitation being forgotten.
    const orphan: WorkoutRecord = { ...workout, id: 'wo-2' };
    delete (orphan as { planSlotId?: string }).planSlotId;

    const out = buildCsv({
      exerciseLabel: 'Push-ups',
      goal: 100,
      challengeLength: '18 sessions',
      workouts: [orphan],
      slotsById: new Map(),
    });
    expect(() => buildCanonicalImport(out, INCUMBENT_CSV_V1)).toThrow();
  });
});
