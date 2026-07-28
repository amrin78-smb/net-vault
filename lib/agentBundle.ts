import fs from 'fs'
import path from 'path'

// NocVault Agents Phase 2 — hub-served agent bundle.
//
// The hub serves the multi-file agent (nocvault-agent.js + core/ + modules/ +
// package.json) to a remote host during install, so the minted one-liner is
// self-bootstrapping (no pre-staging). This module is the single source of truth
// for (1) where the on-disk agent/ dir lives and (2) which files are servable —
// both the manifest route and the per-file route import it so their exclude sets
// can never drift.

// Resolve the on-disk agent/ source directory robustly across dev and the
// standalone production build:
//   • dev / `next dev`      → process.cwd() is the repo root, so <cwd>/agent.
//   • `output: 'standalone'`→ NSSM runs server.js from <repo>/.next/standalone
//     (that dir is process.cwd()); the agent/ dir is a git-tracked sibling of
//     the build that is NOT traced into the standalone output, so it sits two
//     levels up at <repo>/agent.
// Returns the absolute path, or null if no candidate is a directory.
export function resolveAgentDir(): string | null {
  const candidates = [
    path.join(process.cwd(), 'agent'),
    path.join(process.cwd(), '..', '..', 'agent'),
  ]
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return path.resolve(c)
    } catch {
      // not here — try the next candidate
    }
  }
  return null
}

// Blocklist for the runtime bundle. `relPath` is forward-slash relative to the
// agent dir. Excludes: dependencies (re-installed on the remote), local runtime
// state, secrets/keys, logs, tests, and the bootstrap installer itself. Applied
// by BOTH listBundleFiles() and the per-file server so they stay in lockstep.
export function isExcludedBundlePath(relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/')
  const segments = rel.split('/').filter(Boolean)
  if (!segments.length) return true
  const base = segments[segments.length - 1].toLowerCase()

  // Whole-directory excludes (any depth for node_modules + the signing key dir;
  // top-level test/ and the self-update staging/rollback dirs).
  if (segments.includes('node_modules')) return true
  if (segments.includes('keys')) return true
  if (segments[0] === 'test') return true
  // Self-update staging (pending/) and rollback (backup/) trees — pure runtime
  // scratch written by the updater; never part of a fresh bundle.
  if (segments[0] === 'pending' || segments[0] === 'backup') return true

  // Local runtime state / secrets — never part of a fresh bundle.
  if (base === 'config.json' || base === 'hub-identity.json' || base === 'buffer.json') return true
  if (base === 'pending-update.bundle') return true
  // The runtime signed manifest is served by its OWN route (/api/agents/update-manifest),
  // not as a bundle file, and its file list must equal the bundle's served files —
  // so it must not appear in the bundle itself. Same for the updater's apply-marker.
  if (base === 'update-manifest.json') return true
  if (base === '.update-confirm.json') return true
  if (base === '.gitignore') return true
  // The installer script is served separately (baked) — not a runtime file.
  if (base === 'install.ps1') return true
  if (base.endsWith('.log')) return true
  // Private keys of any kind (covers scripts/*.key too).
  if (base.endsWith('.pem') || base.endsWith('.key')) return true

  return false
}

// Recursively list the servable agent files as sorted forward-slash relative
// paths, with the blocklist applied. Returns [] if the dir can't be walked.
export function listBundleFiles(agentDir: string): string[] {
  const out: string[] = []
  const walk = (absDir: string, relDir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (isExcludedBundlePath(rel)) continue
      if (e.isDirectory()) {
        walk(path.join(absDir, e.name), rel)
      } else if (e.isFile()) {
        out.push(rel)
      }
    }
  }
  walk(agentDir, '')
  out.sort()
  return out
}
