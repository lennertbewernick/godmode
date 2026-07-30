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
 *
 * Both measure their container and draw at that size, rather than drawing at a fixed size and
 * letting the browser scale the result. A scaled SVG scales its text and strokes too, so one
 * label size becomes five pixels on a phone and eighteen on a desktop — the chart looked "kind
 * of fixed" because it was. Measuring means one SVG unit is one CSS pixel everywhere, so type
 * stays put, strokes stay honest, and the height, tick count and marker density can each
 * follow the width.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CumulativePoint, SessionPoint } from '../core/stats.js';

/** Observe an element's content width. Returns 0 until the first measurement lands. */
function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured !== undefined) setWidth(Math.round(measured));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

interface Geometry {
  w: number;
  h: number;
  pad: { top: number; right: number; bottom: number; left: number };
  innerW: number;
  innerH: number;
  tickCount: number;
  fontSize: number;
}

/**
 * Chart geometry for a measured width.
 *
 * Height grows with width in steps rather than holding one aspect ratio. A fixed 3:1 looks
 * cramped on a phone and absurd stretched across a desktop column; stepping it keeps the line's
 * angles readable at both ends.
 */
function geometry(width: number): Geometry {
  const w = Math.max(240, width);
  const h = w < 420 ? 200 : w < 768 ? 240 : w < 1024 ? 280 : 320;
  // Four digits of cumulative reps need the room; a phone has none to spare.
  const left = w < 380 ? 32 : 44;
  const pad = { top: 12, right: 12, bottom: 26, left };
  return {
    w,
    h,
    pad,
    innerW: w - pad.left - pad.right,
    innerH: h - pad.top - pad.bottom,
    tickCount: w < 360 ? 3 : w < 560 ? 4 : w < 900 ? 5 : 7,
    fontSize: w < 380 ? 10 : 12,
  };
}

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
function niceScale(max: number, targetLines = 5): { top: number; step: number } {
  if (!Number.isFinite(max) || max <= 0) return { top: 10, step: 5 };
  const rough = max / targetLines;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  return { top: Math.ceil(max / step) * step, step };
}

const OUTCOME_DOT: Partial<Record<string, string>> = {
  deload: '#fbbf24',
  failed: '#f87171',
  advanced_manually: '#38bdf8',
};

