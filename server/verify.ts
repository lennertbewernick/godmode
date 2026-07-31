/**
 * Proving a migrated database, rather than trusting it.
 *
 * The first design of this step verified the migration by re-exporting from the new database and
 * diffing against the source JSON. Codex rejected that, correctly:
 *
 *   > A re-export diff cannot prove that the imported database behaves correctly: it will not
 *   > detect missing foreign-key semantics, broken uniqueness rules, wrong SQLite affinities, or
 *   > computed fields that happen to serialize identically.
 *
 * An empty diff proves the encoder and the decoder agree with each other. That is symmetry, not
 * preservation. Two encoders that both drop `note` produce an empty diff and a database with no
 * notes in it.
 *
 * So every check here interrogates the *database*, and each one can fail the migration on its own:
 *
 *   1. `PRAGMA integrity_check`         — the file is not corrupt.
 *   2. `PRAGMA foreign_key_check`       — every declared reference actually resolves in SQL.
 *   3. meta                             — exactly one row, this build's schema version, the
 *                                         expected dataset revision.
 *   4. counts                           — per table, against the source.
 *   5. id sets                          — per table, against the source. A count alone survives a
 *                                         swapped id; a set does not.
 *   6. records                          — every record read back through `rows.ts` decode and
 *                                         compared canonically against the source record. This is
 *                                         the check that sees a coerced number or a dropped field.
 *   7. columns                          — every physical column holds the source property it is
 *                                         supposed to hold, checked WITHOUT going through
 *                                         `rows.ts`. See `COLUMN_ORACLE`.
 *   8. duplicate primary keys           — asserted in SQL rather than assumed from the DDL.
 *   9. references                       — resolved in JavaScript over the decoded records,
 *                                         including `chainId`, which has no foreign key.
 *  10. attempt uniqueness               — one attempt number per linked slot.
 *  11. slot/challenge coherence         — a workout's slot belongs to the workout's challenge.
 *  12. totals                           — `actualTotal` is the sum of the sets; `targetTotal` is
 *                                         the sum of the targets.
 *  13. settings                         — exactly zero or one row, and it is the expected one.
 *
 * Checks 1–2 are SQL's own opinion of the file. Checks 4–6 are the source's opinion. Checks 8–13
 * are the domain's.
 *
 * Check 7 is the one that answers the hardest form of the objection. Checks 4–6 all speak through
 * `rows.ts` and `fields.ts`, so an encoder and a decoder that are wrong in *the same way* agree
 * with each other and pass — the round trip is symmetric, and symmetry is not meaning. Check 7
 * states the record-to-column mapping a second time, independently, and reads the columns with
 * SQL that never touches `rows.ts`.
 *
 * Nothing here writes. Every failure is collected — being told about one bad row at a time,
 * across 29 sessions, is how a migration turns into an afternoon.
 */

import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, isPlainObject } from './canonical.js';
import { COLLECTIONS, idOf, recordsOf, type CollectionKey, type Dataset } from './dataset.js';
import { TENANT_COLUMN } from './rows.js';
import { SCHEMA_VERSION } from './schema.js';

export interface VerificationIssue {
  /** Which check found it. */
  readonly check: string;
  readonly path: string;
  readonly message: string;
}

export class VerificationFailure extends Error {
  readonly issues: readonly VerificationIssue[];

  constructor(issues: readonly VerificationIssue[]) {
    const shown = issues.slice(0, 30).map((i) => `  [${i.check}] ${i.path}: ${i.message}`);
    const more =
      issues.length > shown.length ? `\n  … and ${issues.length - shown.length} more` : '';
    super(
      `The migrated database failed verification: ${issues.length} problem` +
        `${issues.length === 1 ? '' : 's'} found. It was discarded and nothing was replaced.\n` +
        `${shown.join('\n')}${more}`,
    );
    this.name = 'VerificationFailure';
    this.issues = issues;
  }
}

export interface ExpectedState {
  readonly dataset: Dataset;
  readonly revision: number;
  /**
   * The user the built file's records belong to. The import machinery builds a single-user file
   * (a backup, or a v1 upgrade, is one person's history), so every per-user row carries this id
   * and the revision is checked against this user's `user_revisions` row.
   */
  readonly userId: string;
}

