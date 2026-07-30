/**
 * What a backup file would do, shown before anything is written.
 *
 * Restore used to be one button that cleared the database. It said so — but a user with a Mac
 * backup and a phone that has trained since has no way to want that, and no way to see what it
 * would cost until it had already happened. This dialog puts the numbers in front of the
 * decision, and splits the decision in two: add what is missing, or start again from the file.
 *
 * Neither destructive action is preselected, and replace still takes a second, deliberate press.
 */

import { useState } from 'react';
import type { MergePlan, MergeStore } from '../data/merge.js';
import { MERGE_STORES } from '../data/merge.js';
import { Banner, Button, Modal } from './kit.js';

/** Store names as this app says them out loud, not as the schema spells them. */
const STORE_LABELS: Record<MergeStore, string> = {
  exercises: 'Exercises',
  challenges: 'Workouts',
  planSlots: 'Planned sessions',
  workouts: 'Logged sessions',
  performanceTests: 'Max tests',
};

/** Up to five ids, then a count — enough to recognise, not enough to bury the decision. */
function nameSome(ids: string[]): string {
  const shown = ids.slice(0, 5).join(', ');
  return ids.length > 5 ? `${shown}, and ${ids.length - 5} more` : shown;
}

export function RestoreDialog({
  plan,
  fileName,
  onMerge,
  onReplace,
  onCancel,
}: {
  plan: MergePlan;
  fileName: string;
  onMerge: () => void;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const [confirmReplace, setConfirmReplace] = useState(false);

  const localEnded = plan.divergent.filter((d) => d.reason === 'local-ended');
  const fileEnded = plan.divergent.filter((d) => d.reason === 'file-ended');
  const contentDivergent = plan.divergent.filter((d) => d.reason === 'content');

  if (confirmReplace) {
    return (
      <Modal title="Replace everything?" onClose={onCancel}>
        <div className="flex flex-col gap-3">
          <Banner tone="warn">
            Everything currently on this device — {plan.totals.identical + plan.totals.divergent}{' '}
            record{plan.totals.identical + plan.totals.divergent === 1 ? '' : 's'} it shares with
            this file, and anything it does not — is erased and replaced by {fileName}. This
            cannot be undone.
          </Banner>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setConfirmReplace(false)}>
              Back
            </Button>
            <Button variant="danger" className="flex-1" onClick={onReplace}>
              Replace it all
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="What this backup would change" onClose={onCancel} wide>
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-slate-300">
          <span className="break-all font-medium text-slate-100">{fileName}</span> — nothing has
          been written yet.
        </p>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400">
              <th className="py-1 text-left font-normal">&nbsp;</th>
              <th className="py-1 text-right font-normal">Adds</th>
              <th className="py-1 text-right font-normal">Already here</th>
              <th className="py-1 text-right font-normal">Different here</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#26324b]">
            {MERGE_STORES.map((store) => {
              const counts = plan.counts[store];
              return (
                <tr key={store}>
                  <td className="py-1.5 text-slate-300">{STORE_LABELS[store]}</td>
                  <td className="tnum py-1.5 text-right font-semibold text-teal-300">
                    {counts.added}
                  </td>
                  <td className="tnum py-1.5 text-right text-slate-400">{counts.identical}</td>
                  <td className="tnum py-1.5 text-right text-slate-400">{counts.divergent}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {plan.skipped.length > 0 ? (
          <Banner tone="warn">
            {plan.skipped.length} record{plan.skipped.length === 1 ? '' : 's'} in this file point
            at something neither this device nor the file has, so storing them would leave rows
            the app cannot show. They are left out:{' '}
            <span className="break-all">{nameSome(plan.skipped.map((s) => s.id))}</span>. They
            stay in the file — merge the missing workout first and this file will pick them up.
          </Banner>
        ) : null}

        {plan.divergent.length > 0 ? (
          <div className="flex flex-col gap-2 text-sm leading-relaxed text-slate-300">
            {contentDivergent.length > 0 ? (
              <p>
                The file holds a different version of {contentDivergent.length} record
                {contentDivergent.length === 1 ? '' : 's'}.{' '}
                <span className="font-medium text-slate-100">
                  What is on this device is kept.
                </span>{' '}
                Nothing from the file overwrites it.
              </p>
            ) : null}
            {localEnded.length > 0 ? (
              <p>
                {localEnded.length} workout{localEnded.length === 1 ? '' : 's'} you ended here{' '}
                {localEnded.length === 1 ? 'is' : 'are'} still running in this file. Merging does
                not start {localEnded.length === 1 ? 'it' : 'them'} again — ended stays ended.
              </p>
            ) : null}
            {fileEnded.length > 0 ? (
              <p>
                {fileEnded.length} workout{fileEnded.length === 1 ? '' : 's'} ended in this file{' '}
                {fileEnded.length === 1 ? 'is' : 'are'} still running here. Merging leaves{' '}
                {fileEnded.length === 1 ? 'it' : 'them'} running — end{' '}
                {fileEnded.length === 1 ? 'it' : 'them'} in Settings if that is what you want.
              </p>
            ) : null}
          </div>
        ) : null}

        {plan.warnings.length > 0 ? (
          <p className="text-xs leading-relaxed text-slate-400">
            {plan.warnings.length} incoming record{plan.warnings.length === 1 ? '' : 's'} refer to
            a plan slot or an earlier block that is not here. They are added unchanged and simply
            stay unlinked.
          </p>
        ) : null}

        <p className="text-xs leading-relaxed text-slate-400">
          Your settings — bodyweight, rest, the calorie coefficient — are never merged. This
          device keeps its own.
        </p>

        <div className="flex flex-col gap-2">
          <Button className="w-full" onClick={onMerge}>
            Merge into what's here
          </Button>
          <p className="text-xs leading-relaxed text-slate-400">
            Adds the {plan.totals.added} record{plan.totals.added === 1 ? '' : 's'} this file has
            and this device does not. Nothing here is changed or deleted.
          </p>

          <Button variant="danger" className="mt-2 w-full" onClick={() => setConfirmReplace(true)}>
            Replace everything
          </Button>
          <p className="text-xs leading-relaxed text-slate-400">
            Replaces everything currently stored here.
          </p>

          <Button variant="ghost" className="mt-2 w-full" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
