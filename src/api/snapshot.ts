/**
 * Reading a snapshot — pure functions, no fetch, no storage.
 *
 * These are the queries the retired `repo.ts` ran against IndexedDB: which challenges are
 * active, which one is showing, which slot is next, how many attempts a slot has had. One
 * `GET /api/snapshot` replaces the five independent reads `App.load()` used to make
 * (`.planning/DESIGN-server-sqlite.md` §7), and the answers are derived here rather than asked
 * for one at a time, so they cannot disagree with each other.
 */

import type {
  ChallengeRecord,
  OutboxEntry,
  PlanSlotRecord,
  WorkoutRecord,
} from '../db/schema.js';
import type { Snapshot } from './client.js';

/** Every active challenge, newest first. More than one means more than one exercise on the go. */
export function activeChallenges(snapshot: Snapshot): ChallengeRecord[] {
  return snapshot.challenges
    .filter((c) => c.status === 'active')
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * The challenge to show: the one the user last selected, or the newest active one.
 *
 * The fall-back matters. A stored selection can outlive the challenge it names — the workout
 * was ended, or ended on the other device — and resolving that to "nothing" would strand the
 * user on an empty screen with their data still intact underneath.
 */
export function resolveSelectedChallenge(snapshot: Snapshot): ChallengeRecord | undefined {
  const active = activeChallenges(snapshot);
  return active.find((c) => c.id === snapshot.settings.selectedChallengeId) ?? active[0];
}

/** Labels for the challenges on screen, so the switcher can name them. */
export function exerciseLabels(snapshot: Snapshot): Map<string, string> {
  const labels = new Map<string, string>();
  for (const exercise of snapshot.exercises) labels.set(exercise.id, exercise.label);
  return labels;
}

/** A challenge's live plan, in order. Superseded and cancelled slots are not part of it. */
export function slotsFor(snapshot: Snapshot, challengeId: string): PlanSlotRecord[] {
  return snapshot.planSlots
    .filter(
      (s) =>
        s.challengeId === challengeId && s.status !== 'superseded' && s.status !== 'cancelled',
    )
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
}

/** The next slot to attempt: the lowest ordinal not yet completed. */
export function currentSlot(slots: readonly PlanSlotRecord[]): PlanSlotRecord | undefined {
  return slots.find((s) => s.status !== 'completed');
}

export function attemptsOn(snapshot: Snapshot, planSlotId: string): number {
  return snapshot.workouts.filter((w) => w.planSlotId === planSlotId).length;
}

/** One chain's history, oldest first. `performedAt` is the display order — never `attemptNo`. */
export function workoutsForChain(snapshot: Snapshot, chainId: string): WorkoutRecord[] {
  return snapshot.workouts
    .filter((w) => w.chainId === chainId)
    .slice()
    .sort((a, b) => a.performedAt.localeCompare(b.performedAt));
}

/**
 * The dataset as the user should see it while workouts are still queued locally.
 *
 * **Display only.** Nothing derived here is ever sent anywhere: the outbox entries are POSTed
 * exactly as they were composed, and the moment the server accepts one, the real record with
 * the real `attemptNo` arrives in the next snapshot and replaces this.
 *
 * Without it, finishing a session offline would leave Today still asking for the day you just
 * did, and History missing it — a truthful-but-useless screen. The two things it fabricates are
 * both marked as such:
 *
 *   - `attemptNo` is guessed as "after the ones the server already has". The server assigns the
 *     real one on acceptance; this number is never sent and never stored.
 *   - the slot is ratcheted by the same rule the server applies (`server/routes.ts:401`), so a
 *     completed day stays completed and a slot outside the plan is left alone.
 */
export function applyPending(
  snapshot: Snapshot,
  entries: readonly OutboxEntry[],
): Snapshot {
  if (entries.length === 0) return snapshot;

  const known = new Set(snapshot.workouts.map((w) => w.id));
  const queued = entries.filter((e) => !known.has(e.workout.id));
  if (queued.length === 0) return snapshot;

  const nextAttempt = new Map<string, number>();
  for (const workout of snapshot.workouts) {
    if (workout.planSlotId === undefined) continue;
    nextAttempt.set(
      workout.planSlotId,
      Math.max(nextAttempt.get(workout.planSlotId) ?? 0, workout.attemptNo),
    );
  }

  const added: WorkoutRecord[] = [];
  const advanced = new Map<string, boolean>();
  for (const entry of queued) {
    const slotId = entry.workout.planSlotId;
    const attemptNo = slotId === undefined ? 1 : (nextAttempt.get(slotId) ?? 0) + 1;
    if (slotId !== undefined) {
      nextAttempt.set(slotId, attemptNo);
      advanced.set(slotId, (advanced.get(slotId) ?? false) || entry.workout.evaluation?.advances === true);
    }
    added.push({ ...entry.workout, attemptNo });
  }

  return {
    ...snapshot,
    workouts: [...snapshot.workouts, ...added].sort((a, b) =>
      a.performedAt.localeCompare(b.performedAt),
    ),
    planSlots: snapshot.planSlots.map((slot) =>
      advanced.has(slot.id)
        ? { ...slot, status: ratchet(slot.status, advanced.get(slot.id) === true) }
        : slot,
    ),
  };
}

/** `completed` is a one-way door; slots outside the plan are left alone. Mirrors the server. */
export function ratchet(
  current: PlanSlotRecord['status'],
  advances: boolean,
): PlanSlotRecord['status'] {
  if (current === 'completed' || current === 'superseded' || current === 'cancelled') {
    return current;
  }
  return advances ? 'completed' : 'attempted';
}
