// @vitest-environment node
//
// `server/registration.ts` — the single gate that decides whether a new account may be created.

import { describe, expect, it } from 'vitest';
import { evaluate, resolveRegistrationGate } from './registration.js';

describe('resolveRegistrationGate', () => {
  it('defaults to invite mode when nothing is set', () => {
    expect(resolveRegistrationGate({}).mode).toBe('invite');
  });

  it('reads open and closed modes, and treats an unknown mode as closed', () => {
    expect(resolveRegistrationGate({ GODMODE_REGISTRATION: 'open' }).mode).toBe('open');
    expect(resolveRegistrationGate({ GODMODE_REGISTRATION: 'closed' }).mode).toBe('closed');
    expect(resolveRegistrationGate({ GODMODE_REGISTRATION: 'typo' }).mode).toBe('closed');
  });

  it('carries an invite digest only when a code is configured', () => {
    expect(resolveRegistrationGate({ GODMODE_INVITE_CODE: 'let-me-in' }).inviteDigest).toBeInstanceOf(
      Buffer,
    );
    expect(resolveRegistrationGate({}).inviteDigest).toBeUndefined();
  });
});

describe('evaluate', () => {
  it('open mode accepts anyone, with or without a code', () => {
    const gate = resolveRegistrationGate({ GODMODE_REGISTRATION: 'open' });
    expect(evaluate(gate, undefined).allowed).toBe(true);
    expect(evaluate(gate, 'whatever').allowed).toBe(true);
  });

  it('closed mode refuses everyone', () => {
    const gate = resolveRegistrationGate({ GODMODE_REGISTRATION: 'closed' });
    const decision = evaluate(gate, 'any-code');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('registration_closed');
  });

  it('invite mode with no configured code is a closed door', () => {
    const gate = resolveRegistrationGate({ GODMODE_REGISTRATION: 'invite' });
    expect(evaluate(gate, 'anything').reason).toBe('registration_closed');
  });

  it('invite mode requires a code, and it must be the right one', () => {
    const gate = resolveRegistrationGate({ GODMODE_INVITE_CODE: 'sesame' });
    expect(evaluate(gate, undefined).reason).toBe('invite_required');
    expect(evaluate(gate, '').reason).toBe('invite_required');
    expect(evaluate(gate, 'wrong').reason).toBe('invite_invalid');
    expect(evaluate(gate, 'sesame').allowed).toBe(true);
    expect(evaluate(gate, '  sesame  ').allowed).toBe(true); // trimmed
  });
});
