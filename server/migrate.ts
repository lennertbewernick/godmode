/**
 * The migration: a backup JSON becomes a SQLite file, and is proven before it is trusted.
 *
 * The device holds the only copy of months of training. Codex judged the first design of this
 * step NOT-SOUND for one reason worth repeating here, because it shapes everything below:
 *
 *   > A re-export diff cannot prove that the imported database behaves correctly: it will not
 *   > detect missing foreign-key semantics, broken uniqueness rules, wrong SQLite affinities, or
 *   > computed fields that happen to serialize identically.
 *
 * So nothing here verifies by re-serialising. The importer builds a *fresh* database in a
 * temporary file, and `server/verify.ts` then interrogates that file — pragmas, counts, id sets,
 * record-by-record canonical equality, and domain invariants — before a single byte of the target
 * is touched. Only after every check passes does the temporary file get renamed into place.
 *
 * Four properties this module is built to hold, in order of what they would cost to lose:
 *
 * 1. **A failure at any stage before the rename leaves the target exactly as it was.** Everything
 *    is written to a temporary file inside the target's own directory; the only operation that
 *    touches the target is a single `renameSync`. `server/migrate.test.ts` induces a failure at
 *    each stage and asserts the target is byte-identical afterwards.
 *
 *    The rename is the commit point, and this file says so rather than pretending otherwise: a
 *    failure *after* it — the directory fsync, say — is reported as `MigrationError('committed')`,
 *    which states plainly that the replacement happened and names the safety copy. Codex found the
 *    earlier version claiming "a failure at any stage" while a post-rename `fsync` throw would
 *    have printed "the target is exactly as it was" over a target that had just been replaced.
 *
 * 2. **Re-runnable, never destructive.** Absent id -> insert. Present id with canonically identical
 *    content -> no-op. Present id with different content -> abort and name the ids. Never
 *    `INSERT OR REPLACE` (`server/dataset.ts`, `server/rows.ts:92-98`).
 *
 * 3. **The output is rebuilt, not patched.** When the target already exists, its records are read
 *    back out through `rows.ts` decode — which re-validates every one of them — and re-inserted
 *    into the fresh file alongside the incoming ones. A byte copy would carry forward whatever
 *    corruption it already had; this way the file that lands has been through the same gate the
 *    import came through.
 *
 * 4. **The previous file is kept.** Before the rename, an existing target is copied to
 *    `<target>.pre-import-<timestamp>.sqlite` and left there. Nothing in this module deletes it,
 *    and nothing anywhere in this work calls `indexedDB.deleteDatabase` — the browser copy stays
 *    the fallback.
 *
 * 5. **Nothing else owns the database while this runs.** Codex's remaining finding was that a
 *    sidecar check cannot see an idle SQLite connection, and that a POSIX `rename` over a file a
 *    server still has open succeeds — leaving that server writing into an unlinked inode. So this
 *    module no longer relies on the sidecars for that question. It takes `<target>.lock`
 *    exclusively before its first read and holds it past the rename; `server/db.ts` takes the same
 *    lock when the server opens the database and holds it for the server's whole lifetime. The
 *    mechanism, its staleness rules and the three places the guarantee stops are all written down
 *    in `server/lock.ts`.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, canonicalize, isPlainObject } from './canonical.js';
import { LockUnavailableError, acquireLock, type HeldLock } from './lock.js';
import {
  COLLECTIONS,
  EMPTY_DATASET,
  datasetOf,
  datasetOfBackup,
  idOf,
  readDataset,
  recordsOf,
  writeDataset,
  type CollectionKey,
  type Dataset,
} from './dataset.js';
import { applySchema, armConnection, assertSchemaVersion } from './schema.js';
import { BOOTSTRAP_USER_ID, ensureBootstrapUser } from './users.js';
import { validateBackupStrict } from './validate.js';
import { verifyDatabase, type ExpectedState } from './verify.js';

// ── Errors ──────────────────────────────────────────────────────────────────────────────────

export type MigrationStage =
  | 'validate'
  | 'target'
  | 'plan'
  | 'build'
  | 'verify'
  | 'commit'
  /** After the rename. The replacement HAPPENED; only its durability is in doubt. */
  | 'committed';

