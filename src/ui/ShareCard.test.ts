/**
 * The canvas is where a fabricated target would actually reach a human being, so the drawing
 * is tested too, not just the data behind it.
 *
 * jsdom has no 2D context, so these drive `drawShareCard` through a recording stub and assert
 * on what it asked for: which text was painted where, and — for the two polylines — whether the
 * path was broken or drawn straight through a gap.
 */

import { describe, expect, it } from 'vitest';
import type { StatSlot, StatWorkout } from '../core/stats.js';
import { drawShareCard } from './ShareCard.js';
import { buildShareCard, type ShareCardInput } from './shareCardData.js';

interface Painted {
  text: string;
  x: number;
  y: number;
  fill: string;
  size: number;
}

interface Stroked {
  style: string;
  dashed: boolean;
  path: string[];
}

function recorder() {
  const painted: Painted[] = [];
  const stroked: Stroked[] = [];
  let path: string[] = [];

  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    font: '400 16px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    dash: [] as number[],

    fillRect: () => {},
    setLineDash(next: number[]) {
      this.dash = next;
    },
    measureText(text: string) {
      // Close enough for the legend's wrapping arithmetic.
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 16);
      return { width: text.length * size * 0.55 };
    },
    fillText(text: string, x: number, y: number) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 0);
      painted.push({ text, x, y, fill: String(this.fillStyle), size });
    },
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push(`M${Math.round(x)},${Math.round(y)}`);
    },
    lineTo(x: number, y: number) {
      path.push(`L${Math.round(x)},${Math.round(y)}`);
    },
    arc() {
      path.push('A');
    },
    stroke() {
      stroked.push({ style: String(this.strokeStyle), dashed: this.dash.length > 0, path });
    },
    fill: () => {},
  };

  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return {
    canvas,
    painted,
    stroked,
    draw(input: ShareCardInput) {
      drawShareCard(canvas as unknown as HTMLCanvasElement, buildShareCard(input));
    },
  };
}

function slot(n: number, targetTotal: number): StatSlot {
  return { id: `s${n}`, ordinal: n, targetTotal, status: 'completed' };
}

function workout(day: number, actualTotal: number, planSlotId?: string): StatWorkout {
  return {
    performedAt: `2026-03-${String(day).padStart(2, '0')}T08:00:00.000Z`,
    actualTotal,
    durationSeconds: 900,
    outcome: 'completed_as_planned',
    ...(planSlotId === undefined ? {} : { planSlotId }),
  };
}

const slots = [slot(1, 120), slot(2, 130), slot(3, 140)];
/** Middle session belongs to no slot — an import whose prescription is unrecoverable. */
const mixed = [workout(1, 118, 's1'), workout(3, 173), workout(5, 141, 's3')];

const base: ShareCardInput = {
  exerciseLabel: 'Liegestütze',
  workouts: mixed,
  slots,
  daysPerWeek: 3,
};

describe('drawShareCard', () => {
  it('sets the canvas to the fixed share size, whatever it was before', () => {
    const rec = recorder();
    rec.canvas.width = 300;
    rec.canvas.height = 300;
    rec.draw(base);
    // 4:5 portrait — the ratio chat apps show without cropping.
    expect([rec.canvas.width, rec.canvas.height]).toEqual([1080, 1350]);
  });

  it('paints the wordmark and the exercise it is about', () => {
    const rec = recorder();
    rec.draw(base);
    const texts = rec.painted.map((p) => p.text);
    expect(texts).toContain('GODMODE');
    expect(texts).toContain('No More Later');
    expect(texts).toContain('Liegestütze');
  });

  it('states the context it has and invents none it does not', () => {
    const withContext = recorder();
    withContext.draw({ ...base, goal: 100, currentWeek: 4, currentDay: 2 });
    expect(withContext.painted.map((p) => p.text)).toContain('Week 4 · Day 2 · goal 100');

    const without = recorder();
    without.draw(base);
    for (const p of without.painted) {
      expect(p.text).not.toMatch(/Week|Day \d|goal/);
    }
  });

  it('breaks the target line at a session that had no target', () => {
    const rec = recorder();
    rec.draw(base);

    const target = rec.stroked.find((s) => s.style === '#64748b' && s.dashed && s.path.length > 1);
    expect(target).toBeDefined();
    // Two separate starts and nothing joining them: the line is never drawn across the gap,
    // which is what would imply a prescription the middle session never had.
    expect(target!.path.filter((op) => op.startsWith('M'))).toHaveLength(2);
    expect(target!.path.filter((op) => op.startsWith('L'))).toHaveLength(0);

    // The actual line has every session and is continuous.
    const actual = rec.stroked.find((s) => s.style === '#5eead4' && !s.dashed);
    expect(actual!.path.filter((op) => op.startsWith('M'))).toHaveLength(1);
    expect(actual!.path.filter((op) => op.startsWith('L'))).toHaveLength(2);
  });

  it('shows an em dash for the missing target, never the reps that were done', () => {
    const rec = recorder();
    rec.draw(base);
    const texts = rec.painted.map((p) => p.text);

    expect(texts).toContain('—');
    // 173 is the unlinked session's actual. It is painted once, in the reps column, and is
    // never repeated as though it had also been the prescription.
    expect(texts.filter((t) => t === '173')).toHaveLength(1);
    expect(texts).toContain('120');
    expect(texts).toContain('140');
    expect(texts).not.toContain('130'); // that slot's session is the unlinked one

    // The dash sits in the target column, left of the reps it must not be confused with.
    const dash = rec.painted.find((p) => p.text === '—')!;
    const reps = rec.painted.find((p) => p.text === '173')!;
    expect(dash.x).toBeLessThan(reps.x);
    expect(dash.y).toBe(reps.y);
  });

  it('reports the headline figures the app computes', () => {
    const rec = recorder();
    rec.draw(base);
    const texts = rec.painted.map((p) => p.text);
    expect(texts).toContain('REPS');
    expect(texts).toContain(String(118 + 173 + 141));
    expect(texts).toContain('3 sessions');
    expect(texts).toContain('TIME');
    expect(texts).toContain('45:00');
    expect(texts).toContain('STREAK');
  });

  it('offers no kcal figure when there is none', () => {
    const rec = recorder();
    rec.draw(base);
    expect(rec.painted.map((p) => p.text)).not.toContain('KCAL');
  });

  it('says plainly when nothing has been logged, and draws no table', () => {
    const rec = recorder();
    rec.draw({ ...base, workouts: [] });
    const texts = rec.painted.map((p) => p.text);
    expect(texts.some((t) => t.includes('Nothing logged yet'))).toBe(true);
    expect(texts).not.toContain('Target');
    expect(texts).not.toContain('—');
  });

  it('paints no text too small to read at the size this card is looked at', () => {
    const rec = recorder();
    rec.draw({ ...base, goal: 100, currentWeek: 4, currentDay: 2 });
    expect(rec.painted.length).toBeGreaterThan(20);
    for (const p of rec.painted) {
      expect(p.size).toBeGreaterThanOrEqual(28);
    }
  });

  it('keeps everything it paints inside the card', () => {
    const rec = recorder();
    rec.draw(base);
    for (const p of rec.painted) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1080);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1350);
    }
  });
});
