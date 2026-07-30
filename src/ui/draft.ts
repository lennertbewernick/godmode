/**
 * Every decision about an in-progress workout draft, as pure functions.
 *
 * Nothing here opens a database, reads `window`, or calls `Date.now()` — the clock arrives as a
 * parameter, exactly as in `nav.ts` and `pwa/policy.ts`. That is what lets "would this draft be
 * offered?" be pinned by a test instead of by starting a workout, killing a tab, and looking.
 *
 * The rules these functions encode, stated once so they are argued with rather than rediscovered:
 *
 *   1. A draft is offered, never applied. Restoring a session silently would leave the user
 *      unable to tell a resumed workout from a fresh one, and the numbers on screen would be
 *      someone else's — their own, from Tuesday.
 *   2. A draft is only ever offered for the slot the app is currently showing. A slot that has
 *      been completed is never the current slot, so a logged workout cannot be resurrected by a
 *      draft that outlived it.
 *   3. Age never discards anything. A stale draft is described differently, not deleted:
 *      the only thing that removes reps a user actually performed is that user saying so.
 */

import type { AdjustmentType } from '../core/types.js';
import type { PlanSlotRecord, WorkoutDraftRecord } from '../db/schema.js';
import { WORKOUT_DRAFT_VERSION } from '../db/schema.js';

/** Past this, the offer says when the session started rather than assuming it is still today. */
export const DRAFT_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * The draft a workout starts life as — built, not written.
 *
 * Every prescription the session will be judged against is frozen here, at the one moment the
 * user saw it and pressed Start: the targets after their adjustment, which sets are open-ended,
 * the total to beat, and the rest after each set with the settings override already folded in.
 * Nothing downstream re-reads the slot, so changing a rest override, or superseding the slot
 * from another tab, cannot silently rewrite a workout that is already under way.
 *
 * `id` is supplied rather than generated so this stays pure and so the caller can hand the same
 * id to `logWorkout`, where it makes saving idempotent.
 */
export function newDraft(input: {
  id: string;
  challengeId: string;
  chainId: string;
  slot: PlanSlotRecord;
  attemptNo: number;
  effectiveTargets: number[];
  adjustmentType: AdjustmentType;
  restOverrideSeconds?: number | undefined;
  nowMs: number;
}): WorkoutDraftRecord {
  const startedAt = new Date(input.nowMs).toISOString();
  return {
    id: input.id,
    draftVersion: WORKOUT_DRAFT_VERSION,
    challengeId: input.challengeId,
    chainId: input.chainId,
    planSlotId: input.slot.id,
    attemptNo: input.attemptNo,
    effectiveTargets: [...input.effectiveTargets],
    amrapFlags: input.effectiveTargets.map((_, i) => input.slot.targets[i]?.isAmrap === true),
    targetTotal: input.slot.targetTotal,
    restSecondsPerSet: input.effectiveTargets.map(
      (_, i) =>
        input.restOverrideSeconds ??
        input.slot.targets[i]?.restAfterSeconds ??
        input.slot.restSeconds,
    ),
    adjustmentType: input.adjustmentType,
    // Pre-filled with the prescription, exactly as the runner shows it: the stepper starts on
    // the number you were asked for, and `stamps` is what distinguishes done from prescribed.
    actuals: [...input.effectiveTargets],
    stamps: input.effectiveTargets.map(() => null),
    index: 0,
    phase: 'set',
    restTotalSeconds: 0,
    restEndsAt: null,
    setStartedAt: startedAt,
    startedAt,
    updatedAt: startedAt,
  };
}

/**
 * Can this build make sense of this draft?
 *
 * A draft written by a newer build may carry fields this one has never heard of, and resuming
 * from it would silently drop them. A draft written by an older format may be missing fields
 * this build requires. Either way the answer is to leave it alone — not to guess, and not to
 * delete it, because a build that cannot read a record is in no position to decide it is worthless.
 */
export function isDraftReadable(draft: WorkoutDraftRecord): boolean {
  return draft.draftVersion === WORKOUT_DRAFT_VERSION;
}

/** Does this draft belong to the session the app is currently offering? */
export function draftMatchesSlot(
  draft: WorkoutDraftRecord,
  slot: PlanSlotRecord | undefined,
): boolean {
  return slot !== undefined && draft.planSlotId === slot.id;
}

