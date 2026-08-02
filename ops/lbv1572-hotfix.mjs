import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/var/lib/godmode/godmode.sqlite");
const has = (t,c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
const tableExists = (t) => db.prepare("SELECT count(*) c FROM sqlite_master WHERE type=\x27table\x27 AND name=?").get(t).c > 0;
db.exec("BEGIN");
try {
  if (!has("settings","goal_text")) {
    db.exec("ALTER TABLE settings ADD COLUMN goal_text TEXT NULL CHECK (goal_text IS NULL OR length(goal_text) > 0)");
    console.log("added settings.goal_text");
  } else console.log("settings.goal_text already present");
  if (!tableExists("push_subscriptions")) {
    db.exec(`CREATE TABLE push_subscriptions (
      endpoint   TEXT NOT NULL PRIMARY KEY CHECK (length(endpoint) > 0),
      user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      p256dh     TEXT NOT NULL CHECK (length(p256dh) > 0),
      auth       TEXT NOT NULL CHECK (length(auth) > 0),
      created_at TEXT NOT NULL CHECK (created_at GLOB \x27[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*\x27)
    ) STRICT`);
    db.exec("CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id)");
    console.log("created push_subscriptions + index");
  } else console.log("push_subscriptions already present");
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); console.error("ROLLBACK:", e.message); process.exit(1); }
console.log("=== settings cols ===", db.prepare("PRAGMA table_info(settings)").all().map(r=>r.name).join(","));
console.log("=== push_subscriptions? ===", tableExists("push_subscriptions"));
db.close();
