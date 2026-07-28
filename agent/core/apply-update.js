'use strict';
/**
 * core/apply-update.js — crash-safe apply-on-next-start swap + rollback.
 *
 * NocVault Agents Phase 3, Workstream B. The updater (core/updater.js) verifies a
 * signed manifest and STAGES the new files under <dir>/pending/ with an apply-marker
 * <dir>/pending/APPLY.json, then exits so NSSM restarts the process. This module is
 * what the restarted entrypoint calls, BEFORE loading the modules that a pending
 * update would replace, to actually perform the swap — mirroring the battle-tested
 * NetVault updater's stop → swap → verify → rollback discipline.
 *
 * A bad apply or rollback would BRICK an agent on a live fleet, so every step is
 * crash-safe and NOTHING here throws: each function catches, logs, and returns a
 * safe result. Markers are written atomically (tmp + rename).
 *
 * Flow across restarts:
 *   1. applyPendingIfAny(dir): pending/APPLY.json present → back up current files to
 *      backup/, move pending/ files into place, verify sha256; on success write
 *      .update-confirm.json {version, backup, newlyAdded, attempts:1} and delete
 *      pending/; on ANY failure restore from backup/ and continue on the old build.
 *   2. checkConfirmOnStart(dir): .update-confirm.json present → if attempts >= 3 the
 *      new build has crash-looped → ROLL BACK from backup/; else increment attempts
 *      (so a crash on THIS boot is counted) and return {confirming:true}.
 *   3. commitUpdate(dir): once the new build has started healthy, delete the confirm
 *      marker + backup/ — the update is committed.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MOVE_RETRIES = 5;
const MOVE_RETRY_DELAY_MS = 120;
const MAX_ATTEMPTS = 3;

function noopLogger() {
  return { info: () => {}, error: () => {} };
}
function mkLog(logger) {
  const l = logger || {};
  return {
    info: typeof l.info === 'function' ? l.info.bind(l) : () => {},
    error: typeof l.error === 'function' ? l.error.bind(l) : () => {},
  };
}

// Synchronous sleep (no async in the boot-critical apply path). Uses Atomics.wait on
// a throwaway buffer — blocks the current thread for `ms` without a busy spin.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_e) {
    // SharedArrayBuffer unavailable — fall back to a short busy wait.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Atomic marker write: tmp + rename (atomic on the same volume).
function writeJsonAtomic(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_e) {
    /* best-effort */
  }
}

// Move src -> dest, retrying on Windows EBUSY/EPERM (a file the previous process may
// still be releasing). Ensures the dest parent exists. Throws if it can't complete.
function moveWithRetry(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let i = 0; i < MOVE_RETRIES; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
        // Cross-device or transient lock — try a copy+unlink fallback on the last
        // couple of attempts, else back off and retry the rename.
        if (i >= MOVE_RETRIES - 2) {
          try {
            fs.copyFileSync(src, dest);
            try {
              fs.unlinkSync(src);
            } catch (_e) {
              /* the copy is what matters; a leftover src is cleaned with pending/ */
            }
            return;
          } catch (_e2) {
            /* fall through to retry/back off */
          }
        }
        sleepSync(MOVE_RETRY_DELAY_MS);
        continue;
      }
      if (e && e.code === 'EXDEV') {
        // Different volume — rename can't cross it; copy+unlink.
        fs.copyFileSync(src, dest);
        try {
          fs.unlinkSync(src);
        } catch (_e) {
          /* ignore */
        }
        return;
      }
      throw e;
    }
  }
  throw lastErr || new Error('move failed: ' + src);
}

// Restore the previous tree from backup/: copy every backed-up file back over the
// live path, and delete every newly-added file (which has no backup). Best-effort on
// each entry — a rollback must push through as much as it can.
function restoreFromBackup(dir, backup, newlyAdded, log) {
  const backupDir = path.join(dir, 'backup');
  for (const rel of backup || []) {
    try {
      const from = path.join(backupDir, rel);
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } catch (e) {
      log.error('rollback: could not restore', rel, '-', e && e.message ? e.message : String(e));
    }
  }
  for (const rel of newlyAdded || []) {
    try {
      fs.unlinkSync(path.join(dir, rel));
    } catch (_e) {
      /* already gone — fine */
    }
  }
}

/**
 * applyPendingIfAny(dir, logger) -> { applied:boolean, version?, error? }
 * Performs the staged swap if <dir>/pending/APPLY.json exists. Never throws.
 */
