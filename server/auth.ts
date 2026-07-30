/**
 * The shared secret: where it comes from, how it is compared, and how often it may be guessed.
 *
 * One token for one person is proportionate — this is a single-tenant server with no user
 * accounts and nothing to separate. What is *not* proportionate is a token that can be brute
 * forced, timed, logged, or defaulted to something guessable, so each of those gets a specific
 * answer here.
 *
 * The token is never stored in this process in a form that a heap dump would hand over: only
 * its SHA-256 digest is kept, and comparison is on digests of equal length via
 * `crypto.timingSafeEqual`. Digests are used rather than the raw strings precisely because
 * `timingSafeEqual` throws on unequal lengths, which would leak the token's length to anyone
 * willing to watch for the difference between a 400 and a 401.
 *
 * The token never appears in a URL and is never logged. It is accepted exactly once, by
 * `POST /api/session`, and exchanged for an opaque session id — see `server/session.ts`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { APP_DIR_NAME, type Host, currentHost } from './db.js';

export class TokenMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenMissingError';
  }
}

/** The environment variable, named once. */
export const TOKEN_ENV = 'GODMODE_TOKEN';

/**
 * Read the token, or refuse.
 *
 * There is no default and no "insecure local mode". A default would be published in this file
 * and therefore known to everyone; an insecure mode would be a process that behaves one way on
 * a laptop and another way the first time somebody binds it to an interface. The one-command
 * launcher (`npm run serve`) supplies a real generated secret, so refusing here costs the owner
 * nothing and never trains him to paste a dummy value.
 */
export function requireToken(host: Host = currentHost()): string {
  const raw = host.env[TOKEN_ENV];
  const token = raw?.trim() ?? '';
  if (token === '') {
    throw new TokenMissingError(
      `${TOKEN_ENV} is not set, so the server will not start.\n` +
        '\n' +
        'There is deliberately no default and no unauthenticated mode: a default would be a\n' +
        'published secret, and a mode that behaves differently on a laptop is a mode that will\n' +
        'one day be deployed by accident.\n' +
        '\n' +
        'Run `npm run serve`, which generates a secret on first use and stores it with 0600\n' +
        `permissions outside the repository, or run \`npm run token\` to print it.`,
    );
  }
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    throw new TokenMissingError(
      `${TOKEN_ENV} is only ${String(token.length)} characters. A shared secret guarding the ` +
        `only copy of your training history needs at least ${String(MINIMUM_TOKEN_LENGTH)}. ` +
        'Run `npm run token` to generate one.',
    );
  }
  return token;
}

/** Short enough to type once on a phone, long enough that guessing it is hopeless. */
export const MINIMUM_TOKEN_LENGTH = 16;

export function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Constant-time comparison of a candidate against the stored digest.
 *
 * Both sides are 32-byte SHA-256 digests, so the lengths always match and `timingSafeEqual`
 * never throws — which is the reason for hashing before comparing rather than after.
 */
export function tokenMatches(candidate: string, expected: Buffer): boolean {
  return timingSafeEqual(digest(candidate), expected);
}

// ── The token file, and the launcher that reads it ──────────────────────────────────────────

export const TOKEN_FILE_ENV = 'GODMODE_TOKEN_FILE';
export const TOKEN_FILENAME = 'token';

/**
 * Where the generated secret lives.
 *
 * Deliberately **not** under `GODMODE_DATA_DIR`. That variable exists so a developer can point
 * the database at `./.data` inside the checkout; a secret must never follow it there, because
 * the checkout is the thing that gets shared, archived and pushed. So the token file always
 * lands in the platform's own per-user location, which is outside the repository by
 * construction, unless `GODMODE_TOKEN_FILE` says otherwise.
 */
export function resolveTokenFile(host: Host = currentHost()): string {
  const override = host.env[TOKEN_FILE_ENV]?.trim();
  if (override !== undefined && override !== '') {
    return isAbsolute(override) ? override : resolve(override);
  }
  if (host.platform === 'darwin') {
    return join(host.homedir, 'Library', 'Application Support', APP_DIR_NAME, TOKEN_FILENAME);
  }
  const xdg = host.env['XDG_CONFIG_HOME']?.trim();
  const base =
    xdg !== undefined && xdg !== '' && isAbsolute(xdg)
      ? xdg
      : join(host.homedir, '.config');
  return join(base, APP_DIR_NAME, TOKEN_FILENAME);
}

