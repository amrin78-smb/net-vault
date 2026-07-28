import { NextResponse } from 'next/server'
import { resolveAgentDir, listBundleFiles } from '@/lib/agentBundle'

export const dynamic = 'force-dynamic'

// GET /api/agents/bundle — PUBLIC (no session). Returns the manifest of agent
// files to install as forward-slash relative paths under agent/. The install
// one-liner fetches this before it has any credential, so public is correct (the
// agent is customer-shipped software with no secrets; the exclude set in
// lib/agentBundle strips local state/keys/deps/tests). 503 (never 500) when the
// on-disk agent dir is unavailable.
export async function GET() {
  const agentDir = resolveAgentDir()
  if (!agentDir) {
    return NextResponse.json({ error: 'agent bundle unavailable' }, { status: 503 })
  }
  const files = listBundleFiles(agentDir)
  if (!files.length) {
    return NextResponse.json({ error: 'agent bundle unavailable' }, { status: 503 })
  }
  return NextResponse.json({ files })
}
