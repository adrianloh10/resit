-- Anonymous abuse/cost guard. No personal data: just a per-device daily count.
-- Apply once after creating the D1 database (DEPLOY.md step 4):
--   wrangler d1 execute resit-quota --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS device_quota (
  device_id TEXT NOT NULL,
  day       TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, day)
);
