/**
 * The transient state that ties one Google sign-in attempt to its own callback.
 *
 * ## Why this cookie exists, and why it is `SameSite=Lax` when the session is `Strict`
 *
 * The OAuth callback is the single cross-site inbound request in the whole app: the browser is
 * redirected to `/auth/google/callback` *from google.com*, not from a page of ours. Two
 * consequences follow.
 *
 * First, CSRF. Without a check, an attacker could feed a victim a callback URL carrying the
 * attacker's own `code`, logging the victim into the attacker's account. The defence is the
 * standard OAuth `state` nonce: mint a random value, put it in the authorization URL, store the
 * same value in this cookie, and on the callback require the two to match. An attacker cannot set
 * an `HttpOnly` cookie on the victim's browser, so cannot forge both halves.
 *
 * Second, `SameSite`. The session cookie is `SameSite=Strict`, which the browser deliberately
 * withholds from a request that originated on another site — and the callback is exactly that, so
 * a `Strict` state cookie would simply be absent when it is needed and every Google sign-in would
 * fail the CSRF check. This cookie is therefore `SameSite=Lax`: sent on a top-level navigation the
 * user followed (which the redirect back from Google is), still withheld from cross-site
 * subresource requests. It is short-lived (ten minutes), `Path`-scoped to the callback, `HttpOnly`
 * and `Secure`, and cleared the moment the callback consumes it — it carries no authority of its
 * own, only the nonce and the invite code the attempt was started with.
 *
 * The session cookie stays `Strict`; this note is the reason the two differ.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parseCookies } from './session.js';

export const OAUTH_STATE_COOKIE = 'godmode_oauth';
/** Ten minutes is longer than any real sign-in and short enough that a stale one simply expires. */
export const OAUTH_STATE_MAX_AGE_SECONDS = 600;
/** Where Google returns the browser; the cookie is scoped to it so it rides no other request. */
export const OAUTH_STATE_PATH = '/auth/google';

export interface OAuthState {
  /** The CSRF nonce, echoed to Google as `state` and compared on the callback. */
  readonly nonce: string;
  /** The invite code the attempt was started with, carried server-side so it never hits a URL. */
  readonly invite: string | undefined;
}

/** A fresh attempt: 256 bits of nonce, plus whatever invite code the user supplied. */
export function newOAuthState(invite: string | undefined): OAuthState {
  return { nonce: randomBytes(32).toString('base64url'), invite };
}

/**
 * Encode the state for the cookie value.
 *
 * `nonce.inviteEncoded` — the nonce is base64url (no dot), so a single `.` separates it from the
 * invite cleanly, and the invite is `encodeURIComponent`'d so a code containing a `.` or `;`
 * cannot corrupt the cookie. An absent invite encodes as the empty tail.
 */
export function encodeOAuthState(state: OAuthState): string {
  return `${state.nonce}.${state.invite === undefined ? '' : encodeURIComponent(state.invite)}`;
}

function decodeOAuthState(value: string): OAuthState | undefined {
  const dot = value.indexOf('.');
  if (dot <= 0) return undefined;
  const nonce = value.slice(0, dot);
  const tail = value.slice(dot + 1);
  let invite: string | undefined;
  if (tail === '') {
    invite = undefined;
  } else {
    try {
      invite = decodeURIComponent(tail);
    } catch {
      return undefined;
    }
  }
  return { nonce, invite };
}

/** The `Set-Cookie` value that plants the state. */
export function oauthStateCookie(value: string): string {
  return [
    `${OAUTH_STATE_COOKIE}=${value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Path=${OAUTH_STATE_PATH}`,
    `Max-Age=${String(OAUTH_STATE_MAX_AGE_SECONDS)}`,
  ].join('; ');
}

/** The `Set-Cookie` value that removes it; every attribute except `Max-Age` matches the plant. */
export function clearedOAuthStateCookie(): string {
  return [
    `${OAUTH_STATE_COOKIE}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Path=${OAUTH_STATE_PATH}`,
    'Max-Age=0',
  ].join('; ');
}

/**
 * Read the stored state and confirm it matches the `state` the callback carried.
 *
 * Returns the decoded state (so the caller gets the invite) only when the cookie is present,
 * well-formed, and its nonce equals `presentedState` in constant time. Any mismatch — no cookie,
 * malformed cookie, unequal nonce — is `undefined`, which the caller treats as a failed sign-in.
 */
export function verifyOAuthState(
  req: IncomingMessage,
  presentedState: string | undefined,
): OAuthState | undefined {
  if (presentedState === undefined || presentedState === '') return undefined;
  const raw = parseCookies(req.headers.cookie).get(OAUTH_STATE_COOKIE);
  if (raw === undefined) return undefined;
  const decoded = decodeOAuthState(raw);
  if (decoded === undefined) return undefined;

  const a = Buffer.from(decoded.nonce, 'utf8');
  const b = Buffer.from(presentedState, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return decoded;
}
