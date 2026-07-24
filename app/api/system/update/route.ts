import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getLicenseStatus, getServerId } from '@/lib/license'
import { query } from '@/lib/db'
import { findGitRoot } from '@/lib/gitRoot'

// Update-NetVault.ps1 writes its own PID to <InstallDir>\logs\update.lock at
// startup and removes it in a `finally` block wrapping the whole run (success
// or failure) - see the script's "Concurrency guard" comment. Mirror its
// self-location logic (repoRoot -> ../logs on a suite install, ./logs on a
// standalone one - same two candidates last-update-status/route.ts already
// checks) so this route can tell whether a run is genuinely still in flight
// before scheduling a second one on top of it.
function findLockPid(): number | null {
  const repoRoot = findGitRoot(process.cwd())
  const candidates = [
    path.join(repoRoot, '..', 'logs', 'update.lock'),
    path.join(repoRoot, 'logs', 'update.lock'),
  ]
  const lockPath = candidates.find(p => fs.existsSync(p))
  if (!lockPath) return null
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim()
    const pid = parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

// Node's cross-platform way to check whether a PID is still alive without
// actually sending a signal: `kill(pid, 0)` throws ESRCH if the process is
// gone, or EPERM if it exists but we lack permission (still alive either way).
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

export async function POST() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  const isAdmin = user.role === 'admin' || user.role === 'super_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Concurrency guard (item 6): a manual console run of Update-NetVault.ps1
  // could race this in-app trigger (or a double-click of "Update Now" before
  // the overlay renders), and two overlapping updates would mutate the same
  // on-disk git checkout / build output concurrently. Refuse to schedule a
  // second run while the lock file shows a still-live PID.
  const lockPid = findLockPid()
  if (lockPid !== null && isPidAlive(lockPid)) {
    return NextResponse.json(
      { error: `An update is already in progress (started by process ${lockPid}). Please wait for it to finish before starting another.` },
      { status: 409 }
    )
  }

  const serverId = getServerId()
  const result = await query(
    "SELECT key, value FROM app_settings WHERE key IN ('install_date','license_key')"
  )
  const s: Record<string, string> = {}
  for (const row of result.rows) s[row.key] = row.value ?? ''
  const { status } = getLicenseStatus(
    s['install_date'] ?? '', s['license_key'] ?? '', serverId
  )
  if (status === 'expired') {
    return NextResponse.json(
      { error: 'License expired. Renew your license to receive updates.' },
      { status: 403 }
    )
  }

  const serverIp = process.env.SERVER_IP || ''
  if (!serverIp) {
    return NextResponse.json({ error: 'SERVER_IP not configured in .env.local' }, { status: 400 })
  }
  const repoRoot = findGitRoot(process.cwd())
  const scriptPath = path.join(repoRoot, 'installer', 'Update-NetVault.ps1').replace(/\//g, '\\')
  try {
    try { execSync('schtasks /delete /tn "NetVaultUpdate" /f', { stdio: 'ignore' }) } catch (_e) { /* none */ }
    execSync(
      `schtasks /create /tn "NetVaultUpdate" ` +
      `/tr "powershell.exe -NonInteractive -ExecutionPolicy Bypass ` +
      `-File \\"${scriptPath}\\" -ServerIp \\"${serverIp}\\"" ` +
      `/sc once /st 00:00 /f /ru SYSTEM`,
      { stdio: 'pipe' }
    )
    execSync('schtasks /run /tn "NetVaultUpdate"', { stdio: 'pipe' })
    console.log('[Update] Task scheduled under SYSTEM, ServerIp:', serverIp)
    return NextResponse.json({ started: true })
  } catch (err: any) {
    console.error('[Update] schtasks error:', err.message)
    return NextResponse.json({ error: 'Failed to schedule update: ' + err.message }, { status: 500 })
  }
}
