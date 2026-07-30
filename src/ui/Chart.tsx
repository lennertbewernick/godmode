/**
 * Hand-rolled SVG cumulative chart. One line graph does not justify a dependency, and a
 * strict-CSP-friendly inline SVG is the whole implementation.
 *
 * Two series, visually distinguished (STAT-02): `actual` includes every attempt and deload,
 * `planned` advances once per slot. Deloads and failures are marked on the actual line so a
 * flat stretch is legible rather than mysterious.
 */

import type { CumulativePoint } from '../core/stats.js';

const W = 720;
const H = 240;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

function niceCeil(value: number): number {
  if (value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

export function CumulativeChart({ points }: { points: CumulativePoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-400">
        No sessions yet — your first workout starts the chart.
      </div>
    );
  }

  const maxY = niceCeil(Math.max(...points.map((p) => Math.max(p.actual, p.planned)), 1));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const stepX = points.length === 1 ? 0 : innerW / (points.length - 1);

  const x = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : i * stepX);
  const y = (v: number) => PAD.top + innerH - (v / maxY) * innerH;

  const path = (pick: (p: CumulativePoint) => number) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(pick(p)).toFixed(1)}`).join(' ');

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxY * f));
  const firstDate = points[0]!.performedAt.slice(0, 10);
  const lastDate = points.at(-1)!.performedAt.slice(0, 10);

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-56 w-full min-w-[320px]"
          role="img"
          aria-label={`Cumulative reps from ${firstDate} to ${lastDate}, ${points.at(-1)!.actual} total`}
        >
          {gridValues.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(v)}
                y2={y(v)}
                stroke="#26324b"
                strokeWidth="1"
              />
              <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#7c8aa5">
                {v}
              </text>
            </g>
          ))}

          <path d={path((p) => p.planned)} fill="none" stroke="#64748b" strokeWidth="2" strokeDasharray="5 4" />
          <path d={path((p) => p.actual)} fill="none" stroke="#5eead4" strokeWidth="2.5" />

          {points.map((p, i) =>
            p.outcome === 'deload' || p.outcome === 'failed' ? (
              <circle
                key={i}
                cx={x(i)}
                cy={y(p.actual)}
                r="3"
                fill={p.outcome === 'deload' ? '#fbbf24' : '#f87171'}
              />
            ) : null,
          )}

          <text x={PAD.left} y={H - 6} fontSize="11" fill="#7c8aa5">
            {firstDate}
          </text>
          <text x={W - PAD.right} y={H - 6} fontSize="11" fill="#7c8aa5" textAnchor="end">
            {lastDate}
          </text>
        </svg>
      </div>

      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-teal-300" /> actual (every attempt)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-slate-500" /> planned
          (once per day)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-amber-400" /> deload
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-red-400" /> missed
        </span>
      </figcaption>
    </figure>
  );
}