export class MigrationError extends Error {
  readonly stage: MigrationStage;

  constructor(stage: MigrationStage, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.stage = stage;
  }
}

/** One id that exists on both sides with different content. The reason a re-import aborts. */
export interface Conflict {
  readonly collection: CollectionKey;
  readonly id: string;
  /** Property names whose canonical value differs. Top level only — enough to name the problem. */
  readonly differingFields: readonly string[];
  readonly stored: string;
  readonly incoming: string;
}

export class ImportConflictError extends MigrationError {
  readonly conflicts: readonly Conflict[];

  constructor(conflicts: readonly Conflict[]) {
    const lines = conflicts
      .slice(0, 20)
      .map((c) => `  ${c.collection} "${c.id}" differs in: ${c.differingFields.join(', ')}`);
    const more =
      conflicts.length > lines.length ? `\n  … and ${conflicts.length - lines.length} more` : '';
    super(
      'plan',
      'That backup disagrees with what is already stored, so nothing was imported. ' +
        `${conflicts.length} record${conflicts.length === 1 ? '' : 's'} already here carry the ` +
        `same id and different content:\n${lines.join('\n')}${more}\n` +
        'Nothing has been written and nothing has been replaced. Decide which version is ' +
        'correct before importing again.',
    );
    this.name = 'ImportConflictError';
    this.conflicts = conflicts;
  }
}

function requireId(record: unknown, collection: CollectionKey): string {
  const id = idOf(record);
  if (id === undefined) {
    // Unreachable through the public entry points: every record has been through a field map that
    // declares `id` a non-empty string. Stated anyway, because the alternative to throwing here is
    // a record silently keyed as "undefined" and quietly colliding with another one.
    throw new MigrationError('plan', `a ${collection} record has no id`);
  }
  return id;
}

// ── The plan: insert / no-op / abort ────────────────────────────────────────────────────────

export interface CollectionPlan {
  readonly key: CollectionKey;
  /** Records the incoming backup adds. */
  readonly inserted: readonly unknown[];
  /** Records the incoming backup repeats, identical after canonicalisation. */
  readonly unchanged: number;
  /** Records already stored that the incoming backup does not mention. Kept, untouched. */
  readonly carriedOver: number;
}

export interface ImportPlan {
  readonly collections: readonly CollectionPlan[];
  readonly conflicts: readonly Conflict[];
  /** Stored ∪ incoming — what the new file must contain, and what the verifier checks against. */
  readonly expected: Dataset;
  readonly insertedTotal: number;
}

