/**
 * Settings and backup.
 *
 * Restore and "delete everything" are gone from this screen, and their absence is deliberate
 * rather than an omission. Both were IndexedDB operations on a database that is no longer the
 * dataset: restore cleared six stores and rewrote them, and the reset wiped all seven. The API
 * has no equivalent command — see the note in `src/data/exchange.ts` — and approximating a
 * transaction the server does not offer, on the only copy of someone's history, is exactly the
 * kind of thing that loses it. Restoring is `npm run import-backup`, which verifies the whole
 * file before it replaces anything.
 *
 * What is left of the durability warning still belongs here: an unsent workout lives in this
 * browser until the server takes it, and iOS can clear that.
 */

import { useState } from 'react';
import { daysSinceBackup } from '../data/exchange.js';
import type { ChallengeRecord, SettingsRecord } from '../db/schema.js';
import { Banner, Button, Card, NumberField } from './kit.js';

export function Settings({
  settings,
  exerciseLabel,
  workoutCount,
  unsentCount,
  active,
  labels,
  onEndWorkout,
  onSave,
  onOpenExport,
  onSignOut,
}: {
  settings: SettingsRecord;
  exerciseLabel: string;
  workoutCount: number;
  /** Finished workouts this device is still holding. Zero, almost always. */
  unsentCount: number;
  active: ChallengeRecord[];
  labels: Map<string, string>;
  onEndWorkout: (challengeId: string) => void;
  onSave: (patch: Partial<SettingsRecord>) => void;
  onOpenExport: () => void;
  onSignOut: () => void;
}) {
  const [bodyweight, setBodyweight] = useState<number | ''>(settings.bodyweightKg ?? '');
  const [restOverride, setRestOverride] = useState<number | ''>(
    settings.restOverrideSeconds ?? '',
  );
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);

  const days = daysSinceBackup(settings);

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start">
      <Card>
        {/*
          An inventory, not a selector. The workout row above Today and History owns selection
          outright, and it hosts the "add a workout" control that used to sit in this header —
          one fact, one idiom, one place.
        */}
        <h3 className="font-semibold text-slate-100">Your workouts</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Anything you can count gets its own plan and its own history. Sit-ups, squats,
          pull-ups, dips.
        </p>

        <ul className="mt-4 flex flex-col divide-y divide-[#26324b]">
          {active.map((challenge) => {
            const label = labels.get(challenge.exerciseId) ?? 'Exercise';
            return (
              <li key={challenge.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-100">{label}</div>
                  <div className="tnum mt-0.5 text-xs text-slate-400">
                    from {challenge.baseline.value} toward {challenge.goalValue ?? '—'} · started{' '}
                    {challenge.startedAt.slice(0, 10)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="subtle" onClick={() => setConfirmEnd(challenge.id)}>
                    End
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        {confirmEnd ? (
          <div className="mt-4 flex flex-col gap-3">
            <Banner tone="warn">
              Ending {labels.get(active.find((c) => c.id === confirmEnd)?.exerciseId ?? '') ?? 'it'}{' '}
              stops its plan. The sessions you have logged stay in your history and your backups.
            </Banner>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setConfirmEnd(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                onClick={() => {
                  onEndWorkout(confirmEnd);
                  setConfirmEnd(null);
                }}
              >
                End it
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-100">Backups</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Your history lives on your server, in a SQLite file you can copy. A backup here is a
          second copy you hold yourself — take one now and then.
        </p>
        <div className="mt-3 text-xs text-slate-400">
          {days === null
            ? workoutCount > 0
              ? 'You have never exported a backup.'
              : 'Nothing to back up yet.'
            : days === 0
              ? 'Last backup: today.'
              : `Last backup: ${days} day${days === 1 ? '' : 's'} ago.`}
        </div>
        <div className="mt-4">
          <Button className="w-full" onClick={onOpenExport}>
            Export…
          </Button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-400">
          Restoring one is done on the server, not here:{' '}
          <code className="rounded bg-[#0f1728] px-1 py-0.5">
            npm run import-backup -- backup.json --target godmode.sqlite --dry-run
          </code>
          . It checks every record, builds a new database, verifies it, and only then puts it in
          place — keeping whatever was there before.
        </p>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-100">Unsent workouts</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          A workout you finish with no connection is kept in this browser until the server takes
          it. That is the one thing here iOS can still clear, so do not reinstall or clear site
          data while any are waiting.
        </p>
        <div className="tnum mt-3 text-sm text-slate-200">
          {unsentCount === 0
            ? 'Nothing waiting — everything is on the server.'
            : `${unsentCount} waiting to be sent.`}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-100">Calories</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          A rough estimate, about {settings.kcalCoefficient} kcal per rep per kilo of
          bodyweight.
        </p>
        <div className="mt-4">
          <NumberField
            label="Bodyweight"
            value={bodyweight}
            min={20}
            max={400}
            onChange={setBodyweight}
            suffix="kg"
            hint="Used only for the calorie estimate."
          />
        </div>
        <Button
          variant="ghost"
          className="mt-3 w-full"
          onClick={() =>
            onSave({
              ...(bodyweight === '' ? {} : { bodyweightKg: Number(bodyweight) }),
            })
          }
        >
          Save
        </Button>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-100">Rest between sets</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Rest grows with the size of the session — around 30 seconds early on, about two and
          a half minutes by the end.
        </p>
        <div className="mt-4">
          <NumberField
            label="Fixed rest (leave empty to use the curve)"
            value={restOverride}
            min={0}
            max={600}
            onChange={setRestOverride}
            suffix="sec"
          />
        </div>
        <Button
          variant="ghost"
          className="mt-3 w-full"
          onClick={() =>
            onSave(
              restOverride === ''
                ? { restOverrideSeconds: undefined }
                : { restOverrideSeconds: Number(restOverride) },
            )
          }
        >
          Save
        </Button>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-100">About</h3>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Exercise</dt>
            <dd className="text-slate-200">{exerciseLabel}</dd>
          </div>
          <div className="flex justify-between gap-3">
            {/*
              Scoped, and now said rather than implied. `workoutCount` is the selected
              challenge's session count, while the app also holds a database-wide total (the
              backup nag uses it). With no selection control left in Settings, leaning on the
              adjacent "Exercise" row to carry the scope is weaker than stating it.
            */}
            <dt className="text-slate-400">Sessions for this exercise</dt>
            <dd className="tnum text-slate-200">{workoutCount}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Licence</dt>
            <dd className="text-slate-200">AGPL-3.0</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-100">This device</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Signing out ends the session on the server and forgets it here. Your training is not
          touched — it is on the server, not in this browser.
        </p>
        <Button
          variant="ghost"
          className="mt-4 w-full"
          disabled={unsentCount > 0}
          onClick={onSignOut}
        >
          Sign out
        </Button>
        {unsentCount > 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-amber-300">
            Not while {unsentCount} workout{unsentCount === 1 ? '' : 's'} still needs sending.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
