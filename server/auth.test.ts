// @vitest-environment node
//
// `server/auth.ts` and `server/session.ts` — the secret, the file it lives in, the rate limit,
// and the cookie. The HTTP behaviour these produce is asserted against a real server in
// `server/api.test.ts`; this file pins the pieces that are easier to get wrong than to notice.

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttemptLimiter,
  MINIMUM_TOKEN_LENGTH,
  TokenMissingError,
  digest,
  ensureTokenFile,
  generateToken,
  requireToken,
  resolveTokenFile,
  tokenMatches,
} from './auth.js';
import {
  SESSION_COOKIE,
  SessionStore,
  clearedSessionCookie,
  parseCookies,
  sessionCookie,
} from './session.js';
import type { Host } from './db.js';

const temporaries: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-auth-'));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function host(overrides: Partial<Host> = {}): Host {
  return { env: {}, platform: 'linux', homedir: '/home/tester', ...overrides };
}

describe('requireToken', () => {
  it('refuses to start when the token is unset, empty or whitespace', () => {
    expect(() => requireToken(host())).toThrow(TokenMissingError);
    expect(() => requireToken(host({ env: { GODMODE_TOKEN: '' } }))).toThrow(TokenMissingError);
    expect(() => requireToken(host({ env: { GODMODE_TOKEN: '   ' } }))).toThrow(TokenMissingError);
  });

  it('names the launcher rather than inviting a dummy value', () => {
    // A published default is a published secret, and pasting `changeme` once is a habit.
    expect(() => requireToken(host())).toThrow(/npm run serve/);
  });

  it('refuses a token short enough to be guessed', () => {
    const short = 'x'.repeat(MINIMUM_TOKEN_LENGTH - 1);
    expect(() => requireToken(host({ env: { GODMODE_TOKEN: short } }))).toThrow(/characters/);
  });

  it('accepts and trims a real token', () => {
    const token = generateToken();
    expect(requireToken(host({ env: { GODMODE_TOKEN: ` ${token} ` } }))).toBe(token);
  });
});

describe('tokenMatches', () => {
  it('accepts the token and rejects everything else, including near misses', () => {
    const token = generateToken();
    const expected = digest(token);
    expect(tokenMatches(token, expected)).toBe(true);
    expect(tokenMatches(`${token}x`, expected)).toBe(false);
    expect(tokenMatches(token.slice(0, -1), expected)).toBe(false);
    expect(tokenMatches('', expected)).toBe(false);
  });

  it('compares equal-length digests, so a wrong length is not a different code path', () => {
    // `timingSafeEqual` throws on unequal lengths. Hashing first is what stops the token's
    // length leaking as the difference between a 500 and a 401.
    expect(() => tokenMatches('a', digest('a'.repeat(400)))).not.toThrow();
  });

  it('generates 256 bits in a form that can be typed on a phone', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(MINIMUM_TOKEN_LENGTH);
    expect(generateToken()).not.toBe(token);
  });
});

