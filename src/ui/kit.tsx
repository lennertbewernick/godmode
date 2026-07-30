/**
 * Small shared primitives. Deliberately hand-rolled — this app has no component library
 * and no chart dependency.
 */

import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-[#26324b] bg-[#131c2e] p-4 shadow-lg shadow-black/20 ${className}`}
    >
      {children}
    </div>
  );
}

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-teal-300 text-[#08111f] hover:bg-teal-200 active:bg-teal-400 font-semibold',
  ghost: 'border border-[#33405c] text-slate-200 hover:bg-[#1c2740]',
  danger: 'border border-red-500/40 text-red-300 hover:bg-red-500/10',
  subtle: 'text-slate-400 hover:text-slate-200',
};

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  className = '',
  type = 'button',
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`min-h-11 rounded-xl px-4 py-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 9999,
  hint,
  suffix,
}: {
  label: string;
  value: number | '';
  onChange: (next: number | '') => void;
  min?: number;
  max?: number;
  hint?: ReactNode;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-300">{label}</span>
      <span className="mt-1.5 flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(raw === '' ? '' : Number(raw));
          }}
          className="tnum min-h-11 w-full rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2.5 text-lg text-slate-100 outline-none focus:border-teal-400"
        />
        {suffix ? <span className="text-sm text-slate-400">{suffix}</span> : null}
      </span>
      {hint ? <span className="mt-1.5 block text-xs leading-relaxed text-slate-400">{hint}</span> : null}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-300">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 min-h-11 w-full rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2.5 text-slate-100 outline-none focus:border-teal-400"
      />
      {hint ? <span className="mt-1.5 block text-xs text-slate-400">{hint}</span> : null}
    </label>
  );
}

/** A prescribed-set chip row, e.g. 37 · 47 · 37 · 33 · 51+ */
export function SetRow({
  reps,
  amrapFlags,
  activeIndex,
  className = '',
}: {
  reps: number[];
  amrapFlags: boolean[];
  activeIndex?: number | undefined;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {reps.map((n, i) => {
        const active = i === activeIndex;
        return (
          <span
            key={i}
            className={[
              'tnum inline-flex min-w-11 items-center justify-center rounded-lg px-2.5 py-1.5 text-base',
              active
                ? 'bg-teal-300 font-semibold text-[#08111f]'
                : 'bg-[#1c2740] text-slate-200',
            ].join(' ')}
          >
            {n}
            {amrapFlags[i] ? '+' : ''}
          </span>
        );
      })}
    </div>
  );
}

/**
 * A small segmented control. Used for the chart's two views, the desktop tab row, and the
 * exercise switcher — all the same interaction, so all the same widget.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className = '',
  ariaLabel,
}: {
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex gap-1 rounded-xl bg-[#0f1728] p-1 ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={[
              'rounded-lg transition-colors',
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'min-h-9 px-3 py-1.5 text-sm',
              active
                ? 'bg-[#1c2740] font-semibold text-teal-300'
                : 'text-slate-400 hover:text-slate-200',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="tnum mt-0.5 truncate text-xl font-semibold text-slate-100">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}

export function Banner({
  tone = 'info',
  children,
  onDismiss,
}: {
  tone?: 'info' | 'warn' | 'good';
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    info: 'border-sky-500/30 bg-sky-500/10 text-sky-100',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-100',
    good: 'border-teal-500/30 bg-teal-500/10 text-teal-100',
  };
  return (
    <div className={`rounded-xl border px-3.5 py-3 text-sm leading-relaxed ${tones[tone]}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 text-current opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center text-slate-400">
      <span className="animate-pulse">{label}</span>
    </div>
  );
}
