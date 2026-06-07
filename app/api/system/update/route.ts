import { NextResponse } from 'next/server'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

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

export async function POST() {
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
