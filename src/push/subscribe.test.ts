/**
 * The pure half of the push flow: the VAPID key decoder, the subscription flattener, and the state
 * resolvers. The effectful half (`enableReminders` and friends) touches `PushManager` and
 * `Notification`, which jsdom does not implement, so it is verified in a browser, not here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flattenSubscription,
  isPushSupported,
  reminderStateFrom,
  urlBase64ToUint8Array,
  vapidPublicKey,
} from './subscribe.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url key to its bytes', () => {
    // "aGVsbG8" is base64url for the bytes of "hello".
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([104, 101, 108, 108, 111]);
  });

  it('accepts the url-safe alphabet and missing padding', () => {
    // base64url "-_8" -> standard "+/8=" -> bytes [0xFB, 0xFF].
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([0xfb, 0xff]);
  });

  it('refuses an empty key rather than producing zero bytes', () => {
    expect(() => urlBase64ToUint8Array('   ')).toThrow();
  });
});

describe('flattenSubscription', () => {
  it('flattens the browser shape and trims', () => {
    expect(
      flattenSubscription({
        endpoint: ' https://push.example/x ',
        keys: { p256dh: ' BkeyX ', auth: ' authX ' },
      }),
    ).toEqual({ endpoint: 'https://push.example/x', p256dh: 'BkeyX', auth: 'authX' });
  });

  it('refuses a subscription with no endpoint', () => {
    expect(() => flattenSubscription({ keys: { p256dh: 'a', auth: 'b' } })).toThrow();
  });

  it('refuses a subscription missing either key, which could never be sent to', () => {
    expect(() => flattenSubscription({ endpoint: 'https://x', keys: { p256dh: 'a' } })).toThrow();
    expect(() => flattenSubscription({ endpoint: 'https://x' })).toThrow();
  });
});

describe('vapidPublicKey / isPushSupported', () => {
  const withApis = { serviceWorker: {}, PushManager: {}, Notification: {} };

  it('reads the key from the build env, trimmed, or undefined when unset', () => {
    vi.stubEnv('VITE_GODMODE_VAPID_PUBLIC_KEY', '  a-key  ');
    expect(vapidPublicKey()).toBe('a-key');
    vi.stubEnv('VITE_GODMODE_VAPID_PUBLIC_KEY', '');
    expect(vapidPublicKey()).toBeUndefined();
  });

  it('needs both the browser APIs and a configured key', () => {
    vi.stubEnv('VITE_GODMODE_VAPID_PUBLIC_KEY', 'a-key');
    expect(isPushSupported(withApis)).toBe(true);
    // No key: unsupported however capable the browser.
    vi.stubEnv('VITE_GODMODE_VAPID_PUBLIC_KEY', '');
    expect(isPushSupported(withApis)).toBe(false);
    // Key present but a missing API (an iPhone tab before install) is still unsupported.
    vi.stubEnv('VITE_GODMODE_VAPID_PUBLIC_KEY', 'a-key');
    expect(isPushSupported({ ...withApis, PushManager: undefined })).toBe(false);
  });
});

describe('reminderStateFrom', () => {
  it('reports unsupported before anything else', () => {
    expect(reminderStateFrom({ supported: false, permission: 'granted', hasSubscription: true })).toEqual(
      { kind: 'unsupported' },
    );
  });

  it('reports subscribed when a live subscription exists', () => {
    expect(
      reminderStateFrom({ supported: true, permission: 'granted', hasSubscription: true }),
    ).toEqual({ kind: 'subscribed' });
  });

  it('reports denied when the user blocked notifications and has no subscription', () => {
    expect(
      reminderStateFrom({ supported: true, permission: 'denied', hasSubscription: false }),
    ).toEqual({ kind: 'denied' });
  });

  it('offers the opt-in when supported, undecided and not yet subscribed', () => {
    expect(
      reminderStateFrom({ supported: true, permission: 'default', hasSubscription: false }),
    ).toEqual({ kind: 'available' });
  });
});
