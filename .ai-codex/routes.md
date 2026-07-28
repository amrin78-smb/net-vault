# NetVault API Routes

## admin
GET /api/admin/eol-coverage [auth] [db] — EOL inventory/seed coverage aggregates (super_admin)
POST /api/admin/eol-discrepancies/[id]/resolve [auth] [db] — resolve manual-vs-seed EOL date conflict
GET /api/admin/eol-discrepancies [auth] [db] — list pending EOL date discrepancies (super_admin)
POST /api/admin/eol-recommendations/[id]/resolve [auth] [db] — accept/ignore one status recommendation
POST /api/admin/eol-recommendations/bulk [auth] [db] — bulk accept/ignore status recommendations
GET /api/admin/eol-recommendations [auth] [db] — list pending EOL status recommendations (super_admin)
PUT /api/admin/eol-seed/[id] [auth] [db] — edit a seed catalog entry
DELETE /api/admin/eol-seed/[id] [auth] [db] — delete a seed catalog entry
GET /api/admin/eol-seed/preview [auth] [db] — preview device match count for vendor/model
POST /api/admin/eol-seed/purge-dateless [auth] [db] — purge dateless placeholder seed rows
GET /api/admin/eol-seed [auth] [db] — list/search/group EOL seed catalog (super_admin)
POST /api/admin/eol-seed [auth] [db] — add a seed catalog entry
POST /api/admin/eol-seed/sync [auth] [db,external] — pull central signed EOL feed into eol_seed

## agents (NocVault Agents Phase 2 — hub control plane)
GET /api/agents/install.ps1 [public] [none] — PowerShell agent installer, hub origin baked in (resolveOrigin); public (remote runs `irm` pre-credential)
GET /api/agents/bundle [public] [none] — agent bundle manifest {files:[]} walked from on-disk agent/ dir (excludes deps/state/keys/tests); 503 if unavailable; public
GET /api/agents/bundle/[...path] [public] [none] — serve ONE agent file's bytes; path-traversal confined to agent/ (403 escape, 404 missing/excluded); public
GET /api/agents/update-manifest [public] [none] — serve the committed, offline-signed self-update manifest {version,files:[{path,sha256}],sig} from agent/update-manifest.json; 503 if missing/unparseable (fresh install advertises no update); public (Phase 3 Workstream B)
POST /api/agents/enroll-tokens [auth] [db] — mint one-time enrollment token + install one-liner (super_admin)
POST /api/agents/enroll [public] [db] — token-authed (NO session): agent redeems token+host facts → agent_id, signed identity, module policy. Intentionally public write; NO checkWriteAllowed (token-gated infra)
POST /api/agents/[id]/heartbeat [agent-auth] [db] — agent-authed (requireAgentAuth, JWT sub must == [id]): liveness + health sample
POST /api/agents/[id]/refresh [agent-auth] [db] — agent-authed (sub must == [id]): re-issue identity from CURRENT enabled modules, bump last_seen_at, return {jwt,expires_at}; revoked agent → 401 (stop). Default TTL 7d
GET /api/agents/[id]/policy [agent-auth] [db] — agent-authed (sub must == [id]): module assignment + config + data-plane ingest URLs
GET /api/agents [auth] [db] — fleet list, agents+site+modules+latest buffer_depth, derived status (super_admin)
GET /api/agents/[id] [auth] [db] — agent detail + last ~20 health rows (super_admin)
PATCH /api/agents/[id] [auth] [db] — update name/site_id + upsert/toggle modules (super_admin)
POST /api/agents/[id]/revoke [auth] [db] — set revoked_at, status='revoked' (super_admin); then best-effort fans out an active-kick to each covered app's data plane (Phase 3: SpanVault only, POST 127.0.0.1:3009/api/internal/agents/disconnect, non-fatal) so a LIVE session drops now, not just on next connect

## audit
GET /api/audit/device/[id] [auth] [db] — device audit log, site-scoped
GET /api/audit [auth] [db] — recent-activity feed (?limit=) or full paginated audit log (admin)

## auth
GET /api/auth/[...nextauth] [public] [db] — NextAuth credentials login/session handler
POST /api/auth/[...nextauth] [public] [db] — NextAuth credentials login/session handler
POST /api/auth/sso-verify [public] [db] — verify a sibling-app SSO JWT, confirm user exists

## circuits
GET /api/circuits/[id] [auth] [db] — get circuit by id, site-scoped
PUT /api/circuits/[id] [auth] [db] — update circuit (admin+)
DELETE /api/circuits/[id] [auth] [db] — delete circuit (admin+)
GET /api/circuits [auth] [db] — list/filter circuits, site-scoped
POST /api/circuits [auth] [db] — create circuit

## compliance
GET /api/compliance [auth] [db] — compute fleet compliance score

