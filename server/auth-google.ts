/**
 * The two Google Sign-In routes, which live outside `/api` because a browser walks through them.
 *
 * `/api/*` is a JSON surface the client `fetch`es; these two are top-level *navigations*. The user
 * clicks a button, the browser goes to `/auth/google/login`, is redirected to Google, comes back
 * to `/auth/google/callback`, and is redirected once more to `/`. Nothing here answers with JSON;
 * everything answers with a 302, because the address bar is the client. They are mounted at
 * `/auth/google/*` (not `/api/...`) so the redirect URI registered with the OAuth client —
 * `…/auth/google/callback`, fixed in `server/DEPLOY.md` — is the one this code serves.
 *
 * ## The account decision on the callback
 *
 * Given a verified Google identity, in order:
 *   1. a user with this `google_sub` already exists → sign them in (returning Google user);
 *   2. else a *password* user with this (verified) email exists → attach the `google_sub` to that
 *      account and sign them in, so one person is never two rows;
 *   3. else a brand-new account → allowed only through the same registration gate password sign-up
 *      uses, with the invite code the attempt carried in its state cookie.
 *
 * Step 2 links by email **only when Google says the email is verified.** An unverified email on a
 * Google account is not proof the person controls that mailbox, and treating it as such would let
 * someone register a Google account claiming a victim's email and inherit the victim's training
 * history. Unverified, they fall through to step 3 and get their own account instead.
 *
 * ## Failures are a redirect, not a 500
 *
 * A denied consent, an expired or mismatched `state`, a token exchange that fails, a new user with
 * no invite — none of these is a server error, and none should dump a stack to the user. Each ends
 * the same way: the state cookie is cleared and the browser is sent to `/?authError=<why>`, where
 * the sign-in screen shows a plain sentence. Details go to stderr, never to the URL.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { applySecurityHeaders } from './http.js';
import { buildAuthUrl, exchangeCode, type GoogleIdentity } from './google-oauth.js';
import { evaluate as evaluateGate } from './registration.js';
import type { ApiContext } from './routes.js';
import { resolveDisplayName } from './routes.js';
import { readSessionId, sessionCookie } from './session.js';
import {
  clearedOAuthStateCookie,
  encodeOAuthState,
  newOAuthState,
  oauthStateCookie,
  verifyOAuthState,
} from './oauth-state.js';
import { attachGoogleSub, findUserByEmail, findUserByGoogleSub, registerUser } from './users.js';

/** The prefix this module owns. `server/index.ts` routes matching requests here. */
export const GOOGLE_AUTH_PREFIX = '/auth/google';

function redirect(res: ServerResponse, location: string, setCookie: string | string[]): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Set-Cookie', setCookie);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/** Send the browser back to the app with a reason the sign-in screen can render. */
function fail(res: ServerResponse, why: 'google' | 'invite'): void {
  redirect(res, `/?authError=${why}`, clearedOAuthStateCookie());
}

/**
 * `GET /auth/google/login` — start the flow.
 *
 * Mints the CSRF state, plants it in the `SameSite=Lax` cookie (the session cookie's `Strict`
 * would not survive the return trip; see `server/oauth-state.ts`), and 302s to Google. Any invite
 * code the user typed rides in the cookie, never in a URL Google would log.
 */
function beginLogin(ctx: ApiContext, res: ServerResponse, invite: string | undefined): void {
  if (ctx.google === undefined) {
    notConfigured(res);
    return;
  }
  const state = newOAuthState(invite);
  redirect(res, buildAuthUrl(ctx.google, state.nonce), oauthStateCookie(encodeOAuthState(state)));
}

/** `GET /auth/google/callback` — Google has sent the browser back. */
async function completeLogin(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  if (ctx.google === undefined) {
    notConfigured(res);
    return;
  }

  // Consent denied, or Google reported an error: not our failure, just a return to the screen.
  if (query.has('error')) {
    fail(res, 'google');
    return;
  }

  const state = verifyOAuthState(req, query.get('state') ?? undefined);
  if (state === undefined) {
    // No cookie, malformed, expired, or a forged callback: the CSRF check did its job.
    fail(res, 'google');
    return;
  }

  const code = query.get('code');
  if (code === null || code === '') {
    fail(res, 'google');
    return;
  }

  let identity: GoogleIdentity;
  try {
    identity = await exchangeCode(ctx.google, code, ctx.fetch === undefined ? {} : { fetch: ctx.fetch });
  } catch (cause) {
    console.error('[godmode] Google token exchange failed:', cause);
    fail(res, 'google');
    return;
  }

  const userId = resolveGoogleUser(ctx, identity, state.invite);
  if (userId === undefined) {
    // A brand-new Google user who did not pass the invite gate.
    fail(res, 'invite');
    return;
  }

  // Fixation-safe, exactly as the JSON login paths: drop the presented session, mint a fresh id.
  ctx.sessions.destroy(readSessionId(req));
  const now = ctx.now();
  const id = ctx.sessions.create(userId, now);
  const expiresAt = ctx.sessions.expiresAt(id) ?? now;
  redirect(res, '/', [
    sessionCookie(id, Math.floor((expiresAt - now) / 1000)),
    clearedOAuthStateCookie(),
  ]);
}

/**
 * Turn a Google identity into the id of the account it authenticates, creating one if the gate
 * allows. `undefined` means "a new account that the registration gate refused" — the only outcome
 * the caller renders as a failure rather than a sign-in.
 */
function resolveGoogleUser(
  ctx: ApiContext,
  identity: GoogleIdentity,
  invite: string | undefined,
): string | undefined {
  const bySub = findUserByGoogleSub(ctx.db, identity.sub);
  if (bySub !== undefined) return bySub.id;

  if (identity.emailVerified) {
    const byEmail = findUserByEmail(ctx.db, identity.email);
    if (byEmail !== undefined) {
      // A password account of the same, verified email: link rather than duplicate.
      attachGoogleSub(ctx.db, byEmail.id, identity.sub);
      return byEmail.id;
    }
  }

  // Brand-new account: same gate as password registration.
  if (!evaluateGate(ctx.registration, invite).allowed) return undefined;
  const user = registerUser(ctx.db, {
    email: identity.email,
    displayName: resolveDisplayName(identity.name, identity.email),
    googleSub: identity.sub,
    now: new Date(ctx.now()).toISOString(),
  });
  return user.id;
}

function notConfigured(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('Google sign-in is not configured on this server.\n');
}

/**
 * Route a `/auth/google/*` request. Returns `true` if it handled one, `false` if the path is not
 * ours (so the caller can fall through to the static handler).
 */
export async function handleGoogleAuth(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
): Promise<boolean> {
  applySecurityHeaders(res);
  const method = req.method ?? 'GET';

  if (pathname === `${GOOGLE_AUTH_PREFIX}/login`) {
    if (method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return true;
    }
    beginLogin(ctx, res, query.get('invite') ?? undefined);
    return true;
  }

  if (pathname === `${GOOGLE_AUTH_PREFIX}/callback`) {
    if (method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return true;
    }
    await completeLogin(ctx, req, res, query);
    return true;
  }

  return false;
}