export interface VerifyOptions {
  /**
   * Accept a `chainId` that names a challenge which is not present.
   *
   * `chain_id` deliberately has no foreign key (`server/PERSISTENCE.md` §9): a partial restore or
   * a merge can legitimately leave a chain's head absent, and the app renders such a chain
   * perfectly well. It is still checked by default, because on the owner's real data every chain
   * id resolves and a dangling one is far more likely to be an import defect than an intention.
   */
  readonly allowDanglingChainHead?: boolean;
  /**
   * Accept a `actualTotal` or `targetTotal` that is not the sum of what it is made of.
   *
   * Off by default; it holds on all 29 real sessions and all 36 real slots, and in every write
   * path the app has. The escape exists because refusing to migrate irreplaceable history over an
   * arithmetic disagreement would be the worse failure — see `checkTotals` below.
   */
  readonly allowTotalMismatch?: boolean;
}

class Issues {
  private readonly items: VerificationIssue[] = [];

  add(check: string, path: string, message: string): void {
    this.items.push({ check, path, message });
  }

  get length(): number {
    return this.items.length;
  }

  get all(): readonly VerificationIssue[] {
    return this.items;
  }
}

/**
 * Run one check, turning a thrown error into an issue.
 *
 * A sufficiently damaged file makes SQLite raise rather than answer — `PRAGMA integrity_check` on
 * a database whose pages have been zeroed throws `database disk image is malformed` instead of
 * returning a row saying so. Letting that escape would abort verification at the first check and
 * hide everything the later ones would have found, and would report a corrupt file as an
 * unexpected crash rather than as a failed migration.
 */
function guard(check: string, issues: Issues, body: () => void): void {
  try {
    body();
  } catch (error) {
    issues.add(check, '$', error instanceof Error ? error.message : String(error));
  }
}

const CHECK_NAMES = [
  'integrity_check',
  'foreign_key_check',
  'meta',
  'row counts',
  'id sets',
  'record-by-record canonical equality',
  'columns physically hold what the record says',
  'duplicate primary keys',
  'references resolve',
  'attempt-number uniqueness',
  'slot belongs to the workout’s challenge',
  'totals equal the sum of their parts',
  'settings is a single expected row',
] as const;

/**
 * Run every check. Returns the names of the checks that ran, so a caller can report *what* was
 * proven rather than merely that something was. Throws `VerificationFailure` if any check failed.
 */
export function verifyDatabase(
  db: DatabaseSync,
  expected: ExpectedState,
  options: VerifyOptions = {},
): readonly string[] {
  const issues = new Issues();

  guard('integrity_check', issues, () => { checkIntegrity(db, issues); });
  guard('foreign_key_check', issues, () => { checkForeignKeys(db, issues); });
  guard('meta', issues, () => { checkMeta(db, expected, issues); });

  const actual = decodeAll(db, issues);
  checkCounts(actual, expected.dataset, issues);
  checkIdSets(actual, expected.dataset, issues);
  checkRecords(actual, expected.dataset, issues);
  guard('columns physically hold what the record says', issues, () => {
    checkColumns(db, expected.dataset, issues);
  });
  guard('duplicate primary keys', issues, () => { checkDuplicatePrimaryKeys(db, issues); });
  checkReferences(actual, issues, options.allowDanglingChainHead === true);
  checkAttemptUniqueness(actual, issues);
  checkSlotCoherence(actual, issues);
  checkTotals(actual, issues, options.allowTotalMismatch === true);
  guard('settings is a single expected row', issues, () => {
    checkSettings(db, actual, expected.dataset, issues);
  });

  if (issues.length > 0) throw new VerificationFailure(issues.all);
  return CHECK_NAMES;
}

// ── 1. integrity_check ──────────────────────────────────────────────────────────────────────