function applyPendingIfAny(dir, logger) {
  const log = mkLog(logger);
  const pendingDir = path.join(dir, 'pending');
  const applyMarker = path.join(pendingDir, 'APPLY.json');
  const backupDir = path.join(dir, 'backup');

  if (!fs.existsSync(applyMarker)) {
    return { applied: false };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(applyMarker, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    log.error('apply: unreadable APPLY.json — discarding pending update:', e && e.message ? e.message : String(e));
    rmrf(pendingDir);
    return { applied: false, error: 'unreadable-marker' };
  }
  const files = manifest && Array.isArray(manifest.files) ? manifest.files : null;
  if (!files || files.length === 0) {
    log.error('apply: APPLY.json has no files — discarding pending update');
    rmrf(pendingDir);
    return { applied: false, error: 'empty-marker' };
  }

  // Fresh backup dir for this apply.
  rmrf(backupDir);
  const backedUp = [];
  const newlyAdded = [];

  try {
    // (a) Back up the CURRENT bytes of each target file (or record a newly-added one).
    for (const f of files) {
      const rel = f.path;
      const live = path.join(dir, rel);
      if (fs.existsSync(live)) {
        const bkp = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(bkp), { recursive: true });
        fs.copyFileSync(live, bkp);
        backedUp.push(rel);
      } else {
        newlyAdded.push(rel); // no live file → this update ADDS it; rollback deletes it
      }
    }

    // (b) Move each staged file into place.
    for (const f of files) {
      const staged = path.join(pendingDir, f.path);
      const live = path.join(dir, f.path);
      moveWithRetry(staged, live);
    }

    // (c) Verify each applied file's sha256 against the marker.
    for (const f of files) {
      const live = path.join(dir, f.path);
      const got = sha256File(live);
      if (got !== String(f.sha256).toLowerCase()) {
        throw new Error(`post-apply sha256 mismatch for ${f.path} (expected ${f.sha256}, got ${got})`);
      }
    }
  } catch (e) {
    // (e) ANY failure at (a)-(c) → restore the previous tree and stay on the old build.
    log.error('apply: FAILED — rolling back:', e && e.message ? e.message : String(e));
    restoreFromBackup(dir, backedUp, newlyAdded, log);
    rmrf(pendingDir);
    rmrf(backupDir);
    return { applied: false, error: e && e.message ? e.message : String(e) };
  }

  // (d) Success — write the confirm marker (retained with backup/ for the crash-loop
  //     rollback in checkConfirmOnStart), then drop pending/.
  try {
    writeJsonAtomic(path.join(dir, '.update-confirm.json'), {
      version: manifest.version,
      backup: backedUp,
      newlyAdded,
      attempts: 1,
    });
  } catch (e) {
    // The files ARE applied and verified; only the confirm marker failed. Roll back
    // so we don't run an unconfirmable build with no safety net.
    log.error('apply: applied but could not write confirm marker — rolling back:', e && e.message ? e.message : String(e));
    restoreFromBackup(dir, backedUp, newlyAdded, log);
    rmrf(pendingDir);
    rmrf(backupDir);
    return { applied: false, error: 'confirm-write-failed' };
  }

  rmrf(pendingDir);
  return { applied: true, version: manifest.version };
}

/**
 * checkConfirmOnStart(dir, logger) -> { rolledBack?:true } | { confirming?:true } | {}
 * Runs on every boot. Never throws.
 *   - No .update-confirm.json           -> {}
 *   - attempts >= MAX_ATTEMPTS (crash-loop) -> ROLL BACK from backup/, return {rolledBack:true}
 *   - otherwise                          -> increment attempts, return {confirming:true}
 */
function checkConfirmOnStart(dir, logger) {
  const log = mkLog(logger);
  const confirmPath = path.join(dir, '.update-confirm.json');
  const backupDir = path.join(dir, 'backup');

  if (!fs.existsSync(confirmPath)) return {};

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(confirmPath, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    // Unreadable marker — clear it (and its backup) so we don't loop on it forever.
    log.error('confirm: unreadable .update-confirm.json — clearing:', e && e.message ? e.message : String(e));
    rmrf(confirmPath);
    rmrf(backupDir);
    return {};
  }

  const attempts = typeof marker.attempts === 'number' ? marker.attempts : 1;

  if (attempts >= MAX_ATTEMPTS) {
    // The new build has failed to start healthy MAX_ATTEMPTS times — roll back.
    log.error(`confirm: new build crash-looped (${attempts} attempts) — rolling back to previous version`);
    restoreFromBackup(dir, marker.backup, marker.newlyAdded, log);
    rmrf(confirmPath);
    rmrf(backupDir);
    return { rolledBack: true };
  }

  // Count THIS boot: if the new build crashes before commitUpdate, the next boot sees
  // the incremented attempts and can eventually roll back.
  try {
    writeJsonAtomic(confirmPath, {
      version: marker.version,
      backup: marker.backup || [],
      newlyAdded: marker.newlyAdded || [],
      attempts: attempts + 1,
    });
  } catch (e) {
    log.error('confirm: could not bump attempts:', e && e.message ? e.message : String(e));
  }
  return { confirming: true };
}

/**
 * commitUpdate(dir) — called once the new build has started healthy. Deletes the
 * confirm marker + backup/. Never throws.
 */
function commitUpdate(dir) {
  rmrf(path.join(dir, '.update-confirm.json'));
  rmrf(path.join(dir, 'backup'));
}

module.exports = {
  applyPendingIfAny,
  checkConfirmOnStart,
  commitUpdate,
  // Exposed for tests/introspection.
  _MAX_ATTEMPTS: MAX_ATTEMPTS,
};
