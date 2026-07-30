// @vitest-environment node
//
// The exclusive-ownership contract, and the one test Codex asked for and did not get.
//
// Everything about a lock file that matters is between processes, so the centrepiece here is a
// real second `node` process that takes the lock and holds an open SQLite connection while the
// importer runs against the same file. Nothing about that can be faked in-process: the whole
// hazard is that a POSIX rename over a file another process has open *succeeds*.
//
// The target is hashed with SHA-256 before and after every refusal. Byte-identical, or the
// guarantee is a sentence rather than a property.

import { createHash } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MAXIMAL_BACKUP, clone } from './fixtures.js';
import {
  BOOT_TOLERANCE_SECONDS,
  LockUnavailableError,
  acquireLock,
  bootSecondsNow,
  judgeLock,
  lockPathFor,
  processIsRunning,
  readLockRecord,
  type HostFacts,
  type LockRecord,
} from './lock.js';
import { MigrationError, importBackup } from './migrate.js';
import type { WorkoutRecord } from '../src/db/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child);
    }
  }
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-lock-'));
  tempDirs.push(dir);
  return dir;
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function facts(overrides: Partial<HostFacts> = {}): HostFacts {
  return {
    host: 'testhost',
    pidNamespace: undefined,
    bootSeconds: 1_000_000,
    isRunning: () => true,
    ...overrides,
  };
}

function record(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    kind: 'godmode-database-lock',
    version: 1,
    role: 'server',
    pid: 4242,
    host: 'testhost',
    bootSeconds: 1_000_000,
    acquiredAt: '2026-07-30T12:00:00.000Z',
    nonce: 'nonce-1',
    databasePath: '/tmp/godmode.sqlite',
    ...overrides,
  };
}

// ── judgeLock ───────────────────────────────────────────────────────────────────────────────

describe('judgeLock', () => {
  it('calls a lock live when its process is running on this host, this boot', () => {
    const verdict = judgeLock(record(), facts());
    expect(verdict.state).toBe('live');
    expect(verdict.reason).toContain('4242');
  });

  it('calls a lock stale when no such process is running', () => {
    const verdict = judgeLock(record(), facts({ isRunning: () => false }));
    expect(verdict.state).toBe('stale');
    expect(verdict.reason).toContain('no process with id 4242');
  });

  it('a dead process is stale regardless of what the clock says about the boot', () => {
    // Boot time is derived from `Date.now() - os.uptime()`, so an NTP step moves it. It is
    // therefore only ever allowed to *withhold* a verdict, never to produce one — a dead pid
    // decides staleness on its own.
    const verdict = judgeLock(record(), facts({ isRunning: () => false, bootSeconds: 9_999_999 }));
    expect(verdict.state).toBe('stale');
  });

  it('refuses to judge a live process id from a boot that is not this one', () => {
    // The reboot-plus-pid-reuse case: something answers to that number, but it is almost certainly
    // not the process that took the lock. Guessing either way here would be wrong.
    const verdict = judgeLock(record(), facts({ bootSeconds: 1_000_000 + 600 }));
    expect(verdict.state).toBe('unknowable');
    expect(verdict.reason).toContain('booted since');
  });

  it('tolerates the second or two that two uptime samples disagree by', () => {
    expect(judgeLock(record(), facts({ bootSeconds: 1_000_000 + BOOT_TOLERANCE_SECONDS })).state)
      .toBe('live');
  });

  it('refuses to judge a lock taken on another machine', () => {
    const verdict = judgeLock(record({ host: 'someone-else' }), facts({ isRunning: () => false }));
    expect(verdict.state).toBe('unknowable');
    expect(verdict.reason).toContain('someone-else');
  });

  it('refuses to judge a lock file it cannot read as a record', () => {
    const verdict = judgeLock(undefined, facts());
    expect(verdict.state).toBe('unknowable');
  });

  it('refuses to judge a pid from another process namespace, however alike the hostnames', () => {
    // Codex, finding 3: two containers on one bind mount can be configured with the same
    // hostname. `process.kill` from one reports the other's live server as gone, and the lock a
    // running server is holding would have been declared provably stale and broken.
    const verdict = judgeLock(
      record({ pidNamespace: 'pid:[4026531836]' }),
      facts({ pidNamespace: 'pid:[4026532999]', isRunning: () => false }),
    );
    expect(verdict.state).toBe('unknowable');
    expect(verdict.reason).toContain('different process namespace');
  });

  it('will not probe a namespaced pid from a host that has no namespaces at all', () => {
    expect(
      judgeLock(record({ pidNamespace: 'pid:[4026531836]' }), facts({ isRunning: () => false }))
        .state,
    ).toBe('unknowable');
  });

  it('judges normally when neither side has namespaces', () => {
    expect(judgeLock(record(), facts({ isRunning: () => false })).state).toBe('stale');
  });
});

