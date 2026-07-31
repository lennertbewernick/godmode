// @vitest-environment node
//
// The importer, driven against real files on disk.
//
// `:memory:` cannot test any of what actually matters here: the temporary file, the atomic
// rename, the safety copy, or the claim that a failure leaves the target untouched. So every test
// below uses a real directory, and the ones about failure hash the target's bytes before and after
// and assert they did not move.
//
// The fixtures are `server/fixtures.ts`, not the owner's real export. The real 29 sessions were
// driven through this importer end to end during development — the result is recorded in
// `server/PERSISTENCE.md` §13 — but a test that reads an absolute path outside the repository
// would fail for everyone else and rot here.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { datasetOfBackup, readDataset, writeDataset } from './dataset.js';
import { MAXIMAL_BACKUP, MINIMAL_BACKUP, clone } from './fixtures.js';
import { BOOTSTRAP_USER_ID, ensureBootstrapUser } from './users.js';
import {
  ImportConflictError,
  MigrationError,
  describeReport,
  importBackup,
  planImport,
} from './migrate.js';
import { parseArguments, run } from './import-backup.js';
import { lockPathFor } from './lock.js';
import { applySchema } from './schema.js';
import { BackupValidationError } from './validate.js';
import { VerificationFailure } from './verify.js';
import type { BackupFile } from '../src/data/exchange.js';
import type { WorkoutRecord } from '../src/db/schema.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-migrate-'));
  tempDirs.push(dir);
  return dir;
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every leftover in the target's directory besides the database itself. */
function strays(dir: string, targetName: string): string[] {
  return readdirSync(dir).filter((name) => name !== targetName);
}

function readBack(path: string): ReturnType<typeof readDataset> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    return readDataset(db);
  } finally {
    db.close();
  }
}

/** A second workout, so a re-import has something genuinely new to add. */
function extraWorkout(): WorkoutRecord {
  return {
    id: 'wo_new',
    challengeId: 'ch_1',
    chainId: 'ch_1',
    attemptNo: 1,
    performedAt: '2026-06-01T09:00:00',
    sets: [
      { index: 1, actual: 10 },
      { index: 2, actual: 8 },
    ],
    actualTotal: 18,
    adjustmentType: 'none',
    outcome: 'failed',
  };
}

describe('importBackup — into a target that does not exist yet', () => {
  it('creates a verified database and reports what landed in it', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');

    const report = importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });

    expect(report.targetExisted).toBe(false);
    expect(report.safetyCopyPath).toBeUndefined();
    // 1 exercise, 2 challenges, 1 max test, 2 slots, 2 workouts, 1 settings row.
    expect(report.insertedTotal).toBe(9);
    expect(report.unchangedTotal).toBe(0);
    expect(report.revision).toBe(1);
    expect(report.totalReps).toBe(99);
    expect(report.checksRun.length).toBe(13);
    expect(existsSync(target)).toBe(true);
  });

  it('leaves the records readable back, canonically identical to the backup', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });

    expect(canonicalJson(readBack(target))).toBe(
      canonicalJson(datasetOfBackup(clone(MAXIMAL_BACKUP) as BackupFile)),
    );
  });

  it('cleans up its working directory, leaving only the database', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MINIMAL_BACKUP), targetPath: target });
    expect(strays(dir, 'godmode.sqlite')).toEqual([]);
  });

  it('a dry run builds and verifies a whole database, then creates nothing', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');

    const report = importBackup({
      backup: clone(MAXIMAL_BACKUP),
      targetPath: target,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.checksRun.length).toBe(13);
    expect(report.insertedTotal).toBe(9);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports in plain language', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    const text = describeReport(importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target }));
    expect(text).toContain('Created a new database');
    expect(text).toContain('2 workouts, 99 reps in total.');
    expect(text).toContain('Your browser data has not been touched.');
  });
});

