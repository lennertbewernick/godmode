// @vitest-environment node
//
// Every check in `server/verify.ts`, proven to FAIL.
//
// A verifier that has never been seen to reject anything is a verifier nobody has tested. So each
// test below builds a real, valid database on disk, damages it in one specific way, and asserts
// that verification names that specific damage. The damage is applied the way it would really
// happen — a foreign key broken while the pragma is off, a unique index dropped, a page zeroed —
// rather than by stubbing the check out.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { readDataset, writeDataset, type Dataset } from './dataset.js';
import { MAXIMAL_BACKUP, MINIMAL_BACKUP, clone } from './fixtures.js';
import { applySchema, readSchemaSql } from './schema.js';
import { validateBackupStrict } from './validate.js';
import { VerificationFailure, verifyDatabase, type ExpectedState } from './verify.js';
import type { BackupFile } from '../src/data/exchange.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-verify-'));
  tempDirs.push(dir);
  return dir;
}

function datasetOfBackup(backup: BackupFile): Dataset {
  return {
    exercises: backup.exercises,
    challenges: backup.challenges,
    performanceTests: backup.performanceTests,
    planSlots: backup.planSlots,
    workouts: backup.workouts,
    settings: backup.settings,
  };
}

/** A real file on disk holding a valid dataset, plus the state the verifier should expect. */
function build(source: BackupFile = MAXIMAL_BACKUP): {
  db: DatabaseSync;
  path: string;
  expected: ExpectedState;
} {
  const path = join(tempDir(), 'godmode.sqlite');
  const db = new DatabaseSync(path);
  applySchema(db);
  const backup = validateBackupStrict(clone(source));
  const dataset = datasetOfBackup(backup);
  writeDataset(db, dataset);
  return { db, path, expected: { dataset, revision: 0 } };
}

/**
 * A database built from the real `schema.sql` with one clause taken out.
 *
 * Some states this verifier exists to catch are ones the DDL makes impossible — a duplicate
 * primary key, a second settings row. Testing those against a hand-written toy table would prove
 * only that the check compiles. Removing the single clause that forbids the state, from the real
 * schema, is what proves the check would see it.
 */
function openWithModifiedSchema(mutate: (ddl: string) => string): {
  db: DatabaseSync;
  dataset: Dataset;
} {
  const original = readSchemaSql();
  const ddl = mutate(original);
  expect(ddl).not.toBe(original);
  const db = new DatabaseSync(join(tempDir(), 'modified.sqlite'));
  db.exec(ddl);
  db.exec('PRAGMA foreign_keys = ON');
  const dataset = datasetOfBackup(validateBackupStrict(clone(MAXIMAL_BACKUP)));
  writeDataset(db, dataset);
  return { db, dataset };
}

function failuresFrom(fn: () => unknown): VerificationFailure {
  try {
    fn();
  } catch (error) {
    if (error instanceof VerificationFailure) return error;
    throw error;
  }
  throw new Error('expected verification to fail, but it passed');
}

describe('verifyDatabase — a database that is actually correct', () => {
  it('passes every check on the maximal fixture and names what it proved', () => {
    const { db, expected } = build(MAXIMAL_BACKUP);
    const checks = verifyDatabase(db, expected);
    expect(checks).toContain('integrity_check');
    expect(checks).toContain('foreign_key_check');
    expect(checks).toContain('record-by-record canonical equality');
    expect(checks.length).toBe(13);
    db.close();
  });

  it('passes every check on the minimal fixture, where every optional is absent', () => {
    const { db, expected } = build(MINIMAL_BACKUP);
    expect(verifyDatabase(db, expected).length).toBe(13);
    db.close();
  });
});

