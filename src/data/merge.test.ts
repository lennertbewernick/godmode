/**
 * The merge planner decides what a backup file is allowed to add to a device that already
 * holds history. Every rule here exists because getting it wrong loses training data: a
 * conflict resolved the wrong way overwrites a session, a reopened challenge resurrects a
 * finished plan, and an over-eager write stores a row the app cannot render.
 *
 * These tests need no database — `planMerge` is pure, which is the point of it.
 */

import { describe, expect, it } from 'vitest';
import { MERGE_STORES, planMerge, type DatabaseSnapshot } from './merge.js';
import { BACKUP_FORMAT_VERSION, type BackupFile } from './exchange.js';
import { DB_VERSION, DEFAULT_SETTINGS } from '../db/schema.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  PlanSlotRecord,
  WorkoutRecord,
} from '../db/schema.js';
import type { PerformanceTest } from '../core/types.js';

const AT = '2026-05-29T08:34:00.000Z';

function exercise(id: string, over: Partial<ExerciseRecord> = {}): ExerciseRecord {
  return { id, label: 'Push-ups', unit: 'reps', createdAt: AT, ...over };
}

function challenge(id: string, over: Partial<ChallengeRecord> = {}): ChallengeRecord {
  return {
    id,
    exerciseId: 'ex-1',
    chainId: id,
    patternId: 'percentage-ramp',
    patternVersion: 1,
    patternParams: { weeks: 6, daysPerWeek: 3 },
    restPolicyId: 'volume-derived',
    restPolicyVersion: 1,
    restPolicyParams: { floor: 30 },
    evaluationPolicyId: 'total-reps-at-least-target',
    evaluationPolicyVersion: 1,
    baseline: { value: 18, source: 'tested', recordedAt: AT },
    goalValue: 100,
    status: 'active',
    startedAt: AT,
    ...over,
  };
}

function slot(id: string, over: Partial<PlanSlotRecord> = {}): PlanSlotRecord {
  return {
    id,
    challengeId: 'cha-1',
    ordinal: 1,
    week: 1,
    day: 1,
    patternId: 'percentage-ramp',
    patternVersion: 1,
    generatedAt: AT,
    targets: [
      { index: 1, targetKind: 'reps', reps: 7, role: 'medium', isAmrap: false },
      { index: 2, targetKind: 'reps', reps: 9, role: 'big', isAmrap: true },
    ],
    targetTotal: 16,
    restSeconds: 60,
    status: 'available',
    ...over,
  };
}

function workout(id: string, over: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id,
    challengeId: 'cha-1',
    chainId: 'cha-1',
    attemptNo: 1,
    performedAt: AT,
    sets: [{ index: 1, effectiveTarget: 7, actual: 7 }],
    actualTotal: 7,
    adjustmentType: 'none',
    effectiveTotal: 16,
    outcome: 'completed_as_planned',
    ...over,
  };
}

function maxTest(id: string, over: Partial<PerformanceTest> = {}): PerformanceTest {
  return {
    id,
    exerciseId: 'ex-1',
    performedAt: AT,
    protocolId: 'single-set-max-v1',
    protocolVersion: 1,
    value: 18,
    unit: 'reps',
    ...over,
  };
}

function snapshot(over: Partial<DatabaseSnapshot> = {}): DatabaseSnapshot {
  return {
    exercises: [],
    challenges: [],
    performanceTests: [],
    planSlots: [],
    workouts: [],
    ...over,
  };
}

function backup(over: Partial<DatabaseSnapshot> = {}): BackupFile {
  return {
    format: 'godmode-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: AT,
    settings: { ...DEFAULT_SETTINGS, bodyweightKg: 999 },
    ...snapshot(over),
  };
}

