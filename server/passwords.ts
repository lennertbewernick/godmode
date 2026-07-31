/**
 * Password hashing, self-describing and verified in constant time.
 *
 * ## Why scrypt from `node:sqlite`'s neighbour `node:crypto`, and nothing else
 *
 * The whole point of this fork is to add no runtime dependencies the single-owner build did not
 * already carry — the server is `node:http` + `node:sqlite` and that is the list. A password
 * hash therefore comes from `node:crypto`, which ships `scrypt`: a memory-hard KDF that is a
 * deliberate, standard answer to offline guessing of a stolen `password_hash`. bcrypt/argon2
 * would each be a native dependency to compile, pin and trust; scrypt is already here.
 *
 * ## Why the stored string carries its own parameters
 *
 * A hash written today with one cost factor must still verify years from now after that cost has
 * been raised — otherwise raising it logs everyone out. So the encoded value is self-describing:
 * `scrypt$N$r$p$salt$hash`, every field base64url or decimal, no separator that appears inside a
 * field. `verifyPassword` reads the parameters out of the stored value and re-derives with
 * *those*, never with the current defaults, so old and new hashes coexist in one table.
 *
 * ## Why the comparison is constant-time
 *
 * The derived key is compared with `timingSafeEqual`, not `===`. A byte-at-a-time comparison
 * leaks, through timing, how long a common prefix a guess shares with the real hash — enough, at
 * scale, to reconstruct it. Both sides are the same length by construction (same `keylen`), so
 * `timingSafeEqual` never throws on a length mismatch; a stored value whose decoded hash is a
 * different length is treated as a non-match rather than an exception.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Default cost parameters.
 *
 * `N = 16384` (2^14) is scrypt's own documented default and needs ~16 MiB (`128 * N * r`), well
 * under Node's 32 MiB `maxmem` ceiling, so a hash never fails to compute for lack of memory.
 * Raising `N` later is safe precisely because every stored hash records the `N` it was made with.
 */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

/**
 * A floor, not a policy engine.
 *
 * This is a small server for one person's circle, not a public sign-up form, so the composition
 * rules a public form would need are out of place. What is not optional is length: a memory-hard
 * KDF buys time against guessing, and eight characters is the point below which it buys almost
 * none.
 */
export const MINIMUM_PASSWORD_LENGTH = 8;

/** Reject a password that is too short to be worth hashing, before it is hashed. */
export function passwordTooShort(password: string): boolean {
  return password.length < MINIMUM_PASSWORD_LENGTH;
}

/** `scrypt$N$r$p$salt$hash`, salt and hash base64url. Safe to store verbatim in `users.password_hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * True when `password` re-derives to `stored`, in constant time.
 *
 * A malformed stored value — wrong prefix, missing field, unparseable parameter — is a `false`,
 * never a throw: a corrupt row must fail closed as "wrong password", not crash the login path.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 2 || r < 1 || p < 1) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, { N, r, p });
  } catch {
    // `scryptSync` throws when the parameters exceed `maxmem`; a stored value asking for more
    // memory than we will spend is a non-match, not a crash.
    return false;
  }
  // Lengths are equal by construction (`expected.length` was the requested keylen), so
  // `timingSafeEqual` compares rather than throws.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
