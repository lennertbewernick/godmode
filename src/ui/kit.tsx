/**
 * Small shared primitives. Deliberately hand-rolled — this app has no component library
 * and no chart dependency.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';

/** The repository this build is served from; a deployment overrides it at build time (see below). */
const SOURCE_URL =
  import.meta.env.VITE_GODMODE_REPO_URL?.trim() || 'https://github.com/lennertbewernick/godmode';

/**
 * The AGPL §13 "Source code" link.
 *
 * This app is served to users over a network, so the AGPL requires offering them the source of
 * the exact version they are interacting with. A visible link to the repository satisfies that.
 * The URL is a build-time env var (`VITE_SOURCE_URL`) so a deployment points at its own tree
 * rather than at wherever this happened to be forked from.
 */
export function SourceFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`pb-6 pt-4 text-center text-xs text-slate-600 ${className}`}>
      <a
        href={SOURCE_URL}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-slate-400"
      >
        Source code
      </a>{' '}
      · AGPL-3.0
    </footer>
  );
}

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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The app's only dialog. Everything modal goes through it, so there is one dismissal
 * behaviour, one focus behaviour and one shape to learn.
 *
 * Below `sm` it is a bottom sheet rather than a centred box. That is deliberate rather than
 * decorative: the trigger sits in the top-right chrome, and the phone's thumb zone is the
 * bottom of the screen — a centred dialog would put the actions out of reach of the hand that
 * opened it. `max-h-[85vh]` with its own scroll is what guarantees it cannot outgrow a phone
 * viewport no matter how tall its contents get.
 */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Callers pass an inline arrow, so `onClose` is a new function on every parent render. Held
  // in a ref and read at event time, the open/close effect below can run exactly once —
  // otherwise it tears down and re-runs on every parent render, yanking focus out of whatever
  // the user was actually using inside the dialog.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    // Whatever had focus when the dialog opened — usually the trigger. Without restoring it,
    // closing the sheet drops a keyboard user back at the top of the document every time.
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      // A plain wrap is enough — this app has no nested dialogs.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1220]/80 backdrop-blur-sm sm:items-center"
      onMouseDown={(event) => {
        // Only a press on the backdrop itself closes; one that bubbled out of the panel does not.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={[
          'max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-[#26324b] bg-[#131c2e]',
          'p-4 shadow-2xl shadow-black/50 outline-none sm:rounded-2xl safe-b',
          wide ? 'sm:max-w-lg' : 'sm:max-w-md',
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-slate-100">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-11 shrink-0 px-2 text-slate-400 hover:text-slate-200"
          >
            ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * `className` overrides the height, because the full-screen default is wrong inside a dialog:
 * a `min-h-screen` box within an `85vh` panel makes the panel scroll for no reason.
 */
export function Spinner({ label, className = 'min-h-screen' }: { label: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center text-slate-400 ${className}`}>
      <span className="animate-pulse">{label}</span>
    </div>
  );
}
