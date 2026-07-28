import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { resolveAgentDir } from '@/lib/agentBundle'

export const dynamic = 'force-dynamic'

// GET /api/agents/update-manifest — PUBLIC (no session), like /api/agents/bundle.
// Serves the committed, offline-signed self-update manifest
//   { version, files:[{path, sha256}], sig }
// produced by agent/scripts/sign-agent.js. The agent fetches this on its policy
// tick BEFORE it has decided whether to update — pre-credential, so public is
// correct (the manifest is signed; verification happens against the agent's
// embedded Ed25519 public key, not via transport trust). The files it references
// are served by the existing /api/agents/bundle/<path> route.
//
// The manifest file sits at the AGENT ROOT (agent/update-manifest.json), NOT
// under core/. A fresh install with no committed/signed manifest simply advertises
// no update: 503 (never 500) when the agent dir or the file is missing/unparseable.
export async function GET() {
  const agentDir = resolveAgentDir()
  if (!agentDir) {
    return NextResponse.json({ error: 'update manifest unavailable' }, { status: 503 })
  }
  try {
    const raw = fs.readFileSync(path.join(agentDir, 'update-manifest.json'), 'utf8')
    const manifest = JSON.parse(raw)
    return NextResponse.json(manifest, {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch {
    return NextResponse.json({ error: 'update manifest unavailable' }, { status: 503 })
  }
}