## countries
GET /api/countries [auth] [db] — list countries with region

## dashboard
GET /api/dashboard/devices-by-region [auth] [db] — device totals bucketed by region
GET /api/dashboard/devices-by-type [auth] [db] — top device types by count
GET /api/dashboard/fleet-health [auth] [db] — fleet health donut segments
GET /api/dashboard/overview [auth] [db] — health score overview + 30-day trend
GET /api/dashboard/recent-activity [auth] [db] — recent audit activity, formatted feed
GET /api/dashboard [auth] [db] — full dashboard summary bundle (all widgets)
GET /api/dashboard/stats-row [auth] [db] — top KPI stat row counts
GET /api/dashboard/top-eol-sites [auth] [db] — top 5 sites by EOL device count

## devices
GET /api/devices/[id] [auth] [db] — get device detail, site-scoped
PUT /api/devices/[id] [auth] [db] — update device + write audit_log
DELETE /api/devices/[id] [auth] [db] — delete device, cascades EOL rows + audit_log
PUT /api/devices/bulk [auth] [db] — bulk-update one field across devices + audit_log
GET /api/devices/duplicates [auth] [db] — find duplicate-IP/serial devices with classification
GET /api/devices [auth] [db] — list/filter/paginate devices, site-scoped
POST /api/devices [auth] [db] — create device

## export
GET /api/export [auth] [db] — CSV export of device inventory (PowerBI columns)

## health
GET /api/health [public] [none] — liveness + version check

## hub
GET /api/hub/alerts [auth] [db] — cross-app correlated alerts (EOL/monitoring/security/IPAM)
GET /api/hub/asset360 [auth] [db] — one device's full story across all 4 suite apps
GET /api/hub/kpis [auth] [db] — suite-wide KPI rollup (fleet/availability/logs/IPAM/alerts)
GET /api/hub/search [auth] [db] — unified suite search by IP/hostname/name across 4 apps

## import
POST /api/import/preview [auth] [none] — preview parsed device import file (first 5 rows)
POST /api/import [auth] [db] — bulk import/upsert devices from CSV/XLSX

## license
GET /api/license [public] [db] — license/trial status, server ID, entitled modules
POST /api/license [auth] [db] — activate a license key (super_admin)

## lookup
GET /api/lookup [auth] [db] — filter option lists (regions/sites/types/brands/vendors)

## netvault-stats
GET /api/netvault-stats [public] [db] — public device/site/EOL counts widget

## search
GET /api/search [auth] [db] — global search across devices/sites/circuits

## server-stats
GET /api/server-stats [auth] [none] — live OS server metrics (disk/CPU/mem/uptime)

## settings
POST /api/settings/logo [auth] [db] — upload branding logo (super_admin)
GET /api/settings [public] [db] — get app settings, redacts secrets for non-admin
PUT /api/settings [auth] [db] — update app settings (admin; branding is super_admin-only)

## sites
GET /api/sites/[id] [auth] [db] — site detail + its devices, site-scoped
PUT /api/sites/[id] [auth] [db] — update site (admin+)
POST /api/sites/import/preview [auth] [db] — preview sites-import plan (create/fill/skip)
POST /api/sites/import [auth] [db] — transactional sites import (create + fill-empty-only)
GET /api/sites/import/template [auth] [none] — download XLSX sites-import template
POST /api/sites/manage [auth] [db] — create site (admin+)
PATCH /api/sites/manage [auth] [db] — update site status, blocks decommission w/ active devices
DELETE /api/sites/manage [auth] [db] — delete site (super_admin), blocked if devices/circuits exist
GET /api/sites [auth] [db] — list sites with device/EOL/circuit counts

## sso
GET /api/sso/ddivault [auth] [db] — mint SSO JWT, redirect to DDIVault
GET /api/sso/logvault [auth] [db] — mint SSO JWT, redirect to LogVault
GET /api/sso/spanvault [auth] [db] — mint SSO JWT, redirect to SpanVault

## suite
GET /api/suite/health [public] [external] — aggregate sibling apps' /api/health (cached 20s)
GET /api/suite/stats [public] [external] — aggregate sibling apps' /api/stats (cached 20s)

## system
GET /api/system/enrich-eol/latest [auth] [db] — most recent completed EOL enrichment job summary
POST /api/system/enrich-eol [auth] [db] — start EOL enrichment background job (cron or super_admin)
GET /api/system/enrich-eol/status [auth] [db] — poll an EOL enrichment job's live progress
POST /api/system/health-snapshot [auth] [db] — cron: snapshot + persist fleet health score
POST /api/system/sync-eol [auth] [db,external] — cron: weekly pull of central EOL feed
GET /api/system/update-status [auth] [external] — check origin/main for a newer git commit (any session; gated 2026-07-24, was public)
GET /api/system/last-update-status [auth] — reads logs\last-update-status.json written by Update-NetVault.ps1 (stage/error code/rollback outcome/schemaAppliedButRolledBack of the last update run); {exists:false} if none yet (admin+; gated 2026-07-24, was public)
POST /api/system/update [auth] [db] — schedule self-update task (admin+); 409 if Update-NetVault.ps1's update.lock shows another run still in progress

