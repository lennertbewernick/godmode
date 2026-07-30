/**
 * Import mapping profiles — data, not code.
 *
 * Columns are addressed POSITIONALLY, never by header name. The incumbent's export contains
 * two columns both literally named `Zeit`: index 3 holds the challenge length ("6 Wochen")
 * and index 6 holds the session duration ("06:31"). A header-keyed parser risks collapsing
 * them depending on how the library handles duplicate headers — some return row arrays, some
 * support header transforms, and some silently keep only the last. Positional mapping makes
 * the whole question moot.
 *
 * Because mapping is positional, a translated export does NOT need its own profile. Only a
 * differing *value* format does — which in practice means the date format, so profiles carry
 * a list of candidates and detection picks one.
 */

export interface ImportProfile {
  id: string;
  label: string;
  delimiter: string;
  /** Candidate date formats, tried in order during detection. */
  dateFormats: DateFormatId[];
  durationFormat: 'mm:ss';
  columns: {
    date: number;
    exercise: number;
    goal: number;
    challengeLength: number;
    week: number;
    day: number;
    duration: number;
    /** Positional indices of the per-set columns. */
    sets: number[];
    total: number;
    kcal: number;
  };
  /** Number of columns a data row must have to be considered well-formed. */
  expectedColumns: number;
}

export type DateFormatId = 'd.M.yyyy HH:mm' | 'M/d/yyyy HH:mm' | 'd/M/yyyy HH:mm';

/**
 * The Just 6 Weeks export, verified against a real German file
 * (`example/incumbent-history-sample.csv`, 29 sessions).
 *
 * Header, for reference:
 *   Datum;Workout;Ziel;Zeit;Woche;Tag;Zeit;Set 1;...;Set 5;Summe der Sets;Kcal
 *     0     1      2    3     4    5    6    7 ..  11        12          13
 */
export const INCUMBENT_CSV_V1: ImportProfile = {
  id: 'incumbent-csv-v1',
  label: 'Just 6 Weeks (CSV export)',
  delimiter: ';',
  dateFormats: ['d.M.yyyy HH:mm', 'M/d/yyyy HH:mm', 'd/M/yyyy HH:mm'],
  durationFormat: 'mm:ss',
  columns: {
    date: 0,
    exercise: 1,
    goal: 2,
    challengeLength: 3,
    week: 4,
    day: 5,
    duration: 6,
    sets: [7, 8, 9, 10, 11],
    total: 12,
    kcal: 13,
  },
  expectedColumns: 14,
};

export const PROFILES: ImportProfile[] = [INCUMBENT_CSV_V1];

export function findProfile(id: string): ImportProfile | undefined {
  return PROFILES.find((p) => p.id === id);
}