/** 32 random bytes, base64url — 256 bits of entropy in 43 typeable characters. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Read the secret from `path`, creating it on first use.
 *
 * Created with mode 0600 and re-chmodded on every read, so a file that was once world-readable
 * stops being so the next time the server starts rather than the next time somebody notices.
 * The value is returned, never logged — printing it is `npm run token`'s job, because the owner
 * has to type it into the app once per device.
 */
export function ensureTokenFile(path: string): string {
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing !== '') {
      if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
      return existing;
    }
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }

  const token = generateToken();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'ENOENT'
  );
}

// ── Rate limiting failed attempts ───────────────────────────────────────────────────────────

export interface LimiterDecision {
  readonly allowed: boolean;
  /** Seconds the caller should wait, for the `Retry-After` header. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

export interface LimiterOptions {
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly maxKeys?: number;
}

/**
 * A sliding window of failed token attempts per client.
 *
 * Rate limiting does nothing against a stolen token — that is what the short-lived `HttpOnly`
 * cookie and TLS are for. What it does stop is the only attack a 256-bit secret is otherwise
 * exposed to on a box reachable from the internet: an unbounded guessing loop, which would also
 * fill the disk with failures nobody reads.
 *
 * Keyed by remote address. Three consequences, each deliberate:
 *
 *   **A success below the threshold clears the counter**, so the owner mistyping his token four
 *   times on a phone keyboard does not carry those failures around for the rest of the window.
 *
 *   **Once the threshold is reached, the correct token is refused too.** Being able to tell a
 *   right guess from a wrong one during a lockout would make the limit no limit at all for
 *   whoever eventually guesses right. The cost is that a flood locks the owner out for the
 *   length of the window; the alternative costs more.
 *
 *   **`X-Forwarded-For` is never read.** It is client-supplied, so trusting it would let an
 *   attacker pick a fresh key for every guess and evade the limit entirely. The price is that
 *   behind a reverse proxy every client shares one key — which, for a server with exactly one
 *   user, is no price at all.
 *
 * The map is bounded, because the keys come from whoever can reach the port: expired entries go
 * on every touch, and if a flood from many addresses still fills it, the oldest entries are
 * dropped rather than the process growing without limit.
 */
export class AttemptLimiter {
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #failures = new Map<string, number[]>();

  constructor(options: LimiterOptions = {}) {
    this.#maxFailures = options.maxFailures ?? 10;
    this.#windowMs = options.windowMs ?? 5 * 60 * 1000;
    this.#maxKeys = options.maxKeys ?? 4096;
  }

  check(key: string, now: number): LimiterDecision {
    const recent = this.#recent(key, now);
    if (recent.length < this.#maxFailures) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = recent[0] ?? now;
    const waitMs = Math.max(0, oldest + this.#windowMs - now);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  recordFailure(key: string, now: number): void {
    const recent = this.#recent(key, now);
    recent.push(now);
    this.#failures.set(key, recent);
    this.#evict(now);
  }

  recordSuccess(key: string): void {
    this.#failures.delete(key);
  }

  /** Live keys being tracked. Exposed so the bound can be asserted rather than assumed. */
  get size(): number {
    return this.#failures.size;
  }

  #recent(key: string, now: number): number[] {
    const all = this.#failures.get(key) ?? [];
    const cutoff = now - this.#windowMs;
    const recent = all.filter((at) => at > cutoff);
    if (recent.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, recent);
    return recent;
  }

  #evict(now: number): void {
    if (this.#failures.size <= this.#maxKeys) return;
    const cutoff = now - this.#windowMs;
    for (const [key, attempts] of this.#failures) {
      if (attempts.every((at) => at <= cutoff)) this.#failures.delete(key);
    }
    // Map iteration is insertion-ordered, so this drops the least recently created keys first.
    for (const key of this.#failures.keys()) {
      if (this.#failures.size <= this.#maxKeys) break;
      this.#failures.delete(key);
    }
  }
}
