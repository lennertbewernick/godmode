# ADR 0002 — Additive schema changes require a version bump + migration (never edit a shipped schema in place)

- Status: Accepted
- Date: 2026-08-03
- Context: LBV-1572 (P0 — `POST /api/challenges` returned 500 for every user)

## Incident

After the multi-user v1→v2 fork went live, `POST /api/challenges` returned HTTP 500 for
every account. Validation passed; the write transaction aborted inside `selectChallenge`
→ `writeSettings` with:

```
Error: table settings has no column named goal_text
  code: 'ERR_SQLITE_ERROR'
```

The entire core flow was dead: no plan created → dashboard, history, settings and
reminders all fell back to the onboarding screen for all users.

## Root cause

`goal_text` (settings column) and the whole `push_subscriptions` table were added to
`server/schema.sql` in commit `30d480a` (2026-07-31 16:14, LBV-1481). The production
database had already been migrated v1→v2 **earlier the same day** (2026-07-31 14:03), by
a build whose `schema.sql` did not yet contain those objects.

`SCHEMA_VERSION` was **not** bumped (still `2`). Our migration mechanism only acts when
`on-disk version < SCHEMA_VERSION`, and `applySchema()` only runs against a *fresh* file.
So:

- **Fresh installs** (built after `30d480a`) get `goal_text` + `push_subscriptions` — fine.
- **Databases already at v2** (production, and any dev clone migrated before `30d480a`)
  never receive them — and the running code unconditionally writes them → 500.

This is schema drift: the code's expectation and an already-migrated DB diverged silently,
with no version to detect it and no migration to close it.

## Decision

1. **A schema version, once shipped, is immutable.** Any change to the columns or tables
   of an already-released `SCHEMA_VERSION` — even a purely additive one — requires:
   - bumping `SCHEMA_VERSION`, and
   - a migration from the previous version that brings an existing DB to the new shape,
   verified by `server/verify.ts` exactly as v1→v2 is.
2. **Additive-only changes may migrate in place** (guarded `ALTER TABLE ADD COLUMN` /
   `CREATE TABLE IF NOT EXISTS` + index), rather than the full read→rebuild→rename dance
   used for the tenancy change. A purely additive change carries no risk of the
   insert-order / FK hazards that motivated the rebuild path.
3. **CI must catch drift.** A test proves that a database produced by the migration chain
   has byte-identical schema (`sqlite_master`) to a fresh `applySchema()` database, so
   "column added to `schema.sql` without a migration" fails the build, not production.

## Immediate remediation (done, LBV-1572)

Production was hotfixed under a short maintenance window (service stopped → WAL
checkpointed → DB copied aside to `godmode.sqlite.pre-lbv1572-<stamp>.sqlite` → additive
DDL applied → restart). Applied, matching `schema.sql` exactly:

- `ALTER TABLE settings ADD COLUMN goal_text TEXT NULL CHECK (goal_text IS NULL OR length(goal_text) > 0)`
- `CREATE TABLE push_subscriptions (...) STRICT` + `idx_push_subscriptions_user`

Verified end-to-end over HTTPS: register → `POST /api/challenges` (`select: true`,
exercising the failing `writeSettings` path) → **HTTP 201** with snapshot, revision bumped
to 1; server log clean.

The hotfix is idempotent (checks existence before ALTER/CREATE). The durable version bump
(v2→v3) below must therefore also be idempotent for these two objects, because production
already carries them while still reporting version 2.

## Consequences

- The durable fix (LBV-1572 follow-up child) bumps `SCHEMA_VERSION` to 3 with an
  idempotent v2→v3 additive migration + the drift-detection test.
- No engineer edits a shipped schema version's DDL again without a migration. If you are
  tempted to "just add a column," you are bumping the version.
