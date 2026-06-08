import { NextResponse } from 'next/server'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import pkg from '../../../../package.json'

const RAW_BASE = 'https://raw.githubusercontent.com/amrin78-smb/net-vault/main/'

function parseSemver(v: string): number[] {
  return String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
}

function isRemoteNewer(local: string, remote: string): boolean {
  const a = parseSemver(local)
  const b = parseSemver(remote)
  for (let i = 0; i < 3; i++) {
    const la = a[i] || 0
    const rb = b[i] || 0
    if (rb > la) return true
    if (rb < la) return false
  }
  return false
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function getSemverInfo(): Promise<{
  current_semver: string | undefined
  latest_semver: string | undefined
  changelog: string | undefined
  release_date: string | undefined
  version_update_available: boolean
}> {
  const current_semver = pkg.version
  try {
    const remotePkgText = await fetchText(`${RAW_BASE}package.json`)
    const remotePkg = JSON.parse(remotePkgText)
    const latest_semver = remotePkg.version as string

    let changelog: string | undefined
    let release_date: string | undefined
    try {
      const changelogText = await fetchText(`${RAW_BASE}CHANGELOG.md`)
      const lines = changelogText.split('\n')
      const startIdx = lines.findIndex(l => l.startsWith('## '))
      if (startIdx !== -1) {
        let endIdx = lines.length
        for (let i = startIdx + 1; i < lines.length; i++) {
          if (lines[i].startsWith('## ')) {
            endIdx = i
            break
          }
        }
        changelog = lines.slice(startIdx, endIdx).join('\n').trim()
        const headingMatch = lines[startIdx].match(/[—-]\s*(.+)\s*$/)
        if (headingMatch) release_date = headingMatch[1].trim()
      }
    } catch (e) {
      // changelog is optional; leave changelog/release_date undefined
    }

    return {
      current_semver,
      latest_semver,
      changelog,
      release_date,
      version_update_available: isRemoteNewer(current_semver, latest_semver),
    }
  } catch (e) {
    return {
      current_semver,
      latest_semver: undefined,
      changelog: undefined,
      release_date: undefined,
      version_update_available: false,
    }
  }
}

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

  // Fetch first, separately, so a network/auth failure surfaces as a real
  // error instead of silently masquerading as "up to date".
  try {
    git('git fetch origin main')
  } catch (e: any) {
    const detail = (e.stderr || e.message || 'git fetch failed').toString().trim()
    console.error('[update-status] git fetch failed:', detail)
    return NextResponse.json({ error: 'Could not reach GitHub to check for updates: ' + detail, _gitRoot: repoRoot }, { status: 502 })
  }

  try {
    const current = git('git rev-parse HEAD').slice(0, 7)
    const latest  = git('git rev-parse origin/main').slice(0, 7)
    const behind  = parseInt(git('git rev-list HEAD..origin/main --count'), 10) || 0
    const log     = git('git log HEAD..origin/main --pretty=format:"%h %s"')
    const changes = log ? log.split('\n').map(l => l.trim()).filter(Boolean) : []
    let semver: Record<string, any> = {}
    try {
      semver = await getSemverInfo()
    } catch (e) {
      semver = {}
    }
    return NextResponse.json({ current_version: current, latest_version: latest, commits_behind: behind, up_to_date: behind === 0, changes, _gitRoot: repoRoot, ...semver })
  } catch (e: any) {
    const detail = (e.stderr || e.message || 'git check failed').toString().trim()
    console.error('[update-status] git check failed:', detail)
    return NextResponse.json({ error: 'Could not check for updates: ' + detail, _gitRoot: repoRoot }, { status: 500 })
  }
}
