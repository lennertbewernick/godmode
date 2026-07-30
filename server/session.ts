/**
 * Sessions, and the cookie that carries them.
 *
 * ## Why a cookie and not a bearer header
 *
 * A bearer token has to live somewhere the page can read it, which means `localStorage`, which
 * means any successful same-origin XSS walks off with the long-lived secret itself rather than
 * a revocable session. It also does not survive an iOS home-screen install: WebKit copies
 * cookies into a newly installed web app and does not copy other local storage, so the owner
 * would have to re-enter the token in the installed app. The cookie is set `HttpOnly`, so no
 * script — ours or injected — can read it, and it is revocable server-side by dropping one map
 * entry.
 *
 * ## Why `Secure` still works on localhost
 *
 * `Secure` normally means "never send this over plain HTTP", which would make the cookie
 * useless at `http://localhost:8787`. Browsers exempt loopback from that rule as part of
 * treating it as a potentially trustworthy origin. **Use `http://localhost:<port>`** — that
 * spelling is the one every current engine documents, and engines have not always agreed about
 * other loopback spellings or about `Secure` on plaintext origins generally.
 *
 * The attribute is set unconditionally, so **the moment this server is reachable at anything
 * other than localhost it needs TLS or nobody can sign in.** That is the intended failure mode
 * — a deployment without TLS should not work — and it is in `server/DEPLOY.md` rather than left
 * to be discovered. It is also the one claim here that no test can make: whether a given
 * browser accepts this cookie on a given plaintext origin is the browser's behaviour, not this
 * server's.
 *
 * ## Why there is no CSRF token
 *
 * `SameSite=Strict` means the browser never attaches this cookie to a request that originated
 * from another site — not a form post, not an image, not a fetch. The app is served from the
 * same origin as its API (`server/index.ts` serves `dist/` and `/api` from one listener), so
 * there is no legitimate cross-site entry point to lose. That is the entire reason a CSRF token
 * is unnecessary here.
 *
 * **If the app is ever served from a different origin than the API, this reasoning collapses**:
 * `SameSite=Strict` would stop the real app working, the obvious fix would be `SameSite=None`,
 * and the same edit would silently reopen CSRF. Splitting the origins therefore requires a CSRF
 * token in the same change, not afterwards.
 *
 * ## Why fixation is not possible
 *
 * A session id is only ever minted by this server from `crypto.randomBytes`. A value presented
 * in a request is looked up and either exists or does not; an unknown id is never adopted. And
 * `POST /api/session` always mints a *new* id and discards whatever the caller presented, so an
 * attacker who plants a cookie cannot have it promoted to an authenticated one by the owner
 * logging in.
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'godmode_session';

/** Absolute lifetime. A session older than this is dead however recently it was used. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Idle lifetime. Sliding, so an app left open for a month is not logged out mid-workout. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionEntry {
  readonly createdAt: number;
  lastSeenAt: number;
}

export interface SessionOptions {
  readonly maxAgeMs?: number;
  readonly idleMs?: number;
}

export class SessionStore {
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #maxAgeMs: number;
  readonly #idleMs: number;

  constructor(options: SessionOptions = {}) {
    this.#maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS;
    this.#idleMs = options.idleMs ?? SESSION_IDLE_MS;
  }

  /** 256 bits from the CSPRNG. Opaque: it encodes nothing, so nothing leaks if it is seen. */
  create(now: number): string {
    this.prune(now);
    const id = randomBytes(32).toString('base64url');
    this.#sessions.set(id, { createdAt: now, lastSeenAt: now });
    return id;
  }

  /**
   * True when this id names a live session, refreshing its idle clock as a side effect.
   *
   * An expired entry is deleted here rather than merely rejected, so an attacker who somehow
   * learned an old id cannot keep it alive in the map by probing it.
   */
  validate(id: string | undefined, now: number): boolean {
    if (id === undefined || id === '') return false;
    const entry = this.#sessions.get(id);
    if (entry === undefined) return false;
    if (this.#isExpired(entry, now)) {
      this.#sessions.delete(id);
      return false;
    }
    entry.lastSeenAt = now;
    return true;
  }

  destroy(id: string | undefined): void {
    if (id !== undefined && id !== '') this.#sessions.delete(id);
  }

  /** Used when the token is rotated: every existing session must stop working at once. */
  destroyAll(): void {
    this.#sessions.clear();
  }

  prune(now: number): void {
    for (const [id, entry] of this.#sessions) {
      if (this.#isExpired(entry, now)) this.#sessions.delete(id);
    }
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** When the given session stops being valid even if used continuously. */
  expiresAt(id: string): number | undefined {
    const entry = this.#sessions.get(id);
    return entry === undefined ? undefined : entry.createdAt + this.#maxAgeMs;
  }

  #isExpired(entry: SessionEntry, now: number): boolean {
    return now - entry.createdAt >= this.#maxAgeMs || now - entry.lastSeenAt >= this.#idleMs;
  }
}

/**
 * The `Set-Cookie` value for a fresh session.
 *
 * `Path=/` because the shell and the API share an origin and both need it. `Max-Age` rather
 * than `Expires` so a wrong device clock cannot expire it early or keep it forever.
 */
export function sessionCookie(id: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${id}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}`,
  ].join('; ');
}

/**
 * The `Set-Cookie` value that removes the session from the browser.
 *
 * Every attribute except `Max-Age` must match the cookie being replaced, or the browser treats
 * it as a different cookie and keeps the original — a sign-out that appears to work and does
 * not.
 */
export function clearedSessionCookie(): string {
  return [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ].join('; ');
}

/** Parse a `Cookie` header. Tolerant of spacing, and of values that contain `=`. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name !== '' && !out.has(name)) out.set(name, value);
  }
  return out;
}

export function readSessionId(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE);
}
