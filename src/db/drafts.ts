/**
 * The in-progress workout buffer.
 *
 * Lifted out of the retired `repo.ts` unchanged in behaviour, with one substitution: the check
 * that stopped a draft being written back after its workout was logged used to read the local
 * `workouts` store. That store is not the history any more. Its replacement is two facts this
 * device still owns for certain — the workout is sitting in the outbox, or this tab has
 * tombstoned it — plus the snapshot-level filter in `chooseDraftOffer`, which never offers a
 * draft whose id is already a workout on the server.
 */

import { getLocalDB } from './local.js';
import type { WorkoutDraftRecord } from './schema.js';

/**
 * Ids this tab has deliberately finished with, or thrown away.
 *
 * A discard has to survive the writes that are still in flight when it happens. The runner
 * debounces rep edits, and its own unmount flushes whatever is pending — so discarding while
 * an edit was inside its debounce window used to delete the draft and then immediately write
 * it back, while the screen said it was gone.
 *
 * Per tab and per page load, deliberately: it is a record of a decision made in this session,
 * not persisted state. Another tab is stopped by the durable checks in `saveDraft` instead.
 */
const settledDrafts = new Set<string>();

/**
 * Test seam — forget this tab's discards.
 *
 * Standing in for a *second tab*, which has its own module state and therefore knows nothing
 * about what this one threw away. It is what lets a test show that the durable checks below
 * hold on their own, rather than being masked by the in-memory set.
 */
export function __forgetDiscardedDrafts(): void {
  settledDrafts.clear();
}

/**
 * Record that this workout is finished — accepted by the server, or queued for it.
 *
 * Called on both save paths, before the drafts are deleted, so a debounced write already on its
 * way from the runner cannot resurrect a session that is now history.
 */
export function markWorkoutSettled(workoutId: string): void {
  settledDrafts.add(workoutId);
}

export type SaveDraftResult =
  | 'saved'
  /** The workout was already saved or queued, or the draft was discarded. Writing it back would resurrect it. */
  | 'refused-gone'
  /** Something further along is already stored — another tab. Overwriting would lose sets. */
  | 'refused-stale';

/** Sets with a completed stamp. The measure of how far a draft has actually got. */
function completedSets(draft: WorkoutDraftRecord): number {
  return draft.stamps.reduce<number>((n, stamp) => (stamp === null ? n : n + 1), 0);
}

/**
 * Write the in-progress workout.
 *
 * Called after every material action in the runner, so it is a whole-record `put`: a
 * read-modify-write of the runner's own state would race the next tap of the stepper.
 *
 * It is not an unconditional `put`, though, and the two conditions are the difference between
 * a buffer and a liability. Both are checked inside the transaction that does the writing,
 * because the thing they are defending against is another tab:
 *
 *   - a draft whose workout is already queued in the outbox is never written back. Otherwise a
 *     second tab still holding the session could recreate the draft after the finish path
 *     deleted it, and the app would offer to redo a workout that is already saved.
 *   - a draft that has completed fewer sets than the one already stored is never written
 *     either. Last-writer-wins across two tabs would otherwise let a stale one erase sets the
 *     other had recorded. Rep counts within the same set still go to the last writer; that is
 *     a genuine conflict and this layer does not pretend to resolve it.
 */
export async function saveDraft(draft: WorkoutDraftRecord): Promise<SaveDraftResult> {
  if (settledDrafts.has(draft.id)) return 'refused-gone';

  const db = await getLocalDB();
  const tx = db.transaction(['workoutOutbox', 'workoutDrafts'], 'readwrite');
  const drafts = tx.objectStore('workoutDrafts');

  const [queued, stored] = await Promise.all([
    tx.objectStore('workoutOutbox').get(draft.id),
    drafts.get(draft.id),
  ]);

  if (queued) {
    await tx.done;
    return 'refused-gone';
  }
  if (stored && completedSets(stored) > completedSets(draft)) {
    await tx.done;
    return 'refused-stale';
  }

  await Promise.all([drafts.put(draft), tx.done]);
  return 'saved';
}

/** Every draft on the device. There is normally at most one; see `chooseDraftOffer`. */
export async function listDrafts(): Promise<WorkoutDraftRecord[]> {
  const db = await getLocalDB();
  return db.getAll('workoutDrafts');
}

export async function getDraft(id: string): Promise<WorkoutDraftRecord | undefined> {
  const db = await getLocalDB();
  return db.get('workoutDrafts', id);
}

/**
 * Throw a draft away. Idempotent: deleting a key that is not there is a no-op in IndexedDB, so
 * a double tap, a retry after a failed save, and a draft already cleared by the finish path all
 * behave the same.
 *
 * The id is recorded before anything is awaited, so a write already queued behind this call
 * cannot land after it and undo it.
 */
export async function deleteDraft(id: string): Promise<void> {
  settledDrafts.add(id);
  const db = await getLocalDB();
  await db.delete('workoutDrafts', id);
}

/**
 * Delete every draft for a plan slot, not only the one whose id we were given.
 *
 * A session abandoned without a decision and then redone leaves an older draft behind, and it
 * describes work that is now in the history under a different id. Tombstoned as well as
 * deleted, for the same reason as `deleteDraft`.
 */
export async function clearDraftsForSlot(planSlotId: string): Promise<void> {
  const db = await getLocalDB();
  const tx = db.transaction('workoutDrafts', 'readwrite');
  const keys = await tx.store.index('bySlot').getAllKeys(planSlotId);
  for (const key of keys) settledDrafts.add(key);
  await Promise.all([...keys.map((key) => tx.store.delete(key)), tx.done]);
}
