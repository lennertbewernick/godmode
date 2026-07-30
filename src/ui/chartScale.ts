/**
 * Scale and axis helpers shared by the SVG chart and the canvas share card.
 *
 * These lived inside `Chart.tsx` until the card needed to draw the same graph on a canvas.
 * Extracting them is the only thing keeping the two renderers from drifting: the card is
 * supposed to be recognisably the app's own chart, and it stops being that the moment one of
 * them picks a different ceiling or a different date format.
 */

import type { WorkoutOutcome } from '../core/types.js';

/**
 * A readable y-axis top and gridline step for a maximum value.
 *
 * Rounding up to the next power of ten wastes the plot: a 205-rep peak became a 300 ceiling and
 * the data used two thirds of the height. Picking the step first and the ceiling from it gives
 * 250 instead, with lines at 0/50/100/150/200/250.
 *
 * Steps are restricted to 1, 2, 5 and 10 times a power of ten — deliberately no 2.5, because
 * reps are integers and a 2.5 step produces gridlines like 12.5.
 */
export function niceScale(max: number, targetLines = 5): { top: number; step: number } {
  if (!Number.isFinite(max) || max <= 0) return { top: 10, step: 5 };
  const rough = max / targetLines;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  return { top: Math.ceil(max / step) * step, step };
}

export const OUTCOME_DOT: Partial<Record<string, string>> = {
  deload: '#fbbf24',
  failed: '#f87171',
  advanced_manually: '#38bdf8',
};

/** How an outcome is worded, wherever it is worded. One vocabulary, one place. */
export const OUTCOME_LABEL: Record<WorkoutOutcome, string> = {
  completed_as_planned: 'as planned',
  scaled_up: 'scaled up',
  deload: 'deload',
  failed: 'missed',
  advanced_manually: 'moved on',
};

/** Roughly evenly spaced indices to label, both ends included. */
export function tickIndices(count: number, wanted: number): number[] {
  if (count <= 1) return [0];
  const target = Math.min(wanted, count);
  const step = (count - 1) / (target - 1);
  const seen = new Set<number>();
  for (let k = 0; k < target; k += 1) seen.add(Math.round(k * step));
  return [...seen].sort((a, b) => a - b);
}

/** `2026-03-07T…` → `03-07`. Short enough to repeat along an axis. */
export function shortDate(iso: string): string {
  return iso.slice(5, 10);
}
