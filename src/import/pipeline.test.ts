import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCanonicalImport,
  detectDateFormat,
  parseDelimited,
} from './pipeline.js';
import { INCUMBENT_CSV_V1 } from './profiles.js';

/** The real export, not a fixture. If the pipeline works on this, it works. */
const REAL_CSV = readFileSync(
  resolve(process.cwd(), 'example/incumbent-history-sample.csv'),
  'utf8',
);

describe('IMP-01 — the real 29-session export imports', () => {
  const report = buildCanonicalImport(REAL_CSV, INCUMBENT_CSV_V1);

  it('accepts every row with no errors', () => {
    expect(report.stats.rowsRead).toBe(29);
    expect(report.stats.sessionsAccepted).toBe(29);
    expect(report.stats.rowsRejected).toBe(0);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('totals 3134 reps, matching the app\'s own lifetime figure', () => {
    // The incumbent's stats screen showed Σ 3134.
    expect(report.stats.totalReps).toBe(3134);
  });

  it('detects 18 distinct slots, 6 of them repeated, from 29 sessions', () => {
    // Hand-counted from the source file: w2d3 x2, w3d3 x2, w4d2 x4, w5d2 x3,
    // w5d3 x2, w6d2 x4, and twelve slots attempted once = 29 sessions over 18 slots.
    expect(report.stats.distinctSlots).toBe(18);
    expect(report.stats.repeatedSlots).toBe(6);
    expect(report.stats.sessionsAccepted - report.stats.distinctSlots).toBe(11);
  });

  it('reads the header metadata', () => {
    expect(report.canonical.exerciseLabel).toBe('Liegestütze');
    expect(report.canonical.goal).toBe(100);
    expect(report.canonical.challengeLength).toBe('6 Wochen');
    expect(report.canonical.sourceProfileId).toBe('incumbent-csv-v1');
  });

  it('reproduces the first session exactly', () => {
    const first = report.canonical.sessions[0]!;
    expect(first.performedAt).toBe('2026-05-29T08:34:00');
    expect(first.week).toBe(1);
    expect(first.day).toBe(1);
    expect(first.actualSets).toEqual([7, 8, 7, 6, 9]);
    expect(first.actualTotal).toBe(37);
    expect(first.durationSeconds).toBe(6 * 60 + 31);
    expect(first.kcalExternal).toBe(13);
  });

  it('reproduces the final session exactly (202 against a 205 target)', () => {
    const last = report.canonical.sessions.at(-1)!;
    expect(last.performedAt).toBe('2026-07-30T09:48:00');
    expect(last.week).toBe(6);
    expect(last.day).toBe(3);
    expect(last.actualSets).toEqual([37, 47, 37, 33, 48]);
    expect(last.actualTotal).toBe(202);
  });

  it('keeps sessions in chronological order', () => {
    const dates = report.canonical.sessions.map((s) => s.performedAt);
    expect([...dates].sort()).toEqual(dates);
  });

  it('preserves repeat attempts rather than collapsing them', () => {
    // W4D2 was attempted four times: 92, 98, 104, 108.
    const w4d2 = report.canonical.sessions.filter((s) => s.week === 4 && s.day === 2);
    expect(w4d2).toHaveLength(4);
    expect(w4d2.map((s) => s.actualTotal)).toEqual([92, 98, 104, 108]);
  });

  it('preserves the 2026-06-09 one-rep-short repeat', () => {
    const w2d3 = report.canonical.sessions.filter((s) => s.week === 2 && s.day === 3);
    expect(w2d3.map((s) => s.actualSets)).toEqual([
      [10, 13, 10, 9, 13],
      [10, 13, 10, 9, 14],
    ]);
    expect(w2d3.map((s) => s.actualTotal)).toEqual([55, 56]);
  });
});

describe('IMP-02 — the duplicate `Zeit` column trap', () => {
  it('reads challenge length from index 3 and duration from index 6', () => {
    // Both columns are literally named `Zeit`. Positional mapping keeps them apart.
    const header = REAL_CSV.split('\n')[0]!;
    const names = header.split(';').map((s) => s.trim());
    expect(names[3]).toBe('Zeit');
    expect(names[6]).toBe('Zeit');
    expect(names.filter((n) => n === 'Zeit')).toHaveLength(2);

    const report = buildCanonicalImport(REAL_CSV, INCUMBENT_CSV_V1);
    expect(report.canonical.challengeLength).toBe('6 Wochen'); // index 3
    expect(report.canonical.sessions[0]!.durationSeconds).toBe(391); // index 6
  });

  it('demonstrates what a name-keyed parser would have lost', () => {
    // Building a dict from the header keeps only the LAST `Zeit`, silently discarding
    // the challenge length. This is the failure positional mapping avoids.
    const [header, firstRow] = REAL_CSV.split('\n');
    const keyed: Record<string, string> = {};
    header!.split(';').forEach((k, i) => {
      keyed[k.trim()] = firstRow!.split(';')[i]!.trim();
    });
    expect(keyed['Zeit']).toBe('06:31'); // the "6 Wochen" value is gone
    expect(Object.keys(keyed)).toHaveLength(13); // 14 columns collapsed to 13
  });
});

describe('IMP-03 — date format detection', () => {
  it('detects the unpadded German format in the real file', () => {
    const report = buildCanonicalImport(REAL_CSV, INCUMBENT_CSV_V1);
    expect(report.canonical.detectedDateFormat).toBe('d.M.yyyy HH:mm');
  });

  it('prefers a format that yields chronological order', () => {
    // 1/2/2026 then 3/2/2026: as M/d these are Jan 2 and Mar 2 (ordered);
    // as d/M they are Feb 1 and Feb 3 (also ordered) -> genuinely ambiguous.
    const result = detectDateFormat(
      ['1/2/2026 08:00', '3/2/2026 08:00'],
      ['M/d/yyyy HH:mm', 'd/M/yyyy HH:mm'],
    );
    expect(result).not.toBeNull();
    expect(result!.ambiguous.length).toBeGreaterThan(0);
  });

  it('disambiguates when only one reading is chronological', () => {
    // 5/13/2026 cannot be d/M (month 13), so M/d is forced.
    const result = detectDateFormat(
      ['5/13/2026 08:00', '6/1/2026 08:00'],
      ['d/M/yyyy HH:mm', 'M/d/yyyy HH:mm'],
    );
    expect(result!.format).toBe('M/d/yyyy HH:mm');
    expect(result!.ambiguous).toEqual([]);
  });

  it('warns when the choice is ambiguous rather than guessing silently', () => {
    const csv = [
      'Datum;Workout;Ziel;Zeit;Woche;Tag;Zeit;Set 1;Set 2;Set 3;Set 4;Set 5;Summe;Kcal',
      '1/2/2026 08:00;Push;100;6 Weeks;1;1;05:00;7;8;7;6;9;37;13',
      '3/2/2026 08:00;Push;100;6 Weeks;1;2;05:00;7;9;7;6;10;39;13',
    ].join('\n');
    const report = buildCanonicalImport(csv, INCUMBENT_CSV_V1);
    expect(report.issues.some((i) => i.message.includes('ambiguous'))).toBe(true);
  });

  it('returns null when no candidate parses', () => {
    expect(detectDateFormat(['not a date'], ['d.M.yyyy HH:mm'])).toBeNull();
  });
});

describe('parseDelimited', () => {
  it('handles a UTF-8 BOM, CRLF, and quoted fields', () => {
    const rows = parseDelimited('﻿a;b\r\n"x;y";z\r\n', ';');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x;y', 'z'],
    ]);
  });

  it('handles doubled quotes inside a quoted field', () => {
    expect(parseDelimited('"he said ""hi""";b', ';')).toEqual([['he said "hi"', 'b']]);
  });

  it('drops blank lines', () => {
    expect(parseDelimited('a;b\n\n\nc;d\n', ';')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a trailing row with no newline', () => {
    expect(parseDelimited('a;b\nc;d', ';')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('validation and error reporting', () => {
  const header =
    'Datum;Workout;Ziel;Zeit;Woche;Tag;Zeit;Set 1;Set 2;Set 3;Set 4;Set 5;Summe;Kcal';

  it('skips short rows with a line-numbered error', () => {
    const csv = [
      header,
      '1.6.2026 08:00;Push;100;6 Wochen;1;1;05:00;7;8;7;6;9;37;13',
      '2.6.2026 08:00;Push;100',
    ].join('\n');
    const report = buildCanonicalImport(csv, INCUMBENT_CSV_V1);
    expect(report.stats.sessionsAccepted).toBe(1);
    expect(report.stats.rowsRejected).toBe(1);
    const err = report.issues.find((i) => i.severity === 'error')!;
    expect(err.line).toBe(3);
    expect(err.message).toContain('found 3');
  });

  it('warns when the file\'s stated total disagrees with its own sets', () => {
    const csv = [
      header,
      '1.6.2026 08:00;Push;100;6 Wochen;1;1;05:00;7;8;7;6;9;999;13',
    ].join('\n');
    const report = buildCanonicalImport(csv, INCUMBENT_CSV_V1);
    expect(report.canonical.sessions[0]!.actualTotal).toBe(37);
    expect(report.issues.some((i) => i.message.includes('999'))).toBe(true);
  });

  it('tolerates a file with fewer than five sets', () => {
    const csv = [
      header,
      '1.6.2026 08:00;Push;100;6 Wochen;1;1;05:00;7;8;7;;;22;13',
    ].join('\n');
    const report = buildCanonicalImport(csv, INCUMBENT_CSV_V1);
    expect(report.canonical.sessions[0]!.actualSets).toEqual([7, 8, 7]);
  });

  it('accepts a headerless file', () => {
    const csv = '1.6.2026 08:00;Push;100;6 Wochen;1;1;05:00;7;8;7;6;9;37;13';
    const report = buildCanonicalImport(csv, INCUMBENT_CSV_V1);
    expect(report.stats.sessionsAccepted).toBe(1);
  });

  it('throws a readable error on an empty file', () => {
    expect(() => buildCanonicalImport('', INCUMBENT_CSV_V1)).toThrow(/no rows/i);
  });

  it('throws a readable error when no row is usable', () => {
    expect(() => buildCanonicalImport(`${header}\n;;;;;;;;;;;;;`, INCUMBENT_CSV_V1)).toThrow();
  });

  it('treats "-" kcal as absent rather than zero', () => {
    const csv = [header, '1.6.2026 08:00;Push;100;6 Wochen;1;1;05:00;7;8;7;6;9;37;-'].join('\n');
    const report = buildCanonicalImport(csv, INCUMBENT_CSV_V1);
    expect(report.canonical.sessions[0]!.kcalExternal).toBeUndefined();
  });
});

describe('IMP-07 — actuals are never promoted to prescriptions', () => {
  it('produces no target or prescription field anywhere in the canonical form', () => {
    const report = buildCanonicalImport(REAL_CSV, INCUMBENT_CSV_V1);
    const json = JSON.stringify(report.canonical);
    expect(json).not.toMatch(/"target/i);
    expect(json).not.toMatch(/"prescri/i);
    for (const session of report.canonical.sessions) {
      expect(Object.keys(session).sort()).toEqual(
        [
          'actualSets',
          'actualTotal',
          'day',
          'durationSeconds',
          'kcalExternal',
          'performedAt',
          'sourceLine',
          'week',
        ].filter((k) =>
          k === 'kcalExternal' ? session.kcalExternal !== undefined : true,
        ),
      );
    }
  });
});
