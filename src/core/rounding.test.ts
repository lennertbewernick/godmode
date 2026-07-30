import { describe, expect, it } from 'vitest';
import { clamp, repsFor, roundHalfUp, roundToStep } from './rounding.js';

describe('GEN-07 — rounding is pinned, not inherited', () => {
  it('rounds half away from zero, unlike Math.round on negatives', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(3.5)).toBe(4);
    expect(roundHalfUp(-2.5)).toBe(-3); // Math.round(-2.5) is -2
    expect(Math.round(-2.5)).toBe(-2); // documents the difference we are avoiding
  });

  it('differs from banker\'s rounding at .5', () => {
    // Banker's would give 2 for 2.5 and 4 for 3.5; half-up gives 3 and 4.
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
  });

  it('rounds decimal .5 correctly despite float representation', () => {
    // 1.005 * 100 is 100.49999999999999 in IEEE-754; decimal arithmetic says 100.5 -> 101.
    expect(roundHalfUp(1.005 * 100)).toBe(101);
    // 0.37 * 300 is 111.00000000000001; must not become 112.
    expect(roundHalfUp(0.37 * 300)).toBe(111);
  });

  it('handles ordinary values without surprises', () => {
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(0.4)).toBe(0);
    expect(roundHalfUp(0.6)).toBe(1);
    expect(roundHalfUp(99.49)).toBe(99);
  });

  it('rejects non-finite input rather than silently producing NaN', () => {
    expect(() => roundHalfUp(Number.NaN)).toThrow(RangeError);
    expect(() => roundHalfUp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('repsFor — the exact boundary cases that drive the set shape', () => {
  it('produces the verified baseline card from M=18', () => {
    expect([0.37, 0.47, 0.37, 0.33, 0.51].map((c) => repsFor(18, c))).toEqual([7, 8, 7, 6, 9]);
  });

  it('produces the verified goal card from M=100', () => {
    expect([0.37, 0.47, 0.37, 0.33, 0.51].map((c) => repsFor(100, c))).toEqual([
      37, 47, 37, 33, 51,
    ]);
  });

  it('rounds exact .5 products up', () => {
    // 0.5 * 5 = 2.5 -> 3
    expect(repsFor(5, 0.5)).toBe(3);
    // 0.25 * 6 = 1.5 -> 2
    expect(repsFor(6, 0.25)).toBe(2);
  });

  it('is deterministic across repeated calls', () => {
    for (let m = 1; m <= 300; m += 1) {
      expect(repsFor(m, 0.47)).toBe(repsFor(m, 0.47));
    }
  });
});

describe('roundToStep', () => {
  it('rounds to the nearest multiple', () => {
    expect(roundToStep(31, 5)).toBe(30);
    expect(roundToStep(32.5, 5)).toBe(35); // half-up
    expect(roundToStep(33, 5)).toBe(35);
    expect(roundToStep(0, 5)).toBe(0);
  });

  it('rejects a non-positive step', () => {
    expect(() => roundToStep(10, 0)).toThrow(RangeError);
    expect(() => roundToStep(10, -5)).toThrow(RangeError);
  });
});

describe('clamp', () => {
  it('bounds values inclusively', () => {
    expect(clamp(5, 10, 20)).toBe(10);
    expect(clamp(25, 10, 20)).toBe(20);
    expect(clamp(15, 10, 20)).toBe(15);
  });

  it('rejects an inverted range instead of silently returning nonsense', () => {
    expect(() => clamp(15, 20, 10)).toThrow(RangeError);
  });
});
