import { describe, expect, it } from 'vitest';
import { cueForSecondsLeft } from './cues.js';

describe('rest-timer cue schedule', () => {
  it('warns once, ten seconds out', () => {
    expect(cueForSecondsLeft(11)).toBeNull();
    expect(cueForSecondsLeft(10)).toBe('warn');
    expect(cueForSecondsLeft(9)).toBeNull();
  });

  it('ticks on each of the last five seconds', () => {
    expect([5, 4, 3, 2, 1].map(cueForSecondsLeft)).toEqual([
      'tick',
      'tick',
      'tick',
      'tick',
      'tick',
    ]);
    // 6 is the boundary that a `< 5` typo would get wrong.
    expect(cueForSecondsLeft(6)).toBeNull();
  });

  it('sounds the go chime at zero', () => {
    expect(cueForSecondsLeft(0)).toBe('go');
  });

  it('stays silent through a long rest until the last ten seconds', () => {
    const played = [];
    for (let left = 150; left > 10; left -= 1) played.push(cueForSecondsLeft(left));
    expect(played.every((c) => c === null)).toBe(true);
  });

  it('produces exactly seven cues over a full 150-second rest', () => {
    const cues = [];
    for (let left = 150; left >= 0; left -= 1) {
      const cue = cueForSecondsLeft(left);
      if (cue) cues.push(cue);
    }
    expect(cues).toEqual(['warn', 'tick', 'tick', 'tick', 'tick', 'tick', 'go']);
  });

  it('still ticks and finishes on a rest shorter than the warning threshold', () => {
    // A 3-second rest gets its ticks and its chime, and never a stray warning.
    const cues = [];
    for (let left = 3; left >= 0; left -= 1) {
      const cue = cueForSecondsLeft(left);
      if (cue) cues.push(cue);
    }
    expect(cues).toEqual(['tick', 'tick', 'tick', 'go']);
  });

  it('treats a negative or non-finite value as safe', () => {
    expect(cueForSecondsLeft(-3)).toBe('go');
    expect(cueForSecondsLeft(Number.NaN)).toBeNull();
  });
});
