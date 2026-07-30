/**
 * The share card: one 1080x1350 PNG, drawn on a canvas, for posting into a group chat.
 *
 * The chart is redrawn in canvas 2D rather than rasterised from the existing SVG. An SVG taken
 * through an `<img>` loses the page's CSS and its font stack, so the text comes out in whatever
 * the platform falls back to — which on some devices is a serif at the wrong size. Redrawing
 * costs a hundred lines and renders identically everywhere.
 *
 * Only system font families are named, and no asset is fetched, so the card is produced with
 * the network off. Everything it states is a number `core/stats` already computed — see
 * `shareCardData.ts`, which does the assembly and is where the selection rules are tested.
 *
 * `ShareCardPreview` is a panel, not a dialog: it renders inside the export sheet's Modal, so
 * the app still has exactly one dialog pattern.
 *
 * Revised 2026-07-30 after looking at the first one: the chart is a single line of reps done,
 * with no dashed prescription and no outcome dots, and there is no legend. Five things to decode
 * is right for the History tab, where you are asking a question; it is wrong for an image
 * someone glances at in a chat. The prescription and the outcome words did not disappear — they
 * moved to where they can be read, in the table underneath.
 *
 * Revised a third time: the outcome words left the table too. The app's History tab keeps all of
 * it — the dashed prescription, the coloured dots, the legend, the outcome labels — because that
 * is the surface where you work out *why* a day went the way it did. This one goes to people
 * with no context, who get one glance. The divergence is the design, not drift.
 *
 * Revised again the same day: the week/day/goal subtitle is gone and the headline figures took
 * its place, directly under the exercise name. A card is read top-down and stops being read
 * early, so the numbers someone would actually repeat out loud now sit where the eye already is
 * rather than at the far end.
 */

import { useEffect, useState } from 'react';
import { formatDuration } from '../core/stats.js';
import type { SessionPoint } from '../core/stats.js';
import { downloadBlob, shareImageFilename } from '../data/exchange.js';
import { shortDate, tickIndices } from './chartScale.js';
import type { ShareCardData } from './shareCardData.js';
import { Banner, Button, Spinner } from './kit.js';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

const PAD = 64;
const INNER_RIGHT = CARD_WIDTH - PAD;

const BG = '#0b1220';
const INK = '#e2e8f0';
const MUTED = '#7c8aa5';
const GRID = '#26324b';
const XTICK = '#1c2740';
const ACTUAL = '#5eead4';

/**
 * Generic families only. A webfont would have to be fetched, and this app is expected to work
 * with the network off; `ctx.letterSpacing` is avoided for the same class of reason — Safari
 * does not implement it.
 */
const STACK = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

/**
 * The public mirror, hard-coded on purpose.
 *
 * The canonical remote is a private Forgejo host, and this image gets sent to a group chat —
 * deriving the URL from `git remote` would put a private hostname in front of everyone the card
 * reaches. Printed with its scheme: nothing in a PNG is clickable, so a reader has to type it
 * or point a camera at it, and the `https://` is what makes it unambiguously a URL to copy
 * rather than something that merely looks like a path.
 */
const PROJECT_URL = 'https://github.com/marcushorndt/godmode';

/**
 * The card is judged at roughly 0.4 scale — in the preview panel, and on a phone in a chat.
 * Nothing on it is smaller than this, because below it the text stops being readable in the
 * only two places the image is ever seen.
 */
const MIN_TEXT = 28;

function font(size: number, weight = 400): string {
  return `${weight} ${Math.max(size, MIN_TEXT)}px ${STACK}`;
}

