/**
 * Filenames are the only description an export carries once it is sitting in a Downloads
 * folder, so they are tested like data: the transliteration order, the degenerate labels, and
 * the traversal attempt all have a pinned answer.
 */

import { describe, expect, it } from 'vitest';
import { backupFilename, csvFilename, shareImageFilename, slugLabel } from './filenames.js';

/** Local-time construction, so the stamp assertions hold in any timezone. */
const AT = new Date(2026, 6, 30, 15, 37);

describe('slugLabel', () => {
  it('transliterates German characters to digraphs rather than to bare vowels', () => {
    // The order matters: a normalise-and-strip pass run first turns ü into u and this
    // becomes "liegestutze", which is a different word.
    expect(slugLabel('Liegestütze')).toBe('liegestuetze');
    expect(slugLabel('Straße')).toBe('strasse');
    expect(slugLabel('Übungen')).toBe('uebungen');
    expect(slugLabel('Öl Ärmel')).toBe('oel_aermel');
  });

  it('strips remaining accents to their base letter', () => {
    expect(slugLabel('Café')).toBe('cafe');
    expect(slugLabel('Piñata')).toBe('pinata');
  });

  it('collapses every run of other characters to a single underscore', () => {
    expect(slugLabel('Push-ups; wide')).toBe('push_ups_wide');
    expect(slugLabel('Sit   ups')).toBe('sit_ups');
    expect(slugLabel('  Pull-ups  ')).toBe('pull_ups');
  });

  it('falls back to "workout" for labels that carry nothing usable', () => {
    expect(slugLabel('   ')).toBe('workout');
    expect(slugLabel('///')).toBe('workout');
    expect(slugLabel('...')).toBe('workout');
    expect(slugLabel('')).toBe('workout');
    expect(slugLabel('—')).toBe('workout');
  });

  it('cannot produce a path separator or a dot segment', () => {
    const slug = slugLabel('../../etc/passwd');
    expect(slug).not.toContain('.');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('\\');
    expect(slug.startsWith('_')).toBe(false);
    expect(slug.endsWith('_')).toBe(false);
    expect(slug).toBe('etc_passwd');
  });

  it('leaves nothing but the fallback when the label is only separators', () => {
    expect(slugLabel('..\\..\\windows')).toBe('windows');
    expect(slugLabel('../..')).toBe('workout');
  });

  it('truncates to the cap and does not leave a trailing underscore behind', () => {
    const long = `${'x'.repeat(31)} y`;
    const slug = slugLabel(long);
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug.endsWith('_')).toBe(false);
    expect(slug).toBe('x'.repeat(31));

    expect(slugLabel('a'.repeat(40))).toBe('a'.repeat(32));
    expect(slugLabel('a'.repeat(40), 8)).toBe('a'.repeat(8));
  });

  it('is always ASCII', () => {
    for (const label of ['Liegestütze', 'Café', '日本語', '../../etc/passwd', '']) {
      expect(slugLabel(label)).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('csvFilename', () => {
  it('names the exercise whose history the file contains', () => {
    expect(csvFilename('Liegestütze', AT)).toBe('godmode_liegestuetze_20260730_1537.csv');
    expect(csvFilename('Push-ups; wide', AT)).toBe('godmode_push_ups_wide_20260730_1537.csv');
  });

  it('still produces a usable name for an unusable label', () => {
    expect(csvFilename('///', AT)).toBe('godmode_workout_20260730_1537.csv');
  });
});

describe('backupFilename', () => {
  it('names the exercise only when the database holds exactly one', () => {
    expect(backupFilename(['Liegestütze'], AT)).toBe(
      'godmode_backup_liegestuetze_20260730_1537.json',
    );
  });

  it('states the breadth rather than naming one of several exercises', () => {
    expect(backupFilename(['Push-ups', 'Squats'], AT)).toBe(
      'godmode_backup_all_2_workouts_20260730_1537.json',
    );
    expect(backupFilename(['Push-ups', 'Squats', 'Dips'], AT)).toBe(
      'godmode_backup_all_3_workouts_20260730_1537.json',
    );
  });

  it('says so when there is nothing in the database', () => {
    expect(backupFilename([], AT)).toBe('godmode_backup_empty_20260730_1537.json');
  });
});

describe('shareImageFilename', () => {
  it('marks the file as the card, not the data', () => {
    expect(shareImageFilename('Liegestütze', AT)).toBe(
      'godmode_liegestuetze_card_20260730_1537.png',
    );
  });
});

describe('the timestamp', () => {
  it('pads every field and reads as YYYYMMDD_HHmm', () => {
    expect(csvFilename('Dips', new Date(2026, 0, 5, 9, 4))).toBe(
      'godmode_dips_20260105_0904.csv',
    );
  });
});
