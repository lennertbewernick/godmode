import { describe, expect, it } from 'vitest';
import {
  UPDATE_CHECK_INTERVAL_MS,
  decideLocalAction,
  isDevServerResponse,
  isLocalhostHost,
  shouldCheckForUpdate,
  shouldOfferUpdate,
} from './policy.js';

describe('isDevServerResponse', () => {
  it('recognises the dev server by the module it serves', () => {
    expect(isDevServerResponse({ ok: true, contentType: 'text/javascript' })).toBe(true);
    expect(
      isDevServerResponse({ ok: true, contentType: 'application/javascript; charset=utf-8' }),
    ).toBe(true);
  });

  it('is not fooled by an SPA fallback', () => {
    // Measured, not assumed: `vite preview` answers GET /@vite/client with 200 and the
    // built index.html, because its default appType is 'spa'. A status check alone would
    // therefore report "a dev server is live" on every static preview and every static
    // host — which would purge the very worker `npm run preview:pwa` exists to install.
    expect(isDevServerResponse({ ok: true, contentType: 'text/html' })).toBe(false);
    expect(isDevServerResponse({ ok: true, contentType: 'text/html; charset=utf-8' })).toBe(false);
  });

  it('treats a missing or unhelpful content type as "not a dev server"', () => {
    expect(isDevServerResponse({ ok: true, contentType: null })).toBe(false);
    expect(isDevServerResponse({ ok: true, contentType: '' })).toBe(false);
    expect(isDevServerResponse({ ok: true, contentType: 'application/octet-stream' })).toBe(false);
  });

  it('rejects an error response outright', () => {
    expect(isDevServerResponse({ ok: false, contentType: 'text/javascript' })).toBe(false);
  });
});

describe('isLocalhostHost', () => {
  it('accepts the three names a local server actually answers to', () => {
    expect(isLocalhostHost('localhost')).toBe(true);
    expect(isLocalhostHost('127.0.0.1')).toBe(true);
    expect(isLocalhostHost('::1')).toBe(true);
    // location.hostname keeps the brackets on an IPv6 literal in some browsers.
    expect(isLocalhostHost('[::1]')).toBe(true);
  });

  it('rejects a deployed origin', () => {
    expect(isLocalhostHost('godmode.example.com')).toBe(false);
  });

  it('rejects a hostname that merely starts with localhost', () => {
    // The suffix trick is the whole reason this is an exact match and not `startsWith`.
    expect(isLocalhostHost('localhost.evil.com')).toBe(false);
    expect(isLocalhostHost('notlocalhost')).toBe(false);
    expect(isLocalhostHost('127.0.0.1.evil.com')).toBe(false);
  });

  it('rejects an empty hostname', () => {
    expect(isLocalhostHost('')).toBe(false);
  });
});

