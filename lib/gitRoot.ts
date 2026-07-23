import fs from 'fs'
import path from 'path'

/**
 * Walk up from `start` to find the nearest ancestor directory containing a
 * `.git` folder — the real repo root the updater/update-status routes should
 * operate on.
 *
 * Never trust a `.git` sitting inside a `.next` build-output tree. NSSM runs
 * this app with AppDirectory = `.../.next/standalone` (see
 * `installer/Install-NetVault.ps1`), so `process.cwd()` starts INSIDE the
 * build output — if a stray/duplicate `.git` ever ends up nested in there
 * (confirmed happening on the live server: a near-complete second repo
 * checkout at `.next/standalone/.git`), this would stop at the first match
 * and run `installer/Update-NetVault.ps1` from that STALE, nested copy
 * instead of the real one, silently updating/inspecting the wrong tree while
 * still restarting the real NSSM-managed service — exactly the failure mode
 * that made "Update Now" intermittently not actually update anything, and
 * that made the update-status commit-hash check compare against a stale
 * checkout. Skip any `.git` whose path contains a `\.next\` segment and keep
 * walking up past it.
 *
 * Shared by `app/api/system/update/route.ts` and
 * `app/api/system/update-status/route.ts` — this was previously two
 * independently-maintained copies and the `.next`-path guard drifted between
 * them (fixed 2026-07-23); keep it as one function so future hardening only
 * needs to happen once.
 */
export function findGitRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i++) {
    const isBuildOutput = /[\\/]\.next([\\/]|$)/i.test(dir)
    if (!isBuildOutput && fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}
