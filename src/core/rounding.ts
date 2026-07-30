/**
 * Rounding is pinned explicitly and must never be left to `Math.round` on a float.
 *
 * Why this file exists (PLAN.md §1.2, GEN-07): the set-ordering invariant is sensitive at
 * `.5` boundaries, and three plausible rules disagree there:
 *
 *   value   Math.round   half-up (this)   banker's
 *   2.5     3            3                2
 *   -2.5    -2           -3               -2
 *   0.47*5  2.35 -> 2    2                2
 *
 * `Math.round(-2.5)` is `-2` because it rounds toward +Infinity, not away from zero. We
 * never generate negative reps, but relying on that accidentally is how a rule drifts.
 *
 * Float representation is the second hazard. `0.37 * 300` is `111.00000000000001`, and
 * `1.005 * 100` is `100.49999999999999` — so a naive `Math.round(x * c)` can round the wrong
 * way for values that are exactly `.5` in decimal. We scale through an integer-safe epsilon
 * correction before deciding.
 */

/** Number of decimal digits we trust in coefficient arithmetic. */
const PRECISION = 9;
const EPSILON = 10 ** -PRECISION;

/**
 * Round half away from zero, on the *decimal* value rather than its float artifact.
 *
 * Correcting by EPSILON before flooring pulls values that are mathematically `.5` but
 * represented as `.49999999999` back onto the boundary, so they round up as decimal
 * arithmetic says they should.
 */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`roundHalfUp received a non-finite value: ${value}`);
  }
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  return sign * Math.floor(magnitude + 0.5 + EPSILON);
}

/** Multiply a max by a coefficient and round to whole reps. */
export function repsFor(estimatedMax: number, coefficient: number): number {
  return roundHalfUp(estimatedMax * coefficient);
}

/** Round to the nearest multiple of `step`, half away from zero. */
export function roundToStep(value: number, step: number): number {
  if (step <= 0) throw new RangeError(`step must be positive, received ${step}`);
  return roundHalfUp(value / step) * step;
}

/** Clamp into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError(`min ${min} exceeds max ${max}`);
  return Math.min(Math.max(value, min), max);
}
