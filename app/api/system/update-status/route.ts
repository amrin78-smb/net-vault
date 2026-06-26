import { NextResponse } from 'next/server'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import pkg from '../../../../package.json'

export const dynamic = 'force-dynamic'

const REPO = 'amrin78-smb/net-vault'
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main/`
const COMMITS_API = `https://api.github.com/repos/${REPO}/commits/main`

function findGitRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

// Short git commit hash for the deployed checkout, or null if git is
// unavailable (e.g. a non-git on-prem deploy). Update detection degrades
// gracefully to "up to date" when this is null.
function localCommitHash(repoRoot: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 })
      .trim().slice(0, 7)
  } catch {
    return null
  }
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// Fetch the latest commit SHA on GitHub's main branch via the commits API.
// Returns the first 7 chars, or null on any failure.
async function remoteCommitHash(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(COMMITS_API, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const commit = await res.json()
    return commit && commit.sha ? String(commit.sha).slice(0, 7) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Hardcoded structured release notes, keyed by version. When bumping the
// version, add a matching entry with 3-5 bullets. There is no CHANGELOG.md —
// release notes live here only.
const releaseNotes: Record<string, string[]> = {
  '1.19.6': [
    'Fresh-install fix: the devices table now defines support_vendor_id inline, so the v_devices_flat view (which joins the support vendor) builds successfully on a clean database. Previously the column was only added by a later ALTER, so on a fresh install the view — and its GRANT — failed, breaking device lists, dashboard, search, export, compliance and health scoring until patched',
  ],
  '1.19.5': [
    'Security: the two EOL enrichment status endpoints (latest job + job status) now require the EOL license module, closing an unlicensed-read gap that let an authenticated user on a lapsed install read stale enrichment-job data (device model names)',
  ],
  '1.19.4': [
    'Dark mode: swept the remaining hardcoded light colors on the Sites page — the per-site risk badges (High/Medium/Low) and the per-site Total/Active/EOL/Decommed stat numbers now use the adaptive theme tokens, so they stay readable in dark mode. The site-card hover border also uses the brand token now',
  ],
  '1.19.3': [
    'Dashboard: the KPI cards (Total Devices, Total Sites, WAN Circuits, Main Links, ISP Providers) are now more compact — the icon sits inline on the same row as the number instead of stacked above it, reducing card height',
    'Dark mode: fixed the top KPI cards on the Sites page (Total Sites / Total Devices / EOL Devices) and the Devices page (Total / Active / EOL-EOS / Decommed) that kept light backgrounds in dark mode — they now use the adaptive theme tokens and flip correctly',
  ],
  '1.19.2': [
    'Dashboard: removed the non-functional "Custom View" button — dashboard customization is not available yet, so the placeholder control has been taken out',
  ],
  '1.19.1': [
    'Settings → License: fixed the "Copy" button next to Your Server ID, which did nothing when the app is served over HTTP (the browser clipboard API is unavailable in that context). It now falls back to a reliable copy and shows a "Server ID copied" confirmation toast',
  ],
  '1.19.0': [
    'Launcher tiles are now license-aware: any suite app (LogVault, DDIVault, SpanVault) whose module is not included in your active license key is greyed out and blurred, with its "Open" button replaced by a non-clickable "Not licensed" state and a "contact sales@nocvault.com" prompt',
    'Gating is lenient and never locks you out by mistake — a tile is only marked unlicensed when there is an active license that explicitly lists modules and omits that app. Trial, grace, expired, empty-module, or unreachable-license states leave every tile open as before',
    'The NetVault host tile is always available and never greyed',
    'The Suite Health Overview pills mirror the same state, showing "Not licensed" for any app missing from an explicit active license',
    'Display-only change — no routing or SSO logic changed beyond disabling the open action for unlicensed tiles',
  ],
  '1.18.0': [
    'EOL Intelligence is now a licensed add-on module. On installs whose license does not include the "eol" module, the EOL Intelligence page is locked (shows an upsell with your Server ID), the feed sync and enrichment no longer run (the scheduled tasks no-op), and all EOL admin/system endpoints return 403',
    'Gating is access-control only — NO data is changed or deleted. Your seed catalog, the EOL dates already on devices, and recommendations are all left intact. Activating a license that includes the "eol" module immediately restores full access with all data in place',
    'This establishes reusable per-module license enforcement (the "eol" module is the first); the License page already lists your entitled modules',
  ],
  '1.17.1': [
    'EOL Intelligence: hardened the feed sync. The whole sync now runs in a single database transaction, so a crash mid-sync can no longer leave the seed catalog half-updated (it rolls back instead)',
    'EOL Intelligence: fixed a latent bug where collapsing duplicate seed entries during a sync could fail with a foreign-key error (and abort every subsequent sync) when a device recommendation referenced the merged-away entry — the sync now repoints those references correctly',
    'EOL Intelligence: the feed download now has a 15-second timeout, so an unreachable or slow feed host no longer hangs the weekly sync; it is treated the same as offline',
    'EOL Intelligence: after a manual "Sync from EOL feed", the confirmation now reminds you to run enrichment to apply the updated catalog to devices',
    'EOL Intelligence: added a guard so a model that normalizes to an empty key can never be written to the seed catalog',
  ],
  '1.17.0': [
    'EOL Intelligence: the EOL feed now syncs automatically every week (Sunday) — new vendor end-of-life dates published centrally now reach this install on their own, with no need to click "Sync from EOL feed." The weekly sync runs just ahead of the nightly enrichment, so refreshed dates are applied to devices that same night',
    'EOL Intelligence: the weekly sync verifies the feed signature before writing and only touches the seed catalog (never device records); offline/air-gapped installs simply skip it and keep using the bundled baseline',
    'The manual "Sync from EOL feed" and "Run enrichment now" buttons remain for on-demand use',
  ],
  '1.16.0': [
    'EOL Intelligence: the bundled offline EOL baseline now ships 949 vendor-confirmed models (910 with dates, 40 confirmed-retired) — up from ~32 — regenerated from the central NocVault EOL feed. A fresh or air-gapped install now starts with near-full EOL coverage even before the first "Sync from EOL feed"',
    'EOL Intelligence: the bundled seed now carries each model\'s vendor and lifecycle flag, so the offline baseline matches devices using the exact same keys as the online feed — including vendors the old derivation missed (Brocade, Asus, Linksys, TOTOLINK, and others)',
    'EOL Intelligence: added scripts/gen-eol-seed.cjs to regenerate the bundled seed from the central feed, keeping the offline floor and the live feed in step',
  ],
  '1.15.2': [
    'Updater: the update script now polls the health endpoint after restart instead of waiting a fixed delay, so it continues as soon as the app is actually serving (typically a few seconds sooner)',
    'Updater: removed the synchronous baseline health-snapshot and full EOL-enrichment run that fired during every update — both still run on their daily scheduled tasks, and EOL enrichment can be triggered on demand via the "Run enrichment now" button on the EOL Intelligence page. This shortens the update and avoids loading the freshly-restarted server with a ~2,500-device scan mid-deploy',
  ],
  '1.15.1': [
    'EOL Intelligence: fixed a page crash ("Cannot read properties of null") that occurred once a "should be EOL" recommendation came from a lifecycle=EOL seed entry with no published date — the days-remaining cell now shows "no date" instead of trying to format a null value',
  ],
  '1.15.0': [
    'EOL Intelligence: the EOL feed can now carry a "lifecycle: EOL" flag for models a vendor has confirmed retired/obsolete but for which no concrete End-of-Support date is published — so these are tracked as EOL without inventing a date',
    'EOL Intelligence: when a device matches such a flagged model, enrichment raises a normal (human-gated) "should be EOL" status recommendation reasoned "vendor-confirmed end-of-life (no published EOL date)" — review and accept it like any other',
    'EOL Intelligence: latest feed adds 34 newly-dated legacy models and 39 confirmed-retired-no-date models from the full EOL audit (sync from the feed, then run enrichment to apply)',
  ],
  '1.14.1': [
    'EOL Intelligence: fixed a matcher bug where a dateless "Add all to seed" placeholder could shadow a dated curated entry — a device whose model exactly matched the placeholder stayed undated even though the real EOL date existed on an entry carrying that model as an alias. The exact and alias tiers are now considered together and the dated entry always wins (re-run enrichment to pick up ~24+ previously-shadowed devices, e.g. WS-C2960X, A5120 EI, SG350-52, Catalyst 3850, Cisco 2504)',
  ],
  '1.14.0': [
    'EOL Intelligence: the model matcher is now flexible to product-line naming differences — an inventory "Cisco 3750x" now matches a seed "Catalyst 3750-X", and "Palo Alto NGFW PA-440" matches "PA-440". It strips curated product-line noise words (Catalyst, NGFW, FlexNetwork, ProCurve, Series, …) and common Cisco PID prefixes (WS-C, AIR-AP), while preserving model-defining lines (SonicWave, AirEngine)',
    'EOL Intelligence: "Sync from EOL feed" now self-heals — it recomputes the seed keys with the current normalizer and collapses any duplicate models before applying the feed, so matching stays consistent after a matcher upgrade',
    'EOL Intelligence: re-run enrichment after syncing to pick up the wider matches — more devices will now match the curated EOL dates despite messy inventory model spellings',
  ],
  '1.13.0': [
    'EOL Intelligence: new "Sync from EOL feed" button pulls the centralized NocVault EOL feed (800+ vendor-confirmed models) into the local seed catalog — no more waiting for an app update to get new EOL dates',
    'EOL Intelligence: the feed is cryptographically verified (Ed25519 signature + sha256) before anything is written, so a tampered or corrupt feed is rejected',
    'EOL Intelligence: the sync updates ONLY the EOL seed catalog (added_by="feed") — it never touches device records; device EOL dates are still filled by the separate enrichment step, and the bundled seed remains the offline fallback',
  ],
  '1.12.1': [
    'Site detail: the five summary KPI cards (Total devices, Active, EOL / EOS, Decommed, Circuits) now use theme tokens instead of hardcoded pastel colors, so they render correctly in dark mode instead of staying light-on-dark',
    'Site detail: replaced the tall "By device type" sidebar — which stretched to the full height of the device table and left a large empty box — with a compact full-width strip of clickable type cards (count, share %, EOL badge, mini bar) above a now full-width device table',
    'Site detail: cleaned up remaining hardcoded colors on the page (device-type bar fill, bulk-action bar, circuit group labels) so they adapt to the active theme',
  ],
  '1.12.0': [
    'EOL Intelligence: added vendor-confirmed end-of-support dates for SonicWall SonicPoint-Ne (2020-10-01), SonicWave 432e (2027-04-23) and NSA 3650 (2026-08-01), plus Cisco SG250-08HP / SG200-50 / SG95D-08 / SG350-52 / SG300-28PP / CBS350-24T-4G, Cisco Aironet 1242AG, and TP-Link EAP110-Outdoor — all from official vendor EoL bulletins',
    'EOL Intelligence: the SonicWall AP entries also match the legacy mislabeled model strings ("Ne INT" / "432e INT"), so the ESIP access points are dated even before their model text is cleaned up',
    'EOL Intelligence: enrichment now recognizes SonicWall as a vendor and matching is fully brand-independent — a device with a wrong or missing brand still matches the seed on its model, so inaccurate brand labels no longer block EOL dating',
    'EOL Intelligence: a fresh full research sweep confirmed the remaining dateless models (Aruba Wi-Fi 6 APs, Grandstream GWN, Ruckus R550/R650/T350, Huawei AirEngine/S-series, Palo Alto PA-440/460, Cisco C9200L/C9300) are current-gen with no published vendor EoL — correctly left undated rather than guessed',
  ],
  '1.11.0': [
    'Import: re-importing a device now updates it in place when its IP matches an existing device in the same site, even if the serial does not match — so you can correct or backfill devices that were first imported without serials (or with wrong/garbled ones) just by re-importing with the real names and serial numbers',
    'Import: the IP-based update only overwrites the fields actually present in your file, so a sparse re-import never wipes existing good data (a blank Lifecycle/Status column no longer resets known values), and Technical Debt is recomputed from the resulting values',
    'Import: serial number remains the primary match key (unchanged); IP-in-same-site is the new fallback. A row whose IP already belongs to a device in a different site is still skipped to avoid clobbering the wrong record',
  ],
  '1.10.4': [
    'EOL Intelligence: deleting a device now also clears its pending EOL recommendations and discrepancies, so a removed device no longer lingers in the review queues',
  ],
  '1.10.3': [
    'EOL Intelligence: enrichment can no longer wedge permanently — a job left in "running" after a server restart is now reaped as stale after 30 minutes, and a partial unique index plus a race-safe insert prevent two concurrent runs from colliding',
    'EOL Intelligence: D-Link and Ubiquiti (and every other curated seed vendor) are now recognized by the vendor parser, and the seed migration repairs already-stored entries whose normalized key kept the brand token — so models like the D-Link DGS-1100-24P and Ubiquiti UAP-Pro finally pick up their vendor EOL dates on the next run',
    'EOL Intelligence: status recommendations now respect direction — a new opposite-direction recommendation is no longer suppressed by an unrelated ignored one; and the seed date-fill no longer clobbers an unrelated placeholder row',
    'Reliability: EOL recommendation/discrepancy resolve actions (including bulk accept-all) now run in a transaction, so a mid-step failure can no longer leave a device updated without its audit record — bulk reports an accurate success count instead of a blanket error',
    'Compliance: an empty (or near-empty) fleet now shows an explicit "No data to assess" state instead of a misleading green 100%',
  ],
  '1.10.2': [
    'EOL Intelligence: third (final) research sweep over the legacy tail — added ~27 more vendor-confirmed models from official bulletins (Cisco Catalyst 2960/3750X/ISR-1941/Aironet 3602/1702/2702/1815, Meraki MS210/MS120-8FP/MS355, HP 5130/1950/A5120 SI/2920/2620, Netgear GS408EPP/S3300/GS108T, D-Link DGS-1100-24P, TP-Link EAP225, Ubiquiti UAP-Pro), covering ~115 more devices',
    'Remaining dateless models are now overwhelmingly current-gen gear with no published vendor EOL, junk/placeholder model names, or chassis modules — i.e. correctly not datable',
  ],
  '1.10.1': [
    'EOL Intelligence: added 9 more vendor-confirmed models from official bulletins — Cisco Catalyst 2960/2960-X, Aironet 3800, CBS350, Meraki MR20/MS120-24, Aruba 7205 controller, TP-Link TL-SG1016/TL-SG1024 (~60 devices)',
    'Fixed seed-key normalization for vendors without a recognized prefix (Allied Telesis, TP-Link, etc.): deriveVendor no longer collapses the model into an empty key, so previously-confirmed entries (AT-TQ5403e, AT-x510L, TL-GS108) now correctly match their devices (~40 devices recovered on the next enrichment run)',
  ],
  '1.10.0': [
    'EOL Intelligence: new "Add all to seed" button on the Coverage Worklist bulk-adds every uncovered device model to the seed in one click (server-side, using the same model normalization as the matcher) instead of adding them one at a time, then auto-runs enrichment to refresh',
    'Bulk-added models are dateless placeholders that track the model — their EOL dates still come from research/curation (many current-gen models have no published vendor date)',
  ],
  '1.9.2': [
    'EOL Intelligence: the seed migration now fills confirmed dates onto ALL dateless rows (including UI-added duplicates), not just the first match — so duplicate placeholders for already-confirmed models (AT-TQ5403e, AT-x510L, Aruba 214, HP MSM family) now pick up their vendor dates',
    'Added HP A5120 EI switches (End-of-Sale 2015-10-01 — same hardware as HP 5120 EI per HPE docs), covering ~72 more devices',
    'Re-checked the remaining dateless models (Aruba 2930F 24G/48G + CX 6100, Cisco C9200L/C9300/Aironet 1242AG, Huawei AirEngine/S5731, Palo Alto PA-460, Forcepoint NGFW, and current Wi-Fi 6 APs) — still no official published vendor EOL, so they remain correctly unseeded (no guessing)',
  ],
  '1.9.1': [
    'EOL Intelligence: the seed-entry Vendor field is now a dropdown of known brands (from the inventory) instead of free text, so vendor names stay standardized',
  ],
  '1.9.0': [
    'EOL Intelligence seed expanded with 21 vendor-confirmed model families from official EoS/EoL bulletins (Aruba 207/210/300/360-series + 6200F, HP MSM/5120/5130, Allied Telesis, Netgear, TP-Link, Cisco SF500/SG300/Aironet 2802i, Meraki MR33/MR46/MR52) — each with its vendor source URL — adding confirmed EOL dates to ~480 more devices',
    'The seed migration now upserts: it fills confirmed dates onto dateless placeholder entries (added via the worklist) without overwriting any manually-curated date',
    'Current-gen models (Aruba 5xx/6x00, Grandstream GWN766x, Ruckus, Huawei AirEngine, Cisco C9300/C9200, etc.) were researched but have no published vendor EOL, so they remain correctly unseeded — no dates are guessed',
  ],
  '1.8.1': [
    'Fixed EOL Intelligence seed dates showing (and saving on edit) one day early — the seed-management list read DATE columns in UTC; it now returns true calendar dates, matching the matching-engine fix',
  ],
  '1.8.0': [
    'New EOL Intelligence "Status Recommendations" (super-admin): when a vendor-confirmed (high-confidence) seed date contradicts a device\'s lifecycle status, it surfaces a recommendation — "Should be EOL" (Active devices past their vendor EOL date) and "Possibly Incorrect EOL" (EOL-marked devices still within vendor support)',
    'Recommendations are never auto-applied — an admin accepts (updates lifecycle_status, with the vendor source URL shown to verify and an audit-log entry written) or ignores (suppressed for 90 days); per-row and bulk actions are supported',
    'Only high-confidence exact/alias seed matches generate recommendations (never fuzzy/medium), and stale recommendations auto-clear when a device no longer qualifies',
  ],
  '1.7.1': [
    'Fixed EOL Intelligence date handling: DATE columns were read in UTC and rolled back a day (+07), producing phantom "1-day" discrepancies and off-by-one dates — dates are now compared and displayed as true calendar dates',
    'Discrepancy review no longer flags the enrichment’s own seed-written dates as conflicts (only genuinely manual dates are flagged); stale/false discrepancies are auto-cleared on the next run and resolved items no longer reappear',
    'Coverage Worklist and live run progress now display correctly (the API {ok,job} envelope was not being unwrapped), and the privileged CREATE EXTENSION was moved off the request path',
  ],
  '1.7.0': [
    'New EOL Intelligence admin (Settings → EOL Intelligence, super-admin): the curated EOL seed now lives in a managed database table — add/edit/delete model→EOL/EoS entries with a live coverage preview showing how many devices match before you save',
    'Enrichment now runs as a background job with live progress, flexible matching (exact, alias, and fuzzy similarity when pg_trgm is enabled), and a coverage worklist of the top unmatched models with one-click "add to seed"',
    'Discrepancy review: when the seed disagrees with a manually-entered EOL date, it is flagged for review (accept seed / keep manual / ignore) instead of silently overwriting your data',
  ],
  '1.6.1': [
    'Added EOL provenance columns (eol_source, eol_confidence, eol_enriched_at) to the canonical schema so fresh installs match the enrichment route’s runtime self-heal',
    'Researched the highest-volume unmatched models for end-of-life dates (Aruba 505/515/575, Grandstream GWN7660); no official vendor EoS dates are published for these current Wi-Fi 6 products, so none were added (no guessing) — they are tracked in the seed worklist to revisit',
  ],
  '1.6.0': [
    'New automated EOL/EOS enrichment: a curated, vendor-sourced model→end-of-life seed populates support-end and OS-EOL dates on matching devices, with provenance (source + confidence) and never overwriting manually-entered dates',
    'Runs as a daily scheduled task (and once on update) and returns a curation "worklist" of the highest-volume models still missing EOL dates — coverage grows from real vendor bulletins; no dates are ever guessed',
    'Feeds the new risk scoring: as EOL dates populate, the support-expiry compliance check auto-reactivates (≈175 devices gain dates from the initial seed)',
  ],
  '1.5.0': [
    'Compliance and health scores now measure real risk, not empty fields — checks on inventory fields populated on <5% of the fleet (e.g. support-end-date, OS EOL) move to a new "Data Completeness" metric and are excluded from the risk score until the data exists, then auto-reactivate',
    'Compliance 59% → 88% and health grade F → D now reflect genuine fleet risk (EOL-active devices, sites at risk) instead of undesigned columns',
    'Security hardening: the license key is no longer returned to unauthenticated callers, the in-app update trigger now requires an admin session, the license signing secret can be rotated via env, and token/cookie fragments were removed from SSO logs',
  ],
  '1.4.3': [
    'Correlated suite alerts no longer show a /32 CIDR suffix on the source IP — the Hub security-alert query now strips it with host() like the other Hub queries',
  ],
  '1.4.2': [
    'Fixed correlated suite alerts not appearing — the EOL-device correlation queried NetVault/SpanVault IP columns with a Postgres inet-only function, so those alerts silently failed',
    'Update-NetVault.ps1 now backs up and restores the standalone .env.local across the rebuild, so manually-added keys (e.g. the cross-app read role) are no longer wiped on every update',
  ],
  '1.4.1': [
    'New unified suite search on the launcher Hub — find any asset by IP, hostname or name across all four apps at once',
    'New Asset 360 drawer: one slide-in view of a device’s full story — NetVault asset of record, SpanVault monitoring (status, health, uptime, alerts), LogVault risk & recent security events, and DDIVault DNS/IPAM',
    'Search results tag which apps each asset appears in; the drawer shows suite presence at a glance',
    'All cross-app reads stay read-only and degrade gracefully when a signal is absent for an asset',
  ],
  '1.4.0': [
    'New "NocVault Hub — Suite Intelligence" section on the launcher: cross-app KPIs (fleet health, availability, log anomalies, IPAM utilization, open alerts) and correlated alerts spanning all four apps',
    'Correlated alerts surface what no single app can see — e.g. an end-of-life device that also has active monitoring alerts and security events',
    'Server Status moved to the bottom of the launcher; the existing app cards and Suite Health Overview are unchanged',
    'Reads cross-app data via a dedicated read-only role (populates once NOCVAULT_RO_* is configured; degrades gracefully otherwise)',
  ],
  '1.2.0': [
    'Enterprise dashboard with health score and charts',
    'Animated login page redesign',
    'Server status monitoring',
    'Automatic versioning across suite',
  ],
  '1.2.1': [
    'More reliable auto-reload after applying an update',
    'Extended the update recovery window so slower builds finish cleanly',
    'Cleaner update screen with structured release notes',
    'Removed the legacy CHANGELOG file',
  ],
  '1.2.2': [
    'Idle timeout now returns you to the page you were on after logging back in',
    'Fixed a redirect that could send users to a non-existent /sso page',
    'Login safely ignores invalid or looping callback URLs',
  ],
  '1.2.3': [
    'Removed the redundant refresh button from the dashboard header',
  ],
  '1.2.4': [
    'Standardized Settings page styling to match NocVault suite',
  ],
  '1.2.5': [
    'Standardized Settings menu (removed Branding, added About tab, Security→General)',
    'Theming continues to apply from stored or default values',
  ],
  '1.2.6': [
    'Settings copy cleanup (removed stale branding references)',
  ],
  '1.2.7': [
    'Standardized Updates and About tabs to NocVault suite spec',
  ],
  '1.2.8': [
    'Tightened card corners and elevation for a cleaner operations-console look',
    'Standardized border radius across the suite — 8px panels/cards/tables/modals, 6px buttons/inputs/dropdowns',
    'Replaced heavier card shadows with a subtle border-plus-faint-shadow elevation',
    'Kept pill toggles, status dots, and avatars fully rounded',
  ],
  '1.2.9': [
    'Standardized typography on a shared 7-step type scale (suite-wide standard)',
    'Unified the monospace font into a single token across all app screens',
    'Replaced duplicated hardcoded colors with design tokens for consistent theming',
    'Snapped ad-hoc font sizes onto the scale, collapsing ~12 sizes down to 7',
    'Login and launcher hero typography intentionally left unchanged',
  ],
  '1.2.10': [
    'Standardized sidebar nav icon chips (28×28, radius 8, per-route tint) to match the NocVault suite',
    'Bumped nav labels to 14px for suite-wide typographic parity',
    'Switched the header avatar to a 34px circular badge on solid primary',
  ],
  '1.2.11': [
    'Moved the header tagline beside the logo (after a divider) instead of stacked beneath it, matching the rest of the NocVault suite',
  ],
  '1.2.12': [
    'Opening the suite at the root URL now lands on the launcher (or the login screen if signed out) instead of dropping straight into the NetVault dashboard',
    'NetVault is now opened from the launcher like the other suite apps',
  ],
  '1.3.1': [
    'Extended dark mode across the whole hub — dashboard, settings, devices, sites, circuits, users, EOL, compliance, audit and shared components now adapt cleanly to the dark theme',
    'Replaced hardcoded light backgrounds/text with adaptive design tokens so theme switching is consistent on every page',
    'Kept brand accent colors, status signals, and the navy chrome unchanged in both themes',
  ],
  '1.3.0': [
    'Added suite-standard dark mode with a sun/moon theme switcher in the top bar (launcher + app), bringing NetVault to parity with the rest of the NocVault suite',
    'Your theme choice is remembered and applied before the page paints, so there is no flash of the wrong theme on load',
    'Tokenized the launcher surfaces (background, Suite Health Overview, Server Status, headings/body text) so they adapt cleanly to dark mode',
    'Kept the navy top bar, per-app brand accent colors, and status colors unchanged in both themes',
  ],
  'default': [
    'Bug fixes and performance improvements',
  ],
}

// Compares the local git commit hash against the latest commit on GitHub's main
// branch. ANY differing commit counts as an update available — the package.json
// version is for display only, so patches pushed without a version bump are no
// longer missed. Never 500s: a fetch/git failure degrades to "up to date" so we
// never show a false "update available".
export async function GET() {
  const repoRoot = findGitRoot(process.cwd())
  const current_version = pkg.version
  const localHash = localCommitHash(repoRoot)

  try {
    // Cache-bust the raw files so GitHub's CDN can't return a stale copy — the
    // "Check for updates" button must reflect a freshly pushed commit at once.
    const bust = Date.now()
    const [remoteHash, remotePkgText] = await Promise.all([
      remoteCommitHash(),
      fetchText(`${RAW_BASE}package.json?cb=${bust}`),
    ])

    let latest_version: string | undefined
    try {
      latest_version = JSON.parse(remotePkgText).version
    } catch {
      // best-effort; version is display-only
    }

    // Release notes for the version being offered (the latest), falling back to
    // a generic message when there's no curated entry for that version.
    const release_notes = (latest_version && releaseNotes[latest_version]) || releaseNotes['default']

    // Any differing commit = update available. If either hash is missing
    // (git unavailable or API error), treat as up to date to avoid a false alarm.
    const update_available = !!remoteHash && !!localHash && remoteHash !== localHash

    return NextResponse.json({
      current_version,
      latest_version,
      current_commit: localHash,
      latest_commit: remoteHash,
      current_hash: localHash,
      latest_hash: remoteHash,
      up_to_date: !update_available,
      update_available,
      release_notes,
      release_date: new Date().toISOString().slice(0, 10),
    })
  } catch (e: any) {
    const detail = (e?.message || 'version check failed').toString().trim()
    console.error('[update-status] version check failed:', detail)
    // Degrade to "up to date" rather than surfacing a false update available.
    return NextResponse.json({
      current_version,
      current_commit: localHash,
      up_to_date: true,
      update_available: false,
      error: 'Could not check for updates',
    })
  }
}
