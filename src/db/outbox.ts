/**
 * The outbox: finished workouts the server has not accepted yet.
 *
 * ## Why IndexedDB and not `localStorage`
 *
 * `.planning/DESIGN-server-sqlite.md` §4. `localStorage` is subject to the same WebKit origin
 * eviction, has no transactions, and a read-modify-write queue can lose entries when two
 * contexts write at once. This store is transactional, so enqueueing a workout and deleting the
 * draft it came from happen together or not at all.
 *
 * ## What it does and does not guarantee
 *
 * **No duplicate.** The entry is keyed by the workout id minted when the session started, which
 * is also the server's idempotency key (`server/routes.ts:328-337`). A workout queued twice
 * overwrites one entry; a workout POSTed twice is stored once and the second call returns the
 * first one's result.
 *
 * **No loss inside the browser.** An entry is deleted only after the server has said 201 for
 * that id. A send that fails, a tab that dies mid-drain, a reload — the entry is still there.
 *
 * **Not proof against eviction.** iOS can clear the origin. That is why `requestPersistentStorage`
 * is called on load, why the unsent count is on screen rather than hidden, and why the README
 * says plainly that an unsent offline workout can still be lost.
 */

import { getLocalDB } from './local.js';
import { markWorkoutSettled } from './drafts.js';
import type { OutboxEntry, PendingWorkout } from './schema.js';

/** The device could not keep the workout either. Distinguished because it is the worst case. */
export class OutboxWriteError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(
      'This device could not save that workout either — its storage refused the write. ' +
        'Your reps are still on screen. Do not close the app.',
    );
    this.name = 'OutboxWriteError';
    this.cause = cause;
  }
}

/**
 * Queue a finished workout and retire the drafts it came from, in one transaction.
 *
 * The sequence number is `max(seq) + 1` over what is currently queued, read inside the same
 * transaction. `MAX + 1` rather than `count + 1` for the reason the server gives for
 * `attempt_no`: a count collides the moment an entry is removed, and entries are removed
 * constantly — every successful send deletes one.
 */
export async function enqueueWorkout(
  workout: PendingWorkout,
  planSlotId: string,
): Promise<OutboxEntry> {
  // Tombstoned before anything is awaited: a debounced draft write already on its way from the
  // runner must not land after the delete below and resurrect a session that is now queued.
  markWorkoutSettled(workout.id);

  try {
    const db = await getLocalDB();
    const tx = db.transaction(['workoutOutbox', 'workoutDrafts'], 'readwrite');
    const outbox = tx.objectStore('workoutOutbox');
    const drafts = tx.objectStore('workoutDrafts');

    const newest = await outbox.index('bySeq').openCursor(null, 'prev');
    const entry: OutboxEntry = {
      id: workout.id,
      seq: (newest?.value.seq ?? 0) + 1,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      workout,
    };

    const draftKeys = await drafts.index('bySlot').getAllKeys(planSlotId);
    for (const key of draftKeys) markWorkoutSettled(key);

    await Promise.all([
      outbox.put(entry),
      ...draftKeys.map((key) => drafts.delete(key)),
      tx.done,
    ]);
    return entry;
  } catch (cause) {
    throw new OutboxWriteError(cause);
  }
}

/**
 * Everything queued, oldest first.
 *
 * Sorted by `seq`, which is the order the workouts were finished in on this device. The drainer
 * depends on this order, so it is read from the index rather than reconstructed from timestamps
 * — a device clock that moves backwards must not reorder a queue.
 */
export async function listOutbox(): Promise<OutboxEntry[]> {
  const db = await getLocalDB();
  return db.getAllFromIndex('workoutOutbox', 'bySeq');
}

export async function countOutbox(): Promise<number> {
  const db = await getLocalDB();
  return db.count('workoutOutbox');
}

/**
 * Clear the "the server will not take this" mark from every entry that carries one.
 *
 * The recovery path for a blocked workout, and the reason blocking is survivable at all. A
 * workout is usually refused because of something the owner can put right — the challenge was
 * ended on the other device, so the slot the workout names is gone — and once it is put right,
 * the same command would be accepted. Without this the entry sits there for ever, kept but
 * unreachable, which Codex correctly called a dead end.
 */
export async function unblockAll(): Promise<number> {
  const db = await getLocalDB();
  const tx = db.transaction('workoutOutbox', 'readwrite');
  let cleared = 0;
  for (const entry of await tx.store.getAll()) {
    if (entry.blockedReason === undefined) continue;
    const { blockedReason: _dropped, ...rest } = entry;
    await tx.store.put(rest);
    cleared += 1;
  }
  await tx.done;
  return cleared;
}

/** Remove an entry the server has confirmed it holds. The only path that deletes a workout. */
export async function removeFromOutbox(id: string): Promise<void> {
  const db = await getLocalDB();
  await db.delete('workoutOutbox', id);
}

/**
 * Record an attempt against an entry, and optionally why it can never succeed.
 *
 * A blocked entry is kept. Deleting it would be throwing away training the user performed
 * because the server disagreed about a plan slot, which is never the right answer — the same
 * reasoning the server applies when it stores a workout against a cancelled slot.
 */
export async function recordSendFailure(
  id: string,
  blockedReason?: string,
): Promise<void> {
  const db = await getLocalDB();
  const tx = db.transaction('workoutOutbox', 'readwrite');
  const entry = await tx.store.get(id);
  if (entry !== undefined) {
    await tx.store.put({
      ...entry,
      attempts: entry.attempts + 1,
      ...(blockedReason === undefined ? {} : { blockedReason }),
    });
  }
  await tx.done;
}
