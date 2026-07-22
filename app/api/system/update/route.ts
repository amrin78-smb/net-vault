import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getLicenseStatus, getServerId } from '@/lib/license'
import { query } from '@/lib/db'

function findGitRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i++) {
    // Never trust a .git sitting inside a .next build-output tree. NSSM runs
    // this app with AppDirectory = .../.next/standalone (see
    // installer/Install-NetVault.ps1), so process.cwd() starts INSIDE the
    // build output — if a stray/duplicate .git ever ends up nested in there
    // (confirmed happening on the live server: a near-complete second repo
    // checkout at .next/standalone/.git), this would stop at the first
    // match and run installer/Update-NetVault.ps1 from that STALE, nested
    // copy instead of the real one, silently updating the wrong tree while
    // still restarting the real NSSM-managed service — exactly the failure
    // mode that made "Update Now" intermittently not actually update
    // anything. Skip any .git whose path contains a \.next\ segment and keep
    // walking up past it.
    const isBuildOutput = /[\\/]\.next([\\/]|$)/i.test(dir)
    if (!isBuildOutput && fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

export async function POST() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  const isAdmin = user.role === 'admin' || user.role === 'super_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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