## users
PUT /api/users/[id] [auth] [db] — update user: role/sites/app-access (admin+)
DELETE /api/users/[id] [auth] [db] — delete user (super_admin)
PUT /api/users/me [auth] [db] — change own password
GET /api/users [auth] [db] — list users with sites + app access (admin+)
POST /api/users [auth] [db] — create user (admin+)

## Needs force-dynamic
GET /api/admin/eol-coverage — missing force-dynamic
POST /api/admin/eol-discrepancies/[id]/resolve — missing force-dynamic
GET /api/admin/eol-discrepancies — missing force-dynamic
POST /api/admin/eol-recommendations/[id]/resolve — missing force-dynamic
POST /api/admin/eol-recommendations/bulk — missing force-dynamic
GET /api/admin/eol-recommendations — missing force-dynamic
PUT /api/admin/eol-seed/[id] — missing force-dynamic
DELETE /api/admin/eol-seed/[id] — missing force-dynamic
GET /api/admin/eol-seed/preview — missing force-dynamic
POST /api/admin/eol-seed/purge-dateless — missing force-dynamic
GET /api/admin/eol-seed — missing force-dynamic
POST /api/admin/eol-seed — missing force-dynamic
GET /api/audit/device/[id] — missing force-dynamic
GET /api/audit — missing force-dynamic
GET /api/auth/[...nextauth] — missing force-dynamic
POST /api/auth/[...nextauth] — missing force-dynamic
POST /api/auth/sso-verify — missing force-dynamic
GET /api/circuits/[id] — missing force-dynamic
PUT /api/circuits/[id] — missing force-dynamic
DELETE /api/circuits/[id] — missing force-dynamic
GET /api/circuits — missing force-dynamic
POST /api/circuits — missing force-dynamic
GET /api/compliance — missing force-dynamic
GET /api/countries — missing force-dynamic
GET /api/dashboard/devices-by-region — missing force-dynamic
GET /api/dashboard/devices-by-type — missing force-dynamic
GET /api/dashboard/fleet-health — missing force-dynamic
GET /api/dashboard/overview — missing force-dynamic
GET /api/dashboard/recent-activity — missing force-dynamic
GET /api/dashboard — missing force-dynamic
GET /api/dashboard/stats-row — missing force-dynamic
GET /api/dashboard/top-eol-sites — missing force-dynamic
GET /api/devices/[id] — missing force-dynamic
PUT /api/devices/[id] — missing force-dynamic
DELETE /api/devices/[id] — missing force-dynamic
PUT /api/devices/bulk — missing force-dynamic
GET /api/devices/duplicates — missing force-dynamic
GET /api/devices — missing force-dynamic
POST /api/devices — missing force-dynamic
GET /api/export — missing force-dynamic
POST /api/import — missing force-dynamic
GET /api/license — missing force-dynamic
POST /api/license — missing force-dynamic
GET /api/lookup — missing force-dynamic
GET /api/netvault-stats — missing force-dynamic
GET /api/search — missing force-dynamic
POST /api/settings/logo — missing force-dynamic
GET /api/settings — missing force-dynamic
PUT /api/settings — missing force-dynamic
GET /api/sites/[id] — missing force-dynamic
PUT /api/sites/[id] — missing force-dynamic
POST /api/sites/import/preview — missing force-dynamic
POST /api/sites/import — missing force-dynamic
POST /api/sites/manage — missing force-dynamic
PATCH /api/sites/manage — missing force-dynamic
DELETE /api/sites/manage — missing force-dynamic
GET /api/sites — missing force-dynamic
GET /api/sso/ddivault — missing force-dynamic
GET /api/sso/logvault — missing force-dynamic
GET /api/sso/spanvault — missing force-dynamic
GET /api/system/enrich-eol/latest — missing force-dynamic
POST /api/system/enrich-eol — missing force-dynamic
GET /api/system/enrich-eol/status — missing force-dynamic
POST /api/system/health-snapshot — missing force-dynamic
POST /api/system/sync-eol — missing force-dynamic
POST /api/system/update — missing force-dynamic
PUT /api/users/[id] — missing force-dynamic
DELETE /api/users/[id] — missing force-dynamic
PUT /api/users/me — missing force-dynamic
GET /api/users — missing force-dynamic
POST /api/users — missing force-dynamic
