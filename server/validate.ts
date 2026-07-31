/**
 * The migration gate.
 *
 * `validateBackup` in `src/data/exchange.ts` checks that each collection is an array of objects
 * carrying a string `id` (`exchange.ts:102,121`). That is the right amount of checking for the
 * job it does — refusing to wipe a device from a truncated file — and this module does not
 * replace it, does not import it, and does not change it.
 *
 * This is a different job. A backup is about to become the only copy of months of training, in
 * a typed relational schema, and a field that is silently dropped or coerced on the way in is
 * gone. So everything is checked: every property of every record and every nested object, every
 * enum against its closed set, every number for finiteness and integrality, every id for
 * uniqueness, every reference for a target that exists, and every property the schema has never
 * heard of — because an unknown property has no column, and a record with an unknown property is
 * a record this build does not fully understand.
 *
 * Every problem is collected before anything is thrown. Being told about one bad row at a time,
 * across 29 sessions, is how a migration turns into an afternoon.
 *
 * Pure. No DOM, no storage, no `node:sqlite`.
 */

import { CanonicalJsonError, canonicalize, defineOwn, isPlainObject } from './canonical.js';
import {
  CHALLENGE_FIELDS,
  EXERCISE_FIELDS,
  PERFORMANCE_TEST_FIELDS,
  PLAN_SLOT_FIELDS,
  SETTINGS_FIELDS,
  SETTINGS_ROW_ID,
  WORKOUT_FIELDS,
  isTimestamp,
  type FieldSpec,
  type FieldSpecMap,
} from './fields.js';
import type { BackupFile } from '../src/data/exchange.js';

/**
 * The highest `formatVersion` this build understands.
 *
 * Pinned to `BACKUP_FORMAT_VERSION` in `src/data/exchange.ts:29`, and held equal to it by
 * `server/constants.test.ts`. It is duplicated rather than imported because `exchange.ts` pulls
 * in `repo.ts` -> `idb` at module load, and this module must stay importable from a plain Node
 * process with no IndexedDB anywhere near it.
 */
export const SUPPORTED_BACKUP_FORMAT_VERSION = 1;

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class BackupValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const shown = issues.slice(0, 20).map((i) => `  ${i.path}: ${i.message}`);
    const more = issues.length > shown.length ? `\n  … and ${issues.length - shown.length} more` : '';
    super(
      `That backup cannot be imported: ${issues.length} problem${issues.length === 1 ? '' : 's'} found. ` +
        `Nothing has been written.\n${shown.join('\n')}${more}`,
    );
    this.name = 'BackupValidationError';
    this.issues = issues;
  }
}

const MAX_ISSUES = 500;

class IssueLog {
  private readonly items: ValidationIssue[] = [];
  private truncated = false;

  add(path: string, message: string): void {
    if (this.items.length >= MAX_ISSUES) {
      this.truncated = true;
      return;
    }
    this.items.push({ path, message });
  }

  get length(): number {
    return this.items.length;
  }

