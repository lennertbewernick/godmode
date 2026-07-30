import { describe, expect, it } from 'vitest';
import type { PlanSlotRecord, WorkoutDraftRecord } from '../db/schema.js';
import { WORKOUT_DRAFT_VERSION } from '../db/schema.js';
import {
  DRAFT_STALE_AFTER_MS,
  chooseDraftOffer,
  draftHasWork,
  draftMatchesSlot,
  draftProgress,
  isDraftReadable,
  isDraftStale,
  newDraft,
  restLeftSeconds,
} from './draft.js';

const T0 = Date.parse('2026-07-30T09:00:00.000Z');

function slot(overrides: Partial<PlanSlotRecord> = {}): PlanSlotRecord {
  return {
    id: 'slot_1',
    challengeId: 'ch_1',
    ordinal: 1,
    week: 1,
    day: 1,
    patternId: 'percentage-ramp',
    patternVersion: 1,
    generatedAt: new Date(T0).toISOString(),
    targets: [
      { index: 1, targetKind: 'reps', reps: 10, role: 'medium', isAmrap: false, restAfterSeconds: 60 },
      { index: 2, targetKind: 'reps', reps: 12, role: 'medium', isAmrap: false },
      { index: 3, targetKind: 'reps', reps: 8, role: 'amrap', isAmrap: true },
    ],
    targetTotal: 30,
    restSeconds: 90,
    status: 'available',
    ...overrides,
  };
}

function draft(overrides: Partial<WorkoutDraftRecord> = {}): WorkoutDraftRecord {
  return {
    ...newDraft({
      id: 'wo_1',
      challengeId: 'ch_1',
      chainId: 'ch_1',
      slot: slot(),
      attemptNo: 1,
      effectiveTargets: [10, 12, 8],
      adjustmentType: 'none',
      nowMs: T0,
    }),
    ...overrides,
  };
}

describe('newDraft — the frozen prescription', () => {
  it('snapshots targets, AMRAP flags and the total', () => {
    const d = newDraft({
      id: 'wo_1',
      challengeId: 'ch_1',
      chainId: 'chain_1',
      slot: slot(),
      attemptNo: 2,
      effectiveTargets: [11, 11, 8],
      adjustmentType: 'redistributed',
      nowMs: T0,
    });

    expect(d.effectiveTargets).toEqual([11, 11, 8]);
    expect(d.amrapFlags).toEqual([false, false, true]);
    expect(d.targetTotal).toBe(30);
    expect(d.adjustmentType).toBe('redistributed');
    expect(d.attemptNo).toBe(2);
    expect(d.chainId).toBe('chain_1');
    expect(d.draftVersion).toBe(WORKOUT_DRAFT_VERSION);
  });

  it('copies the targets rather than aliasing the callers array', () => {
    const targets = [10, 12, 8];
    const d = newDraft({
      id: 'wo_1',
      challengeId: 'ch_1',
      chainId: 'ch_1',
      slot: slot(),
      attemptNo: 1,
      effectiveTargets: targets,
      adjustmentType: 'none',
      nowMs: T0,
    });
    targets[0] = 999;
    expect(d.effectiveTargets[0]).toBe(10);
    expect(d.actuals[0]).toBe(10);
  });

  it('resolves rest per set: the settings override beats the set, which beats the slot', () => {
    // Set 1 carries its own 60s; sets 2 and 3 fall back to the slot's 90s.
    expect(
      newDraft({
        id: 'wo_1',
        challengeId: 'ch_1',
        chainId: 'ch_1',
        slot: slot(),
        attemptNo: 1,
        effectiveTargets: [10, 12, 8],
        adjustmentType: 'none',
        nowMs: T0,
      }).restSecondsPerSet,
    ).toEqual([60, 90, 90]);

    expect(
      newDraft({
        id: 'wo_1',
        challengeId: 'ch_1',
        chainId: 'ch_1',
        slot: slot(),
        attemptNo: 1,
        effectiveTargets: [10, 12, 8],
        adjustmentType: 'none',
        restOverrideSeconds: 30,
        nowMs: T0,
      }).restSecondsPerSet,
    ).toEqual([30, 30, 30]);
  });

  it('starts with nothing recorded, however full the actuals look', () => {
    const d = draft();
    expect(d.actuals).toEqual([10, 12, 8]);
    expect(d.stamps).toEqual([null, null, null]);
    expect(draftProgress(d)).toEqual({ setsDone: 0, setCount: 3, repsDone: 0 });
    expect(draftHasWork(d)).toBe(false);
  });
});