function checkIntegrity(db: DatabaseSync, issues: Issues): void {
  const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check?: unknown }[];
  const results = rows.map((row) => String(row.integrity_check));
  if (results.length !== 1 || results[0] !== 'ok') {
    for (const line of results) {
      issues.add('integrity_check', '$', line);
    }
    if (results.length === 0) {
      issues.add('integrity_check', '$', 'PRAGMA integrity_check returned nothing at all');
    }
  }
}

// ── 2. foreign_key_check ────────────────────────────────────────────────────────────────────

function checkForeignKeys(db: DatabaseSync, issues: Issues): void {
  const rows = db.prepare('PRAGMA foreign_key_check').all() as {
    table?: unknown;
    rowid?: unknown;
    parent?: unknown;
    fkid?: unknown;
  }[];
  for (const row of rows) {
    issues.add(
      'foreign_key_check',
      `${String(row.table)}#${String(row.rowid)}`,
      `references a missing row in ${String(row.parent)} (foreign key ${String(row.fkid)})`,
    );
  }
}

// ── 3. meta ─────────────────────────────────────────────────────────────────────────────────

function checkMeta(db: DatabaseSync, expected: ExpectedState, issues: Issues): void {
  const rows = db.prepare('SELECT * FROM meta').all() as Record<string, unknown>[];
  if (rows.length !== 1) {
    issues.add('meta', 'meta', `expected exactly one row, found ${String(rows.length)}`);
    return;
  }
  const row = rows[0] as Record<string, unknown>;
  if (row['schema_version'] !== SCHEMA_VERSION) {
    issues.add(
      'meta',
      'meta.schema_version',
      `expected ${String(SCHEMA_VERSION)}, found ${String(row['schema_version'])}`,
    );
  }
  // The revision is per-user in v2 (`user_revisions`), not on `meta`.
  const revisionRow = db
    .prepare(`SELECT revision FROM user_revisions WHERE ${TENANT_COLUMN} = ?`)
    .get(expected.userId) as { revision?: unknown } | undefined;
  if (revisionRow === undefined) {
    issues.add('meta', 'user_revisions', `no revision row for user "${expected.userId}"`);
  } else if (revisionRow.revision !== expected.revision) {
    issues.add(
      'meta',
      'user_revisions.revision',
      `expected ${String(expected.revision)}, found ${String(revisionRow.revision)}`,
    );
  }
}

// ── decode everything, once ─────────────────────────────────────────────────────────────────

type Decoded = Readonly<Record<CollectionKey, readonly unknown[]>>;

/**
 * Read every row back through `rows.ts` decode.
 *
 * Decoding re-validates against the field maps, so a column that has drifted — a NULL where the
 * record requires a value, a REAL where it requires a whole number, a JSON column that no longer
 * parses — is reported here as a decode failure rather than escaping into the app.
 */
