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
import type { DatabaseSync } from 'node:sqlite';

export const SESSION_COOKIE = 'godmode_session';

/** Absolute lifetime. A session older than this is dead however recently it was used. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Idle lifetime. Sliding, so an app left open for a month is not logged out mid-workout. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionOptions {
  readonly maxAgeMs?: number;
  readonly idleMs?: number;
}

interface SessionRow {
  user_id: string;
  created_at: number;
  last_seen_at: number;
}

/**
 * Sessions persisted in SQLite instead of an in-memory `Map`.
 *
 * ## Why persisted
 *
 * The in-memory map died with the process, so every deploy or restart logged everyone out. That
 * is tolerable for a single owner on a laptop; it is not for a hosted app a group of people share.
 * The rows live in the `sessions` table (`server/schema.sql`), keyed by the same opaque 256-bit id
 * the cookie carries, and each names the `user_id` it authenticates — that is how a request
 * becomes a `req.userId` in `server/routes.ts`.
 *
 * The absolute/idle expiry semantics are unchanged from the map: a session is dead when it is
 * older than `maxAgeMs` however recently used, or idle for longer than `idleMs`. Expiry is still
 * enforced on read, and an expired row is deleted rather than merely rejected, so a leaked old id
 * cannot be kept alive by probing it.
 */
export class SessionStore {
  readonly #db: DatabaseSync;
  readonly #maxAgeMs: number;
  readonly #idleMs: number;

  constructor(db: DatabaseSync, options: SessionOptions = {}) {
    this.#db = db;
    this.#maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS;
    this.#idleMs = options.idleMs ?? SESSION_IDLE_MS;
  }

  /**
   * Mint a session for `userId`. 256 bits from the CSPRNG — opaque, so nothing leaks if it is
   * seen. A new id is always generated and never adopted from the caller (fixation impossibility;
   * see the note above).
   */
  create(userId: string, now: number): string {
    this.prune(now);
    const id = randomBytes(32).toString('base64url');
    this.#db
      .prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, now, now);
    return id;
  }

  /**
   * The `user_id` this session authenticates, or `undefined` if it is unknown or expired.
   *
   * Refreshes the idle clock as a side effect. An expired row is deleted here rather than merely
   * rejected.
   */
  validate(id: string | undefined, now: number): string | undefined {
    if (id === undefined || id === '') return undefined;
    const row = this.#db
      .prepare('SELECT user_id, created_at, last_seen_at FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    if (row === undefined) return undefined;
    if (this.#isExpired(row, now)) {
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return undefined;
    }
    this.#db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
    return row.user_id;
  }

  destroy(id: string | undefined): void {
    if (id !== undefined && id !== '') this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** Used when the token is rotated: every existing session must stop working at once. */
  destroyAll(): void {
    this.#db.prepare('DELETE FROM sessions').run();
  }

  /** Every session belonging to one user — the shape a per-user "sign out everywhere" needs. */
  destroyAllForUser(userId: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  prune(now: number): void {
    const absoluteCutoff = now - this.#maxAgeMs;
    const idleCutoff = now - this.#idleMs;
    this.#db
      .prepare('DELETE FROM sessions WHERE created_at <= ? OR last_seen_at <= ?')
      .run(absoluteCutoff, idleCutoff);
  }

  get size(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    return row.n;
  }

  /** When the given session stops being valid even if used continuously. */
  expiresAt(id: string): number | undefined {
    const row = this.#db.prepare('SELECT created_at FROM sessions WHERE id = ?').get(id) as
      | { created_at: number }
      | undefined;
    return row === undefined ? undefined : row.created_at + this.#maxAgeMs;
  }

  #isExpired(row: SessionRow, now: number): boolean {
    return now - row.created_at >= this.#maxAgeMs || now - row.last_seen_at >= this.#idleMs;
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
