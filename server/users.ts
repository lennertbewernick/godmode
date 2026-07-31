/**
 * The `users` table, and the bootstrap owner every existing install already has.
 *
 * ## Why `user_id` is not a domain field
 *
 * The record types in `src/db/schema.ts` — `WorkoutRecord`, `ChallengeRecord`, … — are shared
 * with the local-first IndexedDB client and the backup/export format. They carry no `userId` and
 * must not: adding one would change the shape the client writes, the JSON a backup contains, and
 * the field maps that guard both. So tenancy lives entirely in the server layer. `user_id` is a
 * column the server injects on write and filters on read (`server/db.ts`, `server/routes.ts`); a
 * workout is the same workout whoever owns it. This module owns the one table that *is* about
 * people rather than training.
 *
 * ## The bootstrap owner
 *
 * Until the auth ticket (registration / login / SSO) lands, there is exactly one real person: the
 * owner whose single-tenant history this fork was built from. Every existing install and every
 * fresh database is seeded with one `users` row — the bootstrap owner — and the token exchange in
 * `server/routes.ts` mints sessions for them. The v1 → v2 migration carries the owner's whole
 * dataset onto this row (`server/migrate-schema.ts`). The auth ticket sits on top: it adds more
 * users and real credentials; this ticket only needs the table to exist and every per-user query
 * to be scoped by it.
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The owner's fixed id.
 *
 * A stable, known id rather than a random UUID, because in the single-user phase it is referenced
 * by the migration, by the fresh-database seed and by the tests, and a value they must all agree
 * on is better named once than generated and threaded. The auth ticket can rename the row's email
 * and credentials; the id stays, so the owner's history never has to be re-parented.
 */
export const BOOTSTRAP_USER_ID = 'usr_owner';

/** Env overrides for the owner's identity, so a deployment can name the real person. */
export const OWNER_EMAIL_ENV = 'GODMODE_OWNER_EMAIL';
export const OWNER_NAME_ENV = 'GODMODE_OWNER_NAME';

const DEFAULT_OWNER_EMAIL = 'owner@godmode.local';
const DEFAULT_OWNER_NAME = 'Owner';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** Nullable until the auth ticket sets it. Present for password sign-in. */
  readonly passwordHash?: string;
  /** Nullable and unique-when-present. Present for Google SSO. */
  readonly googleSub?: string;
  readonly createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  google_sub: string | null;
  created_at: string;
}

function decodeUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    ...(row.password_hash === null ? {} : { passwordHash: row.password_hash }),
    ...(row.google_sub === null ? {} : { googleSub: row.google_sub }),
    createdAt: row.created_at,
  };
}

/**
 * A fresh, opaque user id.
 *
 * `usr_` + 96 bits of base64url. Random rather than sequential so an id reveals neither how many
 * users exist nor the order they joined in, and prefixed so it is recognisable in a log line as a
 * user id and not a session or a record id. The owner keeps the fixed `usr_owner`
 * (`BOOTSTRAP_USER_ID`); every account the auth ticket creates gets one of these.
 */
export function generateUserId(): string {
  return `usr_${randomBytes(12).toString('base64url')}`;
}

/** Insert one user. Plain INSERT — a duplicate id, email or google_sub is a caller error. */
export function createUser(db: DatabaseSync, user: UserRecord): void {
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, google_sub, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    user.id,
    user.email,
    user.displayName,
    user.passwordHash ?? null,
    user.googleSub ?? null,
    user.createdAt,
  );
}

export function findUserById(db: DatabaseSync, id: string): UserRecord | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row === undefined ? undefined : decodeUser(row);
}

/** Case-insensitive, matching `idx_users_email` on `lower(email)`. */
export function findUserByEmail(db: DatabaseSync, email: string): UserRecord | undefined {
  const row = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email) as
    | UserRow
    | undefined;
  return row === undefined ? undefined : decodeUser(row);
}

