//
// lib/envFile.ts — change ONE value in an env file without losing the rest.
//
// Ported from secvault/lib/envFile.js, which earned every guard in it the hard
// way. Read the reasoning before simplifying any of this.
//
// ⛔ THIS FILE HOLDS EVERY SECRET THE HUB HAS. DATABASE_URL, NEXTAUTH_SECRET
// (which signs the cross-app SSO tokens for all four apps), CRON_SECRET,
// NOCVAULT_RO_PASS. A bug here that truncated or re-serialised the file would
// take down the whole suite, not just NetVault: every satellite verifies its
// SSO token against NEXTAUTH_SECRET.
//
// So this does the least possible: a LINE EDIT. Comments, ordering, blank lines
// and every untouched value survive byte for byte, because nothing re-writes
// them — the file is split into lines, one line is replaced, and the lines are
// joined again.
//
// ⛔ AND IT VERIFIES ITSELF AFTER WRITING. Every key that existed before must
// still exist afterwards with the same value, except the one being changed. If
// that does not hold the backup is restored and the call fails. A write that
// silently dropped NEXTAUTH_SECRET would not be noticed until the next restart,
// by which point the original is gone and no satellite can verify a session.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Matches KEY=value, capturing the key. Leading `export ` is tolerated because
// some operators paste from a shell script.
//
// ⛔ THE TRAILING \r? MATTERS FOR CONSUMERS OF THIS EXPORT, NOT FOR THIS FILE,
// AND THE DIFFERENCE WAS MEASURED RATHER THAN ASSUMED. `.` does not match \r
// and `$` without the `m` flag will not match before one, so matching a RAW
// CRLF line without it returns null — the key is never FOUND, so it is never
// REPLACED, so it is APPENDED, and the duplicate-key refusal cannot fire either
// because the occurrence scan uses this same regex.
//
// But setEnvValue and parseEnv below both pre-split on /\r?\n/, so the \r is
// already gone by the time they reach here. Removing the \r? changes NOTHING on
// those paths — verified by mutation; the comment here previously claimed
// otherwise and no test disagreed with it. What actually protects the CRLF path
// in THIS file is the split pattern (mutate it to split('\n') and every
// untouched line comes back as \r\r\n). Both are pinned separately in
// tests/envFile.test.ts.
//
// The \r? stays because LINE_RE is EXPORTED and matched against raw lines
// elsewhere — the Entra duplicate-key scan takes it from here rather than
// declaring a second regex for the same grammar, and a second parser for one
// grammar eventually disagrees with the authoritative one.
//
// CRLF is the shipped shape here, not an edge case. The suite installer writes
// these files from PowerShell with `Out-File`, and Update-NetVault.ps1's
// Set-EnvVar appends CRLF; a Windows checkout of .env.example under git's
// default core.autocrlf=true is CRLF too.
//
// And the failure is silent and asymmetric: dotenv reads the LAST occurrence so
// the app keeps working, while Update-NetVault.ps1 reads the FIRST
// (`Select-Object -First 1`) — the stale one — and propagates it into
// .next/standalone/.env.local, reverting the setting on the next deploy.
export const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*?)\r?$/

// ⛔ 1 MB. An environment file is a few hundred bytes; anything approaching this
// is corruption, not configuration. SecVault lost a production console to a
// .env.local that reached 2.2 GB because an em-dash in a COMMENT was decoded as
// cp1252 and re-encoded as UTF-8 once per deploy, roughly doubling each time —
// and node then refused the file outright, so the app came up with NO
// environment at all and looked exactly like a deliberate plaintext install.
// The tripwire is checked BEFORE the backup, so a corrupt file is not first
// duplicated into a second secret-bearing copy.
const MAX_ENV_BYTES = 1024 * 1024

export type EnvValues = Record<string, string>

export type SetEnvResult =
  | { ok: true; previous: string | null; backupPath: string | null; unchanged: boolean }
  | { ok: false; error: string; backupPath?: string; fileState?: FileState }

type FileState = 'unchanged' | 'restored' | 'damaged' | 'unreadable'

/** Parse into { key: value } without touching the file. */
export function parseEnv(text: string | null | undefined): EnvValues {
  const out: EnvValues = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = LINE_RE.exec(line)
    if (!m) continue
    // A value is taken verbatim, including '=' inside it — DATABASE_URL and
    // base64 secrets both contain them. Only a wrapping pair of quotes is
    // stripped, because that is how a value with spaces is written.
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[m[1]] = v
  }
  return out
}

export function readEnvFile(filePath: string): { text: string; values: EnvValues } {
  const text = fs.readFileSync(filePath, 'utf8')
  return { text, values: parseEnv(text) }
}