describe('the token file', () => {
  it('never follows GODMODE_DATA_DIR into the repository', () => {
    // The data directory is allowed to point at ./.data while developing. A secret must not.
    const resolved = resolveTokenFile(
      host({ env: { GODMODE_DATA_DIR: '/Users/x/repos/godmode/.data' } }),
    );
    expect(resolved).toBe('/home/tester/.config/godmode/token');
  });

  it('uses Application Support on macOS and XDG_CONFIG_HOME on linux', () => {
    expect(resolveTokenFile(host({ platform: 'darwin', homedir: '/Users/x' }))).toBe(
      '/Users/x/Library/Application Support/godmode/token',
    );
    expect(resolveTokenFile(host({ env: { XDG_CONFIG_HOME: '/etc/xdg' } }))).toBe(
      '/etc/xdg/godmode/token',
    );
  });

  it('generates a secret on first use and returns the same one afterwards', () => {
    const path = join(tempDir(), 'nested', 'token');
    const first = ensureTokenFile(path);
    expect(first.length).toBeGreaterThanOrEqual(MINIMUM_TOKEN_LENGTH);
    expect(ensureTokenFile(path)).toBe(first);
    expect(readFileSync(path, 'utf8').trim()).toBe(first);
  });

  it('creates the file 0600 and repairs it if it was loosened', () => {
    const path = join(tempDir(), 'token');
    const token = ensureTokenFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    chmodSync(path, 0o644);
    expect(ensureTokenFile(path)).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('replaces an empty file rather than handing back an empty secret', () => {
    const path = join(tempDir(), 'token');
    writeFileSync(path, '\n');
    expect(ensureTokenFile(path).trim()).not.toBe('');
  });
});

describe('AttemptLimiter', () => {
  it('allows attempts up to the limit and then refuses with a wait', () => {
    const limiter = new AttemptLimiter({ maxFailures: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check('a', 0).allowed).toBe(true);
      limiter.recordFailure('a', 0);
    }
    const blocked = limiter.check('a', 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('forgets failures once they slide out of the window', () => {
    const limiter = new AttemptLimiter({ maxFailures: 2, windowMs: 1000 });
    limiter.recordFailure('a', 0);
    limiter.recordFailure('a', 0);
    expect(limiter.check('a', 500).allowed).toBe(false);
    expect(limiter.check('a', 1500).allowed).toBe(true);
  });

  it('does not lock the owner out after he finally types it correctly', () => {
    const limiter = new AttemptLimiter({ maxFailures: 3, windowMs: 60_000 });
    limiter.recordFailure('a', 0);
    limiter.recordFailure('a', 1);
    limiter.recordSuccess('a');
    limiter.recordFailure('a', 2);
    expect(limiter.check('a', 3).allowed).toBe(true);
  });

  it('bounds the map, so failures from many addresses cannot grow it without limit', () => {
    // The keys come from whoever can reach the port. An unbounded map is a memory leak with a
    // remote trigger.
    const limiter = new AttemptLimiter({ maxFailures: 5, windowMs: 60_000, maxKeys: 8 });
    for (let i = 0; i < 200; i += 1) limiter.recordFailure(`client-${String(i)}`, 1000);
    expect(limiter.size).toBeLessThanOrEqual(8);
    // The most recent addresses are the ones kept.
    expect(limiter.check('client-199', 1000).allowed).toBe(true);
  });

  it('counts each client separately', () => {
    const limiter = new AttemptLimiter({ maxFailures: 1, windowMs: 1000 });
    limiter.recordFailure('a', 0);
    expect(limiter.check('a', 0).allowed).toBe(false);
    expect(limiter.check('b', 0).allowed).toBe(true);
  });
});

describe('SessionStore', () => {
  it('mints opaque, unguessable, distinct ids', () => {
    const store = new SessionStore();
    const a = store.create(0);
    const b = store.create(0);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never adopts an id it did not mint — so fixation is impossible', () => {
    const store = new SessionStore();
    store.create(0);
    expect(store.validate('planted-by-an-attacker', 0)).toBe(false);
  });

  it('expires on idle and on absolute age, and deletes rather than merely refusing', () => {
    const store = new SessionStore({ maxAgeMs: 1000, idleMs: 100 });
    const idle = store.create(0);
    expect(store.validate(idle, 99)).toBe(true);
    expect(store.validate(idle, 250)).toBe(false);
    expect(store.size).toBe(0);

    const kept = store.create(0);
    for (let at = 50; at < 1000; at += 50) expect(store.validate(kept, at)).toBe(true);
    expect(store.validate(kept, 1000)).toBe(false);
  });

  it('drops a destroyed session immediately', () => {
    const store = new SessionStore();
    const id = store.create(0);
    store.destroy(id);
    expect(store.validate(id, 0)).toBe(false);
  });

  it('rejects a missing or empty cookie without touching the map', () => {
    const store = new SessionStore();
    expect(store.validate(undefined, 0)).toBe(false);
    expect(store.validate('', 0)).toBe(false);
  });
});

describe('the session cookie', () => {
  it('carries every attribute the design depends on', () => {
    const cookie = sessionCookie('abc', 60);
    expect(cookie).toContain(`${SESSION_COOKIE}=abc`);
    // HttpOnly: script cannot read it, so same-origin XSS cannot exfiltrate the session.
    expect(cookie).toContain('HttpOnly');
    // Secure: refused over plain HTTP everywhere except localhost, which browsers exempt.
    expect(cookie).toContain('Secure');
    // SameSite=Strict is why there is no CSRF token. See the note in server/session.ts.
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=60');
  });

  it('clears with matching attributes, or the browser keeps the original', () => {
    const cleared = clearedSessionCookie();
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
      expect(cleared).toContain(attribute);
    }
    expect(cleared).toContain('Max-Age=0');
  });

  it('never emits a negative Max-Age', () => {
    expect(sessionCookie('abc', -5)).toContain('Max-Age=0');
  });
});

describe('parseCookies', () => {
  it('reads a normal header', () => {
    expect(parseCookies('a=1; b=2').get('b')).toBe('2');
  });

  it('tolerates spacing, and values containing "="', () => {
    expect(parseCookies('  a = x=y ;b=2').get('a')).toBe('x=y');
  });

  it('returns nothing for an absent or malformed header', () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies('nonsense').size).toBe(0);
    expect(parseCookies('=novalue').size).toBe(0);
  });

  it('keeps the first of a duplicated name', () => {
    expect(parseCookies('a=first; a=second').get('a')).toBe('first');
  });
});
