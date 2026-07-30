/**
 * The workout runner.
 *
 * The AMRAP set is the focal input (RUN-05) — the other sets are essentially a countdown,
 * but the open-ended one is where progress is actually decided. Presentation is driven by
 * target metadata, so zero, one, or several AMRAP sets all render sensibly.
 *
 * Per-set start/end timestamps are recorded (RUN-06), which the incumbent never did — it
 * stored one aggregate duration, which is exactly why its rest behaviour had to be guessed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from '../core/stats.js';
import type { AdjustmentType, PerformedSet, WorkoutPerformance } from '../core/types.js';
import type { PlanSlotRecord } from '../db/schema.js';
import { cueForSecondsLeft, playCue } from './cues.js';
import { Banner, Button, Card, SetRow } from './kit.js';

type Phase = 'set' | 'rest' | 'review';

/** Seconds remaining at which the clock starts warning, then counting. */
const WARN_AT = 10;
const COUNT_FROM = 5;

export interface RunnerProps {
  slot: PlanSlotRecord;
  attemptNo: number;
  /** Effective targets for this attempt, after any adjustment. */
  effectiveTargets: number[];
  adjustmentType: AdjustmentType;
  restOverrideSeconds?: number;
  onFinish: (performance: WorkoutPerformance, durationSeconds: number) => void;
  onCancel: () => void;
}

export function Runner({
  slot,
  attemptNo,
  effectiveTargets,
  adjustmentType,
  restOverrideSeconds,
  onFinish,
  onCancel,
}: RunnerProps) {
  const setCount = effectiveTargets.length;
  const baseRest = restOverrideSeconds ?? slot.restSeconds;

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('set');
  const [actuals, setActuals] = useState<number[]>(() => [...effectiveTargets]);
  const [restLeft, setRestLeft] = useState(baseRest);
  const [restTotal, setRestTotal] = useState(baseRest);

  const startedAt = useRef(Date.now());
  const setStartedAt = useRef(Date.now());
  const stamps = useRef<{ startedAt: string; endedAt: string }[]>([]);

  const amrapFlags = useMemo(() => slot.targets.map((t) => t.isAmrap), [slot.targets]);
  const isAmrap = amrapFlags[index] === true;
  const target = effectiveTargets[index] ?? 0;

  // Rest countdown. A self-rescheduling timeout keyed on the remaining seconds, rather than
  // one long-lived interval, so ±15s takes effect on the very next tick and the value that
  // drives the cues is always the value on screen.
  useEffect(() => {
    if (phase !== 'rest') return;
    if (restLeft <= 0) {
      setPhase('set');
      setStartedAt.current = Date.now();
      return;
    }
    const timer = window.setTimeout(() => setRestLeft((left) => left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, restLeft]);

  // Cues follow the displayed second. Sounding them here rather than inside the countdown's
  // state updater keeps the updater pure, so React re-invoking it never double-beeps.
  const lastCuedAt = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== 'rest') {
      lastCuedAt.current = null;
      return;
    }
    if (lastCuedAt.current === restLeft) return;
    lastCuedAt.current = restLeft;
    const cue = cueForSecondsLeft(restLeft);
    if (cue) playCue(cue);
  }, [phase, restLeft]);

  const setActual = useCallback((value: number) => {
    setActuals((prev) => {
      const next = [...prev];
      next[index] = Math.max(0, value);
      return next;
    });
  }, [index]);

  const completeSet = useCallback(() => {
    const endedAt = new Date().toISOString();
    stamps.current[index] = {
      startedAt: new Date(setStartedAt.current).toISOString(),
      endedAt,
    };

    if (index + 1 >= setCount) {
      setPhase('review');
      return;
    }
    const nextRest = slot.targets[index]?.restAfterSeconds ?? baseRest;
    const rest = restOverrideSeconds ?? nextRest;
    setRestTotal(rest);
    setRestLeft(rest);
    setIndex(index + 1);
    setPhase(rest > 0 ? 'rest' : 'set');
    if (rest <= 0) setStartedAt.current = Date.now();
  }, [index, setCount, slot.targets, baseRest, restOverrideSeconds]);

  const finish = useCallback(() => {
    const sets: PerformedSet[] = actuals.map((actual, i) => ({
      index: i + 1,
      effectiveTarget: effectiveTargets[i] ?? 0,
      actual,
      ...(stamps.current[i] === undefined
        ? {}
        : { startedAt: stamps.current[i]!.startedAt, endedAt: stamps.current[i]!.endedAt }),
    }));
    const actualTotal = actuals.reduce((s, n) => s + n, 0);
    const effectiveTotal = effectiveTargets.reduce((s, n) => s + n, 0);
    onFinish(
      { sets, actualTotal, adjustmentType, effectiveTotal },
      Math.round((Date.now() - startedAt.current) / 1000),
    );
  }, [actuals, effectiveTargets, adjustmentType, onFinish]);

  const runningTotal = actuals
    .slice(0, phase === 'review' ? setCount : index)
    .reduce((s, n) => s + n, 0);

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col px-4 safe-t safe-b">
      <header className="flex items-center justify-between gap-3 pb-3">
        <div className="min-w-0">
          <div className="truncate text-sm text-slate-400">
            {slot.week !== undefined && slot.day !== undefined
              ? `Week ${slot.week} · Day ${slot.day}`
              : (slot.cycleLabel ?? `Session ${slot.ordinal}`)}
            {attemptNo > 1 ? ` · attempt ${attemptNo}` : ''}
          </div>
          <div className="tnum text-xs text-slate-500">
            target {slot.targetTotal} · running {runningTotal}
          </div>
        </div>
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
      </header>

      <SetRow
        reps={effectiveTargets}
        amrapFlags={amrapFlags}
        activeIndex={phase === 'review' ? undefined : index}
        className="pb-4"
      />

      {phase === 'rest' ? (
        <RestPanel
          left={restLeft}
          total={restTotal}
          nextTarget={target}
          nextIsAmrap={isAmrap}
          onAdjust={(delta) => {
            setRestLeft((l) => Math.max(0, l + delta));
            setRestTotal((t) => Math.max(1, t + delta));
          }}
          onSkip={() => {
            setPhase('set');
            setStartedAt.current = Date.now();
            setRestLeft(0);
          }}
        />
      ) : null}

      {phase === 'set' ? (
        <SetPanel
          setNumber={index + 1}
          setCount={setCount}
          target={target}
          isAmrap={isAmrap}
          actual={actuals[index] ?? 0}
          onChange={setActual}
          onDone={completeSet}
        />
      ) : null}

      {phase === 'review' ? (
        <ReviewPanel
          effectiveTargets={effectiveTargets}
          amrapFlags={amrapFlags}
          actuals={actuals}
          targetTotal={slot.targetTotal}
          onEdit={(i, v) =>
            setActuals((prev) => {
              const next = [...prev];
              next[i] = Math.max(0, v);
              return next;
            })
          }
          onSave={finish}
        />
      ) : null}
    </div>
  );
}

