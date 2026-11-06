//
// components/settings/systemPanelHelpers.ts — the judgements the three system
// settings panels (Console address, Certificate, Single sign-on) make about
// what the API told them.
//
// ⛔ PURE, AND SEPARATE FROM THE PANELS FOR ONE REASON: every function here is
// a place where a three-state fact could be flattened into a two-state one.
// `unknown` rendered as `clear`, `failed` rendered as `disabled`, "saved but
// not running" rendered as "saved" — each of those is a sentence that tells an
// operator the opposite of the truth, and none of them is visible in a
// screenshot. They are testable only if they do not live inside JSX, so they
// do not live inside JSX. See `tests/systemPanels.test.ts`.
//
// ⛔ NOTHING HERE DECIDES ANYTHING THE API ALREADY DECIDED. The routes compute
// `shadowVerdict`, `restartPendingFields`, `daysRemaining`, `status` and the
// refusal text; this module only chooses how each one READS. Re-deriving a
// judgement in the browser would be a second implementation of it, and the two
// would eventually disagree — in this feature the disagreement is "nobody can
// sign in".
//
// ⛔ NO COLOUR LITERALS. Every tone resolves to a `--tint-*` / `--tint-*-fg`
// pair from `app/globals.css`, because a hardcoded hex does not flip in dark
// mode (CLAUDE.md, "Typography & design tokens").

/** The five surfaces a callout or badge can take. */
export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral'

export type ToneStyle = { background: string; color: string; borderColor: string }

/**
 * A tone as CSS custom properties.
 *
 * ⛔ THE BACKGROUND AND THE TEXT COME FROM THE SAME PAIR. `--tint-warn` on
 * `--text-secondary` is unreadable in dark mode; the `-fg` half of each pair
 * exists precisely so a tinted surface stays legible in both themes.
 */