describe('planMerge — what a file may add', () => {
  it('adds an incoming record this device does not have, once its references resolve', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')], challenges: [challenge('cha-1')] }),
      backup({ workouts: [workout('wo-1')] }),
    );

    expect(plan.counts.workouts.added).toBe(1);
    expect(plan.additions.workouts.map((w) => w.id)).toEqual(['wo-1']);
    expect(plan.totals.added).toBe(1);
    expect(plan.skipped).toEqual([]);
  });

  it('calls an id it already holds with equal content identical, and writes nothing for it', () => {
    const mine = workout('wo-1');
    const plan = planMerge(
      snapshot({
        exercises: [exercise('ex-1')],
        challenges: [challenge('cha-1')],
        workouts: [mine],
      }),
      backup({ workouts: [JSON.parse(JSON.stringify(mine)) as WorkoutRecord] }),
    );

    expect(plan.counts.workouts).toMatchObject({ added: 0, identical: 1, divergent: 0 });
    expect(plan.additions.workouts).toEqual([]);
  });

  it('compares content by value, not by key order or by an explicit undefined', () => {
    const mine = challenge('cha-1', { patternParams: { weeks: 6, daysPerWeek: 3 } });

    // Same record, keys in the opposite order — which is exactly what a round trip through a
    // file produces, and what raw JSON.stringify would call a conflict.
    const reordered = Object.fromEntries(
      Object.entries(mine).reverse(),
    ) as unknown as ChallengeRecord;
    reordered.patternParams = { daysPerWeek: 3, weeks: 6 };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(mine));

    // A record built in memory can carry an explicitly-undefined optional property; the same
    // record written to a JSON file cannot. They are the same record.
    const withExplicitUndefined = { ...reordered, endedAt: undefined } as unknown as
      ChallengeRecord;

    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')], challenges: [mine] }),
      backup({ challenges: [withExplicitUndefined] }),
    );

    expect(plan.counts.challenges).toMatchObject({ identical: 1, divergent: 0, added: 0 });
  });

  it('keeps the local copy when the same id differs, and names it', () => {
    const plan = planMerge(
      snapshot({
        exercises: [exercise('ex-1')],
        challenges: [challenge('cha-1')],
        workouts: [workout('wo-1', { actualTotal: 7 })],
      }),
      backup({ workouts: [workout('wo-1', { actualTotal: 99 })] }),
    );

    expect(plan.counts.workouts).toMatchObject({ added: 0, identical: 0, divergent: 1 });
    expect(plan.additions.workouts).toEqual([]);
    expect(plan.divergent).toEqual([{ store: 'workouts', id: 'wo-1', reason: 'content' }]);
  });

  it('normalises a retired import-source id before comparing, rather than reporting a conflict', () => {
    const mine = workout('wo-1', { importSource: 'incumbent-csv-v1' });
    const plan = planMerge(
      snapshot({
        exercises: [exercise('ex-1')],
        challenges: [challenge('cha-1')],
        workouts: [mine],
      }),
      backup({ workouts: [workout('wo-1', { importSource: 'retired-profile-id' })] }),
    );

    expect(plan.counts.workouts).toMatchObject({ identical: 1, divergent: 0, added: 0 });
  });

  it('normalises a retired import-source id on a record it does add', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')], challenges: [challenge('cha-1')] }),
      backup({ workouts: [workout('wo-new', { importSource: 'retired-profile-id' })] }),
    );

    expect(plan.additions.workouts[0]?.importSource).toBe('incumbent-csv-v1');
  });
});

describe('planMerge — a challenge that ended stays ended', () => {
  it('reports a file that would reopen an ended challenge, and keeps the local record', () => {
    const ended = challenge('cha-1', {
      status: 'ended',
      endedAt: AT,
      endReason: 'closed_manually',
    });
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')], challenges: [ended] }),
      backup({ challenges: [challenge('cha-1', { status: 'active' })] }),
    );

    expect(plan.divergent).toEqual([
      { store: 'challenges', id: 'cha-1', reason: 'local-ended' },
    ]);
    expect(plan.additions.challenges).toEqual([]);
  });

  it('reports — but does not apply — an ending that only the file knows about', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')], challenges: [challenge('cha-1')] }),
      backup({
        challenges: [
          challenge('cha-1', { status: 'ended', endedAt: AT, endReason: 'closed_manually' }),
        ],
      }),
    );

    expect(plan.divergent).toEqual([{ store: 'challenges', id: 'cha-1', reason: 'file-ended' }]);
    expect(plan.additions.challenges).toEqual([]);
  });
});

