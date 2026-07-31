// @vitest-environment node
//
// `server/oauth-state.ts` — the CSRF state cookie for the Google callback.

import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  OAUTH_STATE_COOKIE,
  clearedOAuthStateCookie,
  encodeOAuthState,
  newOAuthState,
  oauthStateCookie,
  verifyOAuthState,
} from './oauth-state.js';

/** A request carrying `cookieValue` as the oauth-state cookie. */
function reqWith(cookieValue: string | undefined): IncomingMessage {
  const cookie = cookieValue === undefined ? undefined : `${OAUTH_STATE_COOKIE}=${cookieValue}`;
  return { headers: { ...(cookie === undefined ? {} : { cookie }) } } as IncomingMessage;
}

describe('oauth state cookie', () => {
  it('is Lax, HttpOnly, Secure and path-scoped — not Strict', () => {
    const header = oauthStateCookie('abc.def');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('SameSite=Strict');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/auth/google');
  });

  it('clears with a matching attribute set and Max-Age=0', () => {
    const cleared = clearedOAuthStateCookie();
    expect(cleared).toContain('SameSite=Lax');
    expect(cleared).toContain('Path=/auth/google');
    expect(cleared).toContain('Max-Age=0');
  });
});

describe('verifyOAuthState', () => {
  it('accepts a matching nonce and returns the carried invite', () => {
    const state = newOAuthState('my-invite');
    const req = reqWith(encodeOAuthState(state));
    const verified = verifyOAuthState(req, state.nonce);
    expect(verified?.invite).toBe('my-invite');
  });

  it('round-trips an absent invite', () => {
    const state = newOAuthState(undefined);
    const verified = verifyOAuthState(reqWith(encodeOAuthState(state)), state.nonce);
    expect(verified?.invite).toBeUndefined();
  });

  it('round-trips an invite with awkward characters', () => {
    const state = newOAuthState('a;b.c d');
    const verified = verifyOAuthState(reqWith(encodeOAuthState(state)), state.nonce);
    expect(verified?.invite).toBe('a;b.c d');
  });

  it('rejects a mismatched nonce', () => {
    const state = newOAuthState(undefined);
    expect(verifyOAuthState(reqWith(encodeOAuthState(state)), 'not-the-nonce')).toBeUndefined();
  });

  it('rejects a missing cookie or a missing presented state', () => {
    const state = newOAuthState(undefined);
    expect(verifyOAuthState(reqWith(undefined), state.nonce)).toBeUndefined();
    expect(verifyOAuthState(reqWith(encodeOAuthState(state)), undefined)).toBeUndefined();
  });

  it('rejects a malformed cookie value', () => {
    expect(verifyOAuthState(reqWith('no-dot-here'), 'x')).toBeUndefined();
  });
});
