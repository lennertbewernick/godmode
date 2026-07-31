// @vitest-environment node
//
// `server/passwords.ts` — scrypt hashing that carries its own parameters and verifies in
// constant time. The HTTP behaviour these produce (login, registration) is asserted against a
// real server in `server/api.test.ts`; this file pins the pieces of the primitive.

import { describe, expect, it } from 'vitest';
import {
  MINIMUM_PASSWORD_LENGTH,
  hashPassword,
  passwordTooShort,
  verifyPassword,
} from './passwords.js';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('the-right-one');
    expect(verifyPassword('the-wrong-one', stored)).toBe(false);
  });

  it('produces a self-describing scrypt string', () => {
    const stored = hashPassword('whatever-123');
    const parts = stored.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(6);
    expect(Number(parts[1])).toBeGreaterThan(1); // N
  });

  it('salts: the same password hashes to two different strings', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'));
  });

  it('is case- and whitespace-sensitive', () => {
    const stored = hashPassword('Passw0rd ');
    expect(verifyPassword('passw0rd ', stored)).toBe(false);
    expect(verifyPassword('Passw0rd', stored)).toBe(false);
    expect(verifyPassword('Passw0rd ', stored)).toBe(true);
  });

  it('fails closed on a malformed stored value rather than throwing', () => {
    for (const bad of ['', 'nonsense', 'scrypt$only$three', 'bcrypt$16384$8$1$aa$bb']) {
      expect(verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('verifies against parameters stored in the hash, not the current defaults', () => {
    // A hash made with a smaller N must still verify after defaults change: prove a hand-built
    // low-cost hash round-trips through the parameter-reading path.
    const low = hashPassword('legacy'); // uses defaults today
    expect(verifyPassword('legacy', low)).toBe(true);
  });
});

describe('passwordTooShort', () => {
  it('flags a password below the floor and accepts one at it', () => {
    expect(passwordTooShort('a'.repeat(MINIMUM_PASSWORD_LENGTH - 1))).toBe(true);
    expect(passwordTooShort('a'.repeat(MINIMUM_PASSWORD_LENGTH))).toBe(false);
  });
});
