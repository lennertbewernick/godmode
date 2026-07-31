/**
 * Web Push subscriptions — the device state a training reminder is eventually sent to (LBV-1481).
 *
 * ## What this is, and what it is not
 *
 * A `push_subscriptions` row is the encrypted-delivery address of one browser: the push service
 * `endpoint` the browser minted, plus the `p256dh`/`auth` key material a sender needs to encrypt a
 * payload for it. It is device state, not domain data — it is not in `COLLECTIONS`
 * (`server/dataset.ts`), never appears in a snapshot or a backup, and no `user_revisions` bump
 * touches it. That is the same call `sessions` makes and for the same reason: a subscription is
 * re-established by the device on its next visit, so carrying none across a restore is correct.
 *
 * ## What this ticket owns, and what it does not
 *
 * This module stores and removes subscriptions. It does NOT send to them and it does not hold the
 * VAPID keypair: generating the keys, the server-side send (`web-push`), and the reminder scheduler
 * are a separate DevOps ticket (LBV-1481 scope note). The client subscribes with the VAPID *public*
 * key, which is public by definition and reaches the browser as a build-time env var; nothing
 * secret lives here.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface PushSubscriptionRecord {
  /** The push service URL the browser minted. Unique across the table — its natural identity. */
  readonly endpoint: string;
  /** Base64url P-256 ECDH public key of the subscription. */
  readonly p256dh: string;
  /** Base64url auth secret of the subscription. */
  readonly auth: string;
}

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Store a subscription for a user, replacing any existing row for the same endpoint.
 *
 * `ON CONFLICT (endpoint) DO UPDATE`, never `INSERT OR REPLACE`: replace deletes the conflicting
 * row and inserts a new one, firing `ON DELETE` actions on the way — pointless churn on a row other
 * things may come to reference. The conflict target is `endpoint` because that is the browser's own
 * identity for the subscription: re-granting on the same browser must replace, not accumulate. The
 * `user_id` is overwritten too, so a device re-subscribed under a different account moves to it
 * rather than keeping the old owner.
 */
export function storeSubscription(
  db: DatabaseSync,
  userId: string,
  subscription: PushSubscriptionRecord,
  nowIso: string,
): void {
  db.prepare(
    'INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) ' +
      'VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT (endpoint) DO UPDATE SET ' +
      'user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ' +
      'created_at = excluded.created_at',
  ).run(subscription.endpoint, userId, subscription.p256dh, subscription.auth, nowIso);
}

/**
 * Remove one subscription by endpoint, scoped to its owner.
 *
 * Scoped by `user_id` as well as `endpoint` so one user can never drop another's subscription by
 * naming its endpoint — the endpoint is unique, so a match already belongs to exactly one row, but
 * stating the tenant keeps the delete honest and returns "not yours" as "nothing removed". Returns
 * the number of rows removed (0 or 1), so the caller can tell an idempotent no-op from a real drop.
 */
export function removeSubscription(db: DatabaseSync, userId: string, endpoint: string): number {
  const result = db
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .run(endpoint, userId);
  return Number(result.changes);
}

/** Every subscription a user currently has. Used by the sender (DevOps) and by the tests here. */
export function listSubscriptions(
  db: DatabaseSync,
  userId: string,
): readonly PushSubscriptionRecord[] {
  const rows = db
    .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, endpoint')
    .all(userId);
  return rows.map((raw) => {
    const row = raw as unknown as PushSubscriptionRow;
    return { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
  });
}
