/**
 * Hand-rolled SVG charts. One line graph does not justify a dependency, and an inline SVG
 * is the whole implementation.
 *
 * Two views, because they answer different questions:
 *
 *   SessionChart     one point per session — shows the shape of the block. This is the
 *                    default, and the one that looks like the graph people came from.
 *   CumulativeChart  running totals — shows how much work in total. Necessarily smooth.
 *
 * Deloads and misses are marked on both so a dip is legible rather than mysterious.
 */

import type { ReactNode } from 'react';
import type { CumulativePoint, SessionPoint } from '../core/stats.js';

const W = 720;
const H = 240;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

function niceCeil(value: number): number {
  if (value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

const OUTCOME_DOT: Partial<Record<string, string>> = {
  deload: '#fbbf24',
  failed: '#f87171',
  advanced_manually: '#38bdf8',
};

function Empty() {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-slate-400">
      No sessions yet — your first workout starts the chart.
    </div>
  );
}

/**
 * Roughly evenly spaced indices to label, including both ends.
 *
 * Six on a wide screen is about as many MM-DD labels as fit without colliding; below that
 * the count follows the data so a three-session history does not get six labels for three
 * points.
 */
function tickIndices(count: number, wanted = 6): number[] {
  if (count <= 1) return [0];
  const target = Math.min(wanted, count);
  const step = (count - 1) / (target - 1);
  const seen = new Set<number>();
  for (let k = 0; k < target; k += 1) seen.add(Math.round(k * step));
  return [...seen].sort((a, b) => a - b);
}

/** `2026-03-07T…` → `03-07`. Short enough to repeat along an axis. */
function shortDate(iso: string): string {
  return iso.slice(5, 10);
}

/**
 * Shared axis furniture: horizontal grid lines with value labels, plus dated ticks along the
 * bottom.
 *
 * Font sizes are viewBox units, so they scale with the SVG. The larger mobile size exists
 * because at a phone's width the whole 720-unit canvas is squeezed into ~340 real pixels, and
 * an 11-unit label lands at about five pixels — technically drawn, practically unreadable.
 */
function Frame({
  maxY,
  y,
  x,
  dates,
}: {
  maxY: number;
  y: (v: number) => number;
  x: (i: number) => number;
  dates: string[];
}) {
  const ticks = tickIndices(dates.length);
  const lastTick = ticks.at(-1);

  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const v = Math.round(maxY * f);
        return (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#26324b" strokeWidth="1" />
            <text
              x={PAD.left - 8}
              y={y(v) + 5}
              textAnchor="end"
              className="fill-[#7c8aa5] text-[15px] sm:text-[12px]"
            >
              {v}
            </text>
          </g>
        );
      })}

      {ticks.map((i) => (
        <g key={i}>
          <line
            x1={x(i)}
            x2={x(i)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            stroke="#1c2740"
            strokeWidth="1"
          />
          <text
            x={x(i)}
            y={H - 5}
            // Pin the outermost labels inward so neither is clipped at the edge.
            textAnchor={i === 0 ? 'start' : i === lastTick ? 'end' : 'middle'}
            className="fill-[#7c8aa5] text-[15px] sm:text-[12px]"
          >
            {shortDate(dates[i] ?? '')}
          </text>
        </g>
      ))}
    </>
  );
}

function Legend({ children }: { children: ReactNode }) {
  return (
    <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
      {children}
    </figcaption>
  );
}

function Swatch({ colour, dashed = false }: { colour: string; dashed?: boolean }) {
  return dashed ? (
    <span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: colour }} />
  ) : (
    <span className="inline-block h-0.5 w-4" style={{ backgroundColor: colour }} />
  );
}

function Dot({ colour }: { colour: string }) {
  return <span className="inline-block size-2 rounded-full" style={{ backgroundColor: colour }} />;
}

// ── Per-session ─────────────────────────────────────────────────────────────────

