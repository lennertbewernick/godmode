/**
 * The client's contract with the rest of the app: which failure is which, and what never
 * leaves the browser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../db/schema.js';
import {
  ApiError,
  closeSession,
  deletePushSubscription,
  getSnapshot,
  login,
  patchSettings,
  postWorkout,
  putPushSubscription,
  register,
} from './client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SNAPSHOT = {
  apiVersion: 1,
  schemaVersion: 1,
  revision: 3,
  exercises: [],
  challenges: [],
  planSlots: [],
  workouts: [],
  performanceTests: [],
  settings: DEFAULT_SETTINGS,
};

function stub(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('failures are classified, because the UI says different things', () => {
  it('calls a dead network unreachable, with no status to misread', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const error = await getSnapshot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('unreachable');
    expect((error as ApiError).retryable).toBe(true);
  });

  it('calls a 401 unauthorised', async () => {
    stub(401, { error: 'unauthenticated', message: 'Sign in with the shared token.' });
    const error = (await getSnapshot().catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('unauthorised');
    expect(error.retryable).toBe(false);
  });

  it('carries the fresh snapshot out of a 409, so the conflict can be shown', async () => {
    stub(409, {
      error: 'revision_conflict',
      message: 'This command was composed against revision 2 but the dataset is at 3.',
      snapshot: SNAPSHOT,
    });
    const error = (await patchSettings({ bodyweightKg: 80 }, 2).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('conflict');
    expect(error.snapshot?.revision).toBe(3);
  });

  it('calls a 5xx retryable and a 422 not', async () => {
    stub(503, { error: 'internal_error', message: 'nope' });
    expect(((await getSnapshot().catch((e: unknown) => e)) as ApiError).retryable).toBe(true);

    stub(422, { error: 'invalid_record', message: 'nope' });
    expect(((await getSnapshot().catch((e: unknown) => e)) as ApiError).retryable).toBe(false);
  });

  it('refuses a snapshot from a server speaking another API version', async () => {
    stub(200, { ...SNAPSHOT, apiVersion: 99 });
    const error = (await getSnapshot().catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('version');
  });
});

describe('what goes on the wire', () => {
  it('sends every request same-origin and relative, so the cookie rides along by itself', async () => {
    const fetchMock = stub(200, SNAPSHOT);
    await getSnapshot();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/snapshot');
    expect(init.credentials).toBe('same-origin');
  });

  it('never puts the password in the URL, only in the body', async () => {
    const fetchMock = stub(200, { authenticated: true, expiresAt: 'x' });
    await login({ email: 'runner@example.com', password: 'super-secret-password' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session');
    expect(url).not.toContain('super-secret-password');
    // It is in the body, once, which is the whole point of the endpoint.
    expect(String(init.body)).toContain('super-secret-password');
  });

  it('keeps the password out of the error when the server rejects the credentials', async () => {
    stub(401, { error: 'invalid_credentials', message: 'That email or password is not correct.' });
    const error = (await login({
      email: 'runner@example.com',
      password: 'super-secret-password',
    }).catch((e: unknown) => e)) as ApiError;
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
      'super-secret-password',
    );
  });

  it('registers with a 201 and carries the invite code in the body', async () => {
    const fetchMock = stub(201, { authenticated: true, expiresAt: 'x' });
    await register({ email: 'new@example.com', password: 'a-good-password', inviteCode: 'let-me-in' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/register');
    expect(JSON.parse(String(init.body))).toMatchObject({
      email: 'new@example.com',
      inviteCode: 'let-me-in',
    });
  });

  it('spells a cleared optional as null, because JSON has no undefined', async () => {
    const fetchMock = stub(200, { snapshot: SNAPSHOT });
    await patchSettings({ restOverrideSeconds: undefined }, 4);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 4,
      patch: { restOverrideSeconds: null },
    });
  });

  it('sends no expectedRevision with a workout — an outbox drain is stale by definition', async () => {
    const fetchMock = stub(201, {
      workout: {},
      attemptNo: 1,
      duplicate: false,
      snapshot: SNAPSHOT,
    });
    await postWorkout({
      id: 'wo_1',
      challengeId: 'ch_1',
      chainId: 'ch_1',
      planSlotId: 'slot_1',
      performedAt: '2026-01-01T00:00:00.000Z',
      sets: [],
      actualTotal: 0,
      adjustmentType: 'none',
      outcome: 'failed',
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['workout']);
    expect(Object.hasOwn(body['workout'] as object, 'attemptNo')).toBe(false);
  });

  it('accepts the empty 204 a sign-out answers with', async () => {
    stub(204, null);
    await expect(closeSession()).resolves.toBeUndefined();
  });

  it('PUTs a flat push subscription and resolves on the 204', async () => {
    const fetchMock = stub(204, null);
    await expect(
      putPushSubscription({ endpoint: 'https://push.example/x', p256dh: 'BkeyX', auth: 'authX' }),
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/push/subscription');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      endpoint: 'https://push.example/x',
      p256dh: 'BkeyX',
      auth: 'authX',
    });
  });

  it('DELETEs a push subscription by endpoint', async () => {
    const fetchMock = stub(204, null);
    await expect(deletePushSubscription('https://push.example/x')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/push/subscription');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: 'https://push.example/x' });
  });

  it('surfaces an expired session on a push write as unauthorised', async () => {
    stub(401, { error: 'unauthenticated', message: 'Sign in first.' });
    const error = (await putPushSubscription({
      endpoint: 'https://push.example/x',
      p256dh: 'BkeyX',
      auth: 'authX',
    }).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('unauthorised');
  });
});
