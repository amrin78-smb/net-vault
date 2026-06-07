import { NextResponse } from 'next/server'
import { execSync } from 'child_process'
import path from 'path'

export async function POST() {
  const serverIp = process.env.SERVER_IP || ''
  if (!serverIp) {
    return NextResponse.json({ error: 'SERVER_IP not configured in .env.local' }, { status: 400 })
  }
  const scriptPath = path.join(process.cwd(), 'installer', 'Update-NetVault.ps1').replace(/\//g, '\\')
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
