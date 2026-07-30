// @vitest-environment node
//
// `server/db.ts` — where the file goes, and what state a connection is in when it is handed
// over. Every assertion drives a real database in a real temporary directory, because both of
// the failures this module exists to prevent are invisible to a mock: a per-connection pragma
// that was never issued, and a directory that cannot be written to.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DATABASE_FILENAME,
  DataDirError,
  DEFAULT_SETTINGS_ROW,
  bumpRevision,
  ensureDataDir,
  inWriteTransaction,
  openDatabase,
  readRevision,
  readSettings,
  resolveDataDir,
  writeSettings,
  type Host,
} from './db.js';
import { foreignKeysEnabled } from './schema.js';

const temporaries: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-db-'));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir === undefined) continue;
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already gone, or never restricted. Removal below reports anything that matters.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function host(overrides: Partial<Host> = {}): Host {
  return { env: {}, platform: 'linux', homedir: '/home/tester', ...overrides };
}

describe('resolveDataDir', () => {
  it('honours GODMODE_DATA_DIR above everything else', () => {
    const resolved = resolveDataDir(
      host({ env: { GODMODE_DATA_DIR: '/srv/godmode', XDG_DATA_HOME: '/ignored' } }),
    );
    expect(resolved).toBe('/srv/godmode');
  });

  it('resolves a relative override, so the path is never ambiguous', () => {
    const resolved = resolveDataDir(host({ env: { GODMODE_DATA_DIR: './.data' } }));
    expect(resolved.startsWith('/')).toBe(true);
    expect(resolved.endsWith('.data')).toBe(true);
  });

  it('uses Application Support on macOS', () => {
    expect(resolveDataDir(host({ platform: 'darwin', homedir: '/Users/x' }))).toBe(
      '/Users/x/Library/Application Support/godmode',
    );
  });

  it('uses XDG_DATA_HOME on linux when it is absolute', () => {
    expect(resolveDataDir(host({ env: { XDG_DATA_HOME: '/var/lib/state' } }))).toBe(
      '/var/lib/state/godmode',
    );
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset or relative', () => {
    expect(resolveDataDir(host())).toBe('/home/tester/.local/share/godmode');
    expect(resolveDataDir(host({ env: { XDG_DATA_HOME: 'relative/path' } }))).toBe(
      '/home/tester/.local/share/godmode',
    );
  });

  it('never resolves inside this repository by default', () => {
    // `git clean -xdf` deletes ignored files. The default must not be one command from gone.
    const resolved = resolveDataDir(host({ platform: 'darwin', homedir: '/Users/x' }));
    expect(resolved.includes('/godmode/server')).toBe(false);
    expect(resolved.startsWith('/Users/x/Library')).toBe(true);
  });
});