/** Set the largest weight-appropriate font size at which `text` still fits `maxWidth`. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
  weight = 400,
): void {
  for (let size = startSize; size > minSize; size -= 4) {
    ctx.font = font(size, weight);
    if (ctx.measureText(text).width <= maxWidth) return;
  }
  ctx.font = font(minSize, weight);
}

export function drawShareCard(canvas: HTMLCanvasElement, data: ShareCardData): void {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a canvas to draw the card on.');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const chartTop = drawHeadline(ctx, data, drawHeading(ctx, data));
  drawTable(ctx, data, drawChart(ctx, data.points, chartTop));
  drawFootprint(ctx);
}

/** Wordmark and the exercise. Returns the y the headline figures start at. */
function drawHeading(ctx: CanvasRenderingContext2D, data: ShareCardData): number {
  ctx.font = font(40, 700);
  ctx.fillStyle = INK;
  ctx.fillText('GODMODE', PAD, 100);
  const wordmark = ctx.measureText('GODMODE').width;

  ctx.font = font(28, 600);
  ctx.fillStyle = ACTUAL;
  ctx.fillText('No More Later', PAD + wordmark + 20, 100);

  ctx.fillStyle = INK;
  // A long label gets smaller rather than running off the edge of the image.
  fitText(ctx, data.exerciseLabel, INNER_RIGHT - PAD, 66, 40, 700);
  ctx.fillText(data.exerciseLabel, PAD, 182);

  return 228;
}

/** Step sizes that keep every gridline on a round number. 2.5 is allowed only where it lands
 * on an integer — at magnitude 10 it gives 25, which is a perfectly ordinary axis. */
const STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];

/**
 * A y-axis for the card: always rooted at 0, always on round numbers, and as close to the data
 * as those two allow.
 *
 * The shared `niceScale` picks the first round step at or above `max / targetLines`, which is
 * right for the app's chart but leaves the card slack: a 202-rep peak became a 250 ceiling, so a
 * fifth of the plot was empty and the curve was flattened by it. This searches instead —
 * every round step whose line count is sane, then the one with the least dead space — and gets
 * 225 for the same data. It never truncates the baseline: starting anywhere but 0 would
 * overstate the progress, which is the one thing this card must not do.
 *
 * `chartScale.ts` is untouched. The app's chart plots two series and needs headroom for the
 * target above the actual; the card plots one and does not.
 */
export function cardScale(max: number): { top: number; step: number } {
  let best: { top: number; step: number; lines: number } | undefined;

  for (let exponent = 0; exponent <= 6; exponent += 1) {
    for (const multiplier of STEP_MULTIPLIERS) {
      const step = multiplier * 10 ** exponent;
      if (!Number.isInteger(step)) continue;
      const top = Math.ceil(max / step) * step;
      const lines = top / step;
      // Fewer than four gridlines reads as no scale at all; more than nine is a grid.
      if (lines < 4 || lines > 9) continue;
      if (!best || top < best.top || (top === best.top && lines < best.lines)) {
        best = { top, step, lines };
      }
    }
  }

  // Only reachable for a max of 3 or less — one or two very small sessions.
  if (!best) return { top: Math.max(4, Math.ceil(max)), step: 1 };
  return { top: best.top, step: best.step };
}

/**
 * Taller than the app's own chart, and taller than either earlier version of this card. Dropping
 * the target line, the outcome dots, the legend and the subtitle freed most of a third of the
 * card, and the chart is the thing people actually look at, so it took the space each time
 * rather than leaving a band of nothing.
 */
const PLOT_HEIGHT = 480;
const AXIS_GUTTER = 84;

/**
 * Reps per session, and nothing else. Returns the y at which the table starts.
 *
 * Deliberately simpler than `SessionChart`: one teal line, no dashed prescription and no
 * per-point markers. The app's chart is a diagnostic and can afford five things to decode; this
 * is a picture in a group chat, seen at thumbnail size and read in about a second. `Chart.tsx`
 * is unchanged — only the card got simpler.
 */