describe('draftProgress — done, not prescribed', () => {
  it('counts only sets with a completed stamp', () => {
    const d = draft({
      actuals: [10, 14, 8],
      stamps: [
        { startedAt: 'a', endedAt: 'b' },
        { startedAt: 'a', endedAt: 'b' },
        null,
      ],
    });
    expect(draftProgress(d)).toEqual({ setsDone: 2, setCount: 3, repsDone: 24 });
    expect(draftHasWork(d)).toBe(true);
  });
});

describe('draftMatchesSlot', () => {
  it('matches the slot it was started for', () => {
    expect(draftMatchesSlot(draft(), slot())).toBe(true);
  });

  it('does not match a different slot', () => {
    expect(draftMatchesSlot(draft(), slot({ id: 'slot_2' }))).toBe(false);
  });

  it('does not match when there is no current slot at all', () => {
    expect(draftMatchesSlot(draft(), undefined)).toBe(false);
  });
});

describe('isDraftReadable', () => {
  it('accepts the version this build writes', () => {
    expect(isDraftReadable(draft())).toBe(true);
  });

  it('declines a draft from a newer build rather than guessing at it', () => {
    expect(isDraftReadable(draft({ draftVersion: WORKOUT_DRAFT_VERSION + 1 }))).toBe(false);
    expect(isDraftReadable(draft({ draftVersion: 0 }))).toBe(false);
  });
});

describe('isDraftStale', () => {
  it('is fresh inside the window', () => {
    expect(isDraftStale(draft(), T0 + DRAFT_STALE_AFTER_MS - 1000)).toBe(false);
  });

  it('is stale past it', () => {
    expect(isDraftStale(draft(), T0 + DRAFT_STALE_AFTER_MS + 1000)).toBe(true);
  });

  it('treats a clock that moved backwards as fresh, not as evidence', () => {
    expect(isDraftStale(draft(), T0 - 5 * DRAFT_STALE_AFTER_MS)).toBe(false);
  });

  it('does not call an unparseable timestamp stale', () => {
    expect(isDraftStale(draft({ updatedAt: 'not a date' }), T0)).toBe(false);
  });
});

describe('restLeftSeconds', () => {
  it('is zero outside rest', () => {
    expect(restLeftSeconds(draft({ phase: 'set' }), T0)).toBe(0);
    expect(restLeftSeconds(draft({ phase: 'review' }), T0)).toBe(0);
  });

  it('counts down from the stored deadline', () => {
    const d = draft({
      phase: 'rest',
      restTotalSeconds: 90,
      restEndsAt: new Date(T0 + 90_000).toISOString(),
    });
    expect(restLeftSeconds(d, T0)).toBe(90);
    expect(restLeftSeconds(d, T0 + 30_000)).toBe(60);
  });

  it('comes back at zero when the rest expired while the app was gone', () => {
    const d = draft({
      phase: 'rest',
      restTotalSeconds: 90,
      restEndsAt: new Date(T0 + 90_000).toISOString(),
    });
    expect(restLeftSeconds(d, T0 + 10 * 60_000)).toBe(0);
  });

  it('never exceeds the rest it was given, whatever the clock says', () => {
    const d = draft({
      phase: 'rest',
      restTotalSeconds: 90,
      restEndsAt: new Date(T0 + 90_000).toISOString(),
    });
    expect(restLeftSeconds(d, T0 - 60 * 60_000)).toBe(90);
  });
});