describe('planMerge — references', () => {
  it('skips a session whose challenge exists neither here nor in the file', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')] }),
      backup({ workouts: [workout('wo-1', { challengeId: 'cha-gone' })] }),
    );

    expect(plan.counts.workouts).toMatchObject({ added: 0, skipped: 1 });
    expect(plan.additions.workouts).toEqual([]);
    expect(plan.skipped).toEqual([
      { store: 'workouts', id: 'wo-1', missing: 'challenge cha-gone' },
    ]);
  });

  it('resolves a session against a challenge arriving in the same file', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')] }),
      backup({
        challenges: [challenge('cha-new')],
        workouts: [workout('wo-1', { challengeId: 'cha-new', chainId: 'cha-new' })],
      }),
    );

    expect(plan.additions.challenges.map((c) => c.id)).toEqual(['cha-new']);
    expect(plan.additions.workouts.map((w) => w.id)).toEqual(['wo-1']);
    expect(plan.skipped).toEqual([]);
  });

  it('cascades: a challenge skipped for a missing exercise takes its slots and sessions with it', () => {
    const plan = planMerge(
      snapshot(),
      backup({
        challenges: [challenge('cha-1', { exerciseId: 'ex-gone' })],
        planSlots: [slot('ps-1', { challengeId: 'cha-1' })],
        workouts: [workout('wo-1', { challengeId: 'cha-1' })],
      }),
    );

    expect(plan.totals.added).toBe(0);
    expect(plan.totals.skipped).toBe(3);
    expect(plan.skipped).toEqual([
      { store: 'challenges', id: 'cha-1', missing: 'exercise ex-gone' },
      { store: 'planSlots', id: 'ps-1', missing: 'challenge cha-1' },
      { store: 'workouts', id: 'wo-1', missing: 'challenge cha-1' },
    ]);
  });

  it('skips a max test whose exercise is nowhere', () => {
    const plan = planMerge(
      snapshot(),
      backup({ performanceTests: [maxTest('pt-1', { exerciseId: 'ex-gone' })] }),
    );

    expect(plan.skipped).toEqual([
      { store: 'performanceTests', id: 'pt-1', missing: 'exercise ex-gone' },
    ]);
  });

  it('adds a session with a dangling plan slot unmodified, and only warns', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')], challenges: [challenge('cha-1')] }),
      backup({ workouts: [workout('wo-1', { planSlotId: 'ps-gone' })] }),
    );

    expect(plan.additions.workouts).toHaveLength(1);
    expect(plan.additions.workouts[0]?.planSlotId).toBe('ps-gone');
    expect(plan.skipped).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatchObject({ store: 'workouts', id: 'wo-1' });
    expect(plan.warnings[0]?.note).toContain('ps-gone');
  });

  it('does not warn about an optional reference that the same file supplies', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')], challenges: [challenge('cha-1')] }),
      backup({
        planSlots: [slot('ps-1')],
        workouts: [workout('wo-1', { planSlotId: 'ps-1' })],
      }),
    );

    expect(plan.warnings).toEqual([]);
    expect(plan.additions.workouts).toHaveLength(1);
  });
});

describe('planMerge — what it must never do', () => {
  it('never mentions settings, whatever the file carries', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')] }),
      backup({ exercises: [exercise('ex-1')] }),
    );

    expect(MERGE_STORES).not.toContain('settings');
    expect(Object.keys(plan.counts)).not.toContain('settings');
    expect(Object.keys(plan.additions)).not.toContain('settings');
    expect(plan.settingsMerged).toBe(false);
  });

  it('says nothing at all about a record only this device has', () => {
    const plan = planMerge(
      snapshot({
        exercises: [exercise('ex-1')],
        challenges: [challenge('cha-1')],
        workouts: [workout('wo-mine'), workout('wo-shared')],
      }),
      backup({ workouts: [workout('wo-shared')] }),
    );

    const everyId = [
      ...plan.additions.workouts.map((w) => w.id),
      ...plan.divergent.map((d) => d.id),
      ...plan.skipped.map((s) => s.id),
      ...plan.warnings.map((w) => w.id),
    ];
    expect(everyId).not.toContain('wo-mine');
    expect(plan.counts.workouts).toMatchObject({
      added: 0,
      identical: 1,
      divergent: 0,
      skipped: 0,
    });
  });

  it('produces an empty plan for an empty file rather than proposing anything', () => {
    const plan = planMerge(
      snapshot({ exercises: [exercise('ex-1')], workouts: [workout('wo-mine')] }),
      backup(),
    );

    expect(plan.totals).toEqual({ added: 0, identical: 0, divergent: 0, skipped: 0 });
    expect(plan.additions.workouts).toEqual([]);
  });
});