  get issues(): readonly ValidationIssue[] {
    if (!this.truncated) return this.items;
    return [
      ...this.items,
      { path: '$', message: `more than ${String(MAX_ISSUES)} problems; the list was truncated` },
    ];
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a Date';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? 'a number' : `${String(value)}`;
  if (t === 'object') return 'an object';
  return `a ${t}`;
}

type Checked = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const FAILED: Checked = { ok: false };

function checkField(value: unknown, spec: FieldSpec, path: string, log: IssueLog): Checked {
  switch (spec.kind) {
    case 'string': {
      if (typeof value !== 'string') {
        log.add(path, `expected a string, received ${typeName(value)}`);
        return FAILED;
      }
      if (spec.minLength !== undefined && value.length < spec.minLength) {
        log.add(path, `expected at least ${String(spec.minLength)} character(s), received ""`);
        return FAILED;
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        log.add(
          path,
          `expected at most ${String(spec.maxLength)} character(s), received ${String(value.length)}`,
        );
        return FAILED;
      }
      return { ok: true, value };
    }

    case 'timestamp': {
      if (typeof value !== 'string') {
        log.add(path, `expected an ISO timestamp string, received ${typeName(value)}`);
        return FAILED;
      }
      if (!isTimestamp(value)) {
        log.add(path, `"${value}" is not an ISO timestamp (YYYY-MM-DDTHH:MM:SS, zone optional)`);
        return FAILED;
      }
      return { ok: true, value };
    }

    case 'integer': {
      if (typeof value !== 'number') {
        log.add(path, `expected a whole number, received ${typeName(value)}`);
        return FAILED;
      }
      if (!Number.isSafeInteger(value)) {
        // Not rounded. An INTEGER column in a STRICT table refuses a fractional value, and
        // rounding here to make the insert succeed would rewrite history to fit the schema.
        //
        // `isSafeInteger`, not `isInteger`: `JSON.parse` turns 9007199254740993 into
        // 9007199254740992 before anything here can see it, and `isInteger` accepts the rounded
        // result. Every later comparison would then agree with a number the file never contained,
        // and every verification check would pass. SQLite would store it happily — its INTEGER is
        // 64-bit, wider than a JavaScript number. So the boundary is stated where the loss
        // actually happens: past 2^53-1 this build refuses the value rather than pretending.
        log.add(path, `expected a whole number, received ${String(value)}`);
        return FAILED;
      }
      if (spec.min !== undefined && value < spec.min) {
        log.add(path, `expected at least ${String(spec.min)}, received ${String(value)}`);
        return FAILED;
      }
      return { ok: true, value: value === 0 ? 0 : value };
    }

    case 'real': {
      if (typeof value !== 'number') {
        log.add(path, `expected a number, received ${typeName(value)}`);
        return FAILED;
      }
      if (!Number.isFinite(value)) {
        log.add(path, `expected a finite number, received ${String(value)}`);
        return FAILED;
      }
      if (spec.min !== undefined && value < spec.min) {
        log.add(path, `expected at least ${String(spec.min)}, received ${String(value)}`);
        return FAILED;
      }
      if (spec.exclusiveMin !== undefined && value <= spec.exclusiveMin) {
        log.add(path, `expected more than ${String(spec.exclusiveMin)}, received ${String(value)}`);
        return FAILED;
      }
      return { ok: true, value: value === 0 ? 0 : value };
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        log.add(path, `expected true or false, received ${typeName(value)}`);
        return FAILED;
      }
      return { ok: true, value };
    }

    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        log.add(
          path,
          `expected one of ${spec.values.map((v) => `"${v}"`).join(', ')}, received ` +
            (typeof value === 'string' ? `"${value}"` : typeName(value)),
        );
        return FAILED;
      }
      return { ok: true, value };
    }

    case 'opaqueObject': {
      if (!isPlainObject(value)) {
        log.add(path, `expected an object, received ${typeName(value)}`);
        return FAILED;
      }
      try {
        // Opaque does not mean unchecked. The contents are never interpreted, but they must
        // survive JSON: a Date, a NaN or a function in here would be silently mangled.
        return { ok: true, value: canonicalize(value, path) };
      } catch (error) {
        log.add(path, error instanceof CanonicalJsonError ? error.message : String(error));
        return FAILED;
      }
    }

    case 'numberMap': {
      if (!isPlainObject(value)) {
        log.add(path, `expected an object, received ${typeName(value)}`);
        return FAILED;
      }
      let ok = true;
      const out: Record<string, number> = {};
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'number' || !Number.isFinite(item)) {
          log.add(`${path}.${key}`, `expected a finite number, received ${typeName(item)}`);
          ok = false;
          continue;
        }
        defineOwn(out, key, item === 0 ? 0 : item);
      }
      return ok ? { ok: true, value: out } : FAILED;
    }

    case 'object': {
      const checked = checkObject(value, spec.fields, path, log);
      return checked === undefined ? FAILED : { ok: true, value: checked };
    }

    case 'objectArray': {
      if (!Array.isArray(value)) {
        log.add(path, `expected an array, received ${typeName(value)}`);
        return FAILED;
      }
      let ok = true;
      const out: Record<string, unknown>[] = [];
      const seenIndexes = new Set<number>();
      const hasIndex = Object.hasOwn(spec.fields, 'index');
      value.forEach((item: unknown, position) => {
        const checked = checkObject(item, spec.fields, `${path}[${String(position)}]`, log);
        if (checked === undefined) {
          ok = false;
          return;
        }
        if (hasIndex && typeof checked['index'] === 'number') {
          if (seenIndexes.has(checked['index'])) {
            log.add(
              `${path}[${String(position)}].index`,
              `duplicate set index ${String(checked['index'])} within the same session`,
            );
            ok = false;
          }
          seenIndexes.add(checked['index']);
        }
        out.push(checked);
      });
      return ok ? { ok: true, value: out } : FAILED;
    }
  }
}

