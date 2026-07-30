/**
 * Exclusive ownership of the database file — a contract with two sides.
 *
 * The importer replaces the database by building a temporary file and renaming it into place. On
 * POSIX a `rename` over an open file *succeeds*: the process that still has the old file open keeps
 * using the old inode, everything else sees the new one, and every write that old connection makes
 * afterwards lands in a file with no name that nobody will ever read again. Months of training,
 * gone quietly.
 *
 * `server/migrate.ts` used to guard against that by checking for `-wal`/`-shm`/`-journal`
 * sidecars, and said plainly that this proves nothing: an *idle* SQLite connection leaves no
 * sidecar at all. Codex judged that insufficient and was right. This module is the other half.
 *
 *   The server takes this lock before it opens the database and holds it for its whole lifetime.
 *   The importer takes this lock before it reads anything and holds it through the rename.
 *
 * Neither can take the lock while the other holds it, and the importer re-confirms it still holds
 * the same lock *object* immediately before the rename. That is the guarantee, and its strength is
 * exactly the strength of both sides honouring it — see "Where this does not hold" below.
 *
 * ## Why a lock *file* and not `flock`
 *
 * There is no advisory-locking call in Node's standard library. `node:fs` exposes no `flock`, no
 * `fcntl`, and `fs.constants` on this platform has no `O_EXLOCK` either (BSD/macOS have the flag;
 * Linux does not, so it could never have been the portable answer). Reaching `flock` would mean a
 * native addon, and this project takes no new runtime dependencies. So the choice was never
 * "lock file vs. flock" — it was "lock file or nothing".
 *
 * That is a happy accident, because POSIX `fcntl` record locks carry a genuinely dangerous rule:
 * they are released when *any* file descriptor for that file is closed **anywhere in the process**,
 * even one this module never handed out. A single `readFileSync` of the lock file somewhere else in
 * the codebase would silently drop the lock while the server kept running. `flock(2)` does not have
 * that flaw, but is not POSIX and is not reachable from here anyway.
 *
 * A lock file has its own well-known flaw — it does not disappear when the holder dies — so the
 * file records enough to *judge* whether its holder is still alive (`judgeLock`), and a stale one
 * can be broken deliberately rather than by habit.
 *
 * ## Staleness, and why the rules lean the way they do
 *
 * The record carries the pid, the hostname, the pid namespace, and the host's boot time. A pid
 * number only means something inside one host *and* one pid namespace, so both must match before
 * it is probed at all:
 *
 * - hostname differs           → **unknowable**. A pid on another machine cannot be probed here.
 * - pid namespace differs      → **unknowable**. Two containers on one bind mount can be given the
 *   same hostname; `process.kill` from one reports the other's live server as gone. Codex found
 *   this and it is a data-loss shape, not a nuisance.
 * - the file will not parse    → **unknowable**. Refuse loudly rather than guess. The parser is
 *   deliberately strict for this reason: loose parsing produces judgements, and judgements break
 *   locks.
 * - pid not running            → **stale**. Conclusive: the recorded process is gone.
 * - pid running, boot matches  → **live**. Refuse.
 * - pid running, boot differs  → **unknowable**. The host rebooted and something else now holds
 *   that pid number. A human decides.
 *
 * Boot time is only ever used to *weaken* a verdict, never to strengthen one, because it is
 * derived from `Date.now() - os.uptime()` and a wall-clock step would move it. A dead pid alone
 * decides staleness; a live pid with a mismatched boot decides nothing.
 *
 * ## Breaking a stale lock
 *
 * The two sides deliberately behave differently, because they are not equally dangerous.
 *
 * - **The server reclaims a provably stale lock by itself**, loudly. The alternative is a server
 *   that will not start after a power cut, which trains the owner to delete lock files by hand —
 *   the exact habit this must not create.
 * - **The importer only reclaims when the owner says so**, with `--break-stale-lock`, which is not
 *   a `--force`: `acquireLock` refuses a live holder and refuses one it cannot judge, so the flag
 *   does nothing at all against a running server. It exists for one situation, after a crash.
 *
 * Reclaiming renames the old lock aside to `<lock>.stale-<uuid>` rather than deleting it, so the
 * evidence of who held it survives. Crucially it then checks, by inode, that the file it moved is
 * the file it judged — see `reclaim`, which is where Codex's critical finding is answered — and
 * puts it back and refuses if it is not.
 *
 * ## Where this does not hold — stated rather than implied
 *
 * - **Only processes that take the lock are constrained.** `sqlite3 godmode.sqlite`, a backup tool,
 *   an editor — none of them know this file exists. The lock makes the *server* and the *importer*
 *   mutually exclusive. It is not a filesystem-level mandatory lock and cannot be one.
 * - **NFS.** `open(O_CREAT|O_EXCL)` is atomic on NFSv4 and on NFSv3 servers that implement
 *   exclusive create properly; older NFSv3 paths emulate it and can both succeed or report a
 *   spurious `EEXIST`. The read-back nonce check catches the common case of a lost race, but on
 *   such a mount it is a mitigation, not a proof. Keep the database on local storage.
 * - **Container bind-mounts.** A lock from a different pid namespace is judged *unknowable* and is
 *   never broken automatically, so a hard-killed container leaves a lock its replacement refuses.
 *   That refusal is correct and must not be papered over: deleting the lock in an entrypoint is
 *   only safe if the orchestrator guarantees the old task is gone before the new one starts, which
 *   rolling deployments and multi-replica services do *not*. This protocol assumes every
 *   participant shares one filesystem **and** one pid namespace. If yours cannot, the exclusivity
 *   has to come from outside — a single-attachment volume, or a single replica — and this lock is
 *   then a second line rather than the guarantee.
 * - **A crash between reclaim and re-create** leaves the sidelined `<lock>.stale-<uuid>` behind.
 *   Harmless: nothing reads it, and nothing deletes it either, on purpose.
 * - **`release` is not an atomic conditional unlink**, because POSIX has none. It checks the inode
 *   first, which makes "release after somebody already broke and retook this lock" a no-op instead
 *   of a deletion of a live holder's lock — a mitigation, not a proof.
 * - **A third acquirer inside the reclaim-and-restore window** (see `reclaim`) can take a lock that
 *   is then overwritten by the restore. It finds out at `assertStillHeld`, which every destructive
 *   operation runs immediately before committing, so the outcome is a refusal rather than a loss.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname as osHostname, uptime as osUptime } from 'node:os';

/** Appended to the database path. Named, not derived, so a rename is a deliberate edit. */
export const LOCK_SUFFIX = '.lock';

