import { NextResponse } from 'next/server'
import { execSync } from 'child_process'

export async function GET() {
  const cwd = process.cwd()
  const git = (cmd: string) =>
    execSync(cmd, { cwd, encoding: 'utf8', timeout: 30000 }).trim()
  try {
    git('git fetch origin main')
    const current = git('git rev-parse HEAD').slice(0, 7)
    const latest  = git('git rev-parse origin/main').slice(0, 7)
    const behind  = parseInt(git('git rev-list HEAD..origin/main --count'), 10) || 0
    const log     = git('git log HEAD..origin/main --pretty=format:"%h %s"')
    const changes = log ? log.split('\n').map(l => l.trim()).filter(Boolean) : []
    return NextResponse.json({ current_version: current, latest_version: latest, commits_behind: behind, up_to_date: behind === 0, changes })
  } catch (e: any) {
    console.error('[update-status] git check failed:', e.message)
    return NextResponse.json({ error: 'Could not check for updates', up_to_date: true })
  }
}