describe('readLockRecord', () => {
  it('returns undefined for anything that is not this exact shape', () => {
    // Strictness here is a safety property, not tidiness: `undefined` means *unknowable*, which
    // means refuse; anything that parses gets judged, and a judgement is what breaks a lock.
    const good = JSON.parse(JSON.stringify(record())) as Record<string, unknown>;
    const dir = tempDir();
    const path = join(dir, 'x.lock');
    for (const content of [
      'not json at all',
      '[]',
      '"a string"',
      '{}',
      '{"kind":"godmode-database-lock","version":2}',
      // Truncated mid-write: a real possibility, and never a licence to break the lock.
      '{"kind":"godmode-database-lock","version":1,"pid":1,"ho',
      JSON.stringify({ ...good, role: 'nonsense' }),
      // Codex, finding 7: a negative pid parsed, `processIsRunning(-1)` is false, and a mangled
      // lock file was therefore "provably stale".
      JSON.stringify({ ...good, pid: -1 }),
      JSON.stringify({ ...good, pid: 0 }),
      JSON.stringify({ ...good, pid: 12.5 }),
      JSON.stringify({ ...good, bootSeconds: 'yesterday' }),
      JSON.stringify({ ...good, host: '' }),
      JSON.stringify({ ...good, nonce: '' }),
      JSON.stringify({ ...good, acquiredAt: 'some time last week' }),
      JSON.stringify({ ...good, databasePath: '' }),
      JSON.stringify({ ...good, pidNamespace: 7 }),
    ]) {
      writeFileSync(path, content);
      expect(readLockRecord(path), content.slice(0, 60)).toBeUndefined();
    }
    writeFileSync(path, JSON.stringify(good));
    expect(readLockRecord(path)?.nonce).toBe('nonce-1');
    rmSync(path);
    expect(readLockRecord(path)).toBeUndefined();
  });
});

describe('processIsRunning', () => {
  it('says yes to this process and no to a pid that cannot exist', () => {
    expect(processIsRunning(process.pid)).toBe(true);
    expect(processIsRunning(0)).toBe(false);
    expect(processIsRunning(-1)).toBe(false);
  });
});

describe('bootSecondsNow', () => {
  it('is stable across two samples taken moments apart', () => {
    expect(Math.abs(bootSecondsNow() - bootSecondsNow())).toBeLessThanOrEqual(1);
  });
});

// ── acquireLock ─────────────────────────────────────────────────────────────────────────────

