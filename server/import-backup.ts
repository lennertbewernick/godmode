/**
 * `npm run import-backup -- <backup.json> --target <file.sqlite>`
 *
 * (which is `npm run build:server` followed by `node dist-server/server/import-backup.js` — Node's
 * type stripping does not rewrite a `./migrate.js` specifier to the `./migrate.ts` beside it, so
 * `server/` is compiled, exactly as the server itself is)
 *
 * The command the owner actually runs. Everything it does lives in `server/migrate.ts`; this file
 * is argument parsing, a plain-language report, and an exit code — deliberately thin, so that the
 * part which touches the only copy of the data is the part that is unit-tested.
 *
 * Two decisions worth knowing before you run it:
 *
 * - **`--target` is explicit.** No platform default is guessed here. Resolving the data directory
 *   (`GODMODE_DATA_DIR`, else a platform default, else refuse) belongs to the server's own
 *   `db.ts`; duplicating that logic in two places is how the two end up disagreeing about where
 *   the database lives. `GODMODE_DATA_DIR` is honoured as a convenience, and nothing else is.
 *
 * - **Nothing is deleted, ever.** An existing target is copied to
 *   `<target>.pre-import-<timestamp>.sqlite` before the new file is renamed into place, and that
 *   copy stays. The backup JSON stays. The browser's IndexedDB stays — no code in this work calls
 *   `indexedDB.deleteDatabase`.
 *
 * Run it with `--dry-run` first. That builds the whole database and runs every verification check
 * against it, then throws the file away without touching the target: a full rehearsal, including
 * the parts that can fail.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ImportConflictError, MigrationError, describeReport, importBackup } from './migrate.js';
import { BackupValidationError } from './validate.js';
import { VerificationFailure } from './verify.js';

const USAGE = `Usage:
  npm run import-backup -- <backup.json> --target <database.sqlite> [options]

  (that is \`npm run build:server\` followed by
   \`node dist-server/server/import-backup.js <backup.json> --target <database.sqlite>\`)

Options:
  --target <path>            Where the SQLite database is, or should be created.
                             Defaults to $GODMODE_DATA_DIR/godmode.sqlite when that is set.
  --dry-run                  Build and fully verify a database, report, then discard it.
                             The target is not touched. Do this first.
  --allow-dangling-chain-head
                             Accept a chainId naming a challenge that is not in the data.
                             Legitimate after a partial restore; suspicious otherwise.
  --allow-total-mismatch     Accept a workout total that is not the sum of its sets, or a plan
                             slot total that is not the sum of its targets.
  -h, --help                 This.

What it does:
  1. Reads and strictly validates the backup — every field of every record.
  2. Builds a NEW database in a temporary file next to the target. Never in place.
  3. Verifies it: SQLite's own integrity and foreign-key pragmas, per-table counts and id sets
     against the source, every record read back and compared, and the domain invariants.
  4. Only if every check passes, copies any existing database aside and renames the verified
     file into place.

Re-running is safe: a record that is already there and identical is a no-op, and a record that is
already there with different content aborts the whole import and names it.

STOP THE SERVER FIRST. This refuses to run if SQLite left a -wal, -shm or -journal file beside
the target, and it takes a lock that stops a second importer — but an idle connection leaves no
trace, so nothing here can prove the server is stopped. Renaming a database out from under an
open connection loses whatever that connection writes next.`;

export interface CliArguments {
  readonly backupPath: string;
  readonly targetPath: string;
  readonly dryRun: boolean;
  readonly allowDanglingChainHead: boolean;
  readonly allowTotalMismatch: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Parse argv. Exported so the parsing is tested rather than exercised only by hand. */
export function parseArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): CliArguments {
  let backupPath: string | undefined;
  let target: string | undefined;
  let dryRun = false;
  let allowDanglingChainHead = false;
  let allowTotalMismatch = false;

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i] as string;
    switch (argument) {
      case '--target': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('--target needs a path.');
        }
        target = value;
        i += 1;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--allow-dangling-chain-head':
        allowDanglingChainHead = true;
        break;
      case '--allow-total-mismatch':
        allowTotalMismatch = true;
        break;
      default: {
        if (argument.startsWith('-')) throw new UsageError(`Unknown option "${argument}".`);
        if (backupPath !== undefined) {
          throw new UsageError(`Only one backup file at a time; got "${argument}" as well.`);
        }
        backupPath = argument;
      }
    }
  }

  if (backupPath === undefined) throw new UsageError('Which backup file? Give me a path.');

  const dataDir = env['GODMODE_DATA_DIR'];
  const resolvedTarget =
    target ?? (dataDir === undefined || dataDir === '' ? undefined : join(dataDir, 'godmode.sqlite'));
  if (resolvedTarget === undefined) {
    throw new UsageError(
      'Where should the database go? Pass --target <path>, or set GODMODE_DATA_DIR. ' +
        'It must not be inside the repository — `git clean -xdf` deletes ignored files.',
    );
  }

  return {
    backupPath: isAbsolute(backupPath) ? backupPath : resolve(backupPath),
    targetPath: isAbsolute(resolvedTarget) ? resolvedTarget : resolve(resolvedTarget),
    dryRun,
    allowDanglingChainHead,
    allowTotalMismatch,
  };
}

/**
 * Read, import, report. Returns a process exit code rather than calling `process.exit`, so the
 * whole command is callable from a test.
 */
export function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    out(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  let args: CliArguments;
  try {
    args = parseArguments(argv, env);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err('');
    err(USAGE);
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.backupPath, 'utf8'));
  } catch (error) {
    err(`Could not read ${args.backupPath}: ${error instanceof Error ? error.message : String(error)}`);
    err('Nothing has been changed.');
    return 2;
  }

  try {
    const report = importBackup({
      backup: parsed,
      targetPath: args.targetPath,
      dryRun: args.dryRun,
      allowDanglingChainHead: args.allowDanglingChainHead,
      allowTotalMismatch: args.allowTotalMismatch,
    });
    out(describeReport(report));
    return 0;
  } catch (error) {
    if (
      error instanceof BackupValidationError ||
      error instanceof ImportConflictError ||
      error instanceof VerificationFailure ||
      error instanceof MigrationError
    ) {
      err(error.message);
      // A post-rename durability failure is the one case where the target DID change. Saying
      // "exactly as it was" there would be a lie printed over a replaced database.
      if (!(error instanceof MigrationError) || error.stage !== 'committed') {
        err('');
        err(`${args.targetPath} is exactly as it was.`);
      }
      return 1;
    }
    throw error;
  }
}

// `import.meta.main` is true only when this file is the entry point, so importing it from a test
// costs nothing.
if (import.meta.main === true) {
  const code = run(
    process.argv.slice(2),
    process.env,
    (line) => {
      process.stdout.write(`${line}\n`);
    },
    (line) => {
      process.stderr.write(`${line}\n`);
    },
  );
  process.exitCode = code;
}