describe('verifyDatabase — each check can fail', () => {
  it('1. integrity_check: a database whose pages have been zeroed', () => {
    const { db, path, expected } = build();
    db.close();

    // Everything after page 1. sqlite_master survives, so the file still opens and still claims
    // to have tables; every table root is gone. This is what a truncated copy looks like.
    const bytes = readFileSync(path);
    bytes.fill(0, 4096, bytes.length);
    writeFileSync(path, bytes);

    const damaged = new DatabaseSync(path);
    const failure = failuresFrom(() => verifyDatabase(damaged, expected));
    expect(failure.issues.some((i) => i.check === 'integrity_check')).toBe(true);
    expect(failure.message).toMatch(/discarded and nothing was replaced/);
    damaged.close();
  });

  it('2. foreign_key_check: a workout pointing at a challenge that is not there', () => {
    const { db, expected } = build();
    // Foreign keys off for the damage, on for the check — exactly how a real broken reference
    // gets into a file: written by something that forgot the per-connection pragma.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE workouts SET challenge_id = ? WHERE id = ?').run('ch_gone', 'wo_1');
    db.exec('PRAGMA foreign_keys = ON');

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(failure.issues.some((i) => i.check === 'foreign_key_check')).toBe(true);
    db.close();
  });

  it('3. meta: a revision that is not the one the import decided on', () => {
    const { db, expected } = build();
    db.exec('UPDATE meta SET revision = 99');
    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(failure.issues.some((i) => i.check === 'meta' && i.path === 'meta.revision')).toBe(true);
    db.close();
  });

  it('4. row counts: a workout deleted after the import', () => {
    const { db, expected } = build();
    db.prepare('DELETE FROM workouts WHERE id = ?').run('wo_2');
    const failure = failuresFrom(() => verifyDatabase(db, expected));
    const counts = failure.issues.filter((i) => i.check === 'row counts');
    expect(counts).toHaveLength(1);
    expect(counts[0]?.message).toMatch(/expected 2 records, found 1/);
    db.close();
  });

  it('5. id sets: a swapped id, which leaves the count untouched', () => {
    const { db, expected } = build();
    db.prepare('UPDATE workouts SET id = ? WHERE id = ?').run('wo_impostor', 'wo_2');

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    // The count is still 2, so only the id-set check can see this.
    expect(failure.issues.some((i) => i.check === 'row counts')).toBe(false);
    expect(failure.issues.filter((i) => i.check === 'id sets')).toHaveLength(2);
    expect(failure.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['workouts.wo_2', 'workouts.wo_impostor']),
    );
    db.close();
  });

  it('6. records: one field changed, with every count and id still correct', () => {
    const { db, expected } = build();
    db.prepare('UPDATE workouts SET note = ? WHERE id = ?').run('tampered', 'wo_1');

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(failure.issues.some((i) => i.check === 'row counts')).toBe(false);
    expect(failure.issues.some((i) => i.check === 'id sets')).toBe(false);
    const records = failure.issues.filter((i) => i.check === 'record-by-record canonical equality');
    expect(records).toHaveLength(1);
    expect(records[0]?.path).toBe('workouts.wo_1');
    expect(records[0]?.message).toMatch(/tampered/);
    db.close();
  });

  it('6b. records: STRICT stores a lossless string-to-integer conversion, and that is fine', () => {
    const { db, expected } = build();
    // `STRICT` does not stop every coercion: '77' bound to an INTEGER column is stored as the
    // integer 77, because the conversion is lossless and reversible. Verification must therefore
    // *pass* here — the stored value is genuinely the right number — while refusing the
    // conversion that would lose something.
    db.prepare('UPDATE workouts SET actual_total = ? WHERE id = ?').run('77', 'wo_1');
    expect(verifyDatabase(db, expected).length).toBe(13);
    expect(() =>
      db.prepare('UPDATE workouts SET actual_total = 77.5 WHERE id = ?').run('wo_1'),
    ).toThrow(/cannot store REAL value in INTEGER column/);
    db.close();
  });

  it('6c. records: a row that no longer decodes at all', () => {
    const { db, expected } = build();
    // Still a JSON array, so the column CHECK is satisfied — but an element is missing the fields
    // a `SetTarget` must have. `rows.ts` refuses to decode it, and the verifier reports that
    // rather than letting a half-record reach the app.
    db.prepare('UPDATE plan_slots SET targets = ? WHERE id = ?').run('[{"index":1}]', 'slot_0');

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(failure.issues.some((i) => i.message.includes('could not be read back'))).toBe(true);
    expect(failure.issues.some((i) => i.message.includes('required property is missing'))).toBe(true);
    db.close();
  });

  it('7. columns: a symmetric encoder/decoder swap, which the round trip cannot see', () => {
    // Codex's concrete counter-example to the round-trip check, reproduced as the state it would
    // leave on disk: `challenge_id` physically holds the chainId and `chain_id` physically holds
    // the challengeId. A `rows.ts` whose encode and decode were both wrong in this way would
    // reconstruct the record perfectly, so counts, id sets and record equality all pass — and
    // every SQL query, index and join on `challenge_id` would still return the wrong rows.
    const { db, expected } = build();
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE workouts SET challenge_id = chain_id, chain_id = challenge_id WHERE id = ?')
      .run('wo_1');
    db.exec('PRAGMA foreign_keys = ON');

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    const columns = failure.issues.filter(
      (i) => i.check === 'columns physically hold what the record says',
    );
    expect(columns).toHaveLength(2);
    expect(columns.map((i) => i.path).sort()).toEqual([
      'workouts.wo_1.chain_id',
      'workouts.wo_1.challenge_id',
    ]);
    db.close();
  });

  it('7b. columns: a JSON column swap, equally invisible to the round trip', () => {
    const { db, expected } = build();
    db.prepare('UPDATE plan_slots SET decision = pattern_metrics, pattern_metrics = decision WHERE id = ?')
      .run('slot_1');
    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(
      failure.issues.some(
        (i) =>
          i.check === 'columns physically hold what the record says' &&
          i.path === 'plan_slots.slot_1.decision',
      ),
    ).toBe(true);
    db.close();
  });

  it('7c. columns: the oracle must name every column the schema has', () => {
    const { db, dataset } = openWithModifiedSchema((ddl) =>
      ddl.replace('  note                      TEXT        NULL,', '  note TEXT NULL,\n  surprise TEXT NULL,'),
    );
    const failure = failuresFrom(() => verifyDatabase(db, { dataset, revision: 0 }));
    expect(
      failure.issues.some(
        (i) =>
          i.path === 'workouts.surprise' && i.message === 'no source property is declared for it',
      ),
    ).toBe(true);
    db.close();
  });

  it('7d. columns: a flattened group column holding the wrong part of its record', () => {
    const { db, expected } = build();
    db.prepare('UPDATE challenges SET baseline_recorded_at = started_at WHERE id = ?').run('ch_1');
    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(
      failure.issues.some(
        (i) => i.path === 'challenges.ch_1.baseline_recorded_at' && i.message.includes('baseline.recordedAt'),
      ),
    ).toBe(true);
    db.close();
  });

  it('8. duplicate primary keys: a table whose PRIMARY KEY went missing', () => {
    // Built from the real `schema.sql` with one PRIMARY KEY removed, so the check runs against a
    // real database rather than a mock. `workouts` is the table chosen because nothing references
    // it, so dropping its key does not also break a foreign key and mask the result.
    const { db, dataset } = openWithModifiedSchema((ddl) => {
      const at = ddl.indexOf('CREATE TABLE workouts (');
      expect(at).toBeGreaterThan(0);
      return (
        ddl.slice(0, at) +
        ddl
          .slice(at)
          .replace('NOT NULL PRIMARY KEY CHECK (length(id) > 0)', 'NOT NULL CHECK (length(id) > 0)')
      );
    });
    // `wo_2`, not `wo_1`: the unique index on (plan_slot_id, attempt_no) still guards the linked
    // workout, and this test is about the primary key rather than that index.
    db.exec("INSERT INTO workouts SELECT * FROM workouts WHERE id = 'wo_2'");

    const failure = failuresFrom(() => verifyDatabase(db, { dataset, revision: 0 }));
    const duplicates = failure.issues.filter((i) => i.check === 'duplicate primary keys');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.path).toBe('workouts.wo_2');
    expect(duplicates[0]?.message).toMatch(/appears 2 times/);
    db.close();
  });

  it('9. references: a chainId naming a challenge that is not there — no foreign key covers this', () => {
    const { db, expected } = build();
    db.prepare('UPDATE challenges SET chain_id = ? WHERE id = ?').run('ch_gone', 'ch_1');

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    // SQL is happy: chain_id deliberately has no FK.
    expect(failure.issues.some((i) => i.check === 'foreign_key_check')).toBe(false);
    expect(failure.issues.some((i) => i.check === 'references resolve')).toBe(true);
    db.close();
  });

  it('9c. references: a genuinely dangling chain head passes end to end under the flag', () => {
    // Not a mutation of a stored database — a dataset that legitimately has no chain head, built
    // and verified as a whole. This is what a partial restore produces, and it must be importable.
    const source = clone(MAXIMAL_BACKUP);
    source.challenges = source.challenges.map((c) => ({ ...c, chainId: 'ch_head_not_restored' }));
    source.workouts = source.workouts.map((w) => ({ ...w, chainId: 'ch_head_not_restored' }));
    const path = join(tempDir(), 'dangling.sqlite');
    const db = new DatabaseSync(path);
    applySchema(db);
    const dataset = datasetOfBackup(validateBackupStrict(source));
    writeDataset(db, dataset);

    expect(() => verifyDatabase(db, { dataset, revision: 0 })).toThrow(VerificationFailure);
    expect(verifyDatabase(db, { dataset, revision: 0 }, { allowDanglingChainHead: true }).length).toBe(13);
    db.close();
  });

  it('9b. references: --allow-dangling-chain-head accepts a chain whose head is gone', () => {
    const { db, expected } = build();
    db.prepare('UPDATE challenges SET chain_id = ? WHERE id = ?').run('ch_gone', 'ch_1');
    db.prepare('UPDATE workouts SET chain_id = ?').run('ch_gone');

    // The record comparison still fails, because the records genuinely changed — the point of
    // this test is that the reference check is the only thing the flag relaxes.
    const failure = failuresFrom(() =>
      verifyDatabase(db, expected, { allowDanglingChainHead: true }),
    );
    expect(failure.issues.some((i) => i.check === 'references resolve')).toBe(false);
    db.close();
  });

  it('10. attempt-number uniqueness: two attempts numbered the same on one slot', () => {
    const { db, expected } = build();
    // The unique index is dropped first, because it is what normally makes this impossible. The
    // check exists so that losing the index is visible rather than merely quiet.
    db.exec('DROP INDEX idx_workouts_slot_attempt');
    db.prepare('UPDATE workouts SET plan_slot_id = ?, attempt_no = 1 WHERE id = ?').run(
      'slot_1',
      'wo_2',
    );

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(failure.issues.some((i) => i.check === 'attempt-number uniqueness')).toBe(true);
    db.close();
  });

  it('11. slot coherence: a workout linked to a slot from another challenge', () => {
    const { db, expected } = build();
    db.prepare('UPDATE plan_slots SET challenge_id = ? WHERE id = ?').run('ch_0', 'slot_1');

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    // Both challenges exist, so every foreign key still resolves. Only the domain check sees it.
    expect(failure.issues.some((i) => i.check === 'foreign_key_check')).toBe(false);
    expect(
      failure.issues.some((i) => i.check === 'slot belongs to the workout’s challenge'),
    ).toBe(true);
    db.close();
  });

  it('12. totals: a set dropped from the JSON while the total stays', () => {
    const { db, expected } = build();
    // Exactly the shape of a lossy JSON round trip: the record still parses, the count is right,
    // the id is right — one element of an array is gone.
    db.prepare('UPDATE workouts SET sets = ? WHERE id = ?').run(
      JSON.stringify([{ actual: 12, index: 1 }]),
      'wo_2',
    );

    const failure = failuresFrom(() => verifyDatabase(db, expected));
    const totals = failure.issues.filter((i) => i.check === 'totals equal the sum of their parts');
    expect(totals).toHaveLength(1);
    expect(totals[0]?.message).toMatch(/says 22 but its sets add up to 12/);
    db.close();
  });

  it('12b. totals: a plan slot whose targets no longer add up to its total', () => {
    const { db, expected } = build();
    db.prepare('UPDATE plan_slots SET target_total = 999 WHERE id = ?').run('slot_1');
    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(
      failure.issues.some(
        (i) =>
          i.check === 'totals equal the sum of their parts' && i.path.startsWith('planSlots.'),
      ),
    ).toBe(true);
    db.close();
  });

  it('12c. totals: --allow-total-mismatch is the named door out of that refusal', () => {
    const { db, expected } = build();
    db.prepare('UPDATE plan_slots SET target_total = 999 WHERE id = ?').run('slot_1');
    // The record check still sees it, because the record genuinely changed. The point is that the
    // totals check specifically stops objecting.
    const failure = failuresFrom(() => verifyDatabase(db, expected, { allowTotalMismatch: true }));
    expect(failure.issues.some((i) => i.check === 'totals equal the sum of their parts')).toBe(false);
    db.close();
  });

  it('13. settings: the row is gone', () => {
    const { db, expected } = build();
    db.exec('DELETE FROM settings');
    const failure = failuresFrom(() => verifyDatabase(db, expected));
    expect(failure.issues.some((i) => i.check === 'settings is a single expected row')).toBe(true);
    db.close();
  });
});

describe('readDataset', () => {
  it('round-trips a whole database back into records', () => {
    const { db, expected } = build(MAXIMAL_BACKUP);
    const read = readDataset(db);
    expect(read.workouts).toHaveLength(2);
    // Canonical, not `JSON.stringify`: the JSON columns come back with their keys sorted, which
    // is a different byte string for the same record and is precisely what canonicalisation
    // exists to stop counting as a difference.
    expect(canonicalJson(read)).toBe(canonicalJson(expected.dataset));
    db.close();
  });

  it('refuses a database carrying more than one settings row', () => {
    const { db } = openWithModifiedSchema((ddl) =>
      ddl.replace("id                    TEXT NOT NULL PRIMARY KEY CHECK (id = 'settings'),", 'id                    TEXT NOT NULL,'),
    );
    db.prepare('INSERT INTO settings (id, kcal_coefficient) VALUES (?, ?)').run('settings', 0.5);
    expect(() => readDataset(db)).toThrow(/exactly one is allowed/);
    db.close();
  });
});
