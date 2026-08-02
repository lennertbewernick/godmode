/**
 * The registration gate: one config point that decides whether a new account may be created.
 *
 * ## Why a gate at all, and why here
 *
 * This is a hosted app for the owner's circle, not a public product — an open `POST /api/register`
 * on a box reachable from the internet is an open invitation to fill the database with strangers.
 * Lennert asked for invite-gated registration with a single switch that can flip to open later
 * (issue LBV-1480, "Product defaults"). So the whole policy lives in one place: this module reads
 * it from the environment once and the registration path asks the same `evaluate` the same way.
 * Flipping to open is one env var, not an edit to the endpoint.
 *
 * ## Why the code compare is constant-time
 *
 * The invite code is the only secret standing between a stranger and an account. Comparing it with
 * `===` would leak, through timing, how long a prefix a guess shares with the real code. It is
 * compared with `timingSafeEqual` over equal-length digests (SHA-256), the same shape
 * `server/auth.ts` uses for the shared token and for exactly the same reason.
 *
 * ## What this gate is not
 *
 * It gates *new accounts only*. An existing user signing in by password never touches this: they
 * already passed the gate the day they registered. The caller enforces that ordering
 * (`server/routes.ts`); this module only answers "may a brand-new account be created with this
 * code?".
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export type RegistrationMode = 'invite' | 'open' | 'closed';

/** The env var naming the mode, and the one carrying the invite code. */
export const REGISTRATION_MODE_ENV = 'GODMODE_REGISTRATION';
export const INVITE_CODE_ENV = 'GODMODE_INVITE_CODE';

export interface RegistrationGate {
  readonly mode: RegistrationMode;
  /** The SHA-256 digest of the invite code, or `undefined` when the mode needs none. */
  readonly inviteDigest: Buffer | undefined;
}

export interface GateDecision {
  readonly allowed: boolean;
  /** A machine code for the HTTP layer, present only when refused. */
  readonly reason?: 'registration_closed' | 'invite_required' | 'invite_invalid';
  readonly message?: string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Resolve the gate from the environment.
 *
 * The default is `invite`, the safe end of the range: a deployment that sets nothing gets a
 * closed door (invite mode with no code configured refuses every registration) rather than a
 * silently open one. Setting `open` is a deliberate act. An unrecognised mode is treated as
 * `closed` — a typo must never accidentally mean "let everyone in".
 */
export function resolveRegistrationGate(
  env: Readonly<Record<string, string | undefined>> = {},
): RegistrationGate {
  const raw = env[REGISTRATION_MODE_ENV]?.trim().toLowerCase();
  const code = env[INVITE_CODE_ENV]?.trim();
  const inviteDigest = code !== undefined && code !== '' ? digest(code) : undefined;

  let mode: RegistrationMode;
  if (raw === undefined || raw === '') mode = 'invite';
  else if (raw === 'open') mode = 'open';
  else if (raw === 'invite') mode = 'invite';
  else mode = 'closed';

  return { mode, inviteDigest };
}

/**
 * May a new account be created with the code the caller supplied?
 *
 * `open` accepts anyone. `closed` refuses everyone. `invite` requires a code that matches the one
 * configured — and if no code was configured, invite mode is a closed door, because a gate whose
 * key is the empty string is no gate.
 */
export function evaluate(gate: RegistrationGate, providedCode: string | undefined): GateDecision {
  if (gate.mode === 'open') return { allowed: true };
  if (gate.mode === 'closed') {
    return {
      allowed: false,
      reason: 'registration_closed',
      message: 'This server is not accepting new accounts.',
    };
  }

  // invite
  if (gate.inviteDigest === undefined) {
    return {
      allowed: false,
      reason: 'registration_closed',
      message: 'This server is not accepting new accounts.',
    };
  }
  const code = providedCode?.trim() ?? '';
  if (code === '') {
    return {
      allowed: false,
      reason: 'invite_required',
      message: 'An invite code is required to create an account.',
    };
  }
  const candidate = digest(code);
  // Both digests are 32 bytes, so `timingSafeEqual` compares rather than throws.
  if (!timingSafeEqual(candidate, gate.inviteDigest)) {
    return {
      allowed: false,
      reason: 'invite_invalid',
      message: 'That invite code is not correct.',
    };
  }
  return { allowed: true };
}