export function lockPathFor(databasePath: string): string {
  return `${databasePath}${LOCK_SUFFIX}`;
}

export type LockRole = 'server' | 'import';

/** What one holder writes about itself. JSON, human-readable, one file. */
export interface LockRecord {
  readonly kind: 'godmode-database-lock';
  readonly version: 1;
  readonly role: LockRole;
  readonly pid: number;
  readonly host: string;
  /**
   * The holder's pid namespace, on kernels that have them; absent elsewhere.
   *
   * Without this, `host` is the only thing tying a pid number to a meaning — and two containers
   * sharing a bind mount can be configured with the *same* hostname while having different pid
   * namespaces. `process.kill(P, 0)` from the second one then reports ESRCH for a process that is
   * very much alive in the first, and a lock held by a running server is judged provably stale.
   * Codex found that; it is a data-loss shape, not a nuisance.
   */
  readonly pidNamespace?: string;
  /** Seconds since the epoch at which this host booted, to the nearest second. */
  readonly bootSeconds: number;
  readonly acquiredAt: string;
  /** Proves the file on disk is the one *this* holder wrote, after a reclaim or a lost race. */
  readonly nonce: string;
  readonly databasePath: string;
}

export type LockState = 'live' | 'stale' | 'unknowable';

export interface Liveness {
  readonly state: LockState;
  /** One sentence, printed to the owner. Says what was observed, not what to do about it. */
  readonly reason: string;
}

/**
 * Just enough of the machine to judge a record, so the tests never have to fake a reboot.
 */
export interface HostFacts {
  readonly host: string;
  /** `undefined` on kernels without pid namespaces — macOS and the BSDs. */
  readonly pidNamespace: string | undefined;
  readonly bootSeconds: number;
  readonly isRunning: (pid: number) => boolean;
}

/**
 * The identity of this process's pid namespace, or `undefined` where the concept does not exist.
 *
 * Linux exposes it as a symlink whose target contains the namespace inode — `pid:[4026531836]`.
 * There is no portable equivalent and none is needed: the only environments that can put two
 * different pid namespaces on one filesystem are the ones that have this file.
 */
export function pidNamespaceNow(): string | undefined {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
}

