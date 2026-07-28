import { NextResponse } from 'next/server'
import fs from 'fs'
import nodePath from 'path'
import { resolveAgentDir, isExcludedBundlePath } from '@/lib/agentBundle'

export const dynamic = 'force-dynamic'

// text extensions served as text/plain; everything else octet-stream.
const TEXT_EXT = new Set(['.js', '.json', '.md', '.txt', '.ps1', '.cjs', '.mjs'])

// GET /api/agents/bundle/<rel...> — PUBLIC (no session). Serves ONE agent file's
// bytes. SECURITY-CRITICAL: the requested path is untrusted; a naive join would
// let a caller read arbitrary server files (../../.env, absolute paths, symlink
// escapes). We resolve the final path and verify with path.relative that it is
// still inside the agent dir, and re-apply the manifest's exclude set.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const agentDir = resolveAgentDir()
  if (!agentDir) {
    return NextResponse.json({ error: 'agent bundle unavailable' }, { status: 503 })
  }

  const { path: parts } = await params
  const rel = (Array.isArray(parts) ? parts : []).join('/')
  if (!rel) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Resolve + confine to agentDir (reject .. / absolute / symlink escape).
  const abs = nodePath.resolve(agentDir, rel)
  const within = nodePath.relative(agentDir, abs)
  if (within === '' || within.startsWith('..') || nodePath.isAbsolute(within)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Never serve an excluded (secret/state/dep/test) file even if it exists.
  if (isExcludedBundlePath(within)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let realAbs: string
  let data: Buffer
  try {
    // realpathSync collapses any symlink; re-confirm the real target is inside.
    realAbs = fs.realpathSync(abs)
    const realWithin = nodePath.relative(agentDir, realAbs)
    if (realWithin.startsWith('..') || nodePath.isAbsolute(realWithin)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const stat = fs.statSync(realAbs)
    if (!stat.isFile()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    data = fs.readFileSync(realAbs)
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const ext = nodePath.extname(within).toLowerCase()
  const contentType = TEXT_EXT.has(ext)
    ? 'text/plain; charset=utf-8'
    : 'application/octet-stream'

  const body = new Uint8Array(data)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
    },
  })
}
