import { describe, expect, it } from 'vitest';
import {
  classifyOutcome,
  manualAdvance,
  totalRepsAtLeastTargetPolicy as policy,
} from './evaluation.js';
import type { PlanSlotSpec, WorkoutPerformance, AdjustmentType } from '../types.js';

const slot = (targetTotal: number): PlanSlotSpec => ({
  ordinal: 1,
  week: 1,
  day: 1,
  targets: [],
  targetTotal,
  restSeconds: 60,
});

const perf = (
  actualTotal: number,
  adjustmentType: AdjustmentType = 'none',
  effectiveTotal = actualTotal,
): WorkoutPerformance => ({
  sets: [],
  actualTotal,
  adjustmentType,
  effectiveTotal,
});

describe('GEN-09 — pass rule is the TOTAL, verified against the reference CSV', () => {
  it('passes when actual meets the target exactly', () => {
    // W4D2 repeated four times, passing exactly at 108.
    const r = policy.evaluate(slot(108), perf(108));
    expect(r).toMatchObject({ satisfied: true, advances: true });
  });

  it('passes when actual exceeds the target', () => {
    expect(policy.evaluate(slot(108), perf(120))).toMatchObject({
      satisfied: true,
      advances: true,
    });
  });

  it('fails one rep short, reproducing the 2026-06-09 repeat', () => {
    // 10·13·10·9·13 = 55 against 56 -> repeated; next attempt 56 -> passed.
    const failed = policy.evaluate(slot(56), perf(55));
    expect(failed).toMatchObject({ satisfied: false, advances: false });
    expect(failed.reason).toContain('1 rep short');
    expect(policy.evaluate(slot(56), perf(56)).satisfied).toBe(true);
  });

  it('fails the final reference session at 202 against 205', () => {
    const r = policy.evaluate(slot(205), perf(202));
    expect(r).toMatchObject({ satisfied: false, advances: false });
    expect(r.reason).toContain('3 reps short');
    expect(r.measured.shortfall).toBe(3);
  });

  it('pluralises the shortfall correctly', () => {
    expect(policy.evaluate(slot(100), perf(99)).reason).toContain('1 rep short');
    expect(policy.evaluate(slot(100), perf(98)).reason).toContain('2 reps short');
  });
});

describe('the deload rule — counted, but never advances', () => {
  it('does not advance a downward-rescaled session even if the lowered total was met', () => {
    // Prescribed 205, user scaled down to 150, performed 150. The lowered total was met,
    // but the ratchet must not open — otherwise scaling down is a back door to progress.
    const r = policy.evaluate(slot(205), perf(150, 'scaled_down', 150));
    expect(r.satisfied).toBe(false);
    expect(r.advances).toBe(false);
    expect(r.reason).toContain('Deload logged');
    expect(r.reason).toContain('stays next');
  });

  it('judges a deload against the ORIGINAL prescription, not the lowered one', () => {
    const r = policy.evaluate(slot(205), perf(150, 'scaled_down', 150));
    expect(r.measured.prescribedTotal).toBe(205);
    expect(r.measured.effectiveTotal).toBe(150);
  });

  it('redistribution at constant total does not affect pass/fail', () => {
    const redistributed = policy.evaluate(slot(205), perf(205, 'redistributed', 205));
    expect(redistributed).toMatchObject({ satisfied: true, advances: true });
  });

  it('scaling up passes normally', () => {
    expect(policy.evaluate(slot(205), perf(230, 'scaled_up', 230))).toMatchObject({
      satisfied: true,
      advances: true,
    });
  });
});

describe('manual advance — the escape hatch from a deload loop', () => {
  it('advances without claiming the session was satisfied', () => {
    const r = manualAdvance(slot(205), perf(150, 'scaled_down', 150));
    expect(r.satisfied).toBe(false);
    expect(r.advances).toBe(true);
    expect(r.reason).toContain('Advanced manually');
  });
});

describe('outcome classification is separate from the evaluation verdict', () => {
  const pass = { satisfied: true, advances: true, reason: '', measured: {} };
  const fail = { satisfied: false, advances: false, reason: '', measured: {} };

  it('labels each of the five outcomes', () => {
    expect(classifyOutcome(pass, 'none', false)).toBe('completed_as_planned');
    expect(classifyOutcome(pass, 'scaled_up', false)).toBe('scaled_up');
    expect(classifyOutcome(fail, 'scaled_down', false)).toBe('deload');
    expect(classifyOutcome(fail, 'none', false)).toBe('failed');
    expect(classifyOutcome(fail, 'scaled_down', true)).toBe('advanced_manually');
  });

  it('treats manual advance as overriding every other label', () => {
    expect(classifyOutcome(pass, 'none', true)).toBe('advanced_manually');
  });

  it('treats redistribution at target as completed_as_planned', () => {
    expect(classifyOutcome(pass, 'redistributed', false)).toBe('completed_as_planned');
  });
});
