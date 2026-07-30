/**
 * The `percentage-ramp` pattern — the Just 6 Weeks progression scheme.
 *
 * Each session prescribes fixed percentages of a *generation max* that ramps geometrically
 * from a baseline to a goal:
 *
 *   M(n)  = baseline * (goal / baseline) ^ ((n - 1) / (N - 1))
 *   set_i = roundHalfUp(M(n) * coefficient_i)
 *
 * VERIFIED at both endpoints (PLAN.md §1.1):
 *   M=18  -> 7·8·7·6·9+    total 37
 *   M=100 -> 37·47·37·33·51+ total 205
 *
 * NOT verified in between. This curve reproduces 5 of the 18 reference slots exactly and
 * runs high on slots 2-11. It ships because it is inspectable and adjustable, not because
 * it is what the incumbent computes.
 *
 * `goalMax` is a generation coordinate, NOT a capability claim. A challenge with goal 100
 * asserts only "derive the final card from 100" — never "the athlete can do 100 in a row".
 */

import type { NextSlot, ProgramPattern, RestPolicy } from '../contracts.js';
import type { PlanSlotSpec, SetRole, SetTarget } from '../types.js';
import { repsFor } from '../rounding.js';
import {
  DEFAULT_VOLUME_REST_PARAMS,
  volumeDerivedRestPolicy,
  type VolumeDerivedRestParams,
} from '../policies/rest.js';

export const PERCENTAGE_RAMP_ID = 'percentage-ramp';
export const PERCENTAGE_RAMP_VERSION = 1;

export interface PercentageRampParams {
  /** One coefficient per set, applied to the slot's generation max. */
  coefficients: number[];
  roles: SetRole[];
  /** 0-based indices of open-ended sets. Empty is valid; several are valid. */
  amrapIndices: number[];
  /** Starting generation max — normally a tested baseline. */
  baselineMax: number;
  /** Generation max at the final session. Equal to baselineMax gives a fixed-load plan. */
  goalMax: number;
  weeks: number;
  daysPerWeek: number;
}

export interface PercentageRampState {
  nextOrdinal: number;
}

/**
 * The Just 6 Weeks push-up template. Coefficients sum to 2.05, which is why a goal of 100
 * produces a 205-rep terminal session.
 */
export const PUSHUP_5SET_TEMPLATE = {
  id: 'pushup-5set',
  label: 'Push-ups (5 sets)',
  patternId: PERCENTAGE_RAMP_ID,
  coefficients: [0.37, 0.47, 0.37, 0.33, 0.51],
  roles: ['medium', 'big', 'medium', 'small', 'amrap'] as SetRole[],
  amrapIndices: [4],
} as const;

/** Build params for the reference template. */
export function pushupParams(
  baselineMax: number,
  goalMax: number,
  weeks = 6,
  daysPerWeek = 3,
): PercentageRampParams {
  return {
    coefficients: [...PUSHUP_5SET_TEMPLATE.coefficients],
    roles: [...PUSHUP_5SET_TEMPLATE.roles],
    amrapIndices: [...PUSHUP_5SET_TEMPLATE.amrapIndices],
    baselineMax,
    goalMax,
    weeks,
    daysPerWeek,
  };
}

/**
 * The generation max at session `ordinal` (1-based) of `sessions` total.
 *
 * When `goalMax === baselineMax` the ratio is 1, so every session returns the baseline —
 * a flat *fixed-load* plan with no special-casing. Note this is deliberately NOT called
 * "maintenance": a real maintenance program varies stimulus, periodises, and retests. An
 * identical session forever is a degenerate fixed load, useful but not a training model.
 */
export function generationMaxAt(
  ordinal: number,
  sessions: number,
  baselineMax: number,
  goalMax: number,
): number {
  if (sessions < 1) throw new RangeError(`sessions must be >= 1, received ${sessions}`);
  if (!(baselineMax > 0)) throw new RangeError(`baselineMax must be > 0, received ${baselineMax}`);
  if (!(goalMax > 0)) throw new RangeError(`goalMax must be > 0, received ${goalMax}`);
  if (ordinal < 1 || ordinal > sessions) {
    throw new RangeError(`ordinal ${ordinal} out of range 1..${sessions}`);
  }
  if (sessions === 1) return goalMax;
  return baselineMax * Math.pow(goalMax / baselineMax, (ordinal - 1) / (sessions - 1));
}