export function SessionChart({ points }: { points: SessionPoint[] }) {
  if (points.length === 0) return <Empty />;

  const maxY = niceCeil(
    Math.max(...points.map((p) => Math.max(p.actualTotal, p.targetTotal ?? 0)), 1),
  );
  const stepX = points.length === 1 ? 0 : INNER_W / (points.length - 1);
  const x = (i: number) => PAD.left + (points.length === 1 ? INNER_W / 2 : i * stepX);
  const y = (v: number) => PAD.top + INNER_H - (v / maxY) * INNER_H;

  const line = (pick: (p: SessionPoint) => number | undefined) => {
    // Break the path wherever the value is missing, rather than drawing through the gap and
    // implying a prescription that never existed for an unlinked session.
    let started = false;
    const parts: string[] = [];
    points.forEach((p, i) => {
      const v = pick(p);
      if (v === undefined) {
        started = false;
        return;
      }
      parts.push(`${started ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
      started = true;
    });
    return parts.join(' ');
  };

  const best = Math.max(...points.map((p) => p.actualTotal));
  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-56 w-full min-w-[320px]"
          role="img"
          aria-label={`Reps per session across ${points.length} sessions, best ${best}`}
        >
          <Frame maxY={maxY} y={y} x={x} dates={points.map((p) => p.performedAt)} />

          <path d={line((p) => p.targetTotal)} fill="none" stroke="#64748b" strokeWidth="2" strokeDasharray="5 4" />
          <path d={line((p) => p.actualTotal)} fill="none" stroke="#5eead4" strokeWidth="2.5" />

          {points.map((p, i) => {
            const colour = OUTCOME_DOT[p.outcome];
            return (
              <circle
                key={i}
                cx={x(i)}
                cy={y(p.actualTotal)}
                r={colour ? 3.5 : 2}
                fill={colour ?? '#5eead4'}
              />
            );
          })}
        </svg>
      </div>

      <Legend>
        <span className="inline-flex items-center gap-1.5">
          <Swatch colour="#5eead4" /> reps you did
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch colour="#64748b" dashed /> reps the day asked for
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot colour="#fbbf24" /> deload
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot colour="#f87171" /> missed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot colour="#38bdf8" /> moved on
        </span>
      </Legend>
    </figure>
  );
}

// ── Cumulative ──────────────────────────────────────────────────────────────────

export function CumulativeChart({ points }: { points: CumulativePoint[] }) {
  if (points.length === 0) return <Empty />;

  const maxY = niceCeil(Math.max(...points.map((p) => Math.max(p.actual, p.planned)), 1));
  const stepX = points.length === 1 ? 0 : INNER_W / (points.length - 1);
  const x = (i: number) => PAD.left + (points.length === 1 ? INNER_W / 2 : i * stepX);
  const y = (v: number) => PAD.top + INNER_H - (v / maxY) * INNER_H;

  const path = (pick: (p: CumulativePoint) => number) =>
    points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(pick(p)).toFixed(1)}`)
      .join(' ');

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-56 w-full min-w-[320px]"
          role="img"
          aria-label={`Total reps to date, ${points.at(-1)!.actual} across ${points.length} sessions`}
        >
          <Frame maxY={maxY} y={y} x={x} dates={points.map((p) => p.performedAt)} />

          <path d={path((p) => p.planned)} fill="none" stroke="#64748b" strokeWidth="2" strokeDasharray="5 4" />
          <path d={path((p) => p.actual)} fill="none" stroke="#5eead4" strokeWidth="2.5" />

          {points.map((p, i) => {
            const colour = OUTCOME_DOT[p.outcome];
            return colour ? <circle key={i} cx={x(i)} cy={y(p.actual)} r="3.5" fill={colour} /> : null;
          })}
        </svg>
      </div>

      <Legend>
        <span className="inline-flex items-center gap-1.5">
          <Swatch colour="#5eead4" /> every rep you have done
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch colour="#64748b" dashed /> what the plan asked for
        </span>
      </Legend>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
        Your line normally sits above the plan's, because a repeated day is extra work the plan
        only counts once.
      </p>
    </figure>
  );
}