describe('chooseDraftOffer', () => {
  const current = slot();
  const NONE: ReadonlySet<string> = new Set();

  it('offers nothing when there are no drafts', () => {
    expect(chooseDraftOffer({ drafts: [], currentSlot: current, loggedWorkoutIds: NONE, nowMs: T0 })).toEqual({
      kind: 'none',
    });
  });

  it('offers a draft for the slot on screen', () => {
    const offer = chooseDraftOffer({ drafts: [draft()], currentSlot: current, loggedWorkoutIds: NONE, nowMs: T0 });
    expect(offer.kind).toBe('offer');
    if (offer.kind !== 'offer') return;
    expect(offer.draft.id).toBe('wo_1');
    expect(offer.stale).toBe(false);
  });

  it('ignores a draft for a slot that is no longer current — a logged workout stays logged', () => {
    const orphan = draft({ id: 'wo_old', planSlotId: 'slot_done' });
    expect(chooseDraftOffer({ drafts: [orphan], currentSlot: current, loggedWorkoutIds: NONE, nowMs: T0 })).toEqual({
      kind: 'none',
    });
  });

  it('offers nothing once the plan has run out of slots', () => {
    expect(chooseDraftOffer({ drafts: [draft()], currentSlot: undefined, loggedWorkoutIds: NONE, nowMs: T0 })).toEqual({
      kind: 'none',
    });
  });

  it('never offers a draft whose workout is already in the history', () => {
    // The case that makes matching the current slot insufficient: an attempt that fell short
    // leaves its slot `attempted`, which is still the current slot. The draft is a receipt for
    // work already logged, not an unfinished session.
    expect(
      chooseDraftOffer({
        drafts: [draft()],
        currentSlot: current,
        loggedWorkoutIds: new Set(['wo_1']),
        nowMs: T0,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('offers the unfinished one when a logged and an unlogged draft share a slot', () => {
    const logged = draft({ id: 'wo_logged', updatedAt: new Date(T0 + 60_000).toISOString() });
    const live = draft({ id: 'wo_live', updatedAt: new Date(T0).toISOString() });
    const offer = chooseDraftOffer({
      drafts: [logged, live],
      currentSlot: current,
      loggedWorkoutIds: new Set(['wo_logged']),
      nowMs: T0 + 60_000,
    });
    expect(offer.kind === 'offer' && offer.draft.id).toBe('wo_live');
  });

  it('ignores a draft this build cannot read', () => {
    const future = draft({ draftVersion: 99 });
    expect(chooseDraftOffer({ drafts: [future], currentSlot: current, loggedWorkoutIds: NONE, nowMs: T0 })).toEqual({
      kind: 'none',
    });
  });

  it('prefers the most recently touched draft when two exist for one slot', () => {
    const older = draft({ id: 'wo_old', updatedAt: new Date(T0).toISOString() });
    const newer = draft({ id: 'wo_new', updatedAt: new Date(T0 + 60_000).toISOString() });
    const offer = chooseDraftOffer({
      drafts: [older, newer],
      currentSlot: current,
      loggedWorkoutIds: NONE,
      nowMs: T0 + 60_000,
    });
    expect(offer.kind === 'offer' && offer.draft.id).toBe('wo_new');
  });

  it('still offers a stale draft, flagged rather than discarded', () => {
    const offer = chooseDraftOffer({
      drafts: [draft()],
      currentSlot: current,
      loggedWorkoutIds: NONE,
      nowMs: T0 + DRAFT_STALE_AFTER_MS + 60_000,
    });
    expect(offer.kind).toBe('offer');
    expect(offer.kind === 'offer' && offer.stale).toBe(true);
  });

  it('reports the progress the offer should describe', () => {
    const partial = draft({
      actuals: [10, 12, 8],
      stamps: [{ startedAt: 'a', endedAt: 'b' }, null, null],
    });
    const offer = chooseDraftOffer({ drafts: [partial], currentSlot: current, loggedWorkoutIds: NONE, nowMs: T0 });
    expect(offer.kind === 'offer' && offer.progress).toEqual({
      setsDone: 1,
      setCount: 3,
      repsDone: 10,
    });
  });
});