describe('acquireLock', () => {
  it('creates a readable record and takes the path beside the database', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    const held = acquireLock({ databasePath: db, role: 'server' });
    try {
      expect(held.path).toBe(`${db}.lock`);
      const written = readLockRecord(held.path);
      expect(written?.role).toBe('server');
      expect(written?.pid).toBe(process.pid);
      expect(written?.nonce).toBe(held.record.nonce);
    } finally {
      held.release();
    }
    expect(existsSync(lockPathFor(db))).toBe(false);
  });

  it('refuses a second holder while the first is alive, and names it', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    const held = acquireLock({ databasePath: db, role: 'server' });
    try {
      let caught: unknown;
      try {
        acquireLock({ databasePath: db, role: 'import' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LockUnavailableError);
      const error = caught as LockUnavailableError;
      expect(error.liveness.state).toBe('live');
      expect(error.holder?.role).toBe('server');
      expect(error.message).toContain('locked by the GodMode server');
      // The live path must never advertise the escape hatch.
      expect(error.message).not.toContain('--break-stale-lock');
    } finally {
      held.release();
    }
  });

  it('will not break a stale lock unless it is asked to', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    writeFileSync(lockPathFor(db), JSON.stringify(record({ pid: 999_999 })));

    let caught: unknown;
    try {
      acquireLock({ databasePath: db, role: 'import', facts: facts({ isRunning: () => false }) });
    } catch (error) {
      caught = error;
    }
    expect((caught as LockUnavailableError).liveness.state).toBe('stale');
    expect((caught as LockUnavailableError).message).toContain('--break-stale-lock');
    // Still there: refusing is not the same as tidying up behind somebody.
    expect(existsSync(lockPathFor(db))).toBe(true);
  });

  it('breaks a stale lock when asked, and keeps the old one as evidence', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    writeFileSync(lockPathFor(db), JSON.stringify(record({ pid: 999_999 })));

    const reclaims: string[] = [];
    const held = acquireLock({
      databasePath: db,
      role: 'import',
      reclaimStale: true,
      facts: facts({ isRunning: () => false }),
      onReclaim: (info) => reclaims.push(info.sidelinedTo),
    });
    try {
      expect(reclaims).toHaveLength(1);
      expect(existsSync(reclaims[0] as string)).toBe(true);
      expect(readLockRecord(reclaims[0] as string)?.pid).toBe(999_999);
      expect(readLockRecord(held.path)?.pid).toBe(process.pid);
    } finally {
      held.release();
    }
  });

  it('refuses to break a live lock even when asked to break stale ones', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    const held = acquireLock({ databasePath: db, role: 'server' });
    try {
      expect(() =>
        acquireLock({ databasePath: db, role: 'import', reclaimStale: true }),
      ).toThrow(/locked by the GodMode server/);
    } finally {
      held.release();
    }
  });

  it('refuses to break a lock it cannot judge, even when asked to break stale ones', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    writeFileSync(lockPathFor(db), 'half a record, written by something that died mid-write');

    let caught: unknown;
    try {
      acquireLock({ databasePath: db, role: 'import', reclaimStale: true });
    } catch (error) {
      caught = error;
    }
    expect((caught as LockUnavailableError).liveness.state).toBe('unknowable');
    expect((caught as LockUnavailableError).message).toContain('by hand');
    expect(existsSync(lockPathFor(db))).toBe(true);
  });

  it('notices when its own lock was taken away underneath it', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    const held = acquireLock({ databasePath: db, role: 'import' });
    try {
      expect(() => held.assertStillHeld()).not.toThrow();
      // Somebody deleted the lock file and took it themselves.
      writeFileSync(held.path, JSON.stringify(record({ nonce: 'somebody-else' })));
      expect(() => held.assertStillHeld()).toThrow(/no longer the lock this process took/);
    } finally {
      rmSync(held.path, { force: true });
    }
  });

  it('release never removes a lock that is no longer ours', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    const held = acquireLock({ databasePath: db, role: 'import' });
    writeFileSync(held.path, JSON.stringify(record({ nonce: 'somebody-else' })));

    held.release();

    expect(existsSync(held.path)).toBe(true);
    expect(readLockRecord(held.path)?.nonce).toBe('somebody-else');
    rmSync(held.path);
  });

  it('release is safe to call twice', () => {
    const db = join(tempDir(), 'godmode.sqlite');
    const held = acquireLock({ databasePath: db, role: 'server' });
    held.release();
    expect(() => held.release()).not.toThrow();
  });

  it('release leaves alone a lock that was broken and retaken at the same pathname', () => {
    // Same content, different file: an in-place overwrite keeps the inode, so the nonce catches
    // it, and a break-and-retake changes the inode, so the inode catches that. Neither check is
    // an atomic conditional unlink — POSIX has none — and `server/lock.ts` says so rather than
    // claiming release is race-free.
    const db = join(tempDir(), 'godmode.sqlite');
    const held = acquireLock({ databasePath: db, role: 'server' });
    rmSync(held.path);
    const other = acquireLock({ databasePath: db, role: 'import' });

    held.release();

    expect(existsSync(held.path)).toBe(true);
    expect(readLockRecord(held.path)?.nonce).toBe(other.record.nonce);
    other.release();
  });

  it('does not displace a lock that was taken while a stale one was being recovered', () => {
    // Codex's critical finding, reproduced at the only point it can be: between judging a stale
    // record and moving it aside. The `beforeReclaim` seam stands in for the instant in which a
    // server reclaimed the same stale lock and started using the database.
    const db = join(tempDir(), 'godmode.sqlite');
    writeFileSync(lockPathFor(db), JSON.stringify(record({ pid: 999_999, host: hostname() })));

    let live: ReturnType<typeof acquireLock> | undefined;
    let caught: unknown;
    try {
      acquireLock({
        databasePath: db,
        role: 'import',
        reclaimStale: true,
        facts: facts({ host: hostname(), isRunning: (pid) => pid !== 999_999 }),
        beforeReclaim: () => {
          // Somebody else recovers it first and is now genuinely holding the database.
          rmSync(lockPathFor(db));
          live = acquireLock({ databasePath: db, role: 'server' });
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LockUnavailableError);
    expect((caught as LockUnavailableError).message).toContain('while this one was recovering');
    // And the live holder still holds it, at the same pathname, unharmed.
    expect(live).toBeDefined();
    expect(existsSync(lockPathFor(db))).toBe(true);
    expect(() => (live as ReturnType<typeof acquireLock>).assertStillHeld()).not.toThrow();
    (live as ReturnType<typeof acquireLock>).release();
  });
});

// ── A real second process ───────────────────────────────────────────────────────────────────

/**
 * A child that does exactly what the server does: take the lock, open the database, sit there.
 *
 * It imports `server/lock.ts` by absolute path so the contract under test is the real module and
 * not a re-implementation. Node's type stripping loads a `.ts` file directly; the `./x.js`
 * specifiers everywhere else in `server/` are why this cannot simply import `db.ts`, and why the
 * connection here is opened with plain `node:sqlite` instead.
 */
const CHILD_SOURCE = `
import { DatabaseSync } from 'node:sqlite';

const [modulePath, databasePath] = process.argv.slice(2);
const { acquireLock } = await import(modulePath);

const held = acquireLock({ databasePath, role: 'server' });
const db = new DatabaseSync(databasePath);
// One real read, so the connection is genuinely attached to the file — and then nothing at all.
// An idle connection is the whole point: it leaves no -wal, -shm or -journal behind, which is
// precisely why the sidecar check could never have seen it.
db.prepare('SELECT COUNT(*) AS n FROM workouts').get();

process.on('SIGTERM', () => {
  db.close();
  held.release();
  process.exit(0);
});

process.stdout.write('ready\\n');
setInterval(() => {}, 1 << 30);
`;

async function once(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => child.once('exit', () => done()));
}

