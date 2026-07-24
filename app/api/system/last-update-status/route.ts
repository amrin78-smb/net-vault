import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { findGitRoot } from '@/lib/gitRoot'

export const dynamic = 'force-dynamic'

// Update-NetVault.ps1 writes a structured result of the last update attempt to
// <InstallDir>\logs\last-update-status.json on every run (success or failure) -
// see the script's Write-StatusJson function. This route just surfaces that file
// so the frontend can show a banner the moment a failed update needs attention,
// without anyone having to go looking at the updater's log files.
//
// The script's logs dir is `$InstallDir\logs`, where InstallDir is the PARENT of
// the app repo root on a suite install (C:\Apps\NetVault\app -> C:\Apps\NetVault)
// but the SAME as the repo root on a standalone install - mirrors the two layouts
// findGitRoot() already has to handle. Check both.
function resolveStatusPath(): string | null {
  const repoRoot = findGitRoot(process.cwd())
  const candidates = [
    path.join(repoRoot, '..', 'logs', 'last-update-status.json'),
    path.join(repoRoot, 'logs', 'last-update-status.json'),
  ]
  return candidates.find(p => fs.existsSync(p)) || null
}

// Item 10 (2026-07-24 resilience review): this route had no session check at
// all. Its only caller, UpdateFailureBanner, is itself rendered only for
// admin/super_admin (both mount points - app layout and the launcher - gate it
// that way in the UI). The payload can include internal file paths and raw
// error text (e.g. "check C:\Apps\NetVault\logs\npm-install.log") which,
// while not credentials, is more than a non-admin needs to see - so gated
// server-side to match the UI exactly, per this app's "gate the API, not just
// the page" convention (see CLAUDE.md's access-control section), rather than
// left open as an oversight.
export async function GET() {
  const session = await getServerSession(authOptions)
  const role = (session?.user as { role?: string } | undefined)?.role
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (role !== 'admin' && role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const statusPath = resolveStatusPath()
  if (!statusPath) {
    return NextResponse.json({ exists: false })
  }
  try {
    // Strip a leading UTF-8 BOM defensively: Windows PowerShell 5.1's
    // `Out-File -Encoding UTF8` used to write this file with one (fixed on the
    // writer side too, but an already-written file on disk may still have it).
    const BOM = String.fromCharCode(0xfeff)
    const raw = fs.readFileSync(statusPath, 'utf8')
    const status = JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw)
    return NextResponse.json({ exists: true, ...status })
  } catch {
    return NextResponse.json({ exists: false, error: 'Could not read update status file' })
  }
}
