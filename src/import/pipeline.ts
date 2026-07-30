/**
 * The four-stage import pipeline:
 *
 *   raw text -> [1] parse -> rows
 *            -> [2] map (profile) -> CanonicalImport
 *            -> [3] validate -> ImportReport
 *            -> [4] commit -> DB   (see ./commit.ts)
 *
 * The canonical form is the project's real interchange format: it is what exports produce,
 * what test fixtures are written in, and what a group member sends when reporting a bug.
 * Separating map from commit is what makes any of that inspectable.
 *
 * IMP-07 is load-bearing throughout: the source CSV contains ACTUAL reps only. Prescribed
 * targets are never manufactured from them. The model's own interior slots diverge from the
 * reference data, so forcing agreement would fabricate history.
 */

import type { DateFormatId, ImportProfile } from './profiles.js';

export const CANONICAL_FORMAT_VERSION = 1;

export interface CanonicalSession {
  /** ISO-8601 local timestamp, as recorded by the source app. */
  performedAt: string;
  week: number;
  day: number;
  durationSeconds?: number;
  /** ACTUAL reps performed, per set. Never a prescription. */
  actualSets: number[];
  actualTotal: number;
  /** Value from the source export, kept distinct from anything we compute. */
  kcalExternal?: number;
  /** 1-based line number in the source file, for error reporting. */
  sourceLine: number;
}

export interface CanonicalImport {
  formatVersion: number;
  sourceProfileId: string;
  detectedDateFormat: DateFormatId;
  exerciseLabel: string;
  /** The source app's headline goal. A generation coordinate, NOT a capability claim. */
  goal?: number;
  challengeLength?: string;
  sessions: CanonicalSession[];
}

export interface ImportIssue {
  severity: 'error' | 'warning';
  line?: number;
  message: string;
}

export interface ImportReport {
  canonical: CanonicalImport;
  issues: ImportIssue[];
  stats: {
    rowsRead: number;
    sessionsAccepted: number;
    rowsRejected: number;
    /** Distinct (week, day) pairs — i.e. plan slots touched. */
    distinctSlots: number;
    /** Slots attempted more than once. */
    repeatedSlots: number;
    totalReps: number;
  };
}

// ── Stage 1: parse ──────────────────────────────────────────────────────────────

/**
 * Minimal RFC4180-ish splitter with a configurable delimiter. Handles quoted fields,
 * doubled quotes, CRLF, and a UTF-8 BOM. Deliberately not a dependency: the format is
 * fixed and a 30-line parser we control beats a library whose duplicate-header behaviour
 * we would then have to reason about.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ── Date handling ───────────────────────────────────────────────────────────────

interface ParsedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Split "29.5.2026 08:34" or "5/29/2026 08:34" into numeric components. */
function splitDateTime(raw: string): { parts: number[]; hour: number; minute: number } | null {
  const trimmed = raw.trim();
  const match = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})[ T]+(\d{1,2}):(\d{2})/.exec(trimmed);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

function applyFormat(raw: string, format: DateFormatId): ParsedDateParts | null {
  const split = splitDateTime(raw);
  if (!split) return null;
  const [a, b, c] = split.parts as [number, number, number];
  let day: number;
  let month: number;
  const year = c;
  if (format === 'M/d/yyyy HH:mm') {
    month = a;
    day = b;
  } else {
    // Both 'd.M.yyyy' and 'd/M/yyyy' are day-first.
    day = a;
    month = b;
  }
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (split.hour > 23 || split.minute > 59) return null;
  const parts = { year, month, day, hour: split.hour, minute: split.minute };
  // A day-of-month range check accepts 31 February. Construct the date and read it back:
  // if the calendar rolled it over into March, the input was not a real date.
  if (!isRealCalendarDate(parts)) return null;
  return parts;
}

function isRealCalendarDate(p: ParsedDateParts): boolean {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return (
    d.getUTCFullYear() === p.year && d.getUTCMonth() === p.month - 1 && d.getUTCDate() === p.day
  );
}