function validateParams(params: PercentageRampParams): void {
  const { coefficients, roles, amrapIndices, weeks, daysPerWeek } = params;
  if (coefficients.length === 0) throw new RangeError('coefficients must not be empty');
  if (coefficients.length !== roles.length) {
    throw new RangeError(
      `coefficients (${coefficients.length}) and roles (${roles.length}) must match in length`,
    );
  }
  if (coefficients.some((c) => !(c > 0))) throw new RangeError('every coefficient must be > 0');
  for (const i of amrapIndices) {
    if (!Number.isInteger(i) || i < 0 || i >= coefficients.length) {
      throw new RangeError(`amrapIndex ${i} out of range 0..${coefficients.length - 1}`);
    }
  }
  if (new Set(amrapIndices).size !== amrapIndices.length) {
    throw new RangeError('amrapIndices must not contain duplicates');
  }
  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new RangeError(`weeks must be a positive integer, received ${weeks}`);
  }
  if (!Number.isInteger(daysPerWeek) || daysPerWeek < 1) {
    throw new RangeError(`daysPerWeek must be a positive integer, received ${daysPerWeek}`);
  }
}

/** Build set targets for a given generation max. Exported for invariant testing. */
export function targetsForMax(
  generationMax: number,
  shape: Pick<PercentageRampParams, 'coefficients' | 'roles' | 'amrapIndices'>,
): SetTarget[] {
  const amrap = new Set(shape.amrapIndices);
  return shape.coefficients.map((coefficient, i) => ({
    index: i + 1,
    targetKind: 'reps' as const,
    // A prescribed set is never zero reps — "do 0" is a bug, not a rest set.
    reps: Math.max(1, repsFor(generationMax, coefficient)),
    role: shape.roles[i]!,
    isAmrap: amrap.has(i),
  }));
}

/**
 * The pattern. Deterministic, so `next()` ignores `history` — but the signature accepts it
 * so an adaptive successor pattern can use it without changing the interface.
 */
export function createPercentageRampPattern(
  restPolicy: RestPolicy<VolumeDerivedRestParams> = volumeDerivedRestPolicy,
  restParams: VolumeDerivedRestParams = DEFAULT_VOLUME_REST_PARAMS,
): ProgramPattern<PercentageRampParams, PercentageRampState> {
  return {
    id: PERCENTAGE_RAMP_ID,
    version: PERCENTAGE_RAMP_VERSION,

    plannedSessionCount(params) {
      validateParams(params);
      return params.weeks * params.daysPerWeek;
    },

    initialState(params) {
      validateParams(params);
      return { nextOrdinal: 1 };
    },

    next({ params, state }): NextSlot<PercentageRampState> | null {
      validateParams(params);
      const sessions = params.weeks * params.daysPerWeek;
      const ordinal = state.nextOrdinal;
      if (ordinal > sessions) return null;

      const generationMax = generationMaxAt(
        ordinal,
        sessions,
        params.baselineMax,
        params.goalMax,
      );
      const targets = targetsForMax(generationMax, params);
      const targetTotal = targets.reduce((sum, t) => sum + t.reps, 0);

      const rest = restPolicy.prescribe({ ordinal, targets, targetTotal }, restParams);
      const withRest: SetTarget[] = targets.map((t, i) => {
        const perSet = rest.restAfterSeconds?.[i];
        return perSet === undefined ? t : { ...t, restAfterSeconds: perSet };
      });

      const slot: PlanSlotSpec = {
        ordinal,
        week: Math.floor((ordinal - 1) / params.daysPerWeek) + 1,
        day: ((ordinal - 1) % params.daysPerWeek) + 1,
        targets: withRest,
        targetTotal,
        restSeconds: rest.restSeconds,
        patternMetrics: { generationMax },
      };

      return {
        slot,
        nextState: { nextOrdinal: ordinal + 1 },
        decision: {
          patternId: PERCENTAGE_RAMP_ID,
          patternVersion: PERCENTAGE_RAMP_VERSION,
          ordinal,
          sessions,
          generationMax,
          restPolicyId: restPolicy.id,
          restPolicyVersion: restPolicy.version,
        },
      };
    },
  };
}

export const percentageRampPattern = createPercentageRampPattern();
