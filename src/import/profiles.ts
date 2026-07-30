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
 * The incumbent six-week challenge app's CSV export, verified against a real German file
 * (`example/incumbent-history-sample.csv`, 29 sessions).
 *
 * The profile is named for the format, not for the vendor. The mapping is positional, so
 * translated headers do not need their own profile — only differing value formats would.
 *
 * Header, for reference:
 *   Datum;Workout;Ziel;Zeit;Woche;Tag;Zeit;Set 1;...;Set 5;Summe der Sets;Kcal
 *     0     1      2    3     4    5    6    7 ..  11        12          13
 */
export const INCUMBENT_CSV_V1: ImportProfile = {
  id: 'incumbent-csv-v1',
  label: 'Six-week challenge app (CSV export)',
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

/**
 * Resolve a stored `importSource` to a current profile id.
 *
 * The profile id is persisted on every imported workout, so renaming it leaves records in the
 * database carrying the id it shipped under. Rather than hard-coding the retired name, this
 * relies on a fact that is true for the whole period during which any such record could have
 * been written: exactly one import format has ever existed. So an id that matches no known
 * profile can only be an earlier name for the one profile there is, and is resolved to it.
 *
 * That reasoning is deliberately self-limiting. It holds only while `PROFILES` has a single
 * entry; the moment a second format ships, an unrecognised id becomes genuinely ambiguous and
 * is left alone rather than guessed at.
 */
export function canonicalProfileId(id: string): string {
  if (PROFILES.some((p) => p.id === id)) return id;
  const only = PROFILES.length === 1 ? PROFILES[0] : undefined;
  return only ? only.id : id;
}

export function findProfile(id: string): ImportProfile | undefined {
  const canonical = canonicalProfileId(id);
  return PROFILES.find((p) => p.id === canonical);
}