/**
 * `Date.now() - os.uptime()` — the closest portable thing to a boot id.
 *
 * Linux has `/proc/sys/kernel/random/boot_id` and macOS has `kern.boottime`; neither is reachable
 * without reading files that do not exist on the other platform. This estimate drifts with the
 * wall clock, which is exactly why `judgeLock` only ever uses it to *withhold* a verdict.
 */
export function bootSecondsNow(now: number = Date.now()): number {
  return Math.round(now / 1000 - osUptime());
}

/** Signal 0 asks "is there such a process", without sending anything. */
export function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means it exists and belongs to somebody else — that is very much running.
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function currentFacts(): HostFacts {
  return {
    host: osHostname(),
    pidNamespace: pidNamespaceNow(),
    bootSeconds: bootSecondsNow(),
    isRunning: processIsRunning,
  };
}

/**
 * How far the two boot estimates may differ before they are treated as different boots.
 *
 * `os.uptime()` has one-second granularity and is sampled at a different instant on each side, so
 * a few seconds of disagreement is normal even within one boot. Generous rather than tight: a
 * false "different boot" costs a refusal that a human has to resolve, and this number is never the
 * thing that declares a lock stale.
 */
export const BOOT_TOLERANCE_SECONDS = 30;

/**
 * Decide what a lock file's holder is: alive, provably gone, or not judgeable from here.
 *
 * `undefined` means the file exists but could not be read as a record — truncated, hand-edited,
 * written by a future version. That is *unknowable*, never stale: refusing loudly is recoverable,
 * and breaking a lock on the strength of a file we could not read is not.
 */
export function judgeLock(record: LockRecord | undefined, facts: HostFacts = currentFacts()): Liveness {
  if (record === undefined) {
    return {
      state: 'unknowable',
      reason: 'the lock file does not read as a GodMode lock record, so its holder cannot be identified',
    };
  }
  if (record.host !== facts.host) {
    return {
      state: 'unknowable',
      reason:
        `it was taken on host "${record.host}" and this is "${facts.host}", ` +
        'so that process id means nothing here',
    };
  }
  if (record.pidNamespace !== facts.pidNamespace) {
    // Same hostname, different pid namespace: two containers on one bind mount, configured alike.
    // `process.kill` would report the holder gone when it is running perfectly well next door.
    return {
      state: 'unknowable',
      reason:
        'it was taken in a different process namespace than this one, so that process id cannot ' +
        'be probed from here',
    };
  }
  if (!facts.isRunning(record.pid)) {
    return {
      state: 'stale',
      reason: `no process with id ${String(record.pid)} is running on this host`,
    };
  }
  if (Math.abs(record.bootSeconds - facts.bootSeconds) > BOOT_TOLERANCE_SECONDS) {
    return {
      state: 'unknowable',
      reason:
        `process id ${String(record.pid)} is running, but this host appears to have booted since ` +
        'the lock was taken, so that process is probably an unrelated one that reused the number',
    };
  }
  return {
    state: 'live',
    reason: `process id ${String(record.pid)} is running on this host`,
  };
}

/**
 * Parse a lock record, strictly. Anything at all wrong with it yields `undefined`.
 *
 * Strictly, because `undefined` means *unknowable* and unknowable means "refuse and ask a human" —
 * whereas a record that parses loosely gets *judged*, and a judgement is what breaks locks. Codex
 * found the concrete instance: `pid: -1` would have parsed, `processIsRunning(-1)` is false, and a
 * hand-mangled lock file would have been declared provably stale.
 */
export function parseLockRecord(text: string): LockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const c = parsed as Record<string, unknown>;

  if (c['kind'] !== 'godmode-database-lock' || c['version'] !== 1) return undefined;
  if (c['role'] !== 'server' && c['role'] !== 'import') return undefined;
  if (!Number.isSafeInteger(c['pid']) || (c['pid'] as number) <= 0) return undefined;
  if (!Number.isSafeInteger(c['bootSeconds'])) return undefined;
  if (typeof c['host'] !== 'string' || c['host'] === '') return undefined;
  if (typeof c['nonce'] !== 'string' || c['nonce'] === '') return undefined;
  if (typeof c['acquiredAt'] !== 'string' || Number.isNaN(Date.parse(c['acquiredAt']))) {
    return undefined;
  }
  if (typeof c['databasePath'] !== 'string' || c['databasePath'] === '') return undefined;
  const namespace = c['pidNamespace'];
  if (namespace !== undefined && (typeof namespace !== 'string' || namespace === '')) {
    return undefined;
  }
  return c as unknown as LockRecord;
}

