/**
 * Web Push training reminders, from the device's side (LBV-1481).
 *
 * ## The split, and why it is the same one `pwa/lifecycle.ts` makes
 *
 * The pure functions here — the VAPID key decoder, the subscription flattener, the support and
 * state readers that take their inputs as arguments — are unit-tested (`subscribe.test.ts`).
 * Everything that touches `navigator.serviceWorker`, `Notification` or `PushManager` is not: jsdom
 * implements none of them, so those helpers are verified in a real browser (QA does this on an
 * iPhone, where iOS only grants push to a home-screen-installed PWA on 16.4+). Keeping the two
 * apart means the arithmetic that turns a VAPID key into bytes is proven, and the orchestration
 * that cannot be is thin enough to read.
 *
 * ## What this owns, and what it does not
 *
 * This produces and stores subscriptions and removes stale ones. It does NOT send to them: the
 * VAPID keypair, the server-side `web-push` send, and the reminder scheduler are a DevOps ticket.
 * The client subscribes with the VAPID *public* key, which is public by definition and arrives as a
 * build-time env var — nothing secret lives here.
 */

import { deletePushSubscription, putPushSubscription, type PushSubscriptionPayload } from '../api/client.js';

/**
 * The raw JSON a browser's `PushSubscription.toJSON()` produces. `keys` is present once the
 * subscription is created; it is optional in the type only because an interrupted or exotic
 * implementation could omit it, and `flattenSubscription` refuses that rather than storing half a
 * key set the sender could never use.
 */
export interface RawPushSubscription {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

/**
 * Turn a base64url VAPID public key into the `Uint8Array` `pushManager.subscribe` wants for
 * `applicationServerKey`.
 *
 * The Push API predates `applicationServerKey` accepting a base64 string in every engine that
 * matters — Safari in particular — so the key is decoded here rather than handed over as text. The
 * `-`/`_` → `+`/`/` swap and the `=` padding are what make it standard base64 that `atob` reads;
 * the byte-by-byte copy is because `atob` yields a binary string, not bytes.
 */
export function urlBase64ToUint8Array(base64UrlKey: string): Uint8Array<ArrayBuffer> {
  const trimmed = base64UrlKey.trim();
  if (trimmed === '') throw new Error('The VAPID public key is empty.');
  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4);
  const base64 = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Flatten a browser subscription to the wire shape the server stores, or throw if it is missing the
 * endpoint or either key. A subscription without both keys cannot be sent to, so storing it would
 * be storing a delivery address that can never receive — better to fail here than to write a row
 * the DevOps sender trips over.
 */
export function flattenSubscription(raw: RawPushSubscription): PushSubscriptionPayload {
  const endpoint = raw.endpoint?.trim();
  const p256dh = raw.keys?.p256dh?.trim();
  const auth = raw.keys?.auth?.trim();
  if (endpoint === undefined || endpoint === '') throw new Error('The subscription has no endpoint.');
  if (p256dh === undefined || p256dh === '' || auth === undefined || auth === '') {
    throw new Error('The subscription is missing its encryption keys.');
  }
  return { endpoint, p256dh, auth };
}

/** The VAPID public key from the build-time env, or `undefined` when DevOps has not provisioned it. */
export function vapidPublicKey(): string | undefined {
  const key = import.meta.env.VITE_GODMODE_VAPID_PUBLIC_KEY?.trim();
  return key === undefined || key === '' ? undefined : key;
}

/**
 * Whether this browser can do Web Push AND the deployment has a VAPID key to subscribe with.
 *
 * Both halves matter: an iPhone in a Safari tab has the APIs but iOS withholds them until the PWA
 * is on the home screen, and a build with no key cannot subscribe however capable the browser is.
 * Taking the globals as an argument keeps this testable without stubbing `window`.
 */
export function isPushSupported(
  globals: { serviceWorker?: unknown; PushManager?: unknown; Notification?: unknown } = {
    serviceWorker: typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
    PushManager: typeof globalThis !== 'undefined' ? (globalThis as { PushManager?: unknown }).PushManager : undefined,
    Notification: typeof globalThis !== 'undefined' ? (globalThis as { Notification?: unknown }).Notification : undefined,
  },
): boolean {
  return (
    globals.serviceWorker !== undefined &&
    globals.serviceWorker !== null &&
    globals.PushManager !== undefined &&
    globals.Notification !== undefined &&
    vapidPublicKey() !== undefined
  );
}

/** What the UI shows for the reminder toggle. */
export type ReminderState =
  /** Push is unavailable here — unsupported browser, iOS not-installed, or no VAPID key. */
  | { kind: 'unsupported' }
  /** Supported, no subscription and permission not yet denied — the opt-in is offered. */
  | { kind: 'available' }
  /** A live subscription exists — reminders are on. */
  | { kind: 'subscribed' }
  /** The user denied notifications; only browser settings can re-grant, so we say so. */
  | { kind: 'denied' };

/**
 * Resolve the reminder state from inputs the caller has already gathered, so the decision is pure
 * and tested while the gathering (which touches `Notification.permission` and `pushManager`) stays
 * in the thin effectful wrapper below.
 */
export function reminderStateFrom(input: {
  supported: boolean;
  permission: NotificationPermission | undefined;
  hasSubscription: boolean;
}): ReminderState {
  if (!input.supported) return { kind: 'unsupported' };
  if (input.hasSubscription) return { kind: 'subscribed' };
  if (input.permission === 'denied') return { kind: 'denied' };
  return { kind: 'available' };
}

/** The outcome of trying to turn reminders on, in the vocabulary the UI has to say back. */
export type EnableOutcome =
  | { kind: 'subscribed' }
  | { kind: 'denied' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

/**
 * Turn reminders on: ask permission, subscribe with the VAPID key, store the subscription.
 *
 * Not reachable from the test runner — every line below touches an API jsdom does not implement —
 * so it is kept to orchestration only, with every decision it takes delegated to a pure helper
 * above. Verified in a browser. It reuses an existing subscription rather than minting a second,
 * and it POSTs on every success so a subscription the server lost (a wiped database) is restored.
 */
export async function enableReminders(): Promise<EnableOutcome> {
  if (!isPushSupported()) return { kind: 'unsupported' };
  const key = vapidPublicKey();
  if (key === undefined) return { kind: 'unsupported' };

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { kind: 'denied' };

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));

    await putPushSubscription(flattenSubscription(subscription.toJSON() as RawPushSubscription));
    return { kind: 'subscribed' };
  } catch (cause) {
    return {
      kind: 'error',
      message: cause instanceof Error ? cause.message : 'Reminders could not be turned on.',
    };
  }
}

/**
 * Turn reminders off: unsubscribe on the device and drop the row on the server.
 *
 * Best-effort and idempotent. The server delete is scoped to the endpoint and tolerant of one that
 * is already gone, so a half-completed disable (unsubscribed but the delete failed, or vice versa)
 * still converges the next time it runs.
 */
export async function disableReminders(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => undefined);
  await deletePushSubscription(endpoint).catch(() => undefined);
}

/** Read the current reminder state from the live browser. Effectful; see `reminderStateFrom`. */
export async function readReminderState(): Promise<ReminderState> {
  const supported = isPushSupported();
  if (!supported) return { kind: 'unsupported' };
  let hasSubscription = false;
  try {
    const registration = await navigator.serviceWorker.ready;
    hasSubscription = (await registration.pushManager.getSubscription()) !== null;
  } catch {
    hasSubscription = false;
  }
  const permission = typeof Notification !== 'undefined' ? Notification.permission : undefined;
  return reminderStateFrom({ supported, permission, hasSubscription });
}