function drawChart(ctx: CanvasRenderingContext2D, points: SessionPoint[], top: number): number {
  const bottom = top + PLOT_HEIGHT;
  const left = PAD + AXIS_GUTTER;

  if (points.length === 0) {
    ctx.font = font(32);
    ctx.fillStyle = MUTED;
    ctx.fillText('No sessions yet — your first workout starts the chart.', PAD, top + 60);
    return top + 120;
  }

  // Scaled to the reps actually done, because that is now the only line on the chart.
  const scale = cardScale(Math.max(...points.map((p) => p.actualTotal), 1));
  const stepX = points.length === 1 ? 0 : (INNER_RIGHT - left) / (points.length - 1);
  const x = (i: number) =>
    points.length === 1 ? left + (INNER_RIGHT - left) / 2 : left + i * stepX;
  const y = (v: number) => bottom - (v / scale.top) * PLOT_HEIGHT;

  // Horizontal grid with its value labels.
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.font = font(28);
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= scale.top; v += scale.step) {
    ctx.beginPath();
    ctx.strokeStyle = GRID;
    ctx.moveTo(left, y(v));
    ctx.lineTo(INNER_RIGHT, y(v));
    ctx.stroke();

    ctx.fillStyle = MUTED;
    ctx.textAlign = 'right';
    ctx.fillText(String(v), left - 18, y(v));
  }
  ctx.textBaseline = 'alphabetic';

  // Dated ticks, with the outermost two pinned inward so neither is clipped.
  const ticks = tickIndices(points.length, 7);
  const lastTick = ticks.at(-1);
  for (const i of ticks) {
    ctx.beginPath();
    ctx.strokeStyle = XTICK;
    ctx.moveTo(x(i), top);
    ctx.lineTo(x(i), bottom);
    ctx.stroke();

    ctx.fillStyle = MUTED;
    ctx.textAlign = i === 0 ? 'left' : i === lastTick ? 'right' : 'center';
    ctx.fillText(shortDate(points[i]?.performedAt ?? ''), x(i), bottom + 44);
  }
  ctx.textAlign = 'left';

  // One unbroken line: every session has an actual, so there is no gap to break at. The
  // prescription is not drawn at all any more, which is also why nothing here can imply one.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.setLineDash([]);
  ctx.strokeStyle = ACTUAL;
  ctx.lineWidth = 7.5;
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(i), y(p.actualTotal));
    else ctx.lineTo(x(i), y(p.actualTotal));
  });
  ctx.stroke();

  return bottom + 104;
}

/**
 * Three columns spread across the card's full width: the date from the left margin, the target
 * right-aligned a third in, and the reps right-aligned on the same margin the chart above ends
 * at, so the table and the plot share an edge.
 */
const COL_TARGET = 698;
const COL_ACTUAL = INNER_RIGHT;

function drawTable(ctx: CanvasRenderingContext2D, data: ShareCardData, top: number): void {
  if (data.recent.length === 0) {
    ctx.font = font(32);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    ctx.fillText('Nothing logged yet — this card fills in as you train.', PAD, top + 40);
    return;
  }

  ctx.font = font(28, 600);
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'left';
  ctx.fillText('Last sessions', PAD, top);
  ctx.textAlign = 'right';
  ctx.fillText('Target', COL_TARGET, top);
  ctx.fillText('Reps', COL_ACTUAL, top);
  ctx.textAlign = 'left';

  ctx.beginPath();
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.moveTo(PAD, top + 18);
  ctx.lineTo(INNER_RIGHT, top + 18);
  ctx.stroke();

  let y = top + 66;
  for (const row of data.recent) {
    ctx.font = font(34);
    ctx.fillStyle = '#cbd5e1';
    ctx.textAlign = 'left';
    ctx.fillText(row.date, PAD, y);

    // An em dash, never the actual: a session with no slot has no known prescription, and
    // filling one in would fabricate a target the user was never given.
    ctx.textAlign = 'right';
    if (row.targetTotal === undefined) {
      ctx.fillStyle = MUTED;
      ctx.fillText('—', COL_TARGET, y);
    } else {
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(String(row.targetTotal), COL_TARGET, y);
    }

    ctx.font = font(34, 700);
    ctx.fillStyle = INK;
    ctx.fillText(String(row.actualTotal), COL_ACTUAL, y);

    y += 48;
  }
  ctx.textAlign = 'left';
}

/**
 * The headline figures, directly under the exercise they belong to. Returns the chart's top.
 *
 * They used to sit at the foot of the card, below the table, which is where a reader arrives
 * last if at all. A card is read top-down and abandoned early, so the numbers someone would
 * actually repeat — reps, time, streak — now sit where the eye already is.
 *
 * Deliberately subordinate to the 66px exercise name above them: at 46px, next to the title
 * rather than alone at the bottom, they turned the title into a caption. 40px keeps the name
 * leading and is still 17 CSS px in the preview.
 */
