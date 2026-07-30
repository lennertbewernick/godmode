/**
 * Export filenames.
 *
 * A file that has left this app carries no context but its name. `godmode_stats_<stamp>.csv`
 * said nothing about which workout it held, so two exports in the same minute were
 * indistinguishable in a Downloads folder. Every name here states what is inside it.
 *
 * Deliberately dependency-free — no imports at all — so the UI layer can build a filename
 * without dragging in `idb` or the repository.
 */

/** Fallback when a label carries nothing a filename can use. */
const FALLBACK_SLUG = 'workout';

/**
 * German characters get an explicit digraph, and this pass runs FIRST.
 *
 * Order is the whole point. A Unicode normalise-and-strip run first decomposes `ü` into
 * `u` + combining diaeresis and then discards the mark, turning `Liegestütze` into
 * `liegestutze` — a different word, and the wrong one.
 */
const TRANSLITERATE: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  Ä: 'ae',
  Ö: 'oe',
  Ü: 'ue',
  ß: 'ss',
};

/**
 * A user-typed exercise label, reduced to something safe to put in a filename.
 *
 * The allowlist is what makes traversal impossible: `.`, `/` and `\` are not in `[a-z0-9]`,
 * so `../..` collapses to nothing and hits the fallback. There is deliberately no separate
 * traversal check — a second rule could drift from this one, and then only one of them would
 * be true.
 */
export function slugLabel(label: string, maxLength = 32): string {
  const transliterated = [...label].map((ch) => TRANSLITERATE[ch] ?? ch).join('');

  const slug = transliterated
    .toLowerCase()
    // Now that the digraphs are safe, drop the remaining accents: é → e, ñ → n.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength)
    // The truncation itself can expose a trailing separator.
    .replace(/_+$/, '');

  return slug === '' ? FALLBACK_SLUG : slug;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** `YYYYMMDD_HHmm` in local time — the stamp the app has always written. */
function stamp(now: Date): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/** The CSV is scoped to one exercise, so its label is the honest hint. */
export function csvFilename(exerciseLabel: string, now = new Date()): string {
  return `godmode_${slugLabel(exerciseLabel)}_${stamp(now)}.csv`;
}

/**
 * The backup spans the whole database, so naming one exercise is only honest when there is
 * exactly one.
 *
 * Taking the labels rather than a single label is what makes the result truthful by
 * construction: a caller cannot quietly name a multi-exercise backup after one of them.
 * "Workouts" is this app's own word for an exercise — see "Add a workout" / "End".
 */
export function backupFilename(exerciseLabels: string[], now = new Date()): string {
  const breadth =
    exerciseLabels.length === 1
      ? slugLabel(exerciseLabels[0] ?? '')
      : exerciseLabels.length === 0
        ? 'empty'
        : `all_${exerciseLabels.length}_workouts`;
  return `godmode_backup_${breadth}_${stamp(now)}.json`;
}

/** The share card: an image of one workout's progress, not its data. */
export function shareImageFilename(exerciseLabel: string, now = new Date()): string {
  return `godmode_${slugLabel(exerciseLabel)}_card_${stamp(now)}.png`;
}