/**
 * Validate one object against a field map.
 *
 * Returns a fresh object holding only the properties the map describes, in which every optional
 * that was absent — or explicitly `undefined` — stays absent. Returns `undefined` when the value
 * is not an object at all, which is a failure the caller must not try to recover from.
 */
export function checkObject(
  value: unknown,
  fields: FieldSpecMap,
  path: string,
  log: IssueLog,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    log.add(path, `expected an object, received ${typeName(value)}`);
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      // Not tolerated. There is no column for it, so importing this record would drop it —
      // and a dropped field on the only copy of the history is the defect this gate exists for.
      log.add(`${path}.${key}`, 'unknown property: it has no column and would be lost on import');
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const raw = Object.hasOwn(value, key) ? value[key] : undefined;
    if (raw === undefined) {
      if (spec.optional !== true) log.add(`${path}.${key}`, 'required property is missing');
      continue;
    }
    const checked = checkField(raw, spec, `${path}.${key}`, log);
    if (checked.ok) defineOwn(out, key, checked.value);
  }
  return out;
}

/**
 * Validate a single object against a field map, or throw.
 *
 * Used by the row decoders in `server/rows.ts`, so that nothing leaves SQLite without having
 * been through the same gate the import came through. A column that drifts — a NULL where the
 * record requires a value, a REAL where it requires a whole number — surfaces here rather than
 * three screens later as a chart with a hole in it.
 */
export function validateOne<T>(value: unknown, fields: FieldSpecMap, path: string): T {
  const log = new IssueLog();
  const checked = checkObject(value, fields, path, log);
  if (checked === undefined || log.length > 0) throw new BackupValidationError(log.issues);
  return checked as T;
}

const COLLECTIONS = [
  ['exercises', EXERCISE_FIELDS],
  ['challenges', CHALLENGE_FIELDS],
  ['performanceTests', PERFORMANCE_TEST_FIELDS],
  ['planSlots', PLAN_SLOT_FIELDS],
  ['workouts', WORKOUT_FIELDS],
] as const;

const ENVELOPE_KEYS: readonly string[] = [
  'format',
  'formatVersion',
  'dbVersion',
  'exportedAt',
  ...COLLECTIONS.map(([name]) => name),
  'settings',
];

type Row = Record<string, unknown>;

function idOf(row: Row): string | undefined {
  return typeof row['id'] === 'string' ? row['id'] : undefined;
}

/** Reference checks, expressed once so the list is auditable against the DDL's FOREIGN KEYs. */
interface Reference {
  readonly from: string;
  readonly rows: readonly Row[];
  /** Dotted path within the record, e.g. `baseline.evidenceId`. */
  readonly field: string;
  readonly to: string;
  readonly ids: ReadonlySet<string>;
}

function readPath(row: Row, field: string): unknown {
  return field.split('.').reduce<unknown>((acc, key) => {
    return isPlainObject(acc) ? acc[key] : undefined;
  }, row);
}

