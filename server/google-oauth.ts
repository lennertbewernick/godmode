/**
 * Google Sign-In: the OAuth 2.0 authorization-code flow, kept to `fetch` and pure functions.
 *
 * ## The shape of the flow, and where each half runs
 *
 * 1. The browser makes a top-level navigation to `/auth/google/login` (a same-origin GET). The
 *    server answers with a 302 to Google's authorization endpoint carrying our `client_id`, the
 *    fixed `redirect_uri`, the scopes and an opaque `state`.
 * 2. Google authenticates the person and redirects the browser back to `redirect_uri` — the one
 *    cross-site inbound request in the whole app — with `?code=…&state=…`.
 * 3. The server exchanges that `code` for tokens by calling Google's token endpoint **directly**,
 *    server-to-server, with the `client_secret`. The browser never sees a token.
 *
 * ## Why the `id_token` is decoded, not signature-verified
 *
 * The `id_token` here arrives from step 3: a TLS connection this process opened directly to
 * `oauth2.googleapis.com`, authenticated by Google's certificate, carrying nothing that passed
 * through the browser. OpenID Connect Core §3.1.3.7 says a client MAY skip `id_token` signature
 * verification when the token was obtained directly from the token endpoint over TLS — which is
 * exactly this case. So this module decodes the payload rather than pulling Google's JWKS and
 * validating RS256, which would be a key-rotation cache and a crypto dependency for no security
 * this path lacks. `aud` and `iss` are still checked, because those are cheap and catch a token
 * minted for a different client or endpoint.
 *
 * **This reasoning holds only because the token is fetched server-side.** An `id_token` that ever
 * arrives through the browser (an implicit-flow fragment, a client-posted assertion) must be
 * signature-verified against Google's keys — do not reuse `decodeIdToken` for that.
 *
 * ## Testability
 *
 * `exchangeCode` takes its `fetch` as a parameter, so the tests drive the whole exchange against
 * a fake token endpoint without a network. `decodeIdToken`, `buildAuthUrl` and `resolveConfig`
 * are pure.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** The scopes: an OpenID subject, plus the email and display name we store on the user row. */
export const GOOGLE_SCOPES = 'openid email profile';

export const CLIENT_ID_ENV = 'GOOGLE_CLIENT_ID';
export const CLIENT_SECRET_ENV = 'GOOGLE_CLIENT_SECRET';
/** Explicit redirect URI, else derived from the public origin. */
export const REDIRECT_URI_ENV = 'GOOGLE_REDIRECT_URI';
export const PUBLIC_ORIGIN_ENV = 'GODMODE_PUBLIC_ORIGIN';
/** The one path Google redirects back to. Registered with the OAuth client by DevOps. */
export const CALLBACK_PATH = '/auth/google/callback';

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/** The fields of the identity we keep. `sub` is Google's stable per-user id — never the email. */
export interface GoogleIdentity {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | undefined;
}

/**
 * Resolve the OAuth client from the environment, or `undefined` when Google is not configured.
 *
 * Returning `undefined` rather than throwing is deliberate: Google Sign-In is optional
 * infrastructure (`server/DEPLOY.md`, `[MANUAL]`), and a deployment without the credentials must
 * still run with password accounts. The routes read this once and simply do not offer the Google
 * button — and answer `/auth/google/*` with a clear 404 — when it is absent, rather than crashing
 * at startup.
 *
 * The redirect URI is taken verbatim from `GOOGLE_REDIRECT_URI` when set (it must match, to the
 * character, the value registered with Google), and otherwise built from `GODMODE_PUBLIC_ORIGIN`
 * so a standard deployment names its origin once. With neither, and even though a client id and
 * secret are present, Google stays disabled: a redirect URI that does not match the registered
 * one produces `redirect_uri_mismatch` at Google rather than a working login, so guessing one is
 * worse than not offering the button.
 */
export function resolveGoogleConfig(
  env: Readonly<Record<string, string | undefined>> = {},
): GoogleOAuthConfig | undefined {
  const clientId = env[CLIENT_ID_ENV]?.trim();
  const clientSecret = env[CLIENT_SECRET_ENV]?.trim();
  if (clientId === undefined || clientId === '' || clientSecret === undefined || clientSecret === '') {
    return undefined;
  }

  const explicit = env[REDIRECT_URI_ENV]?.trim();
  let redirectUri: string | undefined;
  if (explicit !== undefined && explicit !== '') {
    redirectUri = explicit;
  } else {
    const origin = env[PUBLIC_ORIGIN_ENV]?.trim();
    if (origin !== undefined && origin !== '') {
      redirectUri = `${origin.replace(/\/+$/, '')}${CALLBACK_PATH}`;
    }
  }
  if (redirectUri === undefined) return undefined;

  return { clientId, clientSecret, redirectUri };
}

/**
 * The URL to redirect the browser to, carrying our `state`.
 *
 * `access_type=online` because there is no offline work to do on the user's behalf — no refresh
 * token is wanted or stored. `prompt=select_account` so a shared machine does not silently reuse
 * whichever Google account happens to be signed in. `state` is the caller's CSRF nonce, echoed
 * back on the callback and compared there.
 */
export function buildAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Decode the payload of an `id_token`. See the module note on why this is not signature-verified.
 *
 * Throws on anything that is not a well-formed JWT with the claims we require: a missing `sub`, a
 * missing `email`, an `aud` that is not our client, or an `iss` that is not Google. The caller
 * turns a throw into a failed login, never a crash.
 */
export function decodeIdToken(idToken: string, expectedAudience: string): GoogleIdentity {
  const segments = idToken.split('.');
  if (segments.length !== 3) throw new Error('id_token is not a JWT');

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(segments[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error('id_token payload is not valid JSON');
  }

  const iss = claims['iss'];
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    throw new Error('id_token was not issued by Google');
  }
  const aud = claims['aud'];
  if (aud !== expectedAudience) throw new Error('id_token was minted for a different client');

  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub === '') throw new Error('id_token has no subject');
  const email = claims['email'];
  if (typeof email !== 'string' || email === '') throw new Error('id_token has no email');
  const name = typeof claims['name'] === 'string' && claims['name'] !== '' ? claims['name'] : undefined;
  // Google sends `email_verified` as a boolean or, historically, the string "true".
  const rawVerified = claims['email_verified'];
  const emailVerified = rawVerified === true || rawVerified === 'true';

  return { sub, email, emailVerified, name };
}

export interface ExchangeDeps {
  /** Injected so the exchange is driven against a fake token endpoint in tests. */
  readonly fetch?: typeof fetch;
}

interface TokenResponse {
  id_token?: unknown;
}

/**
 * Exchange an authorization `code` for the caller's Google identity.
 *
 * Server-to-server: the `client_secret` is sent here and only here, never to the browser. A
 * non-2xx from Google, a response without an `id_token`, or an `id_token` that fails
 * `decodeIdToken`'s checks all throw — the caller renders a failed login.
 */
export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
  deps: ExchangeDeps = {},
): Promise<GoogleIdentity> {
  const doFetch = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed with status ${String(response.status)}`);
  }

  const payload = (await response.json()) as TokenResponse;
  const idToken = payload.id_token;
  if (typeof idToken !== 'string' || idToken === '') {
    throw new Error('Google token response carried no id_token');
  }
  return decodeIdToken(idToken, config.clientId);
}