describe('ensureDataDir', () => {
  it('creates the directory on first run, including missing parents', () => {
    const nested = join(tempDir(), 'a', 'b', 'godmode');
    expect(existsSync(nested)).toBe(false);
    ensureDataDir(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('refuses a path that is a file', () => {
    const dir = tempDir();
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'x');
    expect(() => ensureDataDir(file)).toThrow(DataDirError);
  });

  it('refuses to start when the directory cannot be written to', () => {
    const dir = tempDir();
    const target = join(dir, 'readonly');
    mkdirSync(target);
    chmodSync(target, 0o500);
    temporaries.push(target);
    // Root ignores the permission bits entirely, so the assertion would be vacuous.
    if (process.getuid?.() === 0) return;
    expect(() => ensureDataDir(target)).toThrow(/not writable/);
  });
});

describe('openDatabase', () => {
  it('creates the schema on first run and reports it', () => {
    const dir = tempDir();
    const opened = openDatabase({ dataDir: dir });
    try {
      expect(opened.created).toBe(true);
      expect(opened.path).toBe(join(dir, DATABASE_FILENAME));
      expect(readRevision(opened.db)).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  it('reopens an existing database without reapplying the schema', () => {
    const dir = tempDir();
    const first = openDatabase({ dataDir: dir });
    inWriteTransaction(first.db, () => bumpRevision(first.db, '2026-07-30T12:00:00.000Z'));
    first.db.close();

    const second = openDatabase({ dataDir: dir });
    try {
      expect(second.created).toBe(false);
      expect(readRevision(second.db)).toBe(1);
    } finally {
      second.db.close();
    }
  });

  it('arms foreign keys on the connection it returns', () => {
    // SQLite defaults foreign_keys OFF and does not store the setting in the file, so a
    // connection that forgot this ignores every FOREIGN KEY in schema.sql in silence.
    const opened = openDatabase({ dataDir: tempDir() });
    try {
      expect(foreignKeysEnabled(opened.db)).toBe(true);
      expect(() =>
        opened.db
          .prepare('INSERT INTO plan_slots (id, challenge_id, ordinal, pattern_id, pattern_version, generated_at, targets, target_total, rest_seconds, status) VALUES (?, ?, 1, ?, 1, ?, ?, 0, 0, ?)')
          .run('slot_x', 'no_such_challenge', 'p', '2026-07-30T12:00:00.000Z', '[]', 'available'),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      opened.db.close();
    }
  });

  it('puts the database into WAL mode', () => {
    const opened = openDatabase({ dataDir: tempDir() });
    try {
      const row = opened.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(row.journal_mode).toBe('wal');
    } finally {
      opened.db.close();
    }
  });

  it('refuses a database whose schema version this build does not understand', () => {
    const dir = tempDir();
    const opened = openDatabase({ dataDir: dir });
    opened.db.prepare('UPDATE meta SET schema_version = 99').run();
    opened.db.close();
    expect(() => openDatabase({ dataDir: dir })).toThrow(/schema version 99/);
  });

  it('resolves the directory from the host when none is given', () => {
    const dir = tempDir();
    const opened = openDatabase({ host: host({ env: { GODMODE_DATA_DIR: dir } }) });
    try {
      expect(opened.dataDir).toBe(dir);
    } finally {
      opened.db.close();
    }
  });
});

describe('transactions', () => {
  it('rolls back everything a failing body wrote', () => {
    const opened = openDatabase({ dataDir: tempDir() });
    try {
      expect(() =>
        inWriteTransaction(opened.db, () => {
          bumpRevision(opened.db, '2026-07-30T12:00:00.000Z');
          throw new Error('halfway');
        }),
      ).toThrow('halfway');
      expect(readRevision(opened.db)).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  it('rolls back a COMMIT that fails, and leaves the connection usable', () => {
    // The failure mode this guards: `schema.sql` declares its foreign keys DEFERRABLE
    // INITIALLY DEFERRED, so a dangling reference is reported by the COMMIT, not by the INSERT
    // that made it. A COMMIT that threw outside the guard would leave this process's one shared
    // connection inside an open transaction and every later request would fail.
    const opened = openDatabase({ dataDir: tempDir() });
    try {
      expect(() =>
        inWriteTransaction(opened.db, () => {
          opened.db
            .prepare(
              'INSERT INTO challenges (id, exercise_id, chain_id, pattern_id, pattern_version, pattern_params, rest_policy_id, rest_policy_version, rest_policy_params, evaluation_policy_id, evaluation_policy_version, baseline_value, baseline_source, baseline_recorded_at, status, started_at) ' +
                "VALUES ('ch_x', 'ex_missing', 'ch_x', 'p', 1, '{}', 'r', 1, '{}', 'e', 1, 1, 'tested', '2026-07-30T12:00:00.000Z', 'active', '2026-07-30T12:00:00.000Z')",
            )
            .run();
          // The INSERT succeeded: the violation is deferred to commit time.
          bumpRevision(opened.db, '2026-07-30T12:00:00.000Z');
        }),
      ).toThrow(/FOREIGN KEY/i);

      // The connection is not poisoned, and nothing the failed transaction wrote survived.
      expect(readRevision(opened.db)).toBe(0);
      inWriteTransaction(opened.db, () => bumpRevision(opened.db, '2026-07-30T12:01:00.000Z'));
      expect(readRevision(opened.db)).toBe(1);
      const rows = opened.db.prepare('SELECT COUNT(*) AS n FROM challenges').get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  it('serialises writers across connections to the same file', () => {
    // BEGIN IMMEDIATE takes the write lock up front, so a second connection cannot slip a
    // read-check-write between another one's check and its write.
    const dir = tempDir();
    const a = openDatabase({ dataDir: dir });
    const b = openDatabase({ dataDir: dir });
    try {
      // Do not wait five seconds for the lock in a test; the point is that it is held at all.
      b.db.exec('PRAGMA busy_timeout = 50;');
      a.db.exec('BEGIN IMMEDIATE;');
      expect(() => b.db.exec('BEGIN IMMEDIATE;')).toThrow(/busy|locked/i);
      a.db.exec('ROLLBACK;');
      expect(() => inWriteTransaction(b.db, () => bumpRevision(b.db, '2026-07-30T12:00:00.000Z'))).not.toThrow();
      expect(readRevision(a.db)).toBe(1);
    } finally {
      a.db.close();
      b.db.close();
    }
  });

  it('rolls back cleanly when SQLite itself aborted the statement', () => {
    // A constraint failure ends the statement; a ROLLBACK issued afterwards must not mask the
    // real error with "cannot rollback - no transaction is active".
    const opened = openDatabase({ dataDir: tempDir() });
    try {
      expect(() =>
        inWriteTransaction(opened.db, () => {
          opened.db.prepare('INSERT INTO meta (id, schema_version, revision, created_at, updated_at) VALUES (?, 1, 0, ?, ?)')
            .run('meta', '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z');
        }),
      ).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
      expect(readRevision(opened.db)).toBe(0);
    } finally {
      opened.db.close();
    }
  });
});

describe('settings', () => {
  it('reads defaults when no row has been written yet', () => {
    const opened = openDatabase({ dataDir: tempDir() });
    try {
      expect(readSettings(opened.db)).toEqual(DEFAULT_SETTINGS_ROW);
    } finally {
      opened.db.close();
    }
  });

  it('upserts rather than replacing, and round-trips absent optionals as absent', () => {
    const opened = openDatabase({ dataDir: tempDir() });
    try {
      writeSettings(opened.db, { id: 'settings', kcalCoefficient: 0.004, bodyweightKg: 80 });
      expect(readSettings(opened.db)).toEqual({
        id: 'settings',
        kcalCoefficient: 0.004,
        bodyweightKg: 80,
      });

      writeSettings(opened.db, { id: 'settings', kcalCoefficient: 0.004 });
      const cleared = readSettings(opened.db);
      expect(cleared).toEqual({ id: 'settings', kcalCoefficient: 0.004 });
      // Absent, not `{bodyweightKg: undefined}` — an own property holding undefined is reported
      // by Object.keys and breaks structural equality against the record that was written.
      expect(Object.hasOwn(cleared, 'bodyweightKg')).toBe(false);

      const rows = opened.db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      opened.db.close();
    }
  });
});

describe('the meta row', () => {
  it('reports a database that was not created by schema.sql rather than guessing', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'empty.sqlite'));
    try {
      db.exec('CREATE TABLE meta (id TEXT PRIMARY KEY, schema_version INTEGER, revision INTEGER)');
      expect(() => readRevision(db)).toThrow(/meta row is missing/);
    } finally {
      db.close();
    }
  });
});
