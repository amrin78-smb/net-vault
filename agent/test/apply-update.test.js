'use strict';
/**
 * Apply-update test (Phase 3, Workstream B) — the crash-safe swap + rollback.
 *
 * Drives core/apply-update.js against real temp dirs (pure fs, no network, no boot):
 *   applyPendingIfAny — SUCCESS: staged pending/ files move into place, sha256 is
 *     verified, .update-confirm.json is written, pending/ is removed, backup/ retained.
 *   applyPendingIfAny — ROLLBACK: a staged file whose bytes don't match APPLY.json
 *     fails post-apply verify → originals are restored, backup/ + pending/ cleaned, and
 *     NO confirm marker is left.
 *   applyPendingIfAny — newly-added file rollback: an added-file update that fails
 *     verify deletes the added file on rollback (no stray new file).
 *   checkConfirmOnStart — attempts increments; attempts >= 3 rolls back from backup/.
 *   commitUpdate — clears the confirm marker + backup/.
 *
 * `node test/apply-update.test.js` — exits non-zero on failure.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyPendingIfAny, checkConfirmOnStart, commitUpdate } = require('../core/apply-update');

let passed = 0;
const ok = (n) => {
  console.log('  PASS', n);
  passed++;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const silentLogger = { info() {}, error() {} };

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nvagent-apply-' + tag + '-'));
}
function writeFile(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function readFile(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}
// Stage a pending/ tree + APPLY.json exactly as core/updater.js would. `shaOverride`
// lets a test record a WRONG sha in the marker to force a post-apply verify failure.
function stagePending(dir, files) {
  for (const f of files) {
    writeFile(dir, path.join('pending', f.path), f.staged);
  }
  const marker = {
    version: '3.0.0',
    files: files.map((f) => ({ path: f.path, sha256: f.markerSha || sha256(Buffer.from(f.staged)) })),
  };
  writeFile(dir, path.join('pending', 'APPLY.json'), JSON.stringify(marker, null, 2));
}

// ── applyPendingIfAny — SUCCESS ─────────────────────────────────────────────────
(() => {
  const dir = tmpDir('ok');
  try {
    // Current tree: two existing files + (no c.js — it's an add).
    writeFile(dir, 'core/hub.js', 'OLD hub');
    writeFile(dir, 'nocvault-agent.js', 'OLD entry');

    stagePending(dir, [
      { path: 'core/hub.js', staged: 'NEW hub' },
      { path: 'nocvault-agent.js', staged: 'NEW entry' },
      { path: 'modules/new/index.js', staged: 'NEW module' }, // newly-added
    ]);

    const res = applyPendingIfAny(dir, silentLogger);
    assert.strictEqual(res.applied, true, 'applied:true on success');
    assert.strictEqual(res.version, '3.0.0', 'reports the applied version');

    // New bytes are live.
    assert.strictEqual(readFile(dir, 'core/hub.js'), 'NEW hub', 'hub.js swapped');
    assert.strictEqual(readFile(dir, 'nocvault-agent.js'), 'NEW entry', 'entry swapped');
    assert.strictEqual(readFile(dir, 'modules/new/index.js'), 'NEW module', 'new module added');

    // pending/ removed; backup/ + confirm marker retained.
    assert.ok(!fs.existsSync(path.join(dir, 'pending')), 'pending/ removed after apply');
    assert.ok(fs.existsSync(path.join(dir, 'backup')), 'backup/ retained for crash-loop rollback');
    const confirm = JSON.parse(readFile(dir, '.update-confirm.json'));
    assert.strictEqual(confirm.version, '3.0.0', 'confirm marker version');
    assert.strictEqual(confirm.attempts, 1, 'confirm marker starts at attempts:1');
    assert.deepStrictEqual(confirm.backup.sort(), ['core/hub.js', 'nocvault-agent.js'].sort(), 'backup lists replaced files');
    assert.deepStrictEqual(confirm.newlyAdded, ['modules/new/index.js'], 'newlyAdded lists the added file');

    // Backup holds the ORIGINAL bytes.
    assert.strictEqual(readFile(dir, 'backup/core/hub.js'), 'OLD hub', 'backup has old hub bytes');
    ok('applyPendingIfAny SUCCESS: files swapped, marker written, pending removed, backup kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ── applyPendingIfAny — ROLLBACK (post-apply sha mismatch) ──────────────────────
(() => {
  const dir = tmpDir('rollback');
  try {
    writeFile(dir, 'core/hub.js', 'OLD hub');
    writeFile(dir, 'nocvault-agent.js', 'OLD entry');

    // b's staged bytes are 'CORRUPT' but the marker records the sha of 'GOOD entry' —
    // post-apply verify will fail on nocvault-agent.js and trigger rollback.
    stagePending(dir, [
      { path: 'core/hub.js', staged: 'NEW hub' },
      { path: 'nocvault-agent.js', staged: 'CORRUPT', markerSha: sha256(Buffer.from('GOOD entry')) },
    ]);

    const res = applyPendingIfAny(dir, silentLogger);
    assert.strictEqual(res.applied, false, 'applied:false on verify failure');
    assert.ok(res.error, 'an error reason is returned');

    // Both files restored to their ORIGINAL bytes.
    assert.strictEqual(readFile(dir, 'core/hub.js'), 'OLD hub', 'hub.js rolled back to original');
    assert.strictEqual(readFile(dir, 'nocvault-agent.js'), 'OLD entry', 'entry rolled back to original');

    // No stray markers or staging dirs.
    assert.ok(!fs.existsSync(path.join(dir, 'pending')), 'pending/ cleaned after rollback');
    assert.ok(!fs.existsSync(path.join(dir, 'backup')), 'backup/ cleaned after rollback');
    assert.ok(!fs.existsSync(path.join(dir, '.update-confirm.json')), 'no confirm marker after rollback');
    ok('applyPendingIfAny ROLLBACK: verify failure restores originals, cleans markers');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ── applyPendingIfAny — ROLLBACK deletes a newly-added file ─────────────────────
(() => {
  const dir = tmpDir('rollback-add');
  try {
    writeFile(dir, 'core/hub.js', 'OLD hub');
    // 'modules/new/index.js' does NOT exist → it's an add; force its verify to fail.
    stagePending(dir, [
      { path: 'core/hub.js', staged: 'NEW hub' },
      { path: 'modules/new/index.js', staged: 'ADDED', markerSha: sha256(Buffer.from('DIFFERENT')) },
    ]);

    const res = applyPendingIfAny(dir, silentLogger);
    assert.strictEqual(res.applied, false, 'applied:false');
    assert.strictEqual(readFile(dir, 'core/hub.js'), 'OLD hub', 'existing file restored');
    assert.ok(!fs.existsSync(path.join(dir, 'modules/new/index.js')), 'newly-added file deleted on rollback');
    ok('applyPendingIfAny ROLLBACK: deletes newly-added file that had no backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ── applyPendingIfAny — no pending → no-op ──────────────────────────────────────
(() => {
  const dir = tmpDir('none');
  try {
    const res = applyPendingIfAny(dir, silentLogger);
    assert.deepStrictEqual(res, { applied: false }, 'no pending update → { applied:false } and no marker');
    assert.ok(!fs.existsSync(path.join(dir, '.update-confirm.json')), 'no confirm marker written');
    ok('applyPendingIfAny NO-OP: no pending/ → clean no-op');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ── checkConfirmOnStart — attempts increments ───────────────────────────────────
(() => {
  const dir = tmpDir('confirm-inc');
  try {
    writeFile(dir, 'backup/core/hub.js', 'OLD hub');
    writeFile(dir, 'core/hub.js', 'NEW hub');
    writeFile(dir, '.update-confirm.json', JSON.stringify({
      version: '3.0.0', backup: ['core/hub.js'], newlyAdded: [], attempts: 1,
    }));

    const res = checkConfirmOnStart(dir, silentLogger);
    assert.deepStrictEqual(res, { confirming: true }, 'returns { confirming:true } below the limit');
    const marker = JSON.parse(readFile(dir, '.update-confirm.json'));
    assert.strictEqual(marker.attempts, 2, 'attempts incremented to 2');
    assert.strictEqual(readFile(dir, 'core/hub.js'), 'NEW hub', 'new build left in place (no rollback yet)');
    ok('checkConfirmOnStart: increments attempts, no rollback below the limit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ── checkConfirmOnStart — attempts >= 3 → ROLLBACK ──────────────────────────────
(() => {
  const dir = tmpDir('confirm-rollback');
  try {
    writeFile(dir, 'backup/core/hub.js', 'OLD hub');
    writeFile(dir, 'backup/nocvault-agent.js', 'OLD entry');
    writeFile(dir, 'core/hub.js', 'NEW hub'); // the crash-looping new build
    writeFile(dir, 'nocvault-agent.js', 'NEW entry');
    writeFile(dir, 'modules/new/index.js', 'ADDED new module'); // a newly-added file
    writeFile(dir, '.update-confirm.json', JSON.stringify({
      version: '3.0.0',
      backup: ['core/hub.js', 'nocvault-agent.js'],
      newlyAdded: ['modules/new/index.js'],
      attempts: 3,
    }));

    const res = checkConfirmOnStart(dir, silentLogger);
    assert.deepStrictEqual(res, { rolledBack: true }, 'returns { rolledBack:true } at the crash-loop limit');

    // Originals restored from backup/, the added file removed, markers cleaned.
    assert.strictEqual(readFile(dir, 'core/hub.js'), 'OLD hub', 'hub.js rolled back to previous version');
    assert.strictEqual(readFile(dir, 'nocvault-agent.js'), 'OLD entry', 'entry rolled back to previous version');
    assert.ok(!fs.existsSync(path.join(dir, 'modules/new/index.js')), 'newly-added file removed on rollback');
    assert.ok(!fs.existsSync(path.join(dir, '.update-confirm.json')), 'confirm marker cleared after rollback');
    assert.ok(!fs.existsSync(path.join(dir, 'backup')), 'backup/ cleared after rollback');
    ok('checkConfirmOnStart: attempts>=3 rolls back from backup/ and cleans up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ── commitUpdate — clears marker + backup ───────────────────────────────────────
(() => {
  const dir = tmpDir('commit');
  try {
    writeFile(dir, 'backup/core/hub.js', 'OLD hub');
    writeFile(dir, '.update-confirm.json', JSON.stringify({ version: '3.0.0', backup: ['core/hub.js'], newlyAdded: [], attempts: 2 }));

    commitUpdate(dir);
    assert.ok(!fs.existsSync(path.join(dir, '.update-confirm.json')), 'confirm marker deleted');
    assert.ok(!fs.existsSync(path.join(dir, 'backup')), 'backup/ deleted');
    // Safe to call again (no-op, no throw).
    assert.doesNotThrow(() => commitUpdate(dir), 'commitUpdate is idempotent / never throws');
    ok('commitUpdate: clears confirm marker + backup/ (idempotent)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ── Full round trip: apply → confirm → commit ───────────────────────────────────
(() => {
  const dir = tmpDir('roundtrip');
  try {
    writeFile(dir, 'core/hub.js', 'OLD hub');
    stagePending(dir, [{ path: 'core/hub.js', staged: 'NEW hub' }]);

    const applyRes = applyPendingIfAny(dir, silentLogger);
    assert.strictEqual(applyRes.applied, true, 'round-trip apply succeeds');

    const confirmRes = checkConfirmOnStart(dir, silentLogger);
    assert.deepStrictEqual(confirmRes, { confirming: true }, 'first healthy boot confirms');

    commitUpdate(dir);
    assert.ok(!fs.existsSync(path.join(dir, '.update-confirm.json')), 'commit clears the marker');
    assert.ok(!fs.existsSync(path.join(dir, 'backup')), 'commit clears the backup');
    assert.strictEqual(readFile(dir, 'core/hub.js'), 'NEW hub', 'committed build is live');

    // A subsequent boot is a clean no-op.
    assert.deepStrictEqual(checkConfirmOnStart(dir, silentLogger), {}, 'no marker after commit → clean boot');
    ok('round trip: apply → confirm → commit → clean subsequent boot');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

console.log(`\n${passed} apply-update assertions passed.`);
