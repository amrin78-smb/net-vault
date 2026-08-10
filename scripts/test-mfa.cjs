'use strict';
/**
 * test-mfa.cjs — verifies the TOTP implementation in lib/mfa.ts against the
 * OFFICIAL test vectors from RFC 6238 (TOTP), RFC 4226 (HOTP) and RFC 4648
 * (base32), plus the replay and encryption behaviour the login path depends on.
 *
 *   node scripts/test-mfa.cjs
 *
 * Why a hand-written runner rather than a framework: NetVault has no test
 * harness, and adding one to run a single file is more machinery than the thing
 * it tests. The point is that the algorithm is checked against the specification
 * rather than against itself — this is the file that proves an authenticator app
 * will actually agree with us.
 *
 * The crypto here MIRRORS lib/mfa.ts. If you change the algorithm there, this
 * must be updated in lockstep or it is verifying a copy that no longer ships.
 */
const crypto = require('crypto');
const assert = require('assert');

let pass = 0;
function ok(name) { console.log('  PASS', name); pass++; }

// ── Mirror of lib/mfa.ts ────────────────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const c = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of c) {
    const i = B32.indexOf(ch); if (i === -1) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secret).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}
const STEP = 30, WINDOW = 1;
function verifyTotp(secretB32, token, { minStep = null, nowMs = Date.now() } = {}) {
  const digits = String(token || '').replace(/\D/g, '');
  if (digits.length !== 6) return null;
  const secret = base32Decode(secretB32);
  if (!secret.length) return null;
  const step = Math.floor(nowMs / 1000 / STEP);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const s = step + d;
    if (minStep != null && s <= minStep) continue;
    if (hotp(secret, s) === digits) return s;
  }
  return null;
}

// ── RFC 6238 Appendix B (SHA-1 rows) ────────────────────────────────────────
const SEED = Buffer.from('12345678901234567890', 'ascii');
for (const [t, expected] of [
  [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
  [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
]) {
  assert.strictEqual(hotp(SEED, Math.floor(t / STEP)), expected, `RFC6238 T=${t}`);
}
ok('RFC 6238 Appendix B — all 6 SHA-1 vectors');

// ── RFC 4226 Appendix D (HOTP counters 0-9) ─────────────────────────────────
const HOTP_VEC = ['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489'];
HOTP_VEC.forEach((exp, c) => assert.strictEqual(hotp(SEED, c), exp, `RFC4226 c=${c}`));
ok('RFC 4226 Appendix D — counters 0-9');

// ── RFC 4648 base32 ─────────────────────────────────────────────────────────
assert.strictEqual(base32Encode(Buffer.from('foobar', 'ascii')), 'MZXW6YTBOI');
assert.ok(base32Decode(base32Encode(SEED)).equals(SEED));
ok('RFC 4648 base32 — known vector + round trip');

// ── An authenticator app would agree with us right now ──────────────────────
{
  const secret = base32Encode(crypto.randomBytes(20));
  const now = Date.now();
  const code = hotp(base32Decode(secret), Math.floor(now / 1000 / STEP));
  assert.strictEqual(verifyTotp(secret, code, { nowMs: now }), Math.floor(now / 1000 / STEP));
  ok('a freshly generated code verifies against its own secret');
}

// ── Drift window ────────────────────────────────────────────────────────────
{
  const secret = base32Encode(crypto.randomBytes(20));
  const now = Date.now();
  const step = Math.floor(now / 1000 / STEP);
  const prev = hotp(base32Decode(secret), step - 1);
  const next = hotp(base32Decode(secret), step + 1);
  assert.strictEqual(verifyTotp(secret, prev, { nowMs: now }), step - 1, 'previous step accepted');
  assert.strictEqual(verifyTotp(secret, next, { nowMs: now }), step + 1, 'next step accepted');
  const tooOld = hotp(base32Decode(secret), step - 2);
  assert.strictEqual(verifyTotp(secret, tooOld, { nowMs: now }), null, 'two steps back rejected');
  ok('drift window is exactly +/-1 step');
}

// ── Replay defence: this is the whole reason mfa_last_step exists ────────────
{
  const secret = base32Encode(crypto.randomBytes(20));
  const now = Date.now();
  const step = Math.floor(now / 1000 / STEP);
  const code = hotp(base32Decode(secret), step);
  const first = verifyTotp(secret, code, { nowMs: now, minStep: null });
  assert.strictEqual(first, step, 'first use accepted');
  const replay = verifyTotp(secret, code, { nowMs: now, minStep: first });
  assert.strictEqual(replay, null, 'the SAME code must not verify twice');
  const older = hotp(base32Decode(secret), step - 1);
  assert.strictEqual(verifyTotp(secret, older, { nowMs: now, minStep: first }), null,
    'an earlier still-in-window code must not verify after a later one');
  ok('replay rejected — a used code and any earlier one are refused');
}

// ── Junk input ──────────────────────────────────────────────────────────────
{
  const secret = base32Encode(crypto.randomBytes(20));
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '00000a']) {
    assert.strictEqual(verifyTotp(secret, bad), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(verifyTotp('', '123456'), null, 'rejects an empty secret');
  ok('malformed codes and empty secrets are rejected');
}

// ── Secret encryption round trip (mirrors lib/mfa.ts) ───────────────────────
{
  const KEY_INFO = 'nocvault-mfa-secret-encryption-v1';
  const KEY_SALT = 'nocvault-mfa-v1';
  const key = (s) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(s), Buffer.from(KEY_SALT), Buffer.from(KEY_INFO), 32));
  const enc = (plain, s) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(s), iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  };
  const dec = (stored, s) => {
    if (!stored || !stored.startsWith('v1:')) return null;
    try {
      const raw = Buffer.from(stored.slice(3), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key(s), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch { return null; }
  };
  const secret = base32Encode(crypto.randomBytes(20));
  const blob = enc(secret, 'test-secret-value');
  assert.strictEqual(dec(blob, 'test-secret-value'), secret, 'round trips');
  assert.ok(!blob.includes(secret), 'ciphertext must not contain the plaintext');
  // A different NEXTAUTH_SECRET must fail CLOSED (null), never throw or return junk.
  assert.strictEqual(dec(blob, 'a-different-secret'), null, 'wrong key -> null');
  // Tampering must be detected by the GCM tag, not silently decrypted.
  const tampered = 'v1:' + Buffer.concat([
    Buffer.from(blob.slice(3), 'base64').subarray(0, 28),
    Buffer.from('tampered-ciphertext'),
  ]).toString('base64');
  assert.strictEqual(dec(tampered, 'test-secret-value'), null, 'tampered -> null');
  assert.strictEqual(dec('not-a-blob', 'test-secret-value'), null, 'garbage -> null');
  assert.strictEqual(dec(null, 'test-secret-value'), null, 'null -> null');
  ok('secret encryption: round trip, wrong key, tampering and junk all fail closed');
}

console.log(`\n${pass} MFA assertion groups passed.`);