function drawHeadline(
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  top: number,
): number {
  const columns: { label: string; value: string; sub: string }[] = [
    {
      label: 'REPS',
      value: String(data.totals.reps),
      sub: `${data.totals.workouts} sessions`,
    },
    { label: 'TIME', value: formatDuration(data.totals.seconds), sub: 'training' },
    {
      label: 'STREAK',
      value: String(data.metrics.activityStreak),
      sub: `best ${data.metrics.longestActivityStreak}`,
    },
  ];

  // Only when there is a figure, and always labelled with how it was arrived at — an estimate
  // is never presented as a measurement.
  if (data.kcal) {
    columns.push({ label: 'KCAL', value: String(data.kcal.value), sub: data.kcal.note });
  }

  const width = (INNER_RIGHT - PAD) / columns.length;
  ctx.textAlign = 'left';
  columns.forEach((column, i) => {
    const x = PAD + i * width;
    ctx.font = font(28, 600);
    ctx.fillStyle = MUTED;
    ctx.fillText(column.label, x, top);

    ctx.font = font(40, 700);
    ctx.fillStyle = INK;
    ctx.fillText(column.value, x, top + 44);

    ctx.font = font(28);
    ctx.fillStyle = MUTED;
    ctx.fillText(column.sub, x, top + 80);
  });

  return top + 124;
}

/**
 * Where this came from, set quietly at the foot of the card.
 *
 * 24px — below the 28px floor, deliberately. That floor exists for content someone is meant to
 * read; this is a footprint, and it earns its quietness from being small and low-contrast rather
 * than from being hidden. At the preview width it is still around 10 CSS px and legible.
 */
const FOOTPRINT_SIZE = 24;

function drawFootprint(ctx: CanvasRenderingContext2D): void {
  // Written out rather than passed through `font`, which clamps to the content floor.
  ctx.font = `400 ${FOOTPRINT_SIZE}px ${STACK}`;
  ctx.fillStyle = '#55637d';
  ctx.textAlign = 'left';
  ctx.fillText(PROJECT_URL, PAD, 1310);
}

interface Rendered {
  blob: Blob;
  url: string;
  file: File;
}

export function ShareCardPreview({
  data,
  exerciseLabel,
  onBack,
}: {
  data: ShareCardData;
  exerciseLabel: string;
  onBack: () => void;
}) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;

    try {
      const canvas = document.createElement('canvas');
      drawShareCard(canvas, data);
      canvas.toBlob((blob) => {
        if (cancelled) return;
        if (!blob) {
          setError('The card could not be turned into an image on this device.');
          return;
        }
        url = URL.createObjectURL(blob);
        const name = shareImageFilename(exerciseLabel);
        setRendered({ blob, url, file: new File([blob], name, { type: 'image/png' }) });
      }, 'image/png');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The card could not be drawn.');
    }

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [data, exerciseLabel]);

  // The blob is produced on mount, not on the press. iOS Safari drops the user-gesture
  // privilege across an `await`, so a handler that awaited `toBlob` and then called
  // `navigator.share` would fail on the one platform this app is built for. By the time either
  // button exists the File already does, and the share call is synchronous with the gesture.
  const canShare = rendered !== null && (navigator.canShare?.({ files: [rendered.file] }) ?? false);

  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner tone="warn">{error}</Banner> : null}

      {rendered ? (
        <img
          src={rendered.url}
          alt={`Share card for ${exerciseLabel}`}
          className="w-full h-auto rounded-xl border border-[#26324b]"
        />
      ) : error ? null : (
        <Spinner label="Drawing your card…" className="min-h-64" />
      )}

      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        {canShare && rendered ? (
          <Button
            className="flex-1"
            onClick={() => {
              navigator
                .share({
                  files: [rendered.file],
                  title: `${exerciseLabel} — GodMode`,
                  text: `${data.totals.reps} reps across ${data.totals.workouts} sessions.`,
                })
                // Cancelling the system sheet is a decision, not a failure, and must not
                // surface as an error.
                .catch((e: unknown) => {
                  if (e instanceof Error && e.name === 'AbortError') return;
                  setError('The system share sheet did not accept the card. Save it instead.');
                });
            }}
          >
            Share
          </Button>
        ) : null}
        <Button
          className="flex-1"
          variant={canShare ? 'ghost' : 'primary'}
          disabled={rendered === null}
          onClick={() => {
            if (rendered) downloadBlob(rendered.file.name, rendered.blob);
          }}
        >
          Save image
        </Button>
      </div>
    </div>
  );
}