export function findUserByGoogleSub(db: DatabaseSync, googleSub: string): UserRecord | undefined {
  const row = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub) as
    | UserRow
    | undefined;
  return row === undefined ? undefined : decodeUser(row);
}

export function countUsers(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}

export interface BootstrapOwnerOptions {
  readonly email?: string;
  readonly displayName?: string;
  readonly now?: string;
}

/** The owner's identity, resolved from env with sane defaults. */
export function resolveOwner(
  env: Readonly<Record<string, string | undefined>> = {},
  now: string = new Date().toISOString(),
): UserRecord {
  const email = env[OWNER_EMAIL_ENV]?.trim();
  const name = env[OWNER_NAME_ENV]?.trim();
  return {
    id: BOOTSTRAP_USER_ID,
    email: email !== undefined && email !== '' ? email : DEFAULT_OWNER_EMAIL,
    displayName: name !== undefined && name !== '' ? name : DEFAULT_OWNER_NAME,
    createdAt: now,
  };
}

/**
 * Create the bootstrap owner and their revision row if they are not already there.
 *
 * Idempotent: a database opened twice, or a fresh one whose seed already ran, is left alone. Both
 * rows are created together — a user with no `user_revisions` row would have no revision counter,
 * and the first `bumpRevision` for them would have nothing to update.
 */
export function ensureBootstrapUser(
  db: DatabaseSync,
  options: BootstrapOwnerOptions = {},
): UserRecord {
  const existing = findUserById(db, BOOTSTRAP_USER_ID);
  if (existing !== undefined) return existing;

  const now = options.now ?? new Date().toISOString();
  const owner: UserRecord = {
    id: BOOTSTRAP_USER_ID,
    email: options.email ?? DEFAULT_OWNER_EMAIL,
    displayName: options.displayName ?? DEFAULT_OWNER_NAME,
    createdAt: now,
  };
  createUser(db, owner);
  db.prepare('INSERT INTO user_revisions (user_id, revision, updated_at) VALUES (?, 0, ?)').run(
    owner.id,
    now,
  );
  return owner;
}

export interface NewUser {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash?: string;
  readonly googleSub?: string;
  readonly now?: string;
}

/**
 * Create a real account and everything a per-user tenant needs to exist.
 *
 * A user with no `user_revisions` row would have no revision counter, and their first write would
 * have nothing to bump (`server/db.ts:bumpRevision`), so the two rows are created together in one
 * transaction — the same pairing `ensureBootstrapUser` makes for the owner. The id is generated
 * here, not supplied, so a caller can never collide with the owner's fixed id or another user's.
 *
 * A duplicate email or `google_sub` raises SQLite's `UNIQUE` constraint from `createUser`; the
 * caller turns that into the right HTTP answer rather than this module guessing at one.
 */
export function registerUser(db: DatabaseSync, user: NewUser): UserRecord {
  const now = user.now ?? new Date().toISOString();
  const record: UserRecord = {
    id: generateUserId(),
    email: user.email,
    displayName: user.displayName,
    ...(user.passwordHash === undefined ? {} : { passwordHash: user.passwordHash }),
    ...(user.googleSub === undefined ? {} : { googleSub: user.googleSub }),
    createdAt: now,
  };
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    createUser(db, record);
    db.prepare('INSERT INTO user_revisions (user_id, revision, updated_at) VALUES (?, 0, ?)').run(
      record.id,
      now,
    );
    db.prepare('COMMIT').run();
  } catch (cause) {
    db.prepare('ROLLBACK').run();
    throw cause;
  }
  return record;
}

/**
 * Link a Google identity to an account that already exists.
 *
 * Used when someone who first registered by password later signs in with a Google account of the
 * same email: rather than a second, duplicate account, the `google_sub` is attached to the one
 * they have, so both methods reach the same training history. Scoped by `id`; the caller has
 * already established that the row is the right one.
 */
export function attachGoogleSub(db: DatabaseSync, id: string, googleSub: string): void {
  db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(googleSub, id);
}
