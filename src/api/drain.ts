/**
 * Draining the outbox.
 *
 * ## Serialised, because two drainers are a duplicate waiting to happen
 *
 * §5 of the design: "outbox drainage is serialised per client so the reconnect drainer and the
 * page-load drainer cannot overlap". They would otherwise both read the same entry and both
 * POST it. The server would still store one workout — the id is the idempotency key — but the
 * second drainer would then delete an entry the first one had not finished sending, or report a
 * count nobody can reconcile. One queue, one drainer at a time, enforced by a promise chain
 * rather than a boolean flag: a flag has a window between the read and the set.
 *
 * ## Oldest first, and what happens when one entry cannot be sent
 *
 * Entries go in `seq` order, which is the order they were finished in. A failure that retrying
 * could fix — no network, a 5xx, an expired session — **stops the drain**, leaving that entry
 * and everything after it queued in order.
 *
 * A failure retrying cannot fix is different, and the choice here is deliberate. If the server
 * refuses a workout outright (it knows no such plan slot, because the challenge was ended on the
 * other device), stopping would block every later workout behind it forever. So the entry is
 * **kept and marked**, the drain steps over it, and the count of blocked entries is surfaced.
 * Nothing is ever deleted for being unacceptable: it is training the user actually performed.
 */

import { ApiError, postWorkout, type Snapshot } from './client.js';
import { markWorkoutSettled } from '../db/drafts.js';
import { countOutbox, listOutbox, recordSendFailure, removeFromOutbox } from '../db/outbox.js';

export interface DrainResult {
  /** Workouts the server has now confirmed it holds. */
  sent: number;
  /** Entries still queued, including blocked ones. */
  remaining: number;
  /** Entries the server refused for a reason retrying cannot fix. */
  blocked: number;
  /** The snapshot from the last accepted workout, so the caller need not re-read. */
  snapshot?: Snapshot;
  /** Why the drain stopped early, if it did. Always retryable or an auth problem. */
  stoppedBy?: ApiError;
}

const EMPTY: DrainResult = { sent: 0, remaining: 0, blocked: 0 };

let tail: Promise<unknown> = Promise.resolve();

/**
 * Send everything queued. Safe to call from anywhere, as often as you like.
 *
 * Calls made while a drain is running do not run concurrently: they queue behind it and see
 * whatever the earlier one left. `tail` is advanced with the rejection swallowed, so one failed
 * drain cannot poison every later one.
 */
export function drainOutbox(): Promise<DrainResult> {
  const run = tail.then(runDrain, runDrain);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runDrain(): Promise<DrainResult> {
  const entries = await listOutbox();
  if (entries.length === 0) return EMPTY;

  let sent = 0;
  let blocked = 0;
  let snapshot: Snapshot | undefined;
  let stoppedBy: ApiError | undefined;

  for (const entry of entries) {
    if (entry.blockedReason !== undefined) {
      blocked += 1;
      continue;
    }
    try {
      const accepted = await postWorkout(entry.workout);
      // Removed only after the server has said it holds this id — including when it says so by
      // reporting a duplicate, which means an earlier attempt did land.
      await removeFromOutbox(entry.id);
      markWorkoutSettled(entry.id);
      snapshot = accepted.snapshot;
      sent += 1;
    } catch (cause) {
      if (!(cause instanceof ApiError)) throw cause;
      if (cause.retryable || cause.kind === 'unauthorised' || cause.kind === 'version') {
        await recordSendFailure(entry.id);
        stoppedBy = cause;
        break;
      }
      await recordSendFailure(entry.id, cause.message);
      blocked += 1;
    }
  }

  return {
    sent,
    remaining: await countOutbox(),
    blocked,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
  };
}