/** Start the holder and wait until it says it has both the lock and the connection. */
async function startHolder(dir: string, databasePath: string): Promise<ChildProcess> {
  const scriptPath = join(dir, 'holder.mjs');
  writeFileSync(scriptPath, CHILD_SOURCE);
  const child = spawn(
    process.execPath,
    [scriptPath, pathToFileURL(join(HERE, 'lock.ts')).href, databasePath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);

  const errors: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk.toString()));

  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      fail(new Error(`the holder never became ready. stderr:\n${errors.join('')}`));
    }, 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) {
        clearTimeout(timer);
        done();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`the holder exited with ${String(code)}. stderr:\n${errors.join('')}`));
    });
  });
  return child;
}

function seeded(dir: string): { target: string; grown: ReturnType<typeof clone> } {
  const target = join(dir, 'godmode.sqlite');
  importBackup({ backup: clone(MAXIMAL_BACKUP), targetPath: target });
  const grown = clone(MAXIMAL_BACKUP);
  grown.workouts = [
    ...grown.workouts,
    {
      id: 'wo_new',
      challengeId: 'ch_1',
      chainId: 'ch_1',
      attemptNo: 1,
      performedAt: '2026-06-01T09:00:00',
      sets: [{ index: 1, actual: 10 }],
      actualTotal: 10,
      adjustmentType: 'none',
      outcome: 'failed',
    } as WorkoutRecord,
  ];
  return { target, grown };
}