/**
 * Replace (or append) one key in one file.
 *
 * ⛔ NOT ATOMIC BY RENAME, DELIBERATELY. A rename replaces the file and drops
 * any ACL set on it; these env files are the most access-controlled files in
 * the install and inheriting a fresh default would widen them silently
 * (node's `mode: 0o600` does not produce an ACL on Windows, so the ACL is all
 * there is). It writes in place, after a verified backup, and restores that
 * backup on any mismatch.
 */
export function setEnvValue(filePath: string, key: string, value: string | null): SetEnvResult {
  if (!LINE_RE.test(`${key}=x`)) return { ok: false, error: `Invalid environment key: ${key}` }
  const newValue = String(value == null ? '' : value)
  if (/[\r\n]/.test(newValue)) {
    return { ok: false, error: 'A value may not contain a line break.' }
  }

  let before: { text: string; values: EnvValues }
  try {
    before = readEnvFile(filePath)
  } catch (err: any) {
    return { ok: false, error: `Could not read ${filePath}: ${err.message}` }
  }

  // See MAX_ENV_BYTES. A multi-gigabyte file already fails closed above
  // (readFileSync throws ERR_STRING_TOO_LONG); a 50–500 MB one does not, and
  // would be read, COPIED IN FULL into a secret-bearing .bak, rewritten, and
  // read back.
  if (before.text.length > MAX_ENV_BYTES) {
    return {
      ok: false,
      error:
        `${path.basename(filePath)} is ${before.text.length} bytes, which is far larger than ` +
        'an environment file can legitimately be. Refusing to rewrite it — it is probably ' +
        'corrupt. Inspect it on the server before changing any setting.',
    }
  }

  const previous = Object.prototype.hasOwnProperty.call(before.values, key)
    ? before.values[key]
    : null
  if (previous === newValue) {
    return { ok: true, unchanged: true, previous, backupPath: null }
  }

  // ⛔ SPLIT ON BOTH, AND REMEMBER WHICH. Splitting on '\n' alone leaves a
  // trailing '\r' on every line of a CRLF file; joining with '\n' alone would
  // then rewrite the whole file to LF — a diff against every secret in it, and
  // a gratuitous change to a file the installer also edits.
  const eol = before.text.includes('\r\n') ? '\r\n' : '\n'
  const lines = before.text.split(/\r?\n/)
  const occurrences: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i])
    if (m && m[1] === key) occurrences.push(i)
  }

  // ⛔ A DUPLICATED KEY IS REFUSED, NOT GUESSED AT. Which copy a loader honours
  // is a property of the LOADER, not of this file — and picking the wrong one
  // means the save reports success and changes nothing, which is precisely the
  // silent failure this feature exists to prevent. It is not hypothetical here:
  // dotenv reads the LAST occurrence and Update-NetVault.ps1 reads the FIRST,
  // so a duplicated key makes the running value and the deployed value
  // different by construction.
  if (occurrences.length > 1) {
    return {
      ok: false,
      error:
        `${key} appears ${occurrences.length} times in ${path.basename(filePath)} ` +
        `(lines ${occurrences.map((i) => i + 1).join(', ')}). Remove the duplicates by hand ` +
        'first — editing one of them may have no effect, and the running app and the next ' +
        'deploy read different occurrences.',
    }
  }

  // ⛔ THE BACKUP IS WRITTEN HERE, AFTER THE READ-SIDE REFUSALS AND NOT BEFORE
  // THEM. The refusals above change nothing, so they need no backup — and a
  // backup taken before them leaves an unreferenced copy of every secret in the
  // install directory that nothing reports and nobody would think to delete.
  // ⛔ THE STAMP CARRIES RANDOMNESS because it is only millisecond-resolution:
  // two saves in the same millisecond against the same file derive the SAME
  // backup path, so the first to finish deletes the file the second is about to
  // report.
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`
  const backupPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.${stamp}.bak`)
  try {
    fs.writeFileSync(backupPath, before.text, { encoding: 'utf8', mode: 0o600 })
  } catch (err: any) {
    // ⛔ A FAILED BACKUP WRITE CAN STILL HAVE LEFT A PARTIAL FILE. writeFileSync
    // opens and truncates before it can throw, so a mid-write ENOSPC/EIO leaves
    // a truncated copy holding part of NEXTAUTH_SECRET in the install
    // directory, under the DIRECTORY's wider ACL, named in no response and
    // deleted by nothing.
    try {
      fs.unlinkSync(backupPath)
    } catch {
      /* nothing to clean up */
    }
    return { ok: false, error: `Could not write a backup before changing the file: ${err.message}` }
  }

  if (occurrences.length === 1) {
    lines[occurrences[0]] = `${key}=${newValue}`
  } else {
    if (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push(`${key}=${newValue}`, '')
  }

  try {
    fs.writeFileSync(filePath, lines.join(eol), 'utf8')
  } catch (err: any) {
    // ⛔ THE TARGET MAY ALREADY BE TRUNCATED, SO MEASURE THE RESULTING STATE AND
    // SAY WHICH HAPPENED — do not assume it. A read-only or locked target fails
    // at OPEN, so nothing was truncated and the file is intact; announcing that
    // the secret store "may now be incomplete" there would send an operator to
    // restore a backup over a perfectly good file. An ENOSPC after open is the
    // case that really is damaged, and that one is restored.
    let state: FileState = 'unreadable'
    try {
      state = fs.readFileSync(filePath, 'utf8') === before.text ? 'unchanged' : 'damaged'
    } catch {
      /* leave it unreadable */
    }
    if (state === 'damaged') {
      try {
        fs.writeFileSync(filePath, before.text, 'utf8')
        state = 'restored'
      } catch {
        /* stays damaged */
      }
    }
    const SAID: Record<FileState, string> = {
      unchanged: 'Nothing was changed — the file is byte-for-byte as it was.',
      restored: 'The file had already been partially written and has been restored.',
      damaged:
        'IT IS NOW INCOMPLETE and could not be restored automatically — restore it by hand ' +
        'from the backup path below BEFORE restarting the service.',
      unreadable:
        'Its current state could not be read — check it by hand against the backup path ' +
        'below before restarting the service.',
    }
    return {
      ok: false,
      error: `Could not write ${path.basename(filePath)}: ${err.message}. ${SAID[state]}`,
      fileState: state,
      backupPath,
    }
  }

  // ⛔ THE SELF-CHECK. Read it back and prove nothing else moved.
  // ⛔ ITS OWN READ IS GUARDED: a bare read here means a transient EBUSY throws
  // out of setEnvValue AFTER the file has already been rewritten, and callers
  // expect a verdict object rather than an exception — so the operator gets an
  // opaque 500 with no backupPath and no recovery sentence, on the very field
  // this function exists to make recoverable.
  let after: { text: string; values: EnvValues }
  try {
    after = readEnvFile(filePath)
  } catch (err: any) {
    return {
      ok: false,
      error:
        `Wrote ${path.basename(filePath)} but could not read it back to verify it: ` +
        `${err.message}. The previous contents are at the backup path below.`,
      backupPath,
    }
  }
  const lost: string[] = []
  for (const [k, v] of Object.entries(before.values)) {
    if (k === key) continue
    if (!Object.prototype.hasOwnProperty.call(after.values, k) || after.values[k] !== v) lost.push(k)
  }
  if (lost.length > 0 || after.values[key] !== newValue) {
    try {
      fs.writeFileSync(filePath, before.text, 'utf8')
    } catch (err: any) {
      return {
        ok: false,
        error:
          `The file was written incorrectly (${lost.join(', ') || key}) AND could not be restored: ` +
          `${err.message}. Restore it by hand from ${backupPath}.`,
        backupPath,
      }
    }
    return {
      ok: false,
      error:
        `Writing ${key} would have changed ${lost.length} other value(s) (${lost.slice(0, 5).join(', ')}). ` +
        'Nothing was changed — the original file has been restored.',
      backupPath,
    }
  }

  // ⛔ THE BACKUP IS REMOVED ONCE THE SELF-CHECK HAS PROVEN THE WRITE. It exists
  // to recover from a FAILED write, and every failure path above keeps it and
  // reports its path. Left behind on SUCCESS it is a permanent second copy of
  // the file holding NEXTAUTH_SECRET and DATABASE_URL — and because it is
  // created in the install directory it inherits THAT directory's ACL, not the
  // env file's own, so it is readable by principals the original is not.
  // SecVault found five such copies on its reference deployment.
  // ⛔ `previous` is the real recovery information and is returned regardless; a
  // path to a file that no longer exists is worse than none, so the path is
  // reported ONLY while the file is still there.
  let backupRemoved = false
  try {
    fs.unlinkSync(backupPath)
    backupRemoved = true
  } catch {
    // Best effort. The write succeeded and was verified, which is what was
    // asked; a backup that cannot be removed is reported, never hidden.
  }

  return {
    ok: true,
    previous,
    backupPath: backupRemoved ? null : backupPath,
    unchanged: false,
  }
}
