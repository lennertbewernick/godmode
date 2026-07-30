/**
 * The two decisions a half-finished workout can force.
 *
 * Both are the user's, and neither is taken for them. Resuming silently would put someone
 * else's numbers on the screen — their own, from a session they may not remember starting —
 * and dropping the draft on its own initiative would delete reps that were actually performed.
 * So the app says what it found, in reps and sets, and waits.
 *
 * Discarding is deliberately two presses, exactly as replacing a database is in `RestoreDialog`.
 */

import { useState } from 'react';
import type { WorkoutDraftRecord } from '../db/schema.js';
import type { DraftProgress } from './draft.js';
import { Banner, Button, Modal } from './kit.js';

function describeWhen(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'earlier';
  const minutes = Math.round((nowMs - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function progressLine(progress: DraftProgress): string {
  if (progress.setsDone === 0) return 'No sets finished yet.';
  return (
    `${progress.setsDone} of ${progress.setCount} set${progress.setCount === 1 ? '' : 's'} ` +
    `finished · ${progress.repsDone} rep${progress.repsDone === 1 ? '' : 's'} recorded`
  );
}

export function ResumeDialog({
  draft,
  progress,
  stale,
  nowMs,
  onResume,
  onDiscard,
  onDismiss,
}: {
  draft: WorkoutDraftRecord;
  progress: DraftProgress;
  /** Old enough that "you were in the middle of a workout" needs a date attached. */
  stale: boolean;
  nowMs: number;
  onResume: () => void;
  onDiscard: () => void;
  onDismiss: () => void;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  if (confirmDiscard) {
    return (
      <Modal title="Throw this workout away?" onClose={() => setConfirmDiscard(false)}>
        <div className="flex flex-col gap-3">
          <Banner tone="warn">
            {progress.setsDone === 0
              ? 'Nothing was recorded, so nothing is lost.'
              : `${progress.repsDone} rep${progress.repsDone === 1 ? '' : 's'} you already did ` +
                'will be gone. This cannot be undone.'}
          </Banner>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Back
            </Button>
            <Button variant="danger" className="flex-1" onClick={onDiscard}>
              Discard it
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="You have a workout in progress" onClose={onDismiss}>
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-slate-300">
          Started <span className="font-medium text-slate-100">{describeWhen(draft.startedAt, nowMs)}</span>
          {stale ? ' — a while ago now' : ''}. Nothing has been added to your history yet.
        </p>

        <div className="tnum rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2.5 text-sm text-slate-200">
          {progressLine(progress)}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" onClick={onResume}>
            Pick up where you left off
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
            Discard
          </Button>
        </div>
        <button type="button" className="text-xs text-slate-400 underline" onClick={onDismiss}>
          Not now — leave it as it is
        </button>
      </div>
    </Modal>
  );
}

/**
 * Leaving the runner. The draft is kept unless the user says otherwise, because "Cancel" on a
 * screen full of reps is far more often "let me look at something else" than "delete this".
 */
export function LeaveRunnerDialog({
  progress,
  onKeep,
  onDiscard,
  onStay,
}: {
  progress: DraftProgress;
  onKeep: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  return (
    <Modal title="Leave this workout?" onClose={onStay}>
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-slate-300">
          {progress.setsDone === 0
            ? 'Nothing has been recorded yet.'
            : `${progress.repsDone} rep${progress.repsDone === 1 ? '' : 's'} across ` +
              `${progress.setsDone} set${progress.setsDone === 1 ? '' : 's'} are saved on this ` +
              'device. Leaving keeps them — you can pick the session back up from Today.'}
        </p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" onClick={onStay}>
            Keep going
          </Button>
          <Button variant="ghost" onClick={onKeep}>
            Leave and keep it
          </Button>
        </div>
        <button
          type="button"
          className="text-xs text-amber-300 underline"
          onClick={onDiscard}
        >
          Leave and throw it away
        </button>
      </div>
    </Modal>
  );
}