function decodeAll(db: DatabaseSync, issues: Issues): Decoded {
  const check = 'record-by-record canonical equality';
  const out: Record<string, readonly unknown[]> = {};
  for (const collection of COLLECTIONS) {
    const records: unknown[] = [];
    guard(check, issues, () => {
      const rows = db.prepare(`SELECT * FROM ${collection.table}`).all() as Record<
        string,
        unknown
      >[];
      rows.forEach((row, position) => {
        try {
          records.push(collection.decode(row));
        } catch (error) {
          issues.add(
            check,
            `${collection.table}[${String(position)}]`,
            `could not be read back: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    });
    out[collection.key] = records;
  }
  return out as Decoded;
}

// ── 4. counts ───────────────────────────────────────────────────────────────────────────────

function checkCounts(actual: Decoded, expected: Dataset, issues: Issues): void {
  for (const { key } of COLLECTIONS) {
    const found = actual[key].length;
    const wanted = recordsOf(expected, key).length;
    if (found !== wanted) {
      issues.add('row counts', key, `expected ${String(wanted)} records, found ${String(found)}`);
    }
  }
}

// ── 5. id sets ──────────────────────────────────────────────────────────────────────────────

function idSet(records: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const record of records) {
    const id = idOf(record);
    if (id !== undefined) out.add(id);
  }
  return out;
}

function checkIdSets(actual: Decoded, expected: Dataset, issues: Issues): void {
  for (const { key } of COLLECTIONS) {
    const found = idSet(actual[key]);
    const wanted = idSet(recordsOf(expected, key));
    for (const id of wanted) {
      if (!found.has(id)) issues.add('id sets', `${key}.${id}`, 'is missing from the database');
    }
    for (const id of found) {
      if (!wanted.has(id)) {
        issues.add('id sets', `${key}.${id}`, 'is in the database but not in the source');
      }
    }
  }
}

// ── 6. record-by-record canonical equality ──────────────────────────────────────────────────

function checkRecords(actual: Decoded, expected: Dataset, issues: Issues): void {
  const check = 'record-by-record canonical equality';
  for (const { key } of COLLECTIONS) {
    const found = new Map<string, unknown>();
    for (const record of actual[key]) {
      const id = idOf(record);
      if (id !== undefined) found.set(id, record);
    }
    for (const source of recordsOf(expected, key)) {
      const id = idOf(source);
      if (id === undefined) continue;
      const stored = found.get(id);
      if (stored === undefined) continue; // already reported by the id-set check
      let a: string;
      let b: string;
      try {
        a = canonicalJson(source, `${key}.${id}`);
        b = canonicalJson(stored, `${key}.${id}`);
      } catch (error) {
        issues.add(check, `${key}.${id}`, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (a !== b) {
        issues.add(
          check,
          `${key}.${id}`,
          `came back different.\n    source: ${a}\n    stored: ${b}`,
        );
      }
    }
  }
}

// ── 7. columns physically hold what the record says ─────────────────────────────────────────

/**
 * The independent oracle, and the reason it exists.
 *
 * Check 6 compares a record decoded by `rows.ts` against a record validated by `validate.ts`.
 * Both go through the field maps in `fields.ts`, so a *symmetric* defect hides itself. Codex named
 * the concrete case: if `WORKOUTS.encode` put `chainId` into the `challenge_id` column while
 * `WORKOUTS.decode` made the inverse mistake, then integrity passes (both values are valid ids),
 * the foreign key on `challenge_id` resolves (both name real challenges), counts and id sets pass,
 * and decode reconstructs the original object byte for byte — so record equality passes too. The
 * database is nonetheless wrong in the way that matters: every SQL query, index and join on
 * `challenge_id` returns the wrong rows, and the app's reads go through SQL.
 *
 * So this table states the same mapping a second time, in a different form, derived from nothing.
 * It says which *source property* each *physical column* must hold, and it is read by SQL that
 * never touches `rows.ts`. Two independent statements of one mapping: a swap in either is a
 * disagreement, and a disagreement is a failed migration.
 *
 * It is deliberately exhaustive — including the JSON columns, where a swap between `sets` and
 * `targets` would be just as invisible to the round trip — and `checkColumns` refuses any column
 * that this table does not name, so the schema cannot grow past it in silence.
 *
 * The cost is a second copy of the persistence matrix. That is the point. It is the only kind of
 * check that can see a defect the encoder and the decoder agree on.
 */
type ColumnKind = 'value' | 'json' | 'bool';

interface ColumnSource {
  readonly column: string;
  /** Dotted path into the record, e.g. `baseline.evidenceId`. */
  readonly path: string;
  readonly kind?: ColumnKind;
}

const COLUMN_ORACLE: Readonly<Record<CollectionKey, readonly ColumnSource[]>> = {
  exercises: [
    { column: 'id', path: 'id' },
    { column: 'label', path: 'label' },
    { column: 'unit', path: 'unit' },
    { column: 'created_at', path: 'createdAt' },
  ],
  challenges: [
    { column: 'id', path: 'id' },
    { column: 'exercise_id', path: 'exerciseId' },
    { column: 'chain_id', path: 'chainId' },
    { column: 'previous_challenge_id', path: 'previousChallengeId' },
    { column: 'pattern_id', path: 'patternId' },
    { column: 'pattern_version', path: 'patternVersion' },
    { column: 'pattern_params', path: 'patternParams', kind: 'json' },
    { column: 'rest_policy_id', path: 'restPolicyId' },
    { column: 'rest_policy_version', path: 'restPolicyVersion' },
    { column: 'rest_policy_params', path: 'restPolicyParams', kind: 'json' },
    { column: 'evaluation_policy_id', path: 'evaluationPolicyId' },
    { column: 'evaluation_policy_version', path: 'evaluationPolicyVersion' },
    { column: 'baseline_value', path: 'baseline.value' },
    { column: 'baseline_source', path: 'baseline.source' },
    { column: 'baseline_evidence_id', path: 'baseline.evidenceId' },
    { column: 'baseline_recorded_at', path: 'baseline.recordedAt' },
    { column: 'goal_value', path: 'goalValue' },
    { column: 'status', path: 'status' },
    { column: 'started_at', path: 'startedAt' },
    { column: 'ended_at', path: 'endedAt' },
    { column: 'end_reason', path: 'endReason' },
  ],
  performanceTests: [
    { column: 'id', path: 'id' },
    { column: 'exercise_id', path: 'exerciseId' },
    { column: 'challenge_id', path: 'challengeId' },
    { column: 'performed_at', path: 'performedAt' },
    { column: 'protocol_id', path: 'protocolId' },
    { column: 'protocol_version', path: 'protocolVersion' },
    { column: 'value', path: 'value' },
    { column: 'unit', path: 'unit' },
    { column: 'note', path: 'note' },
  ],
  planSlots: [
    { column: 'id', path: 'id' },
    { column: 'challenge_id', path: 'challengeId' },
    { column: 'ordinal', path: 'ordinal' },
    { column: 'week', path: 'week' },
    { column: 'day', path: 'day' },
    { column: 'cycle_label', path: 'cycleLabel' },
    { column: 'pattern_id', path: 'patternId' },
    { column: 'pattern_version', path: 'patternVersion' },
    { column: 'generated_at', path: 'generatedAt' },
    { column: 'decision', path: 'decision', kind: 'json' },
    { column: 'pattern_metrics', path: 'patternMetrics', kind: 'json' },
    { column: 'targets', path: 'targets', kind: 'json' },
    { column: 'target_total', path: 'targetTotal' },
    { column: 'rest_seconds', path: 'restSeconds' },
    { column: 'status', path: 'status' },
    { column: 'supersedes_id', path: 'supersedesId' },
  ],
  workouts: [
    { column: 'id', path: 'id' },
    { column: 'challenge_id', path: 'challengeId' },
    { column: 'chain_id', path: 'chainId' },
    { column: 'plan_slot_id', path: 'planSlotId' },
    { column: 'attempt_no', path: 'attemptNo' },
    { column: 'performed_at', path: 'performedAt' },
    { column: 'duration_seconds', path: 'durationSeconds' },
    { column: 'sets', path: 'sets', kind: 'json' },
    { column: 'actual_total', path: 'actualTotal' },
    { column: 'adjustment_type', path: 'adjustmentType' },
    { column: 'effective_total', path: 'effectiveTotal' },
    { column: 'outcome', path: 'outcome' },
    { column: 'evaluation_satisfied', path: 'evaluation.satisfied', kind: 'bool' },
    { column: 'evaluation_advances', path: 'evaluation.advances', kind: 'bool' },
    { column: 'evaluation_reason', path: 'evaluation.reason' },
    { column: 'evaluation_measured', path: 'evaluation.measured', kind: 'json' },
    { column: 'evaluation_policy_id', path: 'evaluationPolicyId' },
    { column: 'evaluation_policy_version', path: 'evaluationPolicyVersion' },
    { column: 'kcal_value', path: 'kcal.value' },
    { column: 'kcal_source', path: 'kcal.source' },
    { column: 'kcal_estimator_version', path: 'kcal.estimatorVersion' },
    { column: 'note', path: 'note' },
    { column: 'import_source', path: 'importSource' },
  ],
  settings: [
    { column: 'bodyweight_kg', path: 'bodyweightKg' },
    { column: 'kcal_coefficient', path: 'kcalCoefficient' },
    { column: 'rest_override_seconds', path: 'restOverrideSeconds' },
    { column: 'last_backup_at', path: 'lastBackupAt' },
    { column: 'onboarded_at', path: 'onboardedAt' },
    { column: 'goal_text', path: 'goalText' },
    { column: 'selected_challenge_id', path: 'selectedChallengeId' },
  ],
};

/** What the column must literally contain, in SQLite's own terms: text, a number, or NULL. */
function expectedColumnValue(record: unknown, source: ColumnSource): string | number | null {
  const value = field(record, source.path);
  if (value === undefined || value === null) return null;
  switch (source.kind) {
    case 'json':
      return canonicalJson(value, source.path);
    case 'bool':
      return value === true ? 1 : 0;
    default:
      return value === 0 ? 0 : (value as string | number);
  }
}

function checkColumns(db: DatabaseSync, expected: Dataset, issues: Issues): void {
  const check = 'columns physically hold what the record says';

  for (const collection of COLLECTIONS) {
    const oracle = COLUMN_ORACLE[collection.key];
    const named = new Set(oracle.map((c) => c.column));

    // The oracle must name every column the table actually has. Without this, a column added to
    // the schema and to `rows.ts` but not here would be back to being checked only by the round
    // trip that cannot see a symmetric defect.
    const info = db.prepare(`PRAGMA table_info(${collection.table})`).all() as { name?: unknown }[];
    for (const { name } of info) {
      // `user_id` is the tenancy column, not a source property — the oracle deliberately omits it.
      if (typeof name === 'string' && name !== TENANT_COLUMN && !named.has(name)) {
        issues.add(check, `${collection.table}.${name}`, 'no source property is declared for it');
      }
    }

    // `settings` has no physical `id` column (v2 keys it by `user_id`), and the import machinery
    // builds a single-user file, so its one row is fetched without a key rather than by id.
    const isSettings = collection.key === 'settings';
    const statement = db.prepare(
      isSettings
        ? `SELECT * FROM ${collection.table} LIMIT 1`
        : `SELECT * FROM ${collection.table} WHERE id = ?`,
    );
    for (const record of recordsOf(expected, collection.key)) {
      const id = idOf(record);
      if (id === undefined) continue;
      const row = (isSettings ? statement.get() : statement.get(id)) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) continue; // already reported by the id-set check
      for (const source of oracle) {
        const wanted = expectedColumnValue(record, source);
        const found = row[source.column] ?? null;
        if (!Object.is(found === 0 ? 0 : found, wanted)) {
          issues.add(
            check,
            `${collection.table}.${id}.${source.column}`,
            `must hold ${source.path} = ${JSON.stringify(wanted)}, holds ${JSON.stringify(found)}`,
          );
        }
      }
    }
  }
}

// ── 8. duplicate primary keys ───────────────────────────────────────────────────────────────

/**
 * Asserted in SQL rather than inferred from the DDL.
 *
 * A `PRIMARY KEY` makes this impossible — which is the point: if it ever fires, a primary key has
 * gone missing from `schema.sql` and every id-based read in the app has become ambiguous.
 */
function checkDuplicatePrimaryKeys(db: DatabaseSync, issues: Issues): void {
  for (const collection of COLLECTIONS) {
    // `settings` has no `id` column; its primary key is `user_id`, and its single-row-per-user
    // shape is asserted by `checkSettings`. Every other table keys on `id`.
    if (collection.key === 'settings') continue;
    const rows = db
      .prepare(`SELECT id, COUNT(*) AS n FROM ${collection.table} GROUP BY id HAVING n > 1`)
      .all() as { id?: unknown; n?: unknown }[];
    for (const row of rows) {
      issues.add(
        'duplicate primary keys',
        `${collection.table}.${String(row.id)}`,
        `appears ${String(row.n)} times`,
      );
    }
  }
}

// ── 9. references ───────────────────────────────────────────────────────────────────────────

function field(record: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (isPlainObject(acc) ? acc[key] : undefined), record);
}

/**
 * Every reference in the data, resolved over the decoded records.
 *
 * This overlaps `PRAGMA foreign_key_check` on purpose for the six references that *are* foreign
 * keys — a check that agrees with SQL costs nothing and catches the day the pragma silently does
 * nothing because a connection forgot `PRAGMA foreign_keys = ON`. It also covers the three
 * references that deliberately have no foreign key, which SQL will never check for us.
 */
function checkReferences(actual: Decoded, issues: Issues, allowDanglingChainHead: boolean): void {
  const check = 'references resolve';
  const exercises = idSet(actual.exercises);
  const challenges = idSet(actual.challenges);
  const tests = idSet(actual.performanceTests);
  const slots = idSet(actual.planSlots);

  const references: {
    from: CollectionKey;
    path: string;
    to: string;
    ids: ReadonlySet<string>;
    optional?: boolean;
  }[] = [
    { from: 'challenges', path: 'exerciseId', to: 'exercises', ids: exercises },
    { from: 'challenges', path: 'previousChallengeId', to: 'challenges', ids: challenges },
    { from: 'challenges', path: 'baseline.evidenceId', to: 'performanceTests', ids: tests },
    { from: 'performanceTests', path: 'exerciseId', to: 'exercises', ids: exercises },
    { from: 'performanceTests', path: 'challengeId', to: 'challenges', ids: challenges },
    { from: 'planSlots', path: 'challengeId', to: 'challenges', ids: challenges },
    { from: 'planSlots', path: 'supersedesId', to: 'planSlots', ids: slots },
    { from: 'workouts', path: 'challengeId', to: 'challenges', ids: challenges },
    { from: 'workouts', path: 'planSlotId', to: 'planSlots', ids: slots },
  ];

  if (!allowDanglingChainHead) {
    references.push(
      { from: 'challenges', path: 'chainId', to: 'challenges', ids: challenges },
      { from: 'workouts', path: 'chainId', to: 'challenges', ids: challenges },
    );
  }

  for (const reference of references) {
    for (const record of actual[reference.from]) {
      const target = field(record, reference.path);
      if (target === undefined) continue;
      if (typeof target !== 'string' || !reference.ids.has(target)) {
        issues.add(
          check,
          `${reference.from}.${String(idOf(record))}.${reference.path}`,
          `points at ${JSON.stringify(target)}, which is not in ${reference.to}`,
        );
      }
    }
  }
}

// ── 10. attempt-number uniqueness ────────────────────────────────────────────────────────────

/**
 * One attempt number per linked slot.
 *
 * `idx_workouts_slot_attempt` enforces it in SQL, but only `WHERE plan_slot_id IS NOT NULL` —
 * imported sessions that could not be reconciled to a slot all carry attempt 1 and must stay
 * allowed (`server/schema.sql:257-267`). This states the same rule so a broken index would be
 * visible rather than merely absent.
 */
function checkAttemptUniqueness(actual: Decoded, issues: Issues): void {
  const seen = new Set<string>();
  for (const workout of actual.workouts) {
    const slotId = field(workout, 'planSlotId');
    const attemptNo = field(workout, 'attemptNo');
    if (typeof slotId !== 'string' || typeof attemptNo !== 'number') continue;
    const key = `${slotId}#${String(attemptNo)}`;
    if (seen.has(key)) {
      issues.add(
        'attempt-number uniqueness',
        `workouts.${String(idOf(workout))}`,
        `slot "${slotId}" already has an attempt ${String(attemptNo)}`,
      );
    }
    seen.add(key);
  }
}

// ── 11. slot/challenge coherence ────────────────────────────────────────────────────────────

/** A workout linked to a slot from a different challenge — a broken link every FK would accept. */
function checkSlotCoherence(actual: Decoded, issues: Issues): void {
  const slotChallenge = new Map<string, unknown>();
  for (const slot of actual.planSlots) {
    const id = idOf(slot);
    if (id !== undefined) slotChallenge.set(id, field(slot, 'challengeId'));
  }
  for (const workout of actual.workouts) {
    const slotId = field(workout, 'planSlotId');
    if (typeof slotId !== 'string' || !slotChallenge.has(slotId)) continue;
    if (slotChallenge.get(slotId) !== field(workout, 'challengeId')) {
      issues.add(
        'slot belongs to the workout’s challenge',
        `workouts.${String(idOf(workout))}.planSlotId`,
        `slot "${slotId}" belongs to challenge ${JSON.stringify(slotChallenge.get(slotId))}, ` +
          `not ${JSON.stringify(field(workout, 'challengeId'))}`,
      );
    }
  }
}

// ── 12. totals ──────────────────────────────────────────────────────────────────────────────

function sumOf(list: unknown, key: string): number | undefined {
  if (!Array.isArray(list)) return undefined;
  let total = 0;
  for (const item of list) {
    const value = field(item, key);
    if (typeof value !== 'number') return undefined;
    total += value;
  }
  return total;
}

/**
 * The two computed fields, checked against what they are computed from.
 *
 * Both hold in every write path the app has, and both hold across the owner's real export — 29
 * workouts and 36 slots, checked. They are the fields a lossy JSON round trip would most plausibly
 * break without changing anything else: drop a set from `sets` and the total no longer matches,
 * where an id-set comparison would still pass.
 *
 * `actualTotal` is the sum of `sets[].actual` at `Runner.tsx:310`, at `App.tsx:513-515` (a manual
 * advance logs zeros for every set and a zero total) and at `pipeline.ts:389,411` — the import
 * stores `computedTotal`, the sum of the parsed sets, and merely *warns* when the incumbent file's
 * own stated total disagrees. There is no path in this codebase that stores a total it did not
 * compute. `targetTotal` is the sum of `targets[].reps` at `percentageRamp.ts:183` — the only
 * pattern that exists.
 *
 * `PERSISTENCE.md` §6 previously said the opposite about `actualTotal` — that it is "a recorded
 * fact from the source export's own total column". That was wrong about the code, and the line has
 * been corrected. Codex was right to flag the contradiction: a verifier and the document it is
 * supposed to implement must not disagree about what the data means.
 *
 * Still, this is the check most likely to refuse legitimate history one day — a future pattern
 * whose prescribed total is not the sum of its sets, or an import that decides to keep a
 * disagreeing source total. Refusing to migrate irreplaceable history over an arithmetic
 * disagreement would be the worse failure, so `allowTotalMismatch` exists and the CLI exposes it
 * as `--allow-total-mismatch`. Fail closed, with a named door.
 */
function checkTotals(actual: Decoded, issues: Issues, allowMismatch: boolean): void {
  if (allowMismatch) return;
  const check = 'totals equal the sum of their parts';
  for (const workout of actual.workouts) {
    const stated = field(workout, 'actualTotal');
    const summed = sumOf(field(workout, 'sets'), 'actual');
    if (typeof stated !== 'number' || summed === undefined) continue;
    if (stated !== summed) {
      issues.add(
        check,
        `workouts.${String(idOf(workout))}.actualTotal`,
        `says ${String(stated)} but its sets add up to ${String(summed)}`,
      );
    }
  }
  for (const slot of actual.planSlots) {
    const stated = field(slot, 'targetTotal');
    const summed = sumOf(field(slot, 'targets'), 'reps');
    if (typeof stated !== 'number' || summed === undefined) continue;
    if (stated !== summed) {
      issues.add(
        check,
        `planSlots.${String(idOf(slot))}.targetTotal`,
        `says ${String(stated)} but its targets add up to ${String(summed)}`,
      );
    }
  }
}

// ── 13. settings ────────────────────────────────────────────────────────────────────────────

function checkSettings(
  db: DatabaseSync,
  actual: Decoded,
  expected: Dataset,
  issues: Issues,
): void {
  const check = 'settings is a single expected row';
  const count = (db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n?: unknown }).n;
  if (typeof count !== 'number' || count > 1) {
    issues.add('settings is a single expected row', 'settings', `found ${String(count)} rows`);
  }
  const stored = actual.settings[0];
  const wanted = expected.settings;
  if (wanted === undefined && stored !== undefined) {
    issues.add(check, 'settings', 'the database has a settings row the source does not');
  }
  if (wanted !== undefined && stored === undefined) {
    issues.add(check, 'settings', 'the source has a settings row the database does not');
  }
}