function toIso(p: ParsedDateParts): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00`;
}

/**
 * Pick the date format that parses every row AND yields a non-decreasing sequence.
 *
 * Ordering is the discriminator that makes this reliable. The source app exports rows in
 * chronological order, so a wrong day/month reading will usually produce an out-of-order
 * sequence. Where both readings stay ordered the choice is genuinely ambiguous and we say so
 * rather than guessing silently.
 */
export function detectDateFormat(
  rawDates: string[],
  candidates: DateFormatId[],
): { format: DateFormatId; ambiguous: DateFormatId[] } | null {
  const viable: { format: DateFormatId; signature: string }[] = [];

  for (const format of candidates) {
    const parsed = rawDates.map((d) => applyFormat(d, format));
    if (parsed.some((p) => p === null)) continue;
    const isos = (parsed as ParsedDateParts[]).map(toIso);
    const ordered = isos.every((iso, i) => i === 0 || isos[i - 1]! <= iso);
    // Only formats that produce a DIFFERENT reading are genuinely competing. `d.M.yyyy` and
    // `d/M/yyyy` are both day-first, so they agree and there is nothing to warn about.
    if (ordered) viable.push({ format, signature: isos.join('|') });
  }

  if (viable.length === 0) {
    // Fall back to any format that parses at all, even if unordered.
    for (const format of candidates) {
      if (rawDates.every((d) => applyFormat(d, format) !== null)) {
        return { format, ambiguous: [] };
      }
    }
    return null;
  }

  const chosen = viable[0]!;
  const disagreeing = viable
    .slice(1)
    .filter((v) => v.signature !== chosen.signature)
    .map((v) => v.format);

  return { format: chosen.format, ambiguous: disagreeing };
}

function parseDurationSeconds(raw: string): number | undefined {
  const m = /^(\d{1,3}):(\d{2})$/.exec(raw.trim());
  if (!m) return undefined;
  const seconds = Number(m[2]);
  // `mm:ss` — 05:99 is not 6:39, it is a malformed cell. Reading it as 399s would invent
  // a duration the source never recorded.
  if (seconds > 59) return undefined;
  return Number(m[1]) * 60 + seconds;
}

/** Absent (blank or `-`), a value, or a cell that is present but not usable. */
type Cell = number | undefined | 'invalid';

/**
 * Parse a cell that must hold a whole number.
 *
 * Rounding is deliberately not done. `Math.round` turned "7.6" into 8 and "abc"-adjacent junk
 * into a plausible-looking rep count, which is the pipeline silently changing the user's data
 * rather than telling them a cell is unreadable.
 */
function parseIntCell(raw: string | undefined): Cell {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === '' || t === '-') return undefined;
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'invalid';
  return n;
}

/** As above, but a decimal is acceptable — kcal is an estimate, not a count. */
function parseNumberCell(raw: string | undefined): Cell {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === '' || t === '-') return undefined;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : 'invalid';
}

function valueOrUndefined(cell: Cell): number | undefined {
  return cell === 'invalid' ? undefined : cell;
}

// ── Stages 2 & 3: map and validate ──────────────────────────────────────────────

export function buildCanonicalImport(text: string, profile: ImportProfile): ImportReport {
  const issues: ImportIssue[] = [];
  const rows = parseDelimited(text, profile.delimiter);

  if (rows.length === 0) {
    throw new Error('The file contains no rows.');
  }

  // Drop the header row if the first cell is not a date-like value.
  const looksLikeData = splitDateTime(rows[0]![profile.columns.date] ?? '') !== null;
  const dataRows = looksLikeData ? rows : rows.slice(1);
  const headerOffset = looksLikeData ? 1 : 2; // 1-based source line of dataRows[0]

  if (dataRows.length === 0) {
    throw new Error('The file has a header but no data rows.');
  }

  const rawDates = dataRows.map((r) => r[profile.columns.date] ?? '');
  const detection = detectDateFormat(rawDates, profile.dateFormats);
  if (!detection) {
    throw new Error(
      `Could not parse the date column with any known format (${profile.dateFormats.join(', ')}). ` +
        `First value was "${rawDates[0] ?? ''}".`,
    );
  }
  if (detection.ambiguous.length > 0) {
    issues.push({
      severity: 'warning',
      message:
        `Dates are ambiguous: "${detection.format}" and "${detection.ambiguous.join('", "')}" ` +
        'both parse this file in chronological order. Assuming ' +
        `"${detection.format}". Check a session date against the source app if this matters.`,
    });
  }

  const sessions: CanonicalSession[] = [];
  let rowsRejected = 0;

  dataRows.forEach((row, i) => {
    const line = i + headerOffset;

    if (row.length < profile.expectedColumns) {
      issues.push({
        severity: 'error',
        line,
        message: `Expected ${profile.expectedColumns} columns, found ${row.length}. Row skipped.`,
      });
      rowsRejected += 1;
      return;
    }

    const parts = applyFormat(row[profile.columns.date] ?? '', detection.format);
    const week = parseIntCell(row[profile.columns.week]);
    const day = parseIntCell(row[profile.columns.day]);

    if (
      !parts ||
      typeof week !== 'number' ||
      typeof day !== 'number' ||
      week < 1 ||
      day < 1
    ) {
      issues.push({
        severity: 'error',
        line,
        message: 'Missing or unreadable date, week, or day. Row skipped.',
      });
      rowsRejected += 1;
      return;
    }

    // Set columns must keep their positions. The previous version filtered out anything not
    // greater than zero, so a logged set of 0 vanished and every later set silently moved up
    // a slot — set 3 became set 2 in the stored history.
    const rawSets = profile.columns.sets.map((c) => parseIntCell(row[c]));

    if (rawSets.some((c) => c === 'invalid')) {
      issues.push({
        severity: 'error',
        line,
        message: 'A set column is not a whole number. Row skipped.',
      });
      rowsRejected += 1;
      return;
    }
    if (rawSets.some((c) => typeof c === 'number' && c < 0)) {
      issues.push({
        severity: 'error',
        line,
        message: 'A set column is negative. Row skipped.',
      });
      rowsRejected += 1;
      return;
    }

    // Unused trailing set columns are blank in the source and simply mean "fewer sets".
    let end = rawSets.length;
    while (end > 0 && rawSets[end - 1] === undefined) end -= 1;
    const kept = rawSets.slice(0, end);

    if (kept.some((c) => c === undefined)) {
      issues.push({
        severity: 'error',
        line,
        message:
          'A set column is blank between two filled ones, so the set order cannot be trusted. ' +
          'Row skipped.',
      });
      rowsRejected += 1;
      return;
    }

    const actualSets = kept as number[];

    if (actualSets.length === 0) {
      issues.push({
        severity: 'error',
        line,
        message: 'No set values found. Row skipped.',
      });
      rowsRejected += 1;
      return;
    }

    const computedTotal = actualSets.reduce((s, n) => s + n, 0);
    const statedTotal = valueOrUndefined(parseIntCell(row[profile.columns.total]));
    if (statedTotal !== undefined && statedTotal !== computedTotal) {
      issues.push({
        severity: 'warning',
        line,
        message:
          `The file's own total (${statedTotal}) disagrees with the sum of its sets ` +
          `(${computedTotal}). Using ${computedTotal}.`,
      });
    }

    const durationSeconds = parseDurationSeconds(row[profile.columns.duration] ?? '');
    const kcalExternal = valueOrUndefined(parseNumberCell(row[profile.columns.kcal]));

    sessions.push({
      performedAt: toIso(parts),
      week,
      day,
      actualSets,
      actualTotal: computedTotal,
      sourceLine: line,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(kcalExternal === undefined ? {} : { kcalExternal }),
    });
  });

  if (sessions.length === 0) {
    throw new Error('No readable sessions were found in the file.');
  }

  const slotKeys = sessions.map((s) => `${s.week}-${s.day}`);
  const counts = new Map<string, number>();
  for (const key of slotKeys) counts.set(key, (counts.get(key) ?? 0) + 1);

  const first = dataRows[0]!;
  const exerciseLabel = (first[profile.columns.exercise] ?? '').trim() || 'Exercise';
  const goal = valueOrUndefined(parseIntCell(first[profile.columns.goal]));
  const challengeLength = (first[profile.columns.challengeLength] ?? '').trim();

  return {
    canonical: {
      formatVersion: CANONICAL_FORMAT_VERSION,
      sourceProfileId: profile.id,
      detectedDateFormat: detection.format,
      exerciseLabel,
      ...(goal === undefined ? {} : { goal }),
      ...(challengeLength === '' ? {} : { challengeLength }),
      sessions,
    },
    issues,
    stats: {
      rowsRead: dataRows.length,
      sessionsAccepted: sessions.length,
      rowsRejected,
      distinctSlots: counts.size,
      repeatedSlots: [...counts.values()].filter((n) => n > 1).length,
      totalReps: sessions.reduce((s, x) => s + x.actualTotal, 0),
    },
  };
}
