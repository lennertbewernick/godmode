/**
 * Rest policies. Rest is orthogonal to progression, so patterns do not reimplement
 * clamping, rounding, or overrides.
 */

import type { RestContext, RestPolicy, RestPrescription } from '../contracts.js';
import { clamp, roundToStep } from '../rounding.js';

export interface VolumeDerivedRestParams {
  /** Seconds of rest per unit of session volume. */
  slope: number;
  intercept: number;
  minSeconds: number;
  maxSeconds: number;
  roundToSeconds: number;
}

/**
 * The reference curve (PLAN.md §1.5). This is algebra through two assumed endpoints —
 * 30s at volume 37, 150s at volume 205 — giving slope (150-30)/(205-37) ≈ 0.71.
 * It is a product default, NOT measured incumbent behaviour: the source CSV bundles work
 * and rest into one aggregate duration, so rest cannot be separated from rep pace.
 */
export const DEFAULT_VOLUME_REST_PARAMS: VolumeDerivedRestParams = {
  slope: 0.71,
  intercept: 4,
  minSeconds: 30,
  maxSeconds: 180,
  roundToSeconds: 5,
};

export const VOLUME_DERIVED_REST_ID = 'volume-derived-rest';
export const VOLUME_DERIVED_REST_VERSION = 1;

export function restSecondsForVolume(volume: number, params: VolumeDerivedRestParams): number {
  const raw = params.slope * volume + params.intercept;
  return clamp(
    roundToStep(raw, params.roundToSeconds),
    params.minSeconds,
    params.maxSeconds,
  );
}

export const volumeDerivedRestPolicy: RestPolicy<VolumeDerivedRestParams> = {
  id: VOLUME_DERIVED_REST_ID,
  version: VOLUME_DERIVED_REST_VERSION,
  prescribe(context: RestContext, params: VolumeDerivedRestParams): RestPrescription {
    const restSeconds = restSecondsForVolume(context.targetTotal, params);
    return {
      restSeconds,
      // No rest after the final set — the session is over.
      restAfterSeconds: context.targets.map((_, i) =>
        i === context.targets.length - 1 ? 0 : restSeconds,
      ),
    };
  },
};

export interface FixedRestParams {
  restSeconds: number;
}

export const FIXED_REST_ID = 'fixed-rest';

/** Escape hatch for users who want one number and no curve. */
export const fixedRestPolicy: RestPolicy<FixedRestParams> = {
  id: FIXED_REST_ID,
  version: 1,
  prescribe(context: RestContext, params: FixedRestParams): RestPrescription {
    return {
      restSeconds: params.restSeconds,
      restAfterSeconds: context.targets.map((_, i) =>
        i === context.targets.length - 1 ? 0 : params.restSeconds,
      ),
    };
  },
};
