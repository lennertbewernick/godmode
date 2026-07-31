// @vitest-environment node
//
// The push-subscription store, against a real in-memory `node:sqlite` database. What matters here
// is the tenancy boundary and the upsert semantics — properties of the SQL, not of a stub — so the
// tests drive the real schema with two real users.

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applySchema } from './schema.js';
import { ensureBootstrapUser, registerUser, BOOTSTRAP_USER_ID } from './users.js';
import { listSubscriptions, removeSubscription, storeSubscription } from './push.js';

const NOW = '2026-07-31T12:00:00.000Z';

function open(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  ensureBootstrapUser(db);
  return db;
}

const SUB = { endpoint: 'https://push.example.com/a', p256dh: 'BkeyA', auth: 'authA' };

describe('push subscription store', () => {
  it('stores and lists a subscription for its owner', () => {
    const db = open();
    storeSubscription(db, BOOTSTRAP_USER_ID, SUB, NOW);
    expect(listSubscriptions(db, BOOTSTRAP_USER_ID)).toEqual([SUB]);
  });

  it('replaces the row for a repeated endpoint rather than duplicating it', () => {
    const db = open();
    storeSubscription(db, BOOTSTRAP_USER_ID, SUB, NOW);
    const rotated = { ...SUB, p256dh: 'BkeyRotated', auth: 'authRotated' };
    storeSubscription(db, BOOTSTRAP_USER_ID, rotated, '2026-07-31T13:00:00.000Z');
    expect(listSubscriptions(db, BOOTSTRAP_USER_ID)).toEqual([rotated]);
  });

  it('moves an endpoint to a new owner when it is re-granted under another account', () => {
    const db = open();
    const other = registerUser(db, {
      email: 'other@godmode.local',
      displayName: 'Other',
      now: NOW,
    });
    storeSubscription(db, BOOTSTRAP_USER_ID, SUB, NOW);
    // Same endpoint (a shared device), now signed in as someone else.
    storeSubscription(db, other.id, SUB, '2026-07-31T13:00:00.000Z');
    expect(listSubscriptions(db, BOOTSTRAP_USER_ID)).toEqual([]);
    expect(listSubscriptions(db, other.id)).toEqual([SUB]);
  });

  it('scopes a removal to its owner: one user cannot drop another’s subscription', () => {
    const db = open();
    const other = registerUser(db, {
      email: 'other@godmode.local',
      displayName: 'Other',
      now: NOW,
    });
    storeSubscription(db, other.id, SUB, NOW);
    // The owner naming the other user's endpoint removes nothing.
    expect(removeSubscription(db, BOOTSTRAP_USER_ID, SUB.endpoint)).toBe(0);
    expect(listSubscriptions(db, other.id)).toEqual([SUB]);
    // The real owner removes it.
    expect(removeSubscription(db, other.id, SUB.endpoint)).toBe(1);
    expect(listSubscriptions(db, other.id)).toEqual([]);
  });

  it('drops a user’s subscriptions when the user is deleted (ON DELETE CASCADE)', () => {
    const db = open();
    const other = registerUser(db, {
      email: 'other@godmode.local',
      displayName: 'Other',
      now: NOW,
    });
    storeSubscription(db, other.id, SUB, NOW);
    db.prepare('DELETE FROM users WHERE id = ?').run(other.id);
    expect(listSubscriptions(db, other.id)).toEqual([]);
  });
});