/**
 * Validate a backup exhaustively, or throw a `BackupValidationError` listing everything wrong.
 *
 * On success the returned value is a *new* object built only from validated properties. Nothing
 * of the input survives by reference, so a caller cannot accidentally persist a field that was
 * never checked.
 */
export function validateBackupStrict(json: unknown): BackupFile {
  const log = new IssueLog();

  if (!isPlainObject(json)) {
    throw new BackupValidationError([
      { path: '$', message: `expected a backup object, received ${typeName(json)}` },
    ]);
  }

  for (const key of Object.keys(json)) {
    if (!ENVELOPE_KEYS.includes(key)) {
      log.add(`$.${key}`, 'unknown property: this build does not know what it means');
    }
  }

  if (json['format'] !== 'godmode-backup') {
    log.add('$.format', 'that file is not a GodMode backup');
  }

  const formatVersion = json['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    log.add('$.formatVersion', `expected a whole number >= 1, received ${typeName(formatVersion)}`);
  } else if (formatVersion > SUPPORTED_BACKUP_FORMAT_VERSION) {
    log.add(
      '$.formatVersion',
      `that backup was written by a newer version of GodMode (format ${String(formatVersion)}, ` +
        `this build reads ${String(SUPPORTED_BACKUP_FORMAT_VERSION)})`,
    );
  }

  const dbVersion = json['dbVersion'];
  if (typeof dbVersion !== 'number' || !Number.isInteger(dbVersion) || dbVersion < 1) {
    log.add('$.dbVersion', `expected a whole number >= 1, received ${typeName(dbVersion)}`);
  }

  checkField(json['exportedAt'], { kind: 'timestamp' }, '$.exportedAt', log);

  const collected = new Map<string, Row[]>();
  for (const [name, fields] of COLLECTIONS) {
    const value = json[name];
    if (!Array.isArray(value)) {
      log.add(`$.${name}`, `expected a list, received ${typeName(value)}`);
      collected.set(name, []);
      continue;
    }
    const rows: Row[] = [];
    value.forEach((item: unknown, position) => {
      const row = checkObject(item, fields, `$.${name}[${String(position)}]`, log);
      if (row !== undefined) rows.push(row);
    });
    collected.set(name, rows);

    const seen = new Set<string>();
    rows.forEach((row, position) => {
      const id = idOf(row);
      if (id === undefined) return;
      if (seen.has(id)) {
        log.add(`$.${name}[${String(position)}].id`, `duplicate id "${id}" in ${name}`);
      }
      seen.add(id);
    });
  }

  const settings = checkObject(json['settings'], SETTINGS_FIELDS, '$.settings', log);

  const rowsOf = (name: string): Row[] => collected.get(name) ?? [];
  const idsOf = (name: string): ReadonlySet<string> =>
    new Set(rowsOf(name).flatMap((row) => (idOf(row) === undefined ? [] : [idOf(row) as string])));

  const exerciseIds = idsOf('exercises');
  const challengeIds = idsOf('challenges');
  const testIds = idsOf('performanceTests');
  const slotIds = idsOf('planSlots');

  // Mirrors the FOREIGN KEY clauses in `server/schema.sql`, one for one.
  //
  // Two deliberate omissions, both documented in `server/PERSISTENCE.md`:
  //   - `settings.selectedChallengeId` is a preference, not a source of truth; the app is
  //     specified to fall back when it names a challenge that is gone (`src/db/schema.ts:144`).
  //   - `chainId` names the head of a continuation chain, which a partial restore or a merge can
  //     legitimately leave absent.
  const references: readonly Reference[] = [
    { from: 'challenges', rows: rowsOf('challenges'), field: 'exerciseId', to: 'exercises', ids: exerciseIds },
    { from: 'challenges', rows: rowsOf('challenges'), field: 'previousChallengeId', to: 'challenges', ids: challengeIds },
    { from: 'challenges', rows: rowsOf('challenges'), field: 'baseline.evidenceId', to: 'performanceTests', ids: testIds },
    { from: 'performanceTests', rows: rowsOf('performanceTests'), field: 'exerciseId', to: 'exercises', ids: exerciseIds },
    { from: 'performanceTests', rows: rowsOf('performanceTests'), field: 'challengeId', to: 'challenges', ids: challengeIds },
    { from: 'planSlots', rows: rowsOf('planSlots'), field: 'challengeId', to: 'challenges', ids: challengeIds },
    { from: 'planSlots', rows: rowsOf('planSlots'), field: 'supersedesId', to: 'planSlots', ids: slotIds },
    { from: 'workouts', rows: rowsOf('workouts'), field: 'challengeId', to: 'challenges', ids: challengeIds },
    { from: 'workouts', rows: rowsOf('workouts'), field: 'planSlotId', to: 'planSlots', ids: slotIds },
  ];

  for (const reference of references) {
    reference.rows.forEach((row, position) => {
      const target = readPath(row, reference.field);
      if (typeof target !== 'string') return; // absent, or already reported as the wrong type
      if (!reference.ids.has(target)) {
        log.add(
          `$.${reference.from}[${String(position)}].${reference.field}`,
          `points at "${target}", which is not in ${reference.to}`,
        );
      }
    });
  }

  // The two `CHECK (x <> id)` clauses in the DDL. Without these the validator would pass a
  // record that SQLite then refuses, turning a clear "this points at itself" into a constraint
  // code raised halfway through an import.
  const selfReferences = [
    { collection: 'challenges', field: 'previousChallengeId' },
    { collection: 'planSlots', field: 'supersedesId' },
  ] as const;
  for (const { collection, field } of selfReferences) {
    rowsOf(collection).forEach((row, position) => {
      const target = row[field];
      if (typeof target === 'string' && target === idOf(row)) {
        log.add(`$.${collection}[${String(position)}].${field}`, 'points at its own record');
      }
    });
  }

  // The unique index `idx_workouts_slot_attempt`, checked before SQLite gets the chance —
  // so a conflict is reported as a named pair rather than a constraint code.
  const attempts = new Set<string>();
  rowsOf('workouts').forEach((row, position) => {
    const slotId = row['planSlotId'];
    const attemptNo = row['attemptNo'];
    if (typeof slotId !== 'string' || typeof attemptNo !== 'number') return;
    const key = `${slotId}#${String(attemptNo)}`;
    if (attempts.has(key)) {
      log.add(
        `$.workouts[${String(position)}].attemptNo`,
        `slot "${slotId}" already has an attempt ${String(attemptNo)}`,
      );
    }
    attempts.add(key);
  });

  // A workout linked to a slot from a different challenge is a broken link that every foreign
  // key in the schema would happily accept.
  const slotChallenge = new Map<string, unknown>();
  for (const row of rowsOf('planSlots')) {
    const id = idOf(row);
    if (id !== undefined) slotChallenge.set(id, row['challengeId']);
  }
  rowsOf('workouts').forEach((row, position) => {
    const slotId = row['planSlotId'];
    if (typeof slotId !== 'string' || !slotChallenge.has(slotId)) return;
    if (slotChallenge.get(slotId) !== row['challengeId']) {
      log.add(
        `$.workouts[${String(position)}].planSlotId`,
        `slot "${slotId}" belongs to a different challenge than this workout`,
      );
    }
  });

  if (log.length > 0 || settings === undefined) {
    throw new BackupValidationError(log.issues);
  }

  return {
    format: 'godmode-backup',
    formatVersion: formatVersion as number,
    dbVersion: dbVersion as number,
    exportedAt: json['exportedAt'] as string,
    exercises: rowsOf('exercises'),
    challenges: rowsOf('challenges'),
    performanceTests: rowsOf('performanceTests'),
    planSlots: rowsOf('planSlots'),
    workouts: rowsOf('workouts'),
    settings: { ...settings, id: SETTINGS_ROW_ID },
  } as unknown as BackupFile;
}
