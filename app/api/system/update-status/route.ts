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
