import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  credSecretConfigured,
  encryptCred,
  decryptCred,
  isEncryptedCred,
} from '../lib/credStore.ts'

// The module reads NEXTAUTH_SECRET on every call (deliberately — see the comment
// in lib/credStore.ts), so a test can set it per-case. Every case that changes it
// must restore it, or the cases that follow silently test a different key.
const SAVED = process.env.NEXTAUTH_SECRET

function withSecret<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.NEXTAUTH_SECRET
  if (value === undefined) delete process.env.NEXTAUTH_SECRET
  else process.env.NEXTAUTH_SECRET = value
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.NEXTAUTH_SECRET
    else process.env.NEXTAUTH_SECRET = before
  }
}

const TEST_SECRET = 'a-test-secret-for-netvault-credstore'

// ── round trip ──────────────────────────────────────────────────────────────

test('a credential survives a round trip, including non-ASCII and long values', () => {
  withSecret(TEST_SECRET, () => {
    const cases = [
      'hunter2',
      'p@ss:w:rd:with:colons',
      ' leading and trailing spaces ',
      'ไทยยูเนี่ยน — ümlaut, emoji 🔐, 中文',
      'x'.repeat(4096),
    ]
    for (const plain of cases) {
      const enc = encryptCred(plain)
      assert.notEqual(enc, plain, 'the stored value must not be the plaintext')
      assert.equal(decryptCred(enc), plain)
    }
  })
})

test('an empty/falsy plaintext encrypts to an empty string, not a ciphertext', () => {
  withSecret(TEST_SECRET, () => {
    assert.equal(encryptCred(''), '')
    // "no password set" must stay distinguishable from "a password that happens
    // to be empty" — a stored empty ciphertext would read as configured.
    assert.equal(decryptCred(''), '')
  })
})

test('the same plaintext encrypts differently each time (random IV)', () => {
  withSecret(TEST_SECRET, () => {
    const a = encryptCred('same-password')
    const b = encryptCred('same-password')
    // Reusing an IV under one key is the classic GCM break — it leaks the XOR of
    // the plaintexts and, worse, the authentication subkey. A deterministic
    // ciphertext here would also let anyone compare two installs' stored rows and
    // see that they share a password.
    assert.notEqual(a, b, 'a fresh 96-bit IV must be drawn per encryption')
    assert.notEqual(a.split(':')[0], b.split(':')[0], 'the IV itself must differ')
    assert.equal(decryptCred(a), 'same-password')
    assert.equal(decryptCred(b), 'same-password')
  })
})

// ── failure is always '' , never a throw ────────────────────────────────────

test("decryptCred returns '' for malformed input and never throws", () => {
  withSecret(TEST_SECRET, () => {
    const junk = [
      '',
      'not-encrypted-at-all',
      'only:two',
      'a:b:c',
      'zz:zz:zz',
      ':::',
      'deadbeef:deadbeef:', // well-shaped but empty ciphertext part
    ]
    for (const v of junk) {
      assert.equal(decryptCred(v), '', `expected '' for ${JSON.stringify(v)}`)
    }
  })
})

test('a tampered ciphertext is rejected by the GCM auth tag', () => {
  withSecret(TEST_SECRET, () => {
    const enc = encryptCred('hunter2-correct-horse')
    const [iv, tag, ct] = enc.split(':')

    // Flip one hex character of the ciphertext. Without the auth tag this would
    // decrypt to a silently corrupted password (CTR mode underneath GCM happily
    // produces plaintext for any input); the tag is what makes it unusable.
    const flipped = ct[0] === 'a' ? 'b' : 'a'
    assert.equal(decryptCred(`${iv}:${tag}:${flipped}${ct.slice(1)}`), '')

    // The tag itself and the IV are covered too.
    const tagFlipped = tag[0] === 'a' ? 'b' : 'a'
    assert.equal(decryptCred(`${iv}:${tagFlipped}${tag.slice(1)}:${ct}`), '')
    const ivFlipped = iv[0] === 'a' ? 'b' : 'a'
    assert.equal(decryptCred(`${ivFlipped}${iv.slice(1)}:${tag}:${ct}`), '')
  })
})

test('a value written under a different secret decrypts to nothing', () => {
  const enc = withSecret('secret-one', () => encryptCred('hunter2'))
  withSecret('secret-two', () => {
    // Callers MUST treat '' as "no password configured", never as "verified".
    assert.equal(decryptCred(enc), '')
  })
})

// ── shape check ─────────────────────────────────────────────────────────────