/** Roughly evenly spaced indices to label, both ends included. */
function tickIndices(count: number, wanted: number): number[] {
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

function Empty() {
  return (
    <div className="flex h-40 items-center justify-center text-center text-sm text-slate-400">
      No sessions yet — your first workout starts the chart.
    </div>
  );
}

/** Horizontal grid with value labels, plus dated ticks along the bottom. */
function Frame({
  g,
  scale,
  y,
  x,
  dates,
}: {
  g: Geometry;
  scale: { top: number; step: number };
  y: (v: number) => number;
  x: (i: number) => number;
  dates: string[];
}) {
  const ticks = tickIndices(dates.length, g.tickCount);
  const lastTick = ticks.at(-1);

  const values: number[] = [];
  for (let v = 0; v <= scale.top; v += scale.step) values.push(v);

  return (
    <>
      {values.map((v) => (
        <g key={v}>
          <line
            x1={g.pad.left}
            x2={g.w - g.pad.right}
            y1={y(v)}
            y2={y(v)}
            stroke="#26324b"
            strokeWidth="1"
          />
          <text
            x={g.pad.left - 6}
            y={y(v) + g.fontSize / 3}
            textAnchor="end"
            fontSize={g.fontSize}
            fill="#7c8aa5"
          >
            {v}
          </text>
        </g>
      ))}

      {ticks.map((i) => (
        <g key={i}>
          <line
            x1={x(i)}
            x2={x(i)}
            y1={g.pad.top}
            y2={g.h - g.pad.bottom}
            stroke="#1c2740"
            strokeWidth="1"
          />
          <text
            x={x(i)}
            y={g.h - 6}
            // Pin the outermost labels inward so neither is clipped at the edge.
            textAnchor={i === 0 ? 'start' : i === lastTick ? 'end' : 'middle'}
            fontSize={g.fontSize}
            fill="#7c8aa5"
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
    <span
      className="inline-block h-0 w-4 border-t-2 border-dashed"
      style={{ borderColor: colour }}
    />
  ) : (
    <span className="inline-block h-0.5 w-4" style={{ backgroundColor: colour }} />
  );
}

function Dot({ colour }: { colour: string }) {
  return <span className="inline-block size-2 rounded-full" style={{ backgroundColor: colour }} />;
}

/**
 * Shared shell: owns the measurement, and reserves the height before the first measurement
 * lands so the surrounding layout does not jump when the chart appears.
 */
function Plot({
  width,
  containerRef,
  label,
  children,
  legend,
  note,
}: {
  width: number;
  containerRef: RefObject<HTMLDivElement | null>;
  label: string;
  children: (g: Geometry) => ReactNode;
  legend: ReactNode;
  note?: ReactNode;
}) {
  const g = geometry(width || 720);
  return (
    <figure className="m-0">
      <div ref={containerRef} className="w-full" style={{ minHeight: g.h }}>
        {width > 0 ? (
          <svg viewBox={`0 0 ${g.w} ${g.h}`} width="100%" height={g.h} role="img" aria-label={label}>
            {children(g)}
          </svg>
        ) : null}
      </div>
      <Legend>{legend}</Legend>
      {note}
    </figure>
  );
}

// ── Per-session ─────────────────────────────────────────────────────────────────

export function SessionChart({ points }: { points: SessionPoint[] }) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  if (points.length === 0) return <Empty />;

  const best = Math.max(...points.map((p) => p.actualTotal));

  return (
    <Plot
      width={width}
      containerRef={containerRef}
      label={`Reps per session across ${points.length} sessions, best ${best}`}
      legend={
        <>
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
        </>
      }
    >
      {(g) => {
        const scale = niceScale(
          Math.max(...points.map((p) => Math.max(p.actualTotal, p.targetTotal ?? 0)), 1),
        );
        const stepX = points.length === 1 ? 0 : g.innerW / (points.length - 1);
        const x = (i: number) => g.pad.left + (points.length === 1 ? g.innerW / 2 : i * stepX);
        const y = (v: number) => g.pad.top + g.innerH - (v / scale.top) * g.innerH;

        const line = (pick: (p: SessionPoint) => number | undefined) => {
          // Break the path wherever the value is missing, rather than drawing through the gap
          // and implying a prescription that never existed for an unlinked session.
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

        // Markers merge into a smear once they are closer than a few pixels. Below that, keep
        // only the ones that carry information.
        const showPlainDots = stepX >= 12;

        return (
          <>
            <Frame g={g} scale={scale} y={y} x={x} dates={points.map((p) => p.performedAt)} />
            <path
              d={line((p) => p.targetTotal)}
              fill="none"
              stroke="#64748b"
              strokeWidth="2"
              strokeDasharray="5 4"
            />
            <path
              d={line((p) => p.actualTotal)}
              fill="none"
              stroke="#5eead4"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            {points.map((p, i) => {
              const colour = OUTCOME_DOT[p.outcome];
              if (!colour && !showPlainDots) return null;
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
          </>
        );
      }}
    </Plot>
  );
}

// ── Cumulative ──────────────────────────────────────────────────────────────────

export function CumulativeChart({ points }: { points: CumulativePoint[] }) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  if (points.length === 0) return <Empty />;

  return (
    <Plot
      width={width}
      containerRef={containerRef}
      label={`Total reps to date, ${points.at(-1)!.actual} across ${points.length} sessions`}
      legend={
        <>
          <span className="inline-flex items-center gap-1.5">
            <Swatch colour="#5eead4" /> every rep you have done
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Swatch colour="#64748b" dashed /> what the plan asked for
          </span>
        </>
      }
      note={
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          Your line normally sits above the plan's, because a repeated day is extra work the plan
          only counts once.
        </p>
      }
    >
      {(g) => {
        const scale = niceScale(Math.max(...points.map((p) => Math.max(p.actual, p.planned)), 1));
        const stepX = points.length === 1 ? 0 : g.innerW / (points.length - 1);
        const x = (i: number) => g.pad.left + (points.length === 1 ? g.innerW / 2 : i * stepX);
        const y = (v: number) => g.pad.top + g.innerH - (v / scale.top) * g.innerH;

        const path = (pick: (p: CumulativePoint) => number) =>
          points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(pick(p)).toFixed(1)}`)
            .join(' ');

        return (
          <>
            <Frame g={g} scale={scale} y={y} x={x} dates={points.map((p) => p.performedAt)} />
            <path
              d={path((p) => p.planned)}
              fill="none"
              stroke="#64748b"
              strokeWidth="2"
              strokeDasharray="5 4"
            />
            <path
              d={path((p) => p.actual)}
              fill="none"
              stroke="#5eead4"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            {points.map((p, i) => {
              const colour = OUTCOME_DOT[p.outcome];
              return colour ? (
                <circle key={i} cx={x(i)} cy={y(p.actual)} r="3.5" fill={colour} />
              ) : null;
            })}
          </>
        );
      }}
    </Plot>
  );
}
