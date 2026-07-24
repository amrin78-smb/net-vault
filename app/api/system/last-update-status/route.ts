import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
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

export async function GET() {
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
