# ADR 0003 — Reconcile residual `google_sub` drift by making `schema.sql` truthful, not by dropping from prod

- Status: Accepted
- Date: 2026-08-03
- Context: LBV-1578 (pre-v3-deploy hardening gate), follow-up to LBV-1575 / ADR-0002
- Decider: CTO

## Situation

ADR-0002 forbids editing a shipped schema version's DDL in place without a version bump
+ migration. LBV-1567 (`ecee2be`, "retire Google OAuth") did exactly that: it removed the
`users.google_sub` column **and** its partial-unique index `idx_users_google_sub` from
`server/schema.sql` in place — no `SCHEMA_VERSION` bump, no migration — on the reasoning
"v2 schema is unshipped, no in-the-wild DB." That reasoning was false: production carried
a live v2 DB at `/var/lib/godmode/godmode.sqlite` (proven by LBV-1572).

DevOps ran a **read-only** audit of the production DB (LBV-1578, `sqlite3 -readonly`,
deployed commit `3e14609`, `meta.schema_version = 2`) and confirmed the deployed shape:

- **`users.google_sub`** — present: `google_sub TEXT NULL CHECK (google_sub IS NULL OR length(google_sub) > 0)`
- **`idx_users_google_sub`** — present: `CREATE UNIQUE INDEX ... ON users (google_sub) WHERE google_sub IS NOT NULL`
- Everything else matches current `schema.sql`. (The reported `settings.goal_text`
  ordering delta does **not** exist against current `main`: `schema.sql` already defines
  `goal_text` as the last `settings` column, matching prod.)

The v2→v3 additive migration only ADDs `goal_text` + `push_subscriptions`; it never
touches `google_sub`. So once v3 deploys, prod keeps `google_sub` while a fresh
`applySchema()` lacks it — **residual, permanent drift**. The LBV-1575 drift guard cannot
see it: it compares a fixture-migrated DB against fresh `applySchema()`, and the v2 fixture
was reverse-derived from the post-removal `schema.sql`, so **neither side carries
`google_sub`** — they agree with each other but not with reality.

## Decision

**Keep the column. Make `schema.sql` describe the deployed shape. Do NOT mutate prod.**

1. **Restore `users.google_sub` + `idx_users_google_sub` to `server/schema.sql`**, reverting
   the improper in-place LBV-1567 edit. This does not resurrect the Google OAuth code path
   (that removal stands); it only makes `schema.sql` a truthful description of every
   deployed and future DB. The column stays a nullable, unused artifact; the partial-unique
   index constrains only non-NULL values (all NULL post-pivot) — zero runtime cost.
2. **Update the frozen v2 fixture (`server/__fixtures__/schema-v2.sql`) to the real prod
   `sqlite_master`** captured by DevOps (add `google_sub` + its index). The v2 that shipped
   genuinely carried them — the fixture must model reality, not a reverse-derivation.
3. **No migration change.** `google_sub` is present in both the v2 fixture and fresh v3, so
   the additive v2→v3 migration neither adds nor drops it; the drift guard's equality now
   holds *and* reflects the deployed shape.

## Why keep, not drop

Dropping `google_sub` from prod (Option A) would require a destructive `DROP INDEX` +
`ALTER TABLE ... DROP COLUMN` migration — a **board-gated destructive op** on a
single-copy SQLite DB — for **zero runtime benefit** (the column is inert). All risk, no
reward. The correct source of truth to move is `schema.sql`, not the production data.

If retiring the column is ever wanted for hygiene, it must be a **future versioned
destructive migration (v3→v4), board-approved** per ADR-0002 and the destructive-ops rule —
never smuggled into this reconciliation.

## Consequences

- The drift guard becomes trustworthy against the actual deployed shape, closing the blind
  spot LBV-1578 identified. Recommended hardening: assert the v2 fixture carries
  `google_sub` (guard the guard), as the existing `goal_text` guards do.
- **v3-deploy gate:** v3 must not deploy until the `schema.sql` + fixture reconciliation
  (SE child of LBV-1578) is merged to `main` and CTO-reviewed. The deploy itself is a
  separate DevOps step.
- Lesson reinforced: "unshipped schema" claims must be checked against the box, not assumed
  from git timestamps (prod was built from a feature branch, so the repo could not answer).