/** Read the record, or `undefined` if the file is absent, unreadable, or not a lock record. */
export function readLockRecord(lockPath: string): LockRecord | undefined {
  try {
    return parseLockRecord(readFileSync(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The lock file *as an object*, not as a pathname: its record and the inode it came from.
 *
 * A pathname is not a thing, it is a name for a thing, and between judging a lock and acting on it
 * the name can come to mean something else. Codex's critical finding was exactly that shape — read
 * a stale record, and by the time the file is renamed aside, the name refers to a *live* holder's
 * brand-new lock. Carrying (dev, ino) from the read makes that detectable after the fact, which is
 * the strongest thing available without a conditional-rename syscall.
 */
interface LockObject {
  readonly record: LockRecord | undefined;
  readonly dev: number;
  readonly ino: number;
}

function inspect(lockPath: string): LockObject | undefined {
  let fd: number;
  try {
    fd = openSync(lockPath, 'r');
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    // Read through the same descriptor that was stat'ed, so the bytes and the identity are the
    // same object even if the pathname is replaced in between.
    return { record: parseLockRecord(readFileSync(fd, 'utf8')), dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function isSameObject(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export class LockUnavailableError extends Error {
  readonly lockPath: string;
  /** The holder, when the file could be read. Absent when it could not. */
  readonly holder: LockRecord | undefined;
  readonly liveness: Liveness;

  constructor(input: {
    lockPath: string;
    holder: LockRecord | undefined;
    liveness: Liveness;
    message: string;
  }) {
    super(input.message);
    this.name = 'LockUnavailableError';
    this.lockPath = input.lockPath;
    this.holder = input.holder;
    this.liveness = input.liveness;
  }
}

const ROLE_LABEL: Record<LockRole, string> = {
  server: 'the GodMode server',
  import: 'another import',
};

/**
 * What the owner reads when the lock is not available. Says who, why, and what to do — in that
 * order, and without ever suggesting the destructive option first.
 */
function refusalMessage(input: {
  lockPath: string;
  databasePath: string;
  holder: LockRecord | undefined;
  liveness: Liveness;
  wanting: LockRole;
}): string {
  const { lockPath, databasePath, holder, liveness, wanting } = input;
  const who =
    holder === undefined
      ? 'an unidentified holder'
      : `${ROLE_LABEL[holder.role]} (process ${String(holder.pid)} on ${holder.host}, since ${holder.acquiredAt})`;

  const head = `${databasePath} is locked by ${who}.`;
  const evidence = `The lock is ${lockPath}; ${liveness.reason}.`;

  const consequence =
    wanting === 'import'
      ? holder?.role === 'server'
        ? 'Renaming a new database over one that a running server still has open would leave that ' +
          'server writing into a file nothing can read again. Stop the server, then run this again.'
        : 'Two imports must not touch the same database at once.'
      : 'Two processes must not own this database at once.';

  const remedy =
    liveness.state === 'stale'
      ? wanting === 'import'
        ? 'That holder is gone. If you are certain no GodMode server and no other import is ' +
          'running, re-run with --break-stale-lock, which refuses any lock whose holder is ' +
          'still alive.'
        : 'That holder is gone; this process will not break the lock for you.'
      : liveness.state === 'unknowable'
        ? `Nothing here can tell whether that holder is still alive. Check that no GodMode server ` +
          `is running against ${databasePath}, then delete ${lockPath} by hand.`
        : '';

  return [head, evidence, consequence, remedy].filter((part) => part !== '').join('\n');
}

export interface HeldLock {
  readonly path: string;
  readonly record: LockRecord;
  /**
   * Confirm the file on disk is still the one this holder wrote.
   *
   * Called immediately before anything irreversible. If somebody broke this lock and took it while
   * the work was in progress, that is the last moment it can still be stopped for free.
   */
  assertStillHeld(): void;
  /** Remove the lock — but only if it is still ours. Idempotent. */
  release(): void;
}

export interface AcquireOptions {
  readonly databasePath: string;
  readonly role: LockRole;
  /**
   * Break a lock whose holder is *provably* gone. Never breaks a live or unjudgeable one.
   *
   * The server passes `true` (it must survive a power cut unattended); the importer passes `false`
   * unless the owner typed `--break-stale-lock`.
   */
  readonly reclaimStale?: boolean;
  /** Told about a reclaim, so it can be logged loudly rather than happening in silence. */
  readonly onReclaim?: (info: {
    readonly holder: LockRecord | undefined;
    readonly reason: string;
    readonly sidelinedTo: string;
  }) => void;
  readonly facts?: HostFacts;
  readonly now?: () => Date;
  /**
   * Test seam. Nothing in production sets it.
   *
   * Runs between judging a lock stale and moving it aside — the exact instant of the race Codex
   * named, and the only place a test can stand in for "another process reclaimed this first".
   */
  readonly beforeReclaim?: () => void;
}

/**
 * Take the lock, or throw `LockUnavailableError` explaining exactly who has it.
 *
 * `wx` is `O_CREAT | O_EXCL`: the create fails if the file exists, and that failure is the whole
 * mechanism. Mode 0600 because the record names a process on this machine.
 */
export function acquireLock(options: AcquireOptions): HeldLock {
  const { databasePath, role } = options;
  const facts = options.facts ?? currentFacts();
  const now = options.now ?? (() => new Date());
  const path = lockPathFor(databasePath);

  // Two attempts at most: the first, and one more after a reclaim. A loop that kept going would
  // turn "somebody keeps taking this lock" into a spin rather than a refusal.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record: LockRecord = {
      kind: 'godmode-database-lock',
      version: 1,
      role,
      pid: process.pid,
      host: facts.host,
      ...(facts.pidNamespace === undefined ? {} : { pidNamespace: facts.pidNamespace }),
      bootSeconds: facts.bootSeconds,
      acquiredAt: now().toISOString(),
      nonce: randomUUID(),
      databasePath,
    };

    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new LockUnavailableError({
          lockPath: path,
          holder: undefined,
          liveness: { state: 'unknowable', reason: describe(cause) },
          message:
            `The lock file ${path} could not be created (${describe(cause)}), so exclusive ` +
            `ownership of ${databasePath} could not be established. Nothing has been opened or ` +
            'written.',
        });
      }

      const existing = inspect(path);
      const holder = existing?.record;
      const liveness = judgeLock(holder, facts);
      const mayReclaim =
        liveness.state === 'stale' && options.reclaimStale === true && attempt === 0 && existing !== undefined;
      if (!mayReclaim) {
        throw new LockUnavailableError({
          lockPath: path,
          holder,
          liveness,
          message: refusalMessage({
            lockPath: path,
            databasePath,
            holder,
            liveness,
            wanting: role,
          }),
        });
      }

      options.beforeReclaim?.();
      reclaim(path, existing, options.onReclaim, liveness.reason, databasePath);
      continue;
    }

    let created: LockObject | undefined;
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      const stats = fstatSync(fd);
      created = { record, dev: stats.dev, ino: stats.ino };
    } catch (cause) {
      // The file exists but holds nothing judgeable, which would be an *unknowable* lock nobody
      // could ever recover from — a permanent refusal caused by a transient write error. Take it
      // back out, but only if the name still refers to the object this call created.
      removeIfOurs(path, fstatQuietly(fd));
      throw new LockUnavailableError({
        lockPath: path,
        holder: undefined,
        liveness: { state: 'unknowable', reason: describe(cause) },
        message:
          `The lock file ${path} could not be written (${describe(cause)}), so exclusive ` +
          `ownership of ${databasePath} could not be established. Nothing has been opened or ` +
          'written.',
      });
    } finally {
      closeSync(fd);
    }

    // Read back. On a filesystem whose exclusive create is not truly atomic — NFSv3 — this is the
    // only thing standing between two winners, and it is a mitigation rather than a proof.
    const written = inspect(path);
    if (written === undefined || !isSameObject(written, created) || written.record?.nonce !== record.nonce) {
      throw new LockUnavailableError({
        lockPath: path,
        holder: written?.record,
        liveness: judgeLock(written?.record, facts),
        message:
          `${path} was created for this process and then immediately replaced by another one, so ` +
          `exclusive ownership of ${databasePath} could not be established. Nothing has been ` +
          'opened or written.',
      });
    }
    const mine = created;

    return {
      path,
      record,
      assertStillHeld: () => {
        const current = inspect(path);
        if (current === undefined || !isSameObject(current, mine) || current.record?.nonce !== record.nonce) {
          throw new LockUnavailableError({
            lockPath: path,
            holder: current?.record,
            liveness: judgeLock(current?.record, facts),
            message:
              `${path} is no longer the lock this process took — something removed or replaced it ` +
              `while work on ${databasePath} was in progress. Stopping here rather than ` +
              'continuing without exclusive ownership.',
          });
        }
      },
      release: () => {
        removeIfOurs(path, mine);
      },
    };
  }

  // Unreachable: the loop either returns or throws on both passes. Stated so a future edit that
  // adds a third outcome fails loudly instead of falling out with `undefined`.
  throw new LockUnavailableError({
    lockPath: path,
    holder: readLockRecord(path),
    liveness: { state: 'unknowable', reason: 'the lock could not be taken after a reclaim' },
    message: `${path} could not be taken. Nothing has been opened or written.`,
  });
}

/**
 * Move a stale lock aside — and put it back, refusing, if the name meant something else by then.
 *
 * This is the answer to Codex's critical finding, and the reason `inspect` carries an inode.
 * The losing sequence he named was:
 *
 *   1. importer A reads stale lock S and judges it stale;
 *   2. server B reclaims S, creates its own live lock, opens the database;
 *   3. A renames *B's* lock aside, creates its own, and reads its own nonce back happily;
 *   4. A renames a fresh database over the one B still has open.
 *
 * A rename cannot be made conditional on the inode — POSIX has no such call and Node exposes none
 * — so this checks *afterwards* instead. `renameSync` preserves the inode, so if what landed at
 * the sideline is not the object that was judged, step 3 just displaced somebody's live lock: put
 * it straight back and refuse. The importer therefore never reaches step 4.
 *
 * What remains, stated rather than hidden: between the rename and the rename-back, that live lock
 * is briefly absent from its pathname. A third acquirer squeezing into that window would take a
 * lock that then gets overwritten by the restore — and would find out at its own
 * `assertStillHeld`, which every destructive operation runs immediately before committing. So the
 * residue of this race is a spurious refusal, never a silent loss.
 */
function reclaim(
  path: string,
  judged: LockObject,
  onReclaim: AcquireOptions['onReclaim'],
  reason: string,
  databasePath: string,
): void {
  // Sidelined, not deleted: whoever comes looking later can still see who held it and when.
  const sidelinedTo = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, sidelinedTo);
  } catch {
    // Somebody else got there first, so there is nothing of ours to undo. The retry re-reads and
    // re-judges; if they are alive now, the next pass refuses, which is the correct outcome.
    return;
  }

  const moved = inspect(sidelinedTo);
  if (moved !== undefined && !isSameObject(moved, judged)) {
    try {
      renameSync(sidelinedTo, path);
    } catch {
      // Nothing better is available. The refusal below is what matters; a lock file that is now
      // at the sideline instead of in place is recoverable by hand and is not a lost database.
    }
    throw new LockUnavailableError({
      lockPath: path,
      holder: moved.record,
      liveness: { state: 'live', reason: 'it was taken by another process during this recovery' },
      message:
        `${path} was taken by another process while this one was recovering a stale lock, so ` +
        `exclusive ownership of ${databasePath} could not be established. Nothing has been ` +
        'opened or written. Try again once that process has stopped.',
    });
  }

  onReclaim?.({ holder: judged.record, reason, sidelinedTo });
}

function fstatQuietly(fd: number): LockObject | undefined {
  try {
    const stats = fstatSync(fd);
    return { record: undefined, dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

/**
 * Unlink the lock only when the pathname still names the object this process created.
 *
 * Best effort, and worth saying out loud: POSIX has no conditional unlink, so between the `stat`
 * and the `rmSync` the name could come to mean something else. Checking the inode makes the
 * common failure — releasing after somebody already broke and retook the lock — a no-op rather
 * than a deletion of a live holder's lock. It is not a proof, and nothing here claims it is.
 */
function removeIfOurs(path: string, mine: LockObject | undefined): void {
  if (mine === undefined) return;
  // The inode catches a lock that was broken and retaken; the nonce catches one that was
  // overwritten in place, which keeps the inode and is what a careless `echo > lock` does.
  const current = mine.record === undefined ? statOnly(path) : inspect(path);
  if (current === undefined || !isSameObject(current, mine)) return;
  if (mine.record !== undefined && current.record?.nonce !== mine.record.nonce) return;
  rmSync(path, { force: true });
}

function statOnly(path: string): LockObject | undefined {
  try {
    const stats = statSync(path);
    return { record: undefined, dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