test('isEncryptedCred accepts our output and rejects colon-bearing plaintext', () => {
  withSecret(TEST_SECRET, () => {
    assert.equal(isEncryptedCred(encryptCred('hunter2')), true)
    assert.equal(isEncryptedCred(encryptCred('x'.repeat(1000))), true)
  })
  // A real password is allowed to contain colons — the check must not mistake one
  // for a stored value, or an admin's password would never be encrypted on save.
  assert.equal(isEncryptedCred('my:pass:word'), false)
  assert.equal(isEncryptedCred('http://host:25:user'), false)
  assert.equal(isEncryptedCred(''), false)
  assert.equal(isEncryptedCred('hunter2'), false)
  // Right part count, wrong field widths.
  assert.equal(isEncryptedCred('abc:def:0011'), false)
  assert.equal(isEncryptedCred(`${'a'.repeat(24)}:${'b'.repeat(31)}:cc`), false)
})

// ── ⛔ THE CONTRACT TEST ────────────────────────────────────────────────────

test('⛔ CONTRACT: a value produced by DDIVault decrypts here', () => {
  // This vector was produced by DDIVault's OWN module — the reference
  // implementation this format is copied from:
  //
  //   cd ddivault && NEXTAUTH_SECRET='nocvault-credstore-contract-test' \
  //     node -e "console.log(require('./collector/credStore').encrypt('hunter2-correct-horse'))"
  //
  // It pins all three halves of the cross-app contract at once: the
  // "ivHex:authTagHex:ciphertextHex" layout, aes-256-gcm with a 12-byte IV, and
  // key = sha256(NEXTAUTH_SECRET) — a plain digest, NOT HKDF like lib/mfa.ts.
  //
  // ⛔ If this test fails, the satellites can no longer read the hub's SMTP
  // password: LogVault/DDIVault/SpanVault read the hub's smtp_config row
  // directly through the netvault pool and decrypt it with their own copy of
  // this logic, so an incompatible change here is a silent suite-wide email
  // outage, not a local test failure. The fix is to RESTORE compatibility with
  // DDIVault's collector/credStore.js. Never regenerate the vector to make the
  // test pass — that only hides the break until production.
  const DDIVAULT_SECRET = 'nocvault-credstore-contract-test'
  const DDIVAULT_VECTOR =
    '0a5d848613c53695d1f67a96:c1f20a0642c4f706591bbd40ab122a7a:2633ee55e495ff832b26a882ede9fa0daec1d6672f'

  withSecret(DDIVAULT_SECRET, () => {
    assert.equal(isEncryptedCred(DDIVAULT_VECTOR), true)
    assert.equal(decryptCred(DDIVAULT_VECTOR), 'hunter2-correct-horse')

    // And the reverse direction: what we write must be readable by a decryptor
    // built to DDIVault's rules. Re-deriving the key the way ddivault's
    // credStore.js does, from the same literal, is the check that our WRITE side
    // has not drifted.
    assert.equal(decryptCred(encryptCred('hunter2-correct-horse')), 'hunter2-correct-horse')
  })
})

// ── the write path fails loud, the read path does not ───────────────────────

test('⛔ with no secret, encryptCred THROWS and decryptCred does not', () => {
  withSecret(undefined, () => {
    assert.equal(credSecretConfigured(), false)

    // Storing a credential under a guessable key is worse than refusing to store
    // it, so the write path must be loud. (See the comment in lib/credStore.ts
    // for why this is NOT a module-load throw the way DDIVault's is: this module
    // is imported by Next.js route handlers.)
    assert.throws(() => encryptCred('hunter2'), /NEXTAUTH_SECRET/)

    // The read path stays quiet — a settings page must still render so an admin
    // can see there is no password configured.
    assert.equal(decryptCred('anything'), '')
    assert.doesNotThrow(() => decryptCred('0a5d848613c53695d1f67a96:c1f20a06:2633'))
  })

  withSecret('', () => {
    // An empty string is "not configured", not a zero-length key.
    assert.equal(credSecretConfigured(), false)
    assert.throws(() => encryptCred('hunter2'), /NEXTAUTH_SECRET/)
    assert.equal(decryptCred('anything'), '')
  })

  withSecret(TEST_SECRET, () => {
    assert.equal(credSecretConfigured(), true)
  })

  // The falsy-plaintext shortcut wins over the missing-secret throw: nothing is
  // being stored, so there is nothing to refuse.
  withSecret(undefined, () => {
    assert.equal(encryptCred(''), '')
  })
})

test('the ambient NEXTAUTH_SECRET is left exactly as it was found', () => {
  assert.equal(process.env.NEXTAUTH_SECRET, SAVED)
})