describe('a second process holding the database (Codex finding 1)', () => {
  it('leaves no sidecar at all — the hole the old check could not see', async () => {
    const dir = tempDir();
    const { target } = seeded(dir);
    await startHolder(dir, target);

    // This is the premise of the whole finding, asserted rather than asserted-about: a live
    // connection with no `-wal`, `-shm` or `-journal` beside it. Under the old code the importer
    // would have sailed straight past this and renamed a new file over an open database.
    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
    expect(existsSync(`${target}-journal`)).toBe(false);
    expect(existsSync(lockPathFor(target))).toBe(true);
    expect(readLockRecord(lockPathFor(target))?.role).toBe('server');
  });

  it('refuses the import and leaves the database byte-identical', async () => {
    const dir = tempDir();
    const { target, grown } = seeded(dir);
    const before = hash(target);
    const holder = await startHolder(dir, target);

    let caught: unknown;
    try {
      importBackup({ backup: grown, targetPath: target });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationError);
    const error = caught as MigrationError;
    expect(error.stage).toBe('target');
    expect(error.message).toContain('locked by the GodMode server');
    expect(error.message).toContain(String(holder.pid));
    expect(error.message).toContain('Stop the server');
    expect(error.message).toContain('Nothing has been written.');

    expect(hash(target)).toBe(before);
    // And nothing was built, either: no working directory, no safety copy, no half-written file.
    expect(existsSync(`${target}.pre-import-`)).toBe(false);
  });

  it('refuses a dry run too, rather than rehearsing against a moving target', async () => {
    const dir = tempDir();
    const { target, grown } = seeded(dir);
    const before = hash(target);
    await startHolder(dir, target);

    expect(() => importBackup({ backup: grown, targetPath: target, dryRun: true })).toThrow(
      /locked by the GodMode server/,
    );
    expect(hash(target)).toBe(before);
  });

  it('--break-stale-lock is useless against a live holder', async () => {
    const dir = tempDir();
    const { target, grown } = seeded(dir);
    const before = hash(target);
    await startHolder(dir, target);

    expect(() =>
      importBackup({ backup: grown, targetPath: target, breakStaleLock: true }),
    ).toThrow(/locked by the GodMode server/);
    expect(hash(target)).toBe(before);
  });

  it('imports normally once that process has shut down cleanly', async () => {
    const dir = tempDir();
    const { target, grown } = seeded(dir);
    const before = hash(target);
    const holder = await startHolder(dir, target);

    holder.kill('SIGTERM');
    await once(holder);
    expect(existsSync(lockPathFor(target))).toBe(false);

    const report = importBackup({ backup: grown, targetPath: target });
    expect(report.insertedTotal).toBe(1);
    expect(hash(target)).not.toBe(before);
  });

  it('a lock left by a killed process is refused, then breakable on purpose', async () => {
    const dir = tempDir();
    const { target, grown } = seeded(dir);
    const before = hash(target);
    const holder = await startHolder(dir, target);

    // SIGKILL: no handler runs, so the lock file survives its holder. This is the case a lock file
    // has to be able to recover from, and the only one `--break-stale-lock` is for.
    holder.kill('SIGKILL');
    await once(holder);
    expect(existsSync(lockPathFor(target))).toBe(true);

    let caught: unknown;
    try {
      importBackup({ backup: grown, targetPath: target });
    } catch (error) {
      caught = error;
    }
    expect((caught as MigrationError).message).toMatch(/no process with id \d+ is running/);
    expect((caught as MigrationError).message).toContain('--break-stale-lock');
    expect(hash(target)).toBe(before);

    const report = importBackup({ backup: grown, targetPath: target, breakStaleLock: true });
    expect(report.insertedTotal).toBe(1);
    expect(existsSync(lockPathFor(target))).toBe(false);
  });
});