describe('importBackup — run again (Codex finding 2)', () => {
  it('the same backup twice is a no-op: nothing inserted, nothing replaced', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
    const before = canonicalJson(readBack(target));
    const hashBefore = hash(target);

    const second = importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });

    expect(second.targetExisted).toBe(true);
    expect(second.insertedTotal).toBe(0);
    expect(second.unchangedTotal).toBe(9);
    // A true no-op does not move the revision, because nothing a client could be holding changed.
    expect(second.revision).toBe(1);
    expect(canonicalJson(readBack(target))).toBe(before);
    // And it touches nothing: no rename, so not one byte moves and no safety copy piles up.
    expect(second.renamed).toBe(false);
    expect(second.safetyCopyPath).toBeUndefined();
    expect(hash(target)).toBe(hashBefore);
    expect(strays(dir, 'godmode.sqlite')).toEqual([]);
    expect(describeReport(second)).toContain('already holds every record in that backup');
  });

  it('adds only what is new, and keeps what the file does not mention', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });

    const grown = clone(MAXIMAL_BACKUP);
    grown.workouts = [...grown.workouts, extraWorkout()];

    const second = importBackup({ backup: grown, targetPath: target });

    expect(second.insertedTotal).toBe(1);
    expect(second.revision).toBe(2);
    const workouts = second.collections.find((c) => c.key === 'workouts');
    expect(workouts).toMatchObject({ inserted: 1, unchanged: 2, carriedOver: 0, total: 3 });
    expect(readBack(target).workouts.map((w) => w.id).sort()).toEqual([
      'wo_1',
      'wo_2',
      'wo_new',
    ]);
  });

  it('carries over records the incoming backup has never heard of', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    const grown = clone(MAXIMAL_BACKUP);
    grown.workouts = [...grown.workouts, extraWorkout()];
    importBackup({ backup: grown, targetPath: target });

    // The original backup, which does not contain `wo_new`. It must survive.
    const second = importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });

    const workouts = second.collections.find((c) => c.key === 'workouts');
    expect(workouts).toMatchObject({ inserted: 0, unchanged: 2, carriedOver: 1, total: 3 });
    expect(readBack(target).workouts.map((w) => w.id)).toContain('wo_new');
  });

  it('aborts and names the ids when the same id carries different content', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
    const before = hash(target);

    const changed = clone(MAXIMAL_BACKUP);
    const first = changed.workouts[0] as WorkoutRecord;
    changed.workouts = [{ ...first, note: 'rewritten history' }, ...changed.workouts.slice(1)];

    let caught: unknown;
    try {
      importBackup({ backup: changed, targetPath: target });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ImportConflictError);
    const conflict = caught as ImportConflictError;
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0]?.collection).toBe('workouts');
    expect(conflict.conflicts[0]?.id).toBe('wo_1');
    expect(conflict.conflicts[0]?.differingFields).toEqual(['note']);
    expect(conflict.message).toContain('wo_1');
    expect(conflict.message).toContain('nothing has been replaced');
    // The record still says what it said. `REPLACE` would have overwritten it.
    expect(hash(target)).toBe(before);
    expect(readBack(target).workouts[0]?.note).toBe('felt strong');
  });

  it('does not mistake a re-serialised record for a changed one', () => {
    // The same record with its properties in a different order and an optional spelled
    // `undefined` rather than absent. Without canonical comparison, the second run of an import
    // would abort on every record it had itself just written.
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MINIMAL_BACKUP), targetPath: target });

    const reordered = clone(MINIMAL_BACKUP);
    const workout = reordered.workouts[0] as WorkoutRecord;
    reordered.workouts = [
      {
        outcome: workout.outcome,
        sets: workout.sets,
        adjustmentType: workout.adjustmentType,
        actualTotal: workout.actualTotal,
        performedAt: workout.performedAt,
        attemptNo: workout.attemptNo,
        chainId: workout.chainId,
        challengeId: workout.challengeId,
        id: workout.id,
        note: undefined,
      } as unknown as WorkoutRecord,
    ];

    const second = importBackup({ backup: reordered, targetPath: target });
    expect(second.insertedTotal).toBe(0);
    expect(second.unchangedTotal).toBe(5);
    expect(second.renamed).toBe(false);
  });
});