function RestPanel({
  left,
  total,
  nextTarget,
  nextIsAmrap,
  onAdjust,
  onSkip,
}: {
  left: number;
  total: number;
  nextTarget: number;
  nextIsAmrap: boolean;
  onAdjust: (delta: number) => void;
  onSkip: () => void;
}) {
  const progress = total <= 0 ? 1 : 1 - left / total;
  const counting = left <= COUNT_FROM;
  const warning = left <= WARN_AT;

  return (
    <Card className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <div>
        <div
          className={[
            'text-xs uppercase tracking-widest transition-colors',
            counting ? 'text-teal-300' : warning ? 'text-amber-300' : 'text-slate-400',
          ].join(' ')}
        >
          {counting ? 'Get ready' : 'Rest'}
        </div>
        {/* Re-keyed every second while counting so the pulse animation restarts on each tick. */}
        <div
          key={counting ? left : 'steady'}
          className={[
            'tnum mt-1 text-7xl font-light tabular-nums transition-colors',
            counting ? 'cue-pulse text-teal-200' : warning ? 'text-amber-300' : 'text-slate-100',
          ].join(' ')}
          aria-live="off"
        >
          {formatClock(left)}
        </div>
      </div>

      <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[#1c2740]">
        <div
          className={[
            'h-full rounded-full transition-[width,background-color] duration-1000 ease-linear',
            warning ? 'bg-amber-300' : 'bg-teal-300',
            counting ? '!bg-teal-200' : '',
          ].join(' ')}
          style={{ width: `${Math.min(100, progress * 100)}%` }}
        />
      </div>

      <div className="text-sm text-slate-400">
        Next: <span className="tnum font-semibold text-slate-200">{nextTarget}{nextIsAmrap ? '+' : ''}</span>
        {nextIsAmrap ? ' — as many as you can' : ''}
      </div>

      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={() => onAdjust(-15)} ariaLabel="15 seconds less">
          −15s
        </Button>
        <Button onClick={onSkip}>Skip rest</Button>
        <Button variant="ghost" onClick={() => onAdjust(15)} ariaLabel="15 seconds more">
          +15s
        </Button>
      </div>
    </Card>
  );
}

function SetPanel({
  setNumber,
  setCount,
  target,
  isAmrap,
  actual,
  onChange,
  onDone,
}: {
  setNumber: number;
  setCount: number;
  target: number;
  isAmrap: boolean;
  actual: number;
  onChange: (value: number) => void;
  onDone: () => void;
}) {
  return (
    <Card className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
      <div className="text-xs uppercase tracking-widest text-slate-400">
        Set {setNumber} of {setCount}
      </div>

      {isAmrap ? (
        <>
          <div>
            <div className="tnum text-6xl font-light text-teal-300">{target}+</div>
            <div className="mt-2 text-sm text-slate-300">
              At least {target}. Go as far as you can.
            </div>
          </div>
          <Stepper value={actual} onChange={onChange} big />
        </>
      ) : (
        <>
          <div className="tnum text-7xl font-light text-slate-100">{target}</div>
          <Stepper value={actual} onChange={onChange} />
          {actual !== target ? (
            <div className="tnum text-xs text-amber-300">
              recording {actual} instead of {target}
            </div>
          ) : null}
        </>
      )}

      <Button onClick={onDone} className="w-full max-w-xs">
        {setNumber === setCount ? 'Finish workout' : 'Set done'}
      </Button>
    </Card>
  );
}

function Stepper({
  value,
  onChange,
  big = false,
}: {
  value: number;
  onChange: (value: number) => void;
  big?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" onClick={() => onChange(value - 1)} ariaLabel="One less rep">
        −
      </Button>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        className={`tnum w-24 rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2 text-center text-slate-100 outline-none focus:border-teal-400 ${
          big ? 'text-3xl' : 'text-2xl'
        }`}
        aria-label="Reps performed"
      />
      <Button variant="ghost" onClick={() => onChange(value + 1)} ariaLabel="One more rep">
        +
      </Button>
    </div>
  );
}

function ReviewPanel({
  effectiveTargets,
  amrapFlags,
  actuals,
  targetTotal,
  onEdit,
  onSave,
}: {
  effectiveTargets: number[];
  amrapFlags: boolean[];
  actuals: number[];
  targetTotal: number;
  onEdit: (index: number, value: number) => void;
  onSave: () => void;
}) {
  const total = actuals.reduce((s, n) => s + n, 0);
  const shortfall = targetTotal - total;

  return (
    <Card className="flex flex-1 flex-col gap-4">
      <div>
        <div className="text-xs uppercase tracking-widest text-slate-400">Check your numbers</div>
        <div className="tnum mt-1 text-4xl font-light text-slate-100">
          {total}
          <span className="ml-2 text-lg text-slate-400">/ {targetTotal}</span>
        </div>
        {shortfall > 0 ? (
          <div className="tnum mt-1 text-sm text-amber-300">
            {shortfall} short. This day comes round again.
          </div>
        ) : (
          <div className="mt-1 text-sm text-teal-300">Target met.</div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {actuals.map((actual, i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <span className="tnum text-sm text-slate-400">
              Set {i + 1} · target {effectiveTargets[i]}
              {amrapFlags[i] ? '+' : ''}
            </span>
            <span className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => onEdit(i, actual - 1)} ariaLabel={`One less on set ${i + 1}`}>
                −
              </Button>
              <input
                type="number"
                inputMode="numeric"
                value={actual}
                onChange={(e) => onEdit(i, e.target.value === '' ? 0 : Number(e.target.value))}
                className="tnum w-20 rounded-lg border border-[#33405c] bg-[#0f1728] px-2 py-1.5 text-center text-slate-100 outline-none focus:border-teal-400"
                aria-label={`Reps on set ${i + 1}`}
              />
              <Button variant="ghost" onClick={() => onEdit(i, actual + 1)} ariaLabel={`One more on set ${i + 1}`}>
                +
              </Button>
            </span>
          </div>
        ))}
      </div>

      <Banner tone="info">Correct anything you mis-tapped before saving.</Banner>

      <Button onClick={onSave} className="w-full">
        Save workout
      </Button>
    </Card>
  );
}