describe('decideLocalAction', () => {
  const base = {
    isLocalhost: true,
    hasController: false,
    devServerLive: false,
    allowLocalRegistration: false,
    alreadyPurgedThisSession: false,
  };

  it('always registers on a deployed origin, whatever the local fields say', () => {
    expect(
      decideLocalAction({
        isLocalhost: false,
        hasController: true,
        devServerLive: true,
        allowLocalRegistration: false,
        alreadyPurgedThisSession: true,
      }),
    ).toBe('register');
  });

  it('purges and reloads when a worker is controlling a live dev server', () => {
    expect(decideLocalAction({ ...base, devServerLive: true, hasController: true })).toBe(
      'purge-and-reload',
    );
  });

  it('does nothing on a second pass, so a purge can never loop', () => {
    // The sessionStorage sentinel is the only thing standing between a failed
    // unregister and an infinite reload cycle.
    expect(
      decideLocalAction({
        ...base,
        devServerLive: true,
        hasController: true,
        alreadyPurgedThisSession: true,
      }),
    ).toBe('none');
  });

  it('purges without reloading when the registration is not controlling this document', () => {
    expect(decideLocalAction({ ...base, devServerLive: true, hasController: false })).toBe('purge');
  });

  it('registers on localhost only when the opt-in build flag is set', () => {
    expect(
      decideLocalAction({ ...base, devServerLive: false, allowLocalRegistration: true }),
    ).toBe('register');
    // The opt-in wins even over an existing controller — that is the point of preview:pwa.
    expect(
      decideLocalAction({
        ...base,
        devServerLive: false,
        allowLocalRegistration: true,
        hasController: true,
      }),
    ).toBe('register');
  });

  it('purges a controlling worker on a plain local preview', () => {
    expect(
      decideLocalAction({
        ...base,
        devServerLive: false,
        allowLocalRegistration: false,
        hasController: true,
      }),
    ).toBe('purge-and-reload');
  });

  it('purges without reloading on a plain local preview with no controller', () => {
    expect(
      decideLocalAction({
        ...base,
        devServerLive: false,
        allowLocalRegistration: false,
        hasController: false,
      }),
    ).toBe('purge');
  });

  it('honours the sentinel on the preview path too', () => {
    expect(
      decideLocalAction({
        ...base,
        devServerLive: false,
        allowLocalRegistration: false,
        hasController: true,
        alreadyPurgedThisSession: true,
      }),
    ).toBe('none');
  });

  it('never returns purge-and-reload once the sentinel is set', () => {
    for (const devServerLive of [true, false]) {
      for (const hasController of [true, false]) {
        for (const allowLocalRegistration of [true, false]) {
          expect(
            decideLocalAction({
              isLocalhost: true,
              devServerLive,
              hasController,
              allowLocalRegistration,
              alreadyPurgedThisSession: true,
            }),
          ).not.toBe('purge-and-reload');
        }
      }
    }
  });
});

describe('shouldOfferUpdate', () => {
  it('offers only when an update is actually waiting', () => {
    expect(shouldOfferUpdate({ updateReady: true, workoutInProgress: false })).toBe(true);
    expect(shouldOfferUpdate({ updateReady: false, workoutInProgress: false })).toBe(false);
  });

  it('stays silent during a workout, however ready the update is', () => {
    // Runner.tsx holds the session's `actuals` in React state and writes nothing to
    // IndexedDB until the workout is saved. Showing a reload button mid-session invites
    // the user to destroy reps they already did. This guard is the reason the function
    // exists at all — it must not degrade into `return updateReady`.
    expect(shouldOfferUpdate({ updateReady: true, workoutInProgress: true })).toBe(false);
    expect(shouldOfferUpdate({ updateReady: false, workoutInProgress: true })).toBe(false);
  });
});

describe('shouldCheckForUpdate', () => {
  const minIntervalMs = UPDATE_CHECK_INTERVAL_MS;

  it('never polls a backgrounded tab', () => {
    expect(
      shouldCheckForUpdate({
        visibilityState: 'hidden',
        lastCheckedAt: undefined,
        now: 10_000_000,
        minIntervalMs,
      }),
    ).toBe(false);
  });

  it('checks on the first visible opportunity', () => {
    expect(
      shouldCheckForUpdate({
        visibilityState: 'visible',
        lastCheckedAt: undefined,
        now: 0,
        minIntervalMs,
      }),
    ).toBe(true);
  });

  it('checks once the interval has elapsed and not before', () => {
    const lastCheckedAt = 1_000_000;
    expect(
      shouldCheckForUpdate({
        visibilityState: 'visible',
        lastCheckedAt,
        now: lastCheckedAt + minIntervalMs - 1,
        minIntervalMs,
      }),
    ).toBe(false);
    // Exactly at the interval counts as elapsed.
    expect(
      shouldCheckForUpdate({
        visibilityState: 'visible',
        lastCheckedAt,
        now: lastCheckedAt + minIntervalMs,
        minIntervalMs,
      }),
    ).toBe(true);
    expect(
      shouldCheckForUpdate({
        visibilityState: 'visible',
        lastCheckedAt,
        now: lastCheckedAt + minIntervalMs + 1,
        minIntervalMs,
      }),
    ).toBe(true);
  });

  it('does not check when the clock has gone backwards', () => {
    expect(
      shouldCheckForUpdate({
        visibilityState: 'visible',
        lastCheckedAt: 1_000_000,
        now: 500_000,
        minIntervalMs,
      }),
    ).toBe(false);
  });
});

describe('UPDATE_CHECK_INTERVAL_MS', () => {
  it('is one hour', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});