describe('importBackup — every failure stage leaves the target exactly as it was', () => {
  function seeded(): { dir: string; target: string; before: string } {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
    return { dir, target, before: hash(target) };
  }

  it('validate: a backup that fails the strict validator', () => {
    const { dir, target, before } = seeded();
    const broken = clone(MAXIMAL_BACKUP) as unknown as Record<string, unknown>;
    (broken['workouts'] as Record<string, unknown>[])[0]!['actualTotal'] = 'seventy-seven';

    expect(() => importBackup({ backup: broken, targetPath: target })).toThrow(
      BackupValidationError,
    );
    expect(hash(target)).toBe(before);
    expect(strays(dir, 'godmode.sqlite')).toEqual([]);
  });

  it('validate: a backup from a newer format version', () => {
    const { target, before } = seeded();
    const future = clone(MAXIMAL_BACKUP);
    future.formatVersion = 99;
    expect(() => importBackup({ backup: future, targetPath: target })).toThrow(/newer version/);
    expect(hash(target)).toBe(before);
  });

  it('target: a leftover write-ahead log, which may hold data the main file does not', () => {
    const { dir, target, before } = seeded();
    writeFileSync(`${target}-wal`, 'not really a wal, but its presence is the point');

    expect(() => importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target })).toThrow(
      /has this database open or it was not closed cleanly/,
    );
    expect(hash(target)).toBe(before);
    expect(strays(dir, 'godmode.sqlite')).toEqual(['godmode.sqlite-wal']);
  });

  it('target: a schema version this build does not understand', () => {
    const { target, before } = seeded();
    const db = new DatabaseSync(target);
    db.exec('UPDATE meta SET schema_version = 99');
    db.close();
    const tampered = hash(target);

    let caught: unknown;
    try {
      importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).stage).toBe('target');
    expect((caught as MigrationError).message).toMatch(/schema version 99/);
    expect(hash(target)).toBe(tampered);
    expect(before).not.toBe(tampered); // the tamper really happened
  });

  it('plan: a conflicting record', () => {
    const { dir, target, before } = seeded();
    const changed = clone(MAXIMAL_BACKUP);
    const first = changed.workouts[0] as WorkoutRecord;
    changed.workouts = [{ ...first, actualTotal: 1, sets: [{ index: 1, actual: 1 }] }, ...changed.workouts.slice(1)];

    expect(() => importBackup({ backup: changed, targetPath: target })).toThrow(
      ImportConflictError,
    );
    expect(hash(target)).toBe(before);
    expect(strays(dir, 'godmode.sqlite')).toEqual([]);
  });

  it('build: something throws between the insert and the verification', () => {
    const { dir, target, before } = seeded();
    const grown = clone(MAXIMAL_BACKUP);
    grown.workouts = [...grown.workouts, extraWorkout()];

    expect(() =>
      importBackup({
        backup: grown,
        targetPath: target,
        hooks: {
          afterInsert: () => {
            throw new Error('disk went away');
          },
        },
      }),
    ).toThrow('disk went away');
    expect(hash(target)).toBe(before);
    expect(strays(dir, 'godmode.sqlite')).toEqual([]);
  });

  it('verify: the temporary database is damaged before it is checked', () => {
    const { dir, target, before } = seeded();
    const grown = clone(MAXIMAL_BACKUP);
    grown.workouts = [...grown.workouts, extraWorkout()];

    let caught: unknown;
    try {
      importBackup({
        backup: grown,
        targetPath: target,
        hooks: {
          // Exactly the kind of loss the whole verification exists for: a record that was written
          // and then is not there. Nothing else about the file is wrong.
          afterInsert: (db) => {
            db.prepare('DELETE FROM workouts WHERE id = ?').run('wo_new');
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VerificationFailure);
    expect((caught as VerificationFailure).issues.some((i) => i.check === 'row counts')).toBe(true);
    expect(hash(target)).toBe(before);
    expect(strays(dir, 'godmode.sqlite')).toEqual([]);
  });

  it('commit: something throws after verification and before the rename', () => {
    const { dir, target, before } = seeded();
    const grown = clone(MAXIMAL_BACKUP);
    grown.workouts = [...grown.workouts, extraWorkout()];

    expect(() =>
      importBackup({
        backup: grown,
        targetPath: target,
        hooks: {
          beforeRename: () => {
            throw new Error('power cut');
          },
        },
      }),
    ).toThrow('power cut');
    expect(hash(target)).toBe(before);
    // The safety copy is taken before the rename, so it exists — and it is the old database,
    // byte for byte. Nothing deletes it.
    const leftovers = strays(dir, 'godmode.sqlite');
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatch(/^godmode\.sqlite\.pre-import-/);
    expect(hash(join(dir, leftovers[0] as string))).toBe(before);
  });
});

describe('importBackup — the boundaries Codex named', () => {
  function seededPair(): { dir: string; target: string; before: string; grown: BackupFile } {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
    const grown = clone(MAXIMAL_BACKUP);
    grown.workouts = [...grown.workouts, extraWorkout()];
    return { dir, target, before: hash(target), grown };
  }

  it('a real insert failure rolls back and leaves an empty database behind', () => {
    // A genuine `writeDataset` failure, not a hook: a workout pointing at a challenge that is not
    // in the dataset. The strict validator would refuse this before the importer ever saw it, so
    // it is induced here at the layer that actually does the insert, to prove the deferred
    // foreign keys fire at COMMIT and the transaction rolls back rather than half-landing.
    const db = new DatabaseSync(join(tempDir(), 'rollback.sqlite'));
    applySchema(db);
    ensureBootstrapUser(db);
    const dataset = datasetOfBackup(clone(MAXIMAL_BACKUP) as BackupFile);
    const orphan: WorkoutRecord = { ...extraWorkout(), challengeId: 'ch_does_not_exist' };
    expect(() =>
      writeDataset(db, { ...dataset, workouts: [...dataset.workouts, orphan] }, BOOTSTRAP_USER_ID),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM workouts').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM exercises').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('a sidecar appearing mid-import stops the rename', () => {
    const { target, before, grown } = seededPair();

    let caught: unknown;
    try {
      importBackup({
        backup: grown,
        targetPath: target,
        // A server starting up between the first sidecar check and the rename. The second check
        // narrows that window; it cannot close it, which `assertNoSidecars` says plainly.
        hooks: { beforeRename: () => writeFileSync(`${target}-wal`, 'a writer woke up') },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).stage).toBe('commit');
    expect(hash(target)).toBe(before);
  });

  it('a failure after the rename says the replacement HAPPENED, and names the safety copy', () => {
    const { dir, target, before, grown } = seededPair();

    let caught: unknown;
    try {
      importBackup({
        backup: grown,
        targetPath: target,
        hooks: {
          afterRename: () => {
            throw new Error('fsync: I/O error');
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).stage).toBe('committed');
    expect((caught as MigrationError).message).toContain('HAS been replaced');
    expect((caught as MigrationError).message).toContain('.pre-import-');
    // And it is telling the truth: the target really did change.
    expect(hash(target)).not.toBe(before);
    expect(readBack(target).workouts).toHaveLength(3);

    // The CLI must not print "exactly as it was" over that.
    const err: string[] = [];
    const backupPath = join(dir, 'backup.json');
    writeFileSync(backupPath, JSON.stringify(grown));
    const code = run([backupPath, '--target', target], {}, () => undefined, (l) => err.push(l));
    expect(code).toBe(0); // second run is now a no-op, since the first one did land
    expect(err).toEqual([]);
  });

  it('two importers cannot run at once', () => {
    const { target, before, grown } = seededPair();

    let inner: unknown;
    expect(() =>
      importBackup({
        backup: grown,
        targetPath: target,
        hooks: {
          afterInsert: () => {
            try {
              importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
            } catch (error) {
              inner = error;
            }
            throw new Error('stop here');
          },
        },
      }),
    ).toThrow('stop here');

    expect(inner).toBeInstanceOf(MigrationError);
    expect((inner as MigrationError).stage).toBe('target');
    // One lock, two kinds of holder. The record names the role, so the refusal can say which.
    expect((inner as MigrationError).message).toMatch(/locked by another import/);
    expect((inner as MigrationError).message).toContain('Two imports must not touch the same');
    expect((inner as MigrationError).message).toContain('Nothing has been written.');
    expect(hash(target)).toBe(before);
  });

  it('leaves no lock file behind, on success or on failure', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
    expect(existsSync(lockPathFor(target))).toBe(false);
    expect(strays(dir, 'godmode.sqlite')).toEqual([]);

    expect(() =>
      importBackup({ backup: { format: 'not-a-backup' }, targetPath: target }),
    ).toThrow(BackupValidationError);
    expect(existsSync(lockPathFor(target))).toBe(false);
  });

  it('refuses an integer too large to have survived JSON.parse intact', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    const huge = clone(MINIMAL_BACKUP) as unknown as Record<string, unknown>;
    // 2^53 + 1 does not exist as a JavaScript number; it is already 2^53 by the time it gets
    // here. Accepting it would mean every later check agreeing with a number the file never had.
    (huge['workouts'] as Record<string, unknown>[])[0]!['actualTotal'] = 9007199254740993;

    expect(() => importBackup({ backup: huge, targetPath: target })).toThrow(
      BackupValidationError,
    );
    expect(existsSync(target)).toBe(false);
  });
});

describe('importBackup — the safety copy', () => {
  it('keeps the previous database beside the new one', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
    const before = hash(target);

    const grown = clone(MAXIMAL_BACKUP);
    grown.workouts = [...grown.workouts, extraWorkout()];
    const report = importBackup({ backup: grown, targetPath: target });

    expect(report.safetyCopyPath).toMatch(/\.pre-import-.*\.sqlite$/);
    expect(hash(report.safetyCopyPath as string)).toBe(before);
    expect(hash(target)).not.toBe(before);
    // And the copy is a usable database, not just bytes.
    expect(readBack(report.safetyCopyPath as string).workouts).toHaveLength(2);
  });
});

describe('planImport', () => {
  it('an empty target takes everything', () => {
    const plan = planImport(
      { exercises: [], challenges: [], performanceTests: [], planSlots: [], workouts: [], settings: undefined },
      datasetOfBackup(clone(MAXIMAL_BACKUP) as BackupFile),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.insertedTotal).toBe(9);
    expect(plan.expected.workouts).toHaveLength(2);
  });

  it('names every differing field, not just the first', () => {
    const stored = datasetOfBackup(clone(MAXIMAL_BACKUP) as BackupFile);
    const incoming = clone(MAXIMAL_BACKUP);
    const first = incoming.workouts[0] as WorkoutRecord;
    incoming.workouts = [
      { ...first, note: 'different', outcome: 'failed', durationSeconds: 400 },
      ...incoming.workouts.slice(1),
    ];

    const plan = planImport(stored, datasetOfBackup(incoming as BackupFile));
    expect(plan.conflicts[0]?.differingFields).toEqual(['durationSeconds', 'note', 'outcome']);
  });

  it('a differing settings row is a conflict like any other', () => {
    const stored = datasetOfBackup(clone(MAXIMAL_BACKUP) as BackupFile);
    const incoming = clone(MAXIMAL_BACKUP);
    incoming.settings = { ...incoming.settings, bodyweightKg: 90 };
    const plan = planImport(stored, datasetOfBackup(incoming as BackupFile));
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.collection).toBe('settings');
  });
});

describe('the command line', () => {
  it('needs a backup file', () => {
    expect(() => parseArguments([])).toThrow(/Which backup file/);
  });

  it('needs somewhere to put the database', () => {
    expect(() => parseArguments(['backup.json'])).toThrow(/--target/);
  });

  it('falls back to GODMODE_DATA_DIR', () => {
    const args = parseArguments(['backup.json'], { GODMODE_DATA_DIR: '/data/godmode' });
    expect(args.targetPath).toBe('/data/godmode/godmode.sqlite');
  });

  it('prefers an explicit --target over the environment', () => {
    const args = parseArguments(['backup.json', '--target', '/elsewhere/db.sqlite'], {
      GODMODE_DATA_DIR: '/data/godmode',
    });
    expect(args.targetPath).toBe('/elsewhere/db.sqlite');
    expect(args.dryRun).toBe(false);
  });

  it('rejects an unknown option rather than ignoring it', () => {
    expect(() => parseArguments(['backup.json', '--force'])).toThrow(/Unknown option/);
  });

  it('rejects a --target with no value', () => {
    expect(() => parseArguments(['backup.json', '--target', '--dry-run'])).toThrow(/needs a path/);
  });

  it('imports end to end and reports success', () => {
    const dir = tempDir();
    const backupPath = join(dir, 'backup.json');
    const target = join(dir, 'godmode.sqlite');
    writeFileSync(backupPath, JSON.stringify(MAXIMAL_BACKUP));

    const out: string[] = [];
    const err: string[] = [];
    const code = run([backupPath, '--target', target], {}, (l) => out.push(l), (l) => err.push(l));

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('2 workouts, 99 reps in total.');
    expect(existsSync(target)).toBe(true);
  });

  it('reports a damaged backup on stderr, exits non-zero, and says the target is untouched', () => {
    const dir = tempDir();
    const backupPath = join(dir, 'backup.json');
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
    const before = hash(target);
    writeFileSync(backupPath, '{"format":"godmode-backup","formatVersion":1}');

    const out: string[] = [];
    const err: string[] = [];
    const code = run([backupPath, '--target', target], {}, (l) => out.push(l), (l) => err.push(l));

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('cannot be imported');
    expect(err.join('\n')).toContain('is exactly as it was');
    expect(hash(target)).toBe(before);
  });

  it('reports unreadable JSON without touching anything', () => {
    const dir = tempDir();
    const backupPath = join(dir, 'backup.json');
    writeFileSync(backupPath, 'this is not json');

    const err: string[] = [];
    const code = run(
      [backupPath, '--target', join(dir, 'godmode.sqlite')],
      {},
      () => undefined,
      (l) => err.push(l),
    );

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('Nothing has been changed.');
    expect(existsSync(join(dir, 'godmode.sqlite'))).toBe(false);
  });

  it('prints usage and fails when given nothing at all', () => {
    const out: string[] = [];
    const code = run([], {}, (l) => out.push(l), () => undefined);
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('Usage:');
  });
});

describe('a database this importer built', () => {
  it('is a plain SQLite file any other tool can open', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });

    // Opened without `applySchema`, without `armConnection`, by a connection that knows nothing
    // about this codebase — which is what "the owner can see, copy and back up his data" means.
    const plain = new DatabaseSync(target, { readOnly: true });
    const row = plain.prepare('SELECT COUNT(*) AS n, SUM(actual_total) AS reps FROM workouts').get() as {
      n: number;
      reps: number;
    };
    expect(row.n).toBe(2);
    expect(row.reps).toBe(99);
    plain.close();
  });

  it('is byte-identical in shape to one built by applySchema', () => {
    const dir = tempDir();
    const target = join(dir, 'godmode.sqlite');
    importBackup({ backup: clone(MINIMAL_BACKUP), targetPath: target });

    const reference = new DatabaseSync(join(tempDir(), 'reference.sqlite'));
    applySchema(reference);
    const referenceSchema = reference
      .prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
      .all();
    reference.close();

    const built = new DatabaseSync(target, { readOnly: true });
    const builtSchema = built.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    built.close();

    expect(builtSchema).toEqual(referenceSchema);
  });
});