/**
 * Has this draft been sitting around long enough that "resume your workout" would be a lie?
 *
 * Presentation only — see rule 3 above. A negative elapsed time (a device clock that moved
 * backwards, or a draft written on another machine) counts as not stale rather than as
 * evidence of anything.
 */
export function isDraftStale(
  draft: WorkoutDraftRecord,
  nowMs: number,
  maxAgeMs: number = DRAFT_STALE_AFTER_MS,
): boolean {
  const updatedAt = Date.parse(draft.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  return nowMs - updatedAt > maxAgeMs;
}

export interface DraftProgress {
  /** Sets with a completed stamp — work that is genuinely done, not merely pre-filled. */
  setsDone: number;
  setCount: number;
  /** Reps across completed sets only. The remaining entries are still the prescription. */
  repsDone: number;
}

/**
 * What the user would be resuming.
 *
 * Counted from the stamps, never from `actuals`: the runner pre-fills every set with its
 * target, so a workout on set one already has five plausible-looking numbers in it. Reporting
 * those as "reps recorded" would offer to restore work nobody has done.
 */
export function draftProgress(draft: WorkoutDraftRecord): DraftProgress {
  let setsDone = 0;
  let repsDone = 0;
  draft.stamps.forEach((stamp, i) => {
    if (stamp === null) return;
    setsDone += 1;
    repsDone += draft.actuals[i] ?? 0;
  });
  return { setsDone, setCount: draft.effectiveTargets.length, repsDone };
}

/** Whether anything would actually be lost by discarding this draft. */
export function draftHasWork(draft: WorkoutDraftRecord): boolean {
  return draftProgress(draft).setsDone > 0;
}

/**
 * Seconds left on a rest that was in progress when the app went away.
 *
 * The draft stores the instant rest ends, not a countdown, so this is a subtraction rather
 * than a replay. A rest that expired while the app was closed comes back as zero, which drops
 * the resumed session straight into the set — which is what actually happened.
 */
export function restLeftSeconds(draft: WorkoutDraftRecord, nowMs: number): number {
  if (draft.phase !== 'rest' || draft.restEndsAt === null) return 0;
  const endsAt = Date.parse(draft.restEndsAt);
  if (!Number.isFinite(endsAt)) return 0;
  return Math.max(0, Math.min(draft.restTotalSeconds, Math.ceil((endsAt - nowMs) / 1000)));
}

export type DraftOffer =
  | { kind: 'none' }
  | { kind: 'offer'; draft: WorkoutDraftRecord; stale: boolean; progress: DraftProgress };

/**
 * Should the app offer to pick a workout back up, and which one?
 *
 * Three filters, and the third is the one that matters most.
 *
 * Drafts for other slots are ignored rather than deleted. They cost a few hundred bytes and
 * they are the only record that the session happened at all; the alternative is a tidy-up
 * routine that throws away reps because a plan moved on.
 *
 * A draft whose id is already a logged workout is never offered. Matching the current slot is
 * NOT sufficient on its own, and assuming it was would have been a real bug: an attempt that
 * did not reach its target leaves its slot `attempted`, which means still current. A draft for
 * that slot — recreated by a second tab, or written late — would otherwise be offered as
 * unfinished work when its reps are already in the history. The draft carries the id its
 * workout was logged under precisely so this check is possible.
 *
 * When more than one draft survives for the same slot — two tabs, or a start that was
 * abandoned without a decision — the most recently touched one wins. It is the one the user
 * was last looking at.
 */
export function chooseDraftOffer(input: {
  drafts: readonly WorkoutDraftRecord[];
  currentSlot: PlanSlotRecord | undefined;
  /** Ids of workouts already in the history. A draft among them is a receipt, not a session. */
  loggedWorkoutIds: ReadonlySet<string>;
  nowMs: number;
}): DraftOffer {
  const candidates = input.drafts
    .filter(
      (d) =>
        isDraftReadable(d) &&
        draftMatchesSlot(d, input.currentSlot) &&
        !input.loggedWorkoutIds.has(d.id),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const draft = candidates[0];
  if (!draft) return { kind: 'none' };

  return {
    kind: 'offer',
    draft,
    stale: isDraftStale(draft, input.nowMs),
    progress: draftProgress(draft),
  };
}
