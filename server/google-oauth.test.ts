// @vitest-environment node
//
// `server/google-oauth.ts` — pure OAuth helpers plus a token exchange driven against a fake
// endpoint. The end-to-end callback (cookies, redirects, account decision) is asserted in
// `server/auth-google.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  GOOGLE_AUTH_ENDPOINT,
  buildAuthUrl,
  decodeIdToken,
  exchangeCode,
  resolveGoogleConfig,
  type GoogleOAuthConfig,
} from './google-oauth.js';

const CONFIG: GoogleOAuthConfig = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret',
  redirectUri: 'https://godmode.example/auth/google/callback',
};

/** A JWT whose payload is `claims`; the signature is a placeholder — this flow does not verify it. */
function idToken(claims: Record<string, unknown>): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256' })}.${seg(claims)}.not-a-real-signature`;
}

const VALID_CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: CONFIG.clientId,
  sub: 'google-subject-1',
  email: 'runner@example.com',
  email_verified: true,
  name: 'A Runner',
};

describe('resolveGoogleConfig', () => {
  it('is undefined without a client id and secret', () => {
    expect(resolveGoogleConfig({})).toBeUndefined();
    expect(resolveGoogleConfig({ GOOGLE_CLIENT_ID: 'x' })).toBeUndefined();
  });

  it('derives the redirect URI from the public origin', () => {
    const config = resolveGoogleConfig({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GODMODE_PUBLIC_ORIGIN: 'https://godmode.example/',
    });
    expect(config?.redirectUri).toBe('https://godmode.example/auth/google/callback');
  });

  it('prefers an explicit redirect URI, and stays undefined when none can be determined', () => {
    expect(
      resolveGoogleConfig({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REDIRECT_URI: 'https://custom/cb',
      })?.redirectUri,
    ).toBe('https://custom/cb');
    expect(
      resolveGoogleConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }),
    ).toBeUndefined();
  });
});

describe('buildAuthUrl', () => {
  it('targets Google with our client, redirect, scopes and state', () => {
    const url = new URL(buildAuthUrl(CONFIG, 'the-nonce'));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('state')).toBe('the-nonce');
  });
});

describe('decodeIdToken', () => {
  it('extracts the identity from a well-formed token', () => {
    const identity = decodeIdToken(idToken(VALID_CLAIMS), CONFIG.clientId);
    expect(identity).toEqual({
      sub: 'google-subject-1',
      email: 'runner@example.com',
      emailVerified: true,
      name: 'A Runner',
    });
  });

  it('accepts the string "true" for email_verified and a missing name', () => {
    const identity = decodeIdToken(
      idToken({ ...VALID_CLAIMS, email_verified: 'true', name: undefined }),
      CONFIG.clientId,
    );
    expect(identity.emailVerified).toBe(true);
    expect(identity.name).toBeUndefined();
  });

  it('rejects a token for a different client', () => {
    expect(() => decodeIdToken(idToken({ ...VALID_CLAIMS, aud: 'someone-else' }), CONFIG.clientId)).toThrow();
  });

  it('rejects a token not issued by Google', () => {
    expect(() => decodeIdToken(idToken({ ...VALID_CLAIMS, iss: 'https://evil' }), CONFIG.clientId)).toThrow();
  });

  it('rejects a token with no subject or no email, and non-JWT shapes', () => {
    expect(() => decodeIdToken(idToken({ ...VALID_CLAIMS, sub: '' }), CONFIG.clientId)).toThrow();
    expect(() => decodeIdToken(idToken({ ...VALID_CLAIMS, email: undefined }), CONFIG.clientId)).toThrow();
    expect(() => decodeIdToken('not.a', CONFIG.clientId)).toThrow();
  });
});

describe('exchangeCode', () => {
  function fakeFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): typeof fetch {
    return (async () => ({ ok: true, status: 200, ...response }) as Response) as typeof fetch;
  }

  it('posts the code and returns the decoded identity', async () => {
    let seenBody = '';
    const spyFetch = (async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body ?? '');
      return { ok: true, status: 200, json: async () => ({ id_token: idToken(VALID_CLAIMS) }) } as Response;
    }) as typeof fetch;

    const identity = await exchangeCode(CONFIG, 'auth-code', { fetch: spyFetch });
    expect(identity.sub).toBe('google-subject-1');
    expect(seenBody).toContain('code=auth-code');
    expect(seenBody).toContain('grant_type=authorization_code');
    expect(seenBody).toContain('client_secret=secret');
  });

  it('throws on a non-2xx from Google', async () => {
    const bad = fakeFetch({ ok: false, status: 400, json: async () => ({}) });
    await expect(exchangeCode(CONFIG, 'code', { fetch: bad })).rejects.toThrow();
  });

  it('throws when the response carries no id_token', async () => {
    const empty = fakeFetch({ ok: true, status: 200, json: async () => ({}) });
    await expect(exchangeCode(CONFIG, 'code', { fetch: empty })).rejects.toThrow();
  });
});
