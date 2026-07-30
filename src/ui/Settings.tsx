/**
 * Settings, backup, and restore.
 *
 * The device-only-copy explanation lives here and in onboarding (DIST-04), because iOS will
 * evict IndexedDB for sites it considers unused. Data loss is a product concern, not a
 * footnote in a README.
 */

import { useState } from 'react';
import { daysSinceBackup } from '../data/exchange.js';
import type { ChallengeRecord, SettingsRecord } from '../db/schema.js';
import { Banner, Button, Card, NumberField } from './kit.js';

export function Settings({
  settings,
  exerciseLabel,
  workoutCount,
  active,
  labels,
  selectedId,
  onSelectChallenge,
  onAddWorkout,
  onEndWorkout,
  onSave,
  onExportJson,
  onExportCsv,
  onRestore,
  onResetAll,
}: {
  settings: SettingsRecord;
  exerciseLabel: string;
  workoutCount: number;
  active: ChallengeRecord[];
  labels: Map<string, string>;
  selectedId: string;
  onSelectChallenge: (challengeId: string) => void;
  onAddWorkout: () => void;
  onEndWorkout: (challengeId: string) => void;
  onSave: (patch: Partial<SettingsRecord>) => void;
  onExportJson: () => void;
  onExportCsv: () => void;
  onRestore: (file: File) => void;
  onResetAll: () => void;
}) {
  const [bodyweight, setBodyweight] = useState<number | ''>(settings.bodyweightKg ?? '');
  const [restOverride, setRestOverride] = useState<number | ''>(
    settings.restOverrideSeconds ?? '',
  );
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);

  const days = daysSinceBackup(settings);

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-100">Your workouts</h3>
          <Button variant="ghost" onClick={onAddWorkout}>
            Add a workout
          </Button>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Anything you can count gets its own plan and its own history. Sit-ups, squats,
          pull-ups, dips.
        </p>

        <ul className="mt-4 flex flex-col divide-y divide-[#26324b]">
          {active.map((challenge) => {
            const label = labels.get(challenge.exerciseId) ?? 'Exercise';
            const isSelected = challenge.id === selectedId;
            return (
              <li key={challenge.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-100">
                    {label}
                    {isSelected ? (
                      <span className="ml-2 text-xs font-normal text-teal-300">showing</span>
                    ) : null}
                  </div>
                  <div className="tnum mt-0.5 text-xs text-slate-400">
                    from {challenge.baseline.value} toward {challenge.goalValue ?? '—'} · started{' '}
                    {challenge.startedAt.slice(0, 10)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {isSelected ? null : (
                    <Button variant="ghost" onClick={() => onSelectChallenge(challenge.id)}>
                      Show
                    </Button>
                  )}
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
          This phone holds the only copy of your history, and iOS can clear storage for web
          apps you haven't opened in a while. Export a backup now and then.
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
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" onClick={onExportJson}>
            Export backup
          </Button>
          <Button variant="ghost" onClick={onExportCsv}>
            Export CSV
          </Button>
        </div>
        <label className="mt-3 block">
          <span className="text-sm font-medium text-slate-300">Restore from a backup</span>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onRestore(file);
            }}
            className="mt-1.5 block w-full cursor-pointer rounded-xl border border-dashed border-[#3b4a68] bg-[#0f1728] px-3 py-3 text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-[#26324b] file:px-3 file:py-1.5 file:text-slate-200"
          />
          <span className="mt-1.5 block text-xs text-slate-400">
            Replaces everything currently stored here.
          </span>
        </label>
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
            <dt className="text-slate-400">Sessions stored</dt>
            <dd className="tnum text-slate-200">{workoutCount}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Licence</dt>
            <dd className="text-slate-200">AGPL-3.0</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h3 className="font-semibold text-red-300">Delete everything</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Wipes every session and setting on this device. Export a backup first.
        </p>
        {confirmReset ? (
          <div className="mt-4 flex flex-col gap-3">
            <Banner tone="warn">This cannot be undone.</Banner>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setConfirmReset(false)}>
                Keep my data
              </Button>
              <Button variant="danger" className="flex-1" onClick={onResetAll}>
                Delete it all
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" className="mt-4 w-full" onClick={() => setConfirmReset(true)}>
            Delete all data
          </Button>
        )}
      </Card>
    </div>
  );
}
