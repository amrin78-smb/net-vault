-- ============================================================================
-- One-time MANUAL data cleanup — remove a redundant brand baked into devices.model
-- ============================================================================
-- Some imported devices stored the brand INSIDE the model field, e.g.
--   brand = "Cisco", model = "Cisco SW 500"   →  renders as "Cisco Cisco SW 500"
--   brand = "Aruba", model = "Aruba 505"      →  renders as "Aruba Aruba 505"
-- This strips the leading brand word (and a following "Networking" for the full
-- "Aruba Networking" vendor name) so model holds only the model designation.
-- Product lines are preserved (Catalyst, Aironet, Instant On, NGFW, MSM, ...).
--
-- SAFE:  idempotent, transactional, backs up old values first (revert below).
-- SCOPE: ~1,549 rows across ~20 brands (run the PREVIEW to confirm on your data).
-- NOTE:  NOT part of a fresh install / not auto-run by the updater. Run ONCE,
--        manually, as netvault_user (or postgres). EOL matching is unaffected —
--        the matcher normalizes the brand out of the model anyway.
-- Matches lib/model.ts stripBrandFromModel() (import-time strip). Keep them in sync.
--
-- Run (on the server):
--   $env:PGPASSWORD="<netvault_user pass>"
--   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U netvault_user -h localhost -d netvault -f scripts\cleanup-brand-in-model.sql
-- ============================================================================

-- 0) PREVIEW — review before/after; nothing is changed by this SELECT.
SELECT b.name AS brand,
       d.model AS old_model,
       regexp_replace(btrim(substring(d.model FROM length(b.name) + 1)),
                      '^[Nn]etworking[[:space:]]+', '') AS new_model,
       count(*) AS devices
FROM devices d JOIN brands b ON b.id = d.brand_id
WHERE d.model IS NOT NULL AND b.name IS NOT NULL
  AND lower(d.model) LIKE lower(b.name) || ' %'
  AND length(btrim(substring(d.model FROM length(b.name) + 1))) > 0
GROUP BY b.name, d.model
ORDER BY b.name, devices DESC;

-- 1) APPLY — backup → update → verify, all in one transaction.
BEGIN;

-- Back up EVERY device's current model so a revert is trivial (see step 2).
DROP TABLE IF EXISTS devices_model_backup;
CREATE TABLE devices_model_backup AS
  SELECT id, model AS old_model, now() AS backed_up_at FROM devices;

WITH cleaned AS (
  SELECT d.id,
         regexp_replace(btrim(substring(d.model FROM length(b.name) + 1)),
                        '^[Nn]etworking[[:space:]]+', '') AS new_model
  FROM devices d JOIN brands b ON b.id = d.brand_id
  WHERE d.model IS NOT NULL AND b.name IS NOT NULL
    AND lower(d.model) LIKE lower(b.name) || ' %'
    AND length(btrim(substring(d.model FROM length(b.name) + 1))) > 0
)
UPDATE devices d
SET model = c.new_model
FROM cleaned c
WHERE d.id = c.id AND d.model <> c.new_model;

-- VERIFY — expect 0 rows still carrying the brand as a prefix.
SELECT count(*) AS remaining_brand_in_model
FROM devices d JOIN brands b ON b.id = d.brand_id
WHERE lower(d.model) LIKE lower(b.name) || ' %';

-- If the update count (~1549) and remaining (0) look right:
COMMIT;
-- otherwise:  ROLLBACK;

-- ============================================================================
-- 2) REVERT (only if needed, AFTER commit) — restore the pre-cleanup models:
--   UPDATE devices d SET model = k.old_model
--   FROM devices_model_backup k WHERE k.id = d.id AND d.model <> k.old_model;
--   DROP TABLE devices_model_backup;
-- ============================================================================
