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

export async function GET() {
  const repoRoot = findGitRoot(process.cwd())
  const git = (cmd: string) =>
    execSync(cmd, { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }).trim()
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
