/**
 * Training reminders: the onboarding "why", and the Web Push opt-in (LBV-1481).
 *
 * Reached only from Settings, which is only reachable once a challenge exists — so this is
 * structurally "after onboarding, not on first paint", which is where the push permission prompt is
 * required to live. The permission request happens on the user's explicit tap of "Turn on
 * reminders", never automatically: a permission dialog nobody asked for is how a user denies for
 * good.
 *
 * The push effects live in `src/push/subscribe.ts`; this component only orchestrates them and shows
 * the result. Under jsdom none of the push APIs exist, so `readReminderState` reports `unsupported`
 * and the opt-in is simply not rendered — the goal capture still is, and is what the tests drive.
 */

import { useEffect, useState } from 'react';
import { GOAL_TEXT_MAX_LENGTH } from '../db/schema.js';
import {
  disableReminders,
  enableReminders,
  readReminderState,
  type ReminderState,
} from '../push/subscribe.js';
import { Banner, Button, Card, TextArea } from './kit.js';

export function Reminders({
  goalText,
  onSaveGoal,
}: {
  goalText: string | undefined;
  /** `undefined` clears the stored goal; a non-empty string sets it. Goes through PATCH /settings. */
  onSaveGoal: (goalText: string | undefined) => void;
}) {
  const [goal, setGoal] = useState(goalText ?? '');
  const [reminder, setReminder] = useState<ReminderState>({ kind: 'unsupported' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Read the live push state once. Effectful and browser-only; under jsdom it resolves to
  // `unsupported`, which hides the toggle without failing the render.
  useEffect(() => {
    let alive = true;
    void readReminderState().then((state) => {
      if (alive) setReminder(state);
    });
    return () => {
      alive = false;
    };
  }, []);

  const trimmedGoal = goal.trim();
  const goalDirty = trimmedGoal !== (goalText ?? '');

  async function turnOn() {
    setBusy(true);
    setNote(null);
    const outcome = await enableReminders();
    setBusy(false);
    switch (outcome.kind) {
      case 'subscribed':
        setReminder({ kind: 'subscribed' });
        setNote('Reminders are on for this device.');
        return;
      case 'denied':
        setReminder({ kind: 'denied' });
        return;
      case 'unsupported':
        setReminder({ kind: 'unsupported' });
        return;
      case 'error':
        setNote(outcome.message);
        return;
    }
  }

  async function turnOff() {
    setBusy(true);
    setNote(null);
    await disableReminders();
    setBusy(false);
    setReminder({ kind: 'available' });
    setNote('Reminders are off for this device.');
  }

  return (
    <Card className="lg:mb-4 lg:break-inside-avoid">
      <h3 className="font-semibold text-slate-100">Reminders</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
        Why are you doing this? Write it down. A reminder that says it back lands harder than a
        generic nudge.
      </p>

      <div className="mt-4">
        <TextArea
          label="Your why"
          value={goal}
          onChange={setGoal}
          maxLength={GOAL_TEXT_MAX_LENGTH}
          placeholder="e.g. So I can keep up with my kids without getting winded."
          hint="Kept on your server, in your backups. Only you see it."
        />
      </div>
      <Button
        variant="ghost"
        className="mt-3 w-full"
        disabled={!goalDirty}
        onClick={() => onSaveGoal(trimmedGoal === '' ? undefined : trimmedGoal)}
      >
        Save
      </Button>

      {/*
        The push opt-in. Rendered only where push can actually work — a supported browser, a VAPID
        key in the build, and on iOS a home-screen-installed PWA — so a user who cannot use it is
        not shown a button that would only fail.
      */}
      {reminder.kind !== 'unsupported' ? (
        <div className="mt-5 border-t border-[#26324b] pt-4">
          <h4 className="text-sm font-semibold text-slate-100">Training reminders</h4>
          {reminder.kind === 'subscribed' ? (
            <>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
                This device will get a push when it is time to train.
              </p>
              <Button
                variant="ghost"
                className="mt-3 w-full"
                disabled={busy}
                onClick={() => void turnOff()}
              >
                Turn reminders off
              </Button>
            </>
          ) : null}
          {reminder.kind === 'available' ? (
            <>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
                Get a push on this device when a session is due. On an iPhone this needs the app
                added to your home screen first.
              </p>
              <Button
                className="mt-3 w-full"
                disabled={busy}
                onClick={() => void turnOn()}
              >
                Turn reminders on
              </Button>
            </>
          ) : null}
          {reminder.kind === 'denied' ? (
            <p className="mt-1.5 text-sm leading-relaxed text-amber-300">
              Notifications are blocked for this app. Turn them back on in your browser or system
              settings, then come back here.
            </p>
          ) : null}
        </div>
      ) : null}

      {note ? (
        <div className="mt-3">
          <Banner tone="info" onDismiss={() => setNote(null)}>
            {note}
          </Banner>
        </div>
      ) : null}
    </Card>
  );
}