export function toneStyle(tone: Tone): ToneStyle {
  switch (tone) {
    case 'ok':
      return { background: 'var(--tint-success)', color: 'var(--tint-success-fg)', borderColor: 'var(--tint-success-fg)' }
    case 'info':
      return { background: 'var(--tint-info)', color: 'var(--tint-info-fg)', borderColor: 'var(--tint-info-fg)' }
    case 'warn':
      return { background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', borderColor: 'var(--tint-warn-fg)' }
    case 'danger':
      return { background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', borderColor: 'var(--tint-danger-fg)' }
    default:
      return { background: 'var(--surface-subtle)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }
  }
}

// ─── transport (the three TLS states) ────────────────────────────────────────

export type TransportPresentation = {
  tone: Tone
  /** Short badge text. */
  label: string
  /** One line an operator can act on. */
  headline: string
  /**
   * ⛔ TRUE ONLY FOR `failed`. The operator asked for TLS and is not getting
   * it; this is the one transport state that has to be loud.
   */
  loud: boolean
  /** ⛔ TRUE ONLY FOR `disabled` — not configured is how the suite has always
   *  shipped, and it is NOT an error. */
  normal: boolean
}

/**
 * How each of the three transport states reads.
 *
 * ⛔ THREE STATES, NEVER TWO, AND `failed` MUST NEVER READ LIKE `disabled`.
 * `disabled` means nobody configured TLS: plain HTTP, normal, no alarm.
 * `failed` means somebody DID configure it and the server is serving plaintext
 * anyway — the reader's natural conclusion ("we're encrypted") is the exact
 * opposite of the truth, which is why it is the only one that gets `danger`.
 *
 * ⛔ AN UNRECOGNISED OR ABSENT STATUS IS `warn`, NOT `ok`. It means we have not
 * learned the transport yet (the GET failed, or the API grew a state this build
 * does not know); reporting that as healthy is the same failed-read-recorded-as
 * -a-fact mistake one level up.
 */
export function transportPresentation(
  status: string | null | undefined,
  opts: {
    httpsPort?: number | null
    httpPort?: number | null
    error?: string | null
    /**
     * ⛔ WHETHER A TERMINATOR IS IN FRONT CHANGES WHAT EVERY PORT NUMBER MEANS.
     * `resolveTlsConfig` reads `HTTPS_PORT || PORT` from THIS process, and
     * after the TLS cutover this process's PORT is its LOOPBACK port — 13000 —
     * where it serves PLAIN HTTP behind NocVault-Tls. Reported unchanged, the
     * panel said "Serving HTTPS on port 13000", which is wrong twice over: the
     * app is not serving HTTPS, and 13000 is not the port anyone connects to.
     * Observed on production 2026-11-06.
     *
     * The decision layer is NOT changed to fix this — the terminator itself
     * resolves its listening ports through the same function, so moving those
     * semantics would move where it binds. This is a reporting frame, and it
     * belongs in the reporting layer.
     */
    fronted?: boolean | null
    /** The port the browser actually connects to when `fronted`. */
    publicPort?: number | null
  } = {},
): TransportPresentation {
  const httpsPort = typeof opts.httpsPort === 'number' ? opts.httpsPort : null
  const httpPort = typeof opts.httpPort === 'number' ? opts.httpPort : null
  const publicPort = typeof opts.publicPort === 'number' ? opts.publicPort : null
  // ⛔ THREE STATES IN, THREE STATES OUT. `fronted` is `boolean | null` and
  // `null` means the probe could not read the service. Falling through to the
  // plain `active` sentence there states the loopback port as the public
  // address with full confidence — the same failure as the bug above, just
  // reached through a failed `sc.exe` instead of a missing frame. Say so
  // instead.
  if (status === 'active' && opts.fronted === null && 'fronted' in opts) {
    return {
      tone: 'warn',
      label: 'HTTPS active',
      headline:
        'A certificate is loaded and this console is serving HTTPS, but the shared NocVault-Tls front '
        + 'door could not be read, so which port the browser connects to cannot be stated here. '
        + `This process listens on ${httpsPort ? `port ${httpsPort}` : 'its configured port'}; if the front door is `
        + 'running, the public port is a different one.',
      loud: false,
      normal: false,
    }
  }
  if (status === 'active' && opts.fronted) {
    return {
      tone: 'ok',
      label: 'HTTPS active',
      headline:
        `Served over HTTPS${publicPort ? ` on port ${publicPort}` : ''} by the NocVault-Tls front door, `
        + `which holds the certificate. This console itself listens on `
        + `127.0.0.1${httpsPort ? `:${httpsPort}` : ''} in plain HTTP behind it and is not reachable `
        + 'directly. Plain HTTP on the public port is answered with a redirect to HTTPS.',
      loud: false,
      normal: false,
    }
  }
  if (status === 'active') {
    return {
      tone: 'ok',
      label: 'HTTPS active',
      headline: httpsPort
        ? `Serving HTTPS on port ${httpsPort}${httpPort ? ` (plain HTTP on ${httpPort} redirects here)` : ''}.`
        : 'Serving HTTPS.',
      loud: false,
      normal: false,
    }
  }
  if (status === 'disabled') {
    return {
      tone: 'neutral',
      label: 'Not configured',
      headline: httpsPort
        ? `No certificate is configured, so the console is served over plain HTTP on port ${httpsPort}. `
          + 'This is the normal state of an install that does not use HTTPS.'
        : 'No certificate is configured, so the console is served over plain HTTP. This is the '
          + 'normal state of an install that does not use HTTPS.',
      loud: false,
      normal: true,
    }
  }
  if (status === 'failed') {
    const why = (opts.error || '').trim()
    return {
      tone: 'danger',
      label: 'Configured but NOT active',
      headline:
        'HTTPS is configured and is not working — the console is being served over plain HTTP '
        + `right now.${why ? ` ${why}` : ''}`,
      loud: true,
      normal: false,
    }
  }
  return {
    tone: 'warn',
    label: 'Unknown',
    headline:
      'The transport could not be read, so whether this console is encrypted is unknown. This is '
      + 'an unchecked condition, not a clean bill of health.',
    loud: false,
    normal: false,
  }
}

// ─── the shadow verdict (three states, per key) ──────────────────────────────

export type ShadowVerdictLike =
  | { state?: string | null; serviceName?: string | null; reason?: string | null }
  | null
  | undefined

export type ShadowPresentation = {
  state: 'shadowed' | 'unknown' | 'clear'
  tone: Tone
  label: string
  /** ⛔ `clear` is the only state the panel may stay silent about. */
  show: boolean
  detail: string
}

/**
 * The three shadow states, kept as three.
 *
 * ⛔ `shadowed` IS A WARNING, NOT A SUCCESS. The write is durable and inert:
 * the NSSM service environment pins the key and wins over both environment
 * files, so a restart changes nothing until an upgrade clears the pin. "Saved"
 * on its own is a success message for a change that will never happen.
 *
 * ⛔ `unknown` IS NOT `clear` AND MUST NOT RENDER LIKE IT. It means we could
 * not read the service environment (not Windows, or no permission). "We did
 * not check" is not "nothing is pinned", and the difference decides whether the
 * operator's next restart does anything at all.
 *
 * ⛔ ANYTHING UNRECOGNISED FAILS CLOSED TO `unknown`. A missing verdict is a
 * read we did not get, so it is reported as unchecked rather than as fine.
 */
export function shadowPresentation(
  verdict: ShadowVerdictLike,
  key: string,
  fallbackServiceName = 'NetVault',
): ShadowPresentation {
  const state = verdict?.state
  if (state === 'shadowed') {
    const service = (verdict?.serviceName || fallbackServiceName).trim() || fallbackServiceName
    return {
      state: 'shadowed',
      tone: 'warn',
      label: 'Pinned by the service environment',
      show: true,
      detail:
        `The ${service} service environment pins ${key}, and a service environment variable wins `
        + 'over both environment files. Saving here is durable but it cannot take effect — not '
        + 'even after a restart — until that pin is removed, which the next suite upgrade does.',
    }
  }
  if (state === 'clear') {
    return {
      state: 'clear',
      tone: 'ok',
      label: 'Will take effect',
      show: false,
      detail: `Nothing in the service environment pins ${key}, so the saved value is the one that will be read.`,
    }
  }
  const reason = (verdict?.reason || '').trim()
  return {
    state: 'unknown',
    tone: 'warn',
    label: 'Not checked',
    show: true,
    detail:
      `Whether the service environment pins ${key} could not be determined`
      + `${reason ? ` (${reason})` : ''}. If it does, it wins over both files and this change will `
      + 'not take effect. This is an unchecked condition, not a clean bill of health.',
  }
}

/**
 * The worst verdict across several keys, so a panel that writes two or three
 * keys can show one banner without losing the bad one.
 *
 * ⛔ WORST WINS, AND `unknown` BEATS `clear`. Summarising a shadowed key and a
 * clear key as "clear" is how the inert save gets reported as a working one.
 */
export function worstShadow(verdicts: Array<ShadowVerdictLike>): 'shadowed' | 'unknown' | 'clear' {
  let sawUnknown = false
  for (const v of verdicts) {
    const s = v?.state
    if (s === 'shadowed') return 'shadowed'
    if (s !== 'clear') sawUnknown = true
  }
  return sawUnknown ? 'unknown' : 'clear'
}

/**
 * `takesEffectOnRestart` is tri-state in every one of the three responses.
 *
 * ⛔ `null` IS NOT `true`. It is the "we could not check" answer and it reads
 * as unchecked.
 */
export function takesEffectPresentation(
  value: boolean | null | undefined,
  serviceName = 'NetVault',
): { tone: Tone; text: string } {
  if (value === true) {
    return { tone: 'info', text: `Restart the ${serviceName} service to apply this.` }
  }
  if (value === false) {
    return {
      tone: 'warn',
      text:
        `Saved, but restarting ${serviceName} will NOT apply it: the service environment pins at `
        + 'least one of these keys and wins over the environment files.',
    }
  }
  return {
    tone: 'warn',
    text:
      `Saved. Whether restarting ${serviceName} will apply it could not be determined — the `
      + 'service environment was not readable from here.',
  }
}

// ─── certificate expiry ──────────────────────────────────────────────────────

/** Inside this many days, expiry is an emergency rather than a reminder. */
export const EXPIRY_DANGER_DAYS = 14
/** Inside this many days, it is a reminder. */
export const EXPIRY_WARN_DAYS = 30

export type ExpiryPresentation = { text: string; tone: Tone; expired: boolean }

/**
 * Days remaining as a sentence.
 *
 * ⛔ AN ABSENT OR UNPARSEABLE COUNT IS `warn`, NOT `ok`. A certificate whose
 * expiry we could not read is not a certificate that is fine for a long time,
 * and `0` is a real value that `!days` would swallow into "unknown".
 */
export function formatDaysRemaining(days: number | null | undefined): ExpiryPresentation {
  if (typeof days !== 'number' || !Number.isFinite(days)) {
    return { text: 'Expiry unknown', tone: 'warn', expired: false }
  }
  const n = Math.trunc(days)
  if (n < 0) {
    const ago = Math.abs(n)
    return {
      text: `Expired ${ago} day${ago === 1 ? '' : 's'} ago`,
      tone: 'danger',
      expired: true,
    }
  }
  if (n === 0) return { text: 'Expires today', tone: 'danger', expired: false }
  const text = `Expires in ${n} day${n === 1 ? '' : 's'}`
  if (n <= EXPIRY_DANGER_DAYS) return { text, tone: 'danger', expired: false }
  if (n <= EXPIRY_WARN_DAYS) return { text, tone: 'warn', expired: false }
  return { text, tone: 'ok', expired: false }
}

/**
 * How many certificates arrived.
 *
 * ⛔ A LEAF-ONLY CHAIN IS A WARNING. It validates in a browser that already has
 * the intermediate cached and fails in strict clients — an intermittent,
 * per-client failure that gets blamed on the client.
 */
export function chainPresentation(chainLength: number | null | undefined): { tone: Tone; text: string } {
  if (typeof chainLength !== 'number' || !Number.isFinite(chainLength) || chainLength < 1) {
    return { tone: 'warn', text: 'Chain length unknown' }
  }
  if (chainLength === 1) {
    return {
      tone: 'warn',
      text:
        'Leaf certificate only — no intermediate. It will validate in browsers that have the '
        + 'intermediate cached and fail in strict clients.',
    }
  }
  return { tone: 'ok', text: `${chainLength} certificates (leaf + ${chainLength - 1} chain).` }
}

// ─── saved vs running ────────────────────────────────────────────────────────

export type SavedRunningRow = {
  saved: string | null
  running: string | null
  /** ⛔ Computed from the VALUES, never from "is it configured". */
  differs: boolean
  /** Whether both are absent, so the panel can say "not set" once. */
  empty: boolean
}

/**
 * Compare the value on disk with the value the process is running on.
 *
 * ⛔ THEY ARE DIFFERENT FACTS AND BOTH ARE SHOWN WHENEVER THEY DIFFER. The
 * process read its environment at startup, so a value saved a moment ago is not
 * the value in force; a panel that shows one of them cannot say which.
 */
export function savedVsRunning(
  saved: string | null | undefined,
  running: string | null | undefined,
): SavedRunningRow {
  const s = (saved || '').trim() || null
  const r = (running || '').trim() || null
  return { saved: s, running: r, differs: s !== r, empty: s === null && r === null }
}

/**
 * The sentence for a pending restart, built from the API's OWN field labels.
 *
 * ⛔ THE LABELS ARE NEVER INVENTED HERE. `/api/system/entra` compares the saved
 * and running secrets on the SERVER and sends back only the field LABEL of a
 * difference, precisely so the secret does not travel. Making up a label in the
 * browser would mean guessing which field changed — and the field that matters
 * is the one we are not allowed to see.
 */
export function pendingFieldSummary(
  fields: Array<string | null | undefined> | null | undefined,
  serviceName = 'NetVault',
): string | null {
  if (!Array.isArray(fields)) return null
  const clean = fields.map((f) => (typeof f === 'string' ? f.trim() : '')).filter((f) => f !== '')
  if (clean.length === 0) return null
  const list = clean.length === 1
    ? clean[0]
    : `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`
  return (
    `${list} ${clean.length === 1 ? 'is' : 'are'} saved but not yet in force. Restart the `
    + `${serviceName} service to apply ${clean.length === 1 ? 'it' : 'them'}.`
  )
}

// ─── per-file state ──────────────────────────────────────────────────────────

export type FileReportLike = {
  path?: string | null
  role?: string | null
  exists?: boolean
  value?: string | null
  error?: string | null
}

export type FilePresentation = { tone: Tone; label: string; detail: string | null }

/**
 * What one environment file is reporting.
 *
 * ⛔ AN UNREADABLE FILE IS NOT AN UNCONFIGURED ONE, and the route is explicit
 * about that. Rendering a read error as "not set" invites an administrator to
 * retype a value that is already there, into a file whose contents are unknown.
 */
export function filePresentation(file: FileReportLike | null | undefined): FilePresentation {
  if (!file) return { tone: 'warn', label: 'Unknown', detail: null }
  const err = (file.error || '').trim()
  if (err) return { tone: 'danger', label: 'Could not be read', detail: err }
  if (file.exists === false) {
    return { tone: 'neutral', label: 'Not present', detail: 'This file does not exist on the server.' }
  }
  const value = (file.value || '').trim()
  if (!value) return { tone: 'warn', label: 'Not set', detail: null }
  return { tone: 'ok', label: value, detail: null }
}

/** The two roles the console-address route reports, in words. */
export function fileRoleLabel(role: string | null | undefined): string {
  if (role === 'deploy-source') return 'Deploy source'
  if (role === 'running') return 'Running file'
  return role ? String(role) : 'File'
}

// ─── uploads ─────────────────────────────────────────────────────────────────

/**
 * The base64 payload out of a `FileReader.readAsDataURL` result.
 *
 * ⛔ THE PREFIX MUST GO. `readAsDataURL` yields `data:<type>;base64,<payload>`
 * and the route does `Buffer.from(value, 'base64')` — which does NOT throw on
 * the prefix, it silently decodes garbage. A .pfx mangled that way fails at the
 * parse step with a message about the password, sending the operator to fix the
 * one thing that was right.
 */
export function base64Payload(dataUrl: string | null | undefined): string {
  const s = String(dataUrl || '')
  const comma = s.indexOf(',')
  if (s.startsWith('data:') && comma >= 0) return s.slice(comma + 1)
  return s
}

// ─── the redirect URI pair ───────────────────────────────────────────────────

export type RedirectUriPresentation = {
  /** The one that must be registered for sign-in to work RIGHT NOW. */
  current: string | null
  /** The one it becomes after the pending console-address restart, if any. */
  afterRestart: string | null
  /** ⛔ True when BOTH have to be registered. */
  bothRequired: boolean
  note: string | null
}

/**
 * Which Redirect URI(s) have to exist in the Entra app registration.
 *
 * ⛔ WHEN THEY DIFFER, BOTH ARE SHOWN. The running one is what NextAuth sends
 * today; the saved one is what it sends after the console-address restart.
 * Registering only one breaks sign-in on one side of that restart, and the
 * failure happens on Microsoft's side — the user sees an AADSTS page and
 * nothing reaches this server's logs at all.
 */
export function redirectUriPresentation(
  redirectUri: string | null | undefined,
  redirectUriAfterRestart: string | null | undefined,
): RedirectUriPresentation {
  const current = (redirectUri || '').trim() || null
  const after = (redirectUriAfterRestart || '').trim() || null
  const bothRequired = Boolean(current && after && after !== current)
  return {
    current,
    afterRestart: bothRequired ? after : null,
    bothRequired,
    note: bothRequired
      ? 'The console address has a change waiting for a restart, so the Redirect URI changes with '
        + 'it. Register BOTH of these in the Entra app registration: registering only the current '
        + 'one breaks sign-in after the restart, and registering only the new one breaks it until '
        + 'the restart.'
      : null,
  }
}