function differingFields(stored: unknown, incoming: unknown): string[] {
  const a = canonicalize(stored);
  const b = canonicalize(incoming);
  if (!isPlainObject(a) || !isPlainObject(b)) return ['<the whole record>'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
  return out.length > 0 ? out : ['<no visible difference>'];
}

/**
 * Decide, per record, what a re-run does — without writing anything.
 *
 * Equality is `canonicalJson(a) === canonicalJson(b)`: keys sorted, `undefined` dropped, `-0`
 * normalised. So a record that came back out of SQLite with its properties in a different order,
 * or with an optional spelled absent rather than `undefined`, is correctly seen as *the same
 * record* rather than as a conflict. Without that, the second run of an import would abort on
 * every record it had itself just written.
 */
export function planImport(existing: Dataset, incoming: Dataset): ImportPlan {
  const collections: CollectionPlan[] = [];
  const conflicts: Conflict[] = [];
  const union: Record<string, readonly unknown[]> = {};

  for (const { key } of COLLECTIONS) {
    const stored = recordsOf(existing, key);
    const arriving = recordsOf(incoming, key);

    const storedById = new Map<string, unknown>();
    for (const record of stored) storedById.set(requireId(record, key), record);

    const inserted: unknown[] = [];
    let unchanged = 0;
    const arrivingIds = new Set<string>();

    for (const record of arriving) {
      const id = requireId(record, key);
      arrivingIds.add(id);
      const already = storedById.get(id);
      if (already === undefined) {
        inserted.push(record);
        continue;
      }
      if (canonicalJson(already, `${key}.${id}`) === canonicalJson(record, `${key}.${id}`)) {
        unchanged += 1;
        continue;
      }
      conflicts.push({
        collection: key,
        id,
        differingFields: differingFields(already, record),
        stored: canonicalJson(already, `${key}.${id}`),
        incoming: canonicalJson(record, `${key}.${id}`),
      });
    }

    const carried = stored.filter((record) => !arrivingIds.has(requireId(record, key)));
    collections.push({ key, inserted, unchanged, carriedOver: carried.length });

    // Records present on both sides are taken from the *stored* side — the copy that actually has
    // to survive. They are canonically identical to the incoming ones by construction, so the two
    // choices are equally strong under canonical equivalence; the earlier comment here called the
    // stored side "stricter", which Codex correctly rebutted. The reason to prefer it is different
    // and still good: for carried-over records there is no incoming object at all, so taking the
    // stored side everywhere means the verifier proves the same thing about every record — that
    // what is on disk survives — rather than proving one thing about new records and another
    // about old ones.
    union[key] = [...stored, ...inserted];
  }

  return {
    collections,
    conflicts,
    expected: datasetOf(union as Readonly<Record<CollectionKey, readonly unknown[]>>),
    insertedTotal: collections.reduce((sum, c) => sum + c.inserted.length, 0),
  };
}

// ── The procedure ───────────────────────────────────────────────────────────────────────────

/** Test seam. Nothing in production sets these. */
export interface MigrationHooks {
  /** Runs against the temporary database after the insert commits and before verification. */
  readonly afterInsert?: (db: DatabaseSync) => void;
  /** Runs after verification passes and before the rename. */
  readonly beforeRename?: (temporaryPath: string) => void;
  /** Runs after the rename, inside the block that reports a post-commit durability failure. */
  readonly afterRename?: (targetPath: string) => void;
}

export interface ImportOptions {
  /** Already-parsed backup JSON. Unvalidated — `validateBackupStrict` is applied to it here. */
  readonly backup: unknown;
  readonly targetPath: string;
  /** Build and verify the temporary file, report, then discard it. The target is never renamed. */
  readonly dryRun?: boolean;
  /**
   * Accept a `chainId` whose head challenge is absent.
   *
   * Off by default, and it stays off for the owner's data: every chain id in the real export
   * resolves. It exists because `chain_id` deliberately has no foreign key — a partial restore can
   * legitimately produce a chain whose head is missing (`server/PERSISTENCE.md` §9) — so the
   * verifier has to be able to say "this is dangling" without that being an unfixable refusal.
   */
  readonly allowDanglingChainHead?: boolean;
  /**
   * Accept a total that is not the sum of its parts. See `checkTotals` in `server/verify.ts`.
   * Off by default; every one of the owner's 29 sessions and 36 slots satisfies the invariant.
   */
  readonly allowTotalMismatch?: boolean;
  /**
   * Break a `<target>.lock` whose holder is *provably* gone — a dead process on this host.
   *
   * Deliberately not a `--force`: `acquireLock` refuses a live holder and refuses one it cannot
   * judge, so this flag is useless against a running server and useful only after a crash.
   */
  readonly breakStaleLock?: boolean;
  readonly hooks?: MigrationHooks;
}

export interface CollectionReport {
  readonly key: CollectionKey;
  readonly inserted: number;
  readonly unchanged: number;
  readonly carriedOver: number;
  readonly total: number;
}

export interface ImportReport {
  readonly targetPath: string;
  readonly targetExisted: boolean;
  /** Where the previous database was copied before the rename, or `undefined` if there was none. */
  readonly safetyCopyPath: string | undefined;
  readonly dryRun: boolean;
  /** Whether a new file was actually put in place. False for a dry run and for a true no-op. */
  readonly renamed: boolean;
  readonly collections: readonly CollectionReport[];
  readonly insertedTotal: number;
  readonly unchangedTotal: number;
  readonly revision: number;
  /** Sum of `actualTotal` over every workout in the resulting file. The owner's headline number. */
  readonly totalReps: number;
  readonly checksRun: readonly string[];
}

const SIDECARS = ['-wal', '-shm', '-journal'] as const;

/**
 * Refuse a target that was not closed cleanly — and be honest that this is not proof of anything
 * stronger.
 *
 * A `-wal` file holds committed transactions that are not yet in the main database, and a
 * `-journal` file means a write was interrupted. Reading the main file alone in either state would
 * silently miss data, and renaming a new file over it would strand the sidecars beside a database
 * they no longer describe. So their presence is a hard refusal.
 *
 * **Their absence proves nothing**, and this check never claimed otherwise: an *idle* SQLite
 * connection leaves no sidecar at all, so a running server passes it. That gap is now closed by
 * something else — `server/lock.ts`, taken exclusively at the top of `importBackup` and held
 * through the rename, which a running server holds for its whole lifetime. This check is kept
 * because it catches what the lock cannot: a database left mid-write by a process that never took
 * the lock at all — `sqlite3`, a copy that was interrupted, a crash before this contract existed.
 *
 * It is still run twice, once before reading and once immediately before the rename.
 */
function assertNoSidecars(targetPath: string, stage: MigrationStage = 'target'): void {
  for (const suffix of SIDECARS) {
    if (existsSync(`${targetPath}${suffix}`)) {
      throw new MigrationError(
        stage,
        `"${targetPath}${suffix}" exists, so another process has this database open or it was ` +
          'not closed cleanly. Importing now could lose whatever that file holds. Stop the ' +
          'server, let SQLite finish, then try again. Nothing has been written.',
      );
    }
  }
}

/**
 * Take exclusive ownership of the database, or refuse and say who has it.
 *
 * One lock, two holders, and that is the whole point: the server takes `<database>.lock` when it
 * opens the file and holds it until it closes (`server/db.ts`), and this takes the same lock
 * before it reads a single byte and holds it through the rename. So "another import is running"
 * and "the server is running" are the same refusal with different words, and neither can be
 * mistaken for the other because the record in the file names its role.
 *
 * The refusal is re-thrown as a `MigrationError` on the `target` stage so that every way this
 * command can decline still arrives at the caller as one type carrying one stage — nothing has
 * been created, opened or written at this point.
 */
function acquireOwnership(targetPath: string, breakStaleLock: boolean): HeldLock {
  try {
    return acquireLock({
      databasePath: targetPath,
      role: 'import',
      // Never by itself. `--break-stale-lock` is the owner saying so out loud, and even then
      // `acquireLock` refuses anything whose holder is not provably gone.
      reclaimStale: breakStaleLock,
    });
  } catch (error) {
    if (error instanceof LockUnavailableError) {
      throw new MigrationError('target', `${error.message}\nNothing has been written.`);
    }
    throw error;
  }
}

/** The same re-throw, at the commit stage: ownership lost between taking the lock and the rename. */
function assertStillOwned(lock: HeldLock): void {
  try {
    lock.assertStillHeld();
  } catch (error) {
    if (error instanceof LockUnavailableError) {
      throw new MigrationError('commit', `${error.message}\nNothing has been replaced.`);
    }
    throw error;
  }
}

/**
 * Copy the previous database aside, refusing to overwrite an earlier copy.
 *
 * `COPYFILE_EXCL` makes the copy fail rather than clobber. Two imports in the same millisecond, a
 * clock that went backwards, or a path that happens to exist would otherwise silently destroy the
 * one artefact whose entire job is to still be there afterwards.
 */
function copyAside(targetPath: string, now: Date): string {
  const base = `${targetPath}.pre-import-${timestampSuffix(now)}`;
  for (const suffix of ['', `-${randomUUID()}`]) {
    const candidate = `${base}${suffix}.sqlite`;
    try {
      copyFileSync(targetPath, candidate, constants.COPYFILE_EXCL);
      fsyncPath(candidate);
      return candidate;
    } catch (error) {
      if (suffix !== '') throw error;
    }
  }
  throw new MigrationError('commit', 'could not write a safety copy; nothing has been replaced.');
}

/** Push bytes to disk before the rename, so a crash cannot leave a renamed-but-empty file. */
function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function timestampSuffix(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Read a backup, build a verified database from it, and put that database in place.
 *
 * Ordered so the cheap refusals happen before anything is created, and so the only operation that
 * touches the target is the last one.
 */
export function importBackup(options: ImportOptions): ImportReport {
  const { targetPath } = options;

  // 1. Validate. Nothing has been created yet, so a rejection here costs nothing — and it costs
  //    nothing to anybody else either, which is why it happens before the lock is taken.
  const backup = validateBackupStrict(options.backup);
  const incoming = datasetOfBackup(backup);

  // 2. Take exclusive ownership, before anything is read.
  //
  //    Earlier than it needs to be for the rename alone, on purpose. Codex's finding named the
  //    rename, but the same reasoning condemns the two reads that precede it: a dataset decoded
  //    out of a database somebody is writing to is a dataset that was never in the file at one
  //    instant, and a safety copy taken from underneath a live writer is an inconsistent copy of
  //    the one artefact whose whole job is to be usable afterwards. So the lock spans all of it.
  //
  //    A dry run takes it too. It reads the target, and a rehearsal against a moving database is
  //    a rehearsal of nothing — worse, it would pass and then the real run would refuse.
  const lock = acquireOwnership(targetPath, options.breakStaleLock === true);
  try {
    return importUnderLock(options, incoming, lock);
  } finally {
    lock.release();
  }
}

/** Everything from the first read to the rename, with `<target>.lock` held throughout. */
function importUnderLock(options: ImportOptions, incoming: Dataset, lock: HeldLock): ImportReport {
  const { targetPath } = options;
  const dryRun = options.dryRun === true;

  // 3. Read whatever is already there — read-only. The live file is never opened for writing.
  const targetExisted = existsSync(targetPath);
  let existing = EMPTY_DATASET;
  let existingRevision = 0;
  let createdAt: string | undefined;
  if (targetExisted) {
    assertNoSidecars(targetPath);
    try {
      const current = new DatabaseSync(targetPath, { readOnly: true });
      try {
        armConnection(current);
        assertSchemaVersion(current);
        const meta = current.prepare('SELECT created_at FROM meta').get() as
          | { created_at: string }
          | undefined;
        // The revision is per-user in v2 (`user_revisions`). The import machinery works on a
        // single-user file — the bootstrap owner — so this reads that owner's counter.
        const revisionRow = current
          .prepare('SELECT revision FROM user_revisions WHERE user_id = ?')
          .get(BOOTSTRAP_USER_ID) as { revision: number } | undefined;
        existingRevision = revisionRow?.revision ?? 0;
      if (!Number.isSafeInteger(existingRevision) || existingRevision < 0) {
        throw new Error(
          `user_revisions.revision is ${String(existingRevision)}, which is not a usable ` +
            'revision number.',
        );
      }
        createdAt = meta?.created_at;
        existing = readDataset(current);
      } finally {
        current.close();
      }
    } catch (error) {
      // Everything that can go wrong while reading the target — an unreadable file, a schema
      // version this build does not understand, a row that no longer decodes — becomes one error
      // type carrying one stage, so a caller never has to guess whether anything was written.
      // Nothing has been: this block only ever opens the file read-only.
      throw new MigrationError(
        'target',
        `${targetPath} could not be read, so nothing was imported and nothing was changed.\n` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  // 4. Plan. A conflict aborts here, before a temporary file has even been created.
  const plan = planImport(existing, incoming);
  if (plan.conflicts.length > 0) throw new ImportConflictError(plan.conflicts);

  // A rebuilt dataset invalidates any revision a client is holding, so the revision moves whenever
  // a record was added. A true no-op keeps it, because nothing a client could be holding changed.
  const revision = existingRevision + (plan.insertedTotal > 0 ? 1 : 0);
  const expectedState: ExpectedState = {
    dataset: plan.expected,
    revision,
    userId: BOOTSTRAP_USER_ID,
  };

  // 5. Build — in the target's own directory, so the rename at the end is a same-filesystem move
  //    and therefore atomic. A temporary file under /tmp would make it a copy, which is not.
  const workDir = mkdtempSync(join(dirname(targetPath), '.godmode-import-'));
  const temporaryPath = join(workDir, basename(targetPath));
  let renamed = false;
  try {
    let checksRun: readonly string[] = [];
    const fresh = new DatabaseSync(temporaryPath);
    try {
      applySchema(fresh);
      const now = new Date().toISOString();
      // One owner for the whole file (the import machinery is single-user); all records land on it.
      ensureBootstrapUser(fresh, { now });
      writeDataset(fresh, plan.expected, BOOTSTRAP_USER_ID);
      fresh
        .prepare('UPDATE meta SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(createdAt ?? now, now, 'meta');
      fresh
        .prepare('UPDATE user_revisions SET revision = ?, updated_at = ? WHERE user_id = ?')
        .run(revision, now, BOOTSTRAP_USER_ID);

      options.hooks?.afterInsert?.(fresh);

      // 6. Verify. Every check can fail; any failure means the target is never touched.
      checksRun = verifyDatabase(fresh, expectedState, {
        ...(options.allowDanglingChainHead === true ? { allowDanglingChainHead: true } : {}),
        ...(options.allowTotalMismatch === true ? { allowTotalMismatch: true } : {}),
      });
    } finally {
      fresh.close();
    }

    // Nothing new arrived, so there is nothing to put in place. The rebuild still happened and was
    // still fully verified — which is a genuine health check on what is already stored, since the
    // records it was built from were decoded out of the target — but the target itself is left
    // literally untouched. Renaming an identical file over it would churn its bytes and drop
    // another safety copy beside it on every run, for no gain.
    const nothingToDo = targetExisted && plan.insertedTotal === 0;

    const report = buildReport({
      plan,
      targetPath,
      targetExisted,
      dryRun,
      renamed: !dryRun && !nothingToDo,
      revision,
      checksRun,
      safetyCopyPath: undefined,
    });

    if (dryRun || nothingToDo) return report;

    // 7. Put it in place. Copy the old file aside first, and leave that copy there for good.
    fsyncPath(temporaryPath);
    let safetyCopyPath: string | undefined;
    if (targetExisted) safetyCopyPath = copyAside(targetPath, new Date());

    options.hooks?.beforeRename?.(temporaryPath);

    // Two last looks before the point of no return, and they answer different questions.
    //
    // The lock answers "does anything that honours this contract still own the file" — including
    // the case the sidecars are blind to, an idle server connection. It is re-checked rather than
    // assumed because a stale-lock reclaim by somebody else, or a hand-deleted lock file, would
    // have taken ownership away from this process while it was building; better to find that out
    // for free here than after the rename.
    //
    // The sidecar check answers "was this database left mid-write by anything at all", including
    // processes that never heard of the lock. Both are cheap and neither implies the other.
    assertStillOwned(lock);
    if (targetExisted) assertNoSidecars(targetPath, 'commit');

    renameSync(temporaryPath, targetPath);
    renamed = true;

    // Past this line the replacement has happened. Anything that throws from here is a durability
    // problem, not a reason to tell the owner nothing changed.
    try {
      fsyncPath(dirname(targetPath));
      options.hooks?.afterRename?.(targetPath);
    } catch (error) {
      throw new MigrationError(
        'committed',
        `${targetPath} HAS been replaced — the new database is in place and passed every check.\n` +
          'What failed was making that change durable on this filesystem, so a power cut in the ' +
          'next moments could leave the directory entry unwritten.\n' +
          (safetyCopyPath === undefined
            ? 'There was no previous database to fall back to; the backup JSON is unchanged.\n'
            : `The previous database is at ${safetyCopyPath}.\n`) +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    return { ...report, safetyCopyPath };
  } finally {
    // Whatever happened, the working directory goes. On the success path the file has already been
    // renamed out of it; on every failure path before the rename the half-built database dies here
    // and the target still holds exactly what it held. `renamed` is what the caller would consult
    // to know which of those two it is in; it is deliberately not swallowed into the report,
    // because a post-rename failure throws rather than returns.
    void renamed;
    rmSync(workDir, { recursive: true, force: true });
  }
}

function buildReport(input: {
  plan: ImportPlan;
  targetPath: string;
  targetExisted: boolean;
  dryRun: boolean;
  renamed: boolean;
  revision: number;
  checksRun: readonly string[];
  safetyCopyPath: string | undefined;
}): ImportReport {
  const collections = input.plan.collections.map((c) => ({
    key: c.key,
    inserted: c.inserted.length,
    unchanged: c.unchanged,
    carriedOver: c.carriedOver,
    total: recordsOf(input.plan.expected, c.key).length,
  }));
  return {
    targetPath: input.targetPath,
    targetExisted: input.targetExisted,
    safetyCopyPath: input.safetyCopyPath,
    dryRun: input.dryRun,
    renamed: input.renamed,
    collections,
    insertedTotal: input.plan.insertedTotal,
    unchangedTotal: collections.reduce((sum, c) => sum + c.unchanged, 0),
    revision: input.revision,
    totalReps: input.plan.expected.workouts.reduce((sum, w) => sum + w.actualTotal, 0),
    checksRun: input.checksRun,
  };
}

const COLLECTION_LABELS: Record<CollectionKey, string> = {
  exercises: 'exercises',
  challenges: 'challenges',
  performanceTests: 'max tests',
  planSlots: 'plan slots',
  workouts: 'workouts',
  settings: 'settings',
};

/** What happened, in the words the owner would use. Printed by `server/import-backup.ts`. */
export function describeReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(
    report.dryRun
      ? 'Dry run: a database was built and fully verified, then thrown away. Nothing changed.'
      : !report.renamed
        ? `Nothing to add: ${report.targetPath} already holds every record in that backup. ` +
          'It was rebuilt and fully verified in a temporary file to confirm that, then the ' +
          'temporary file was thrown away. The database itself was not touched.'
        : report.targetExisted
          ? `Imported into the existing database at ${report.targetPath}.`
          : `Created a new database at ${report.targetPath}.`,
  );
  lines.push('');
  lines.push('  table          in file   added   already there   kept from before');
  for (const c of report.collections) {
    lines.push(
      `  ${COLLECTION_LABELS[c.key].padEnd(13)}${String(c.total).padStart(8)}` +
        `${String(c.inserted).padStart(8)}${String(c.unchanged).padStart(16)}` +
        `${String(c.carriedOver).padStart(19)}`,
    );
  }
  const workouts = report.collections.find((c) => c.key === 'workouts')?.total ?? 0;
  lines.push('');
  lines.push(`  ${String(workouts)} workouts, ${String(report.totalReps)} reps in total.`);
  lines.push(`  Dataset revision: ${String(report.revision)}.`);
  lines.push('');
  lines.push(`  Verified by ${String(report.checksRun.length)} checks, every one of which passed:`);
  for (const check of report.checksRun) lines.push(`    - ${check}`);
  if (report.safetyCopyPath !== undefined) {
    lines.push('');
    lines.push(`  The previous database was copied to ${report.safetyCopyPath} and left there.`);
  }
  if (report.renamed) {
    lines.push('');
    lines.push('  Your browser data has not been touched. Keep it, and keep the backup file.');
  }
  return lines.join('\n');
}
