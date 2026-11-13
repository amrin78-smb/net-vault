# NocVault — SMTP centralization plan

**Status:** planned, not started. Written 2026-11-13.
**Goal:** one SMTP configuration for the whole suite, owned by the NetVault hub,
instead of three independent ones that an admin has to fill in separately.

---

## 1. Where SMTP lives today

**NetVault has none at all** — no `nodemailer` dependency, no mailer module, no
`smtp_*` key in `schema.sql`, no Settings section. The hub cannot send email.
Centralizing *to* the hub therefore means **building the capability there first**,
not relocating something that half-exists.

The three satellites each grew their own, independently:

| | LogVault | DDIVault | SpanVault |
|---|---|---|---|
| Storage | `app_settings` k/v rows | dedicated `smtp_config` table | `app_settings` k/v rows |
| Password at rest | plaintext | **AES-256-GCM** (`credStore.js`) | plaintext |
| `secure` flag | ✗ derived (`port === 465`) | ✓ explicit column | ✗ derived |
| `from_name` | ✗ | ✓ | ✗ |
| Enabled toggle | `smtp_enabled` | `enabled` column | `email_alerts_enabled` |
| Recipients | `email_notify_recipients` + per-rule `notify_email` | `alert_recipients` table (site + severity filters) | `notification_routes` + `alert_email_to` fallback |
| Config cache | 5 min | 5 min | **none** — fresh query per send |
| Test button | `POST /api/settings/test-email` | `POST /api/smtp/test` | **none** |
| Consumer | `collector/emailer.js` | `api/emailer.js` → `alertDispatcher` + 2 schedulers | `collector/collector.js` (alerts + escalation) **and** `api/reportScheduler.js` |
| nodemailer | `^8.0.10` | `^8.0.10` | **`^6.9.13`** |
| TLS verification | default (verifies) | **`rejectUnauthorized: false`** | default (verifies) |

DDIVault's model is a strict superset of the other two and the only one that
encrypts the password. It is the shape to standardize on.

---

## 2. Findings that shaped this plan

### 2.1 ⛔ SMTP must NOT live in `netvault.app_settings`

`net-vault/app/api/settings/route.ts`'s `GET` handler takes **no session** — the
launcher page and `components/IdleTimeout.tsx` fetch it unauthenticated for
branding — and it redacts exactly one key:

```ts
const SENSITIVE_KEYS = new Set(['license_key'])
```

Every other key in that table is served to anonymous callers. Putting `smtp_pass`
there would publish the SMTP password on the login surface.

Note the asymmetry that makes this easy to get wrong: NetVault's
`app_settings_public` **view** is a 5-key branding allowlist, so the *readonly
diagnostic roles* would have been safe. The leak is in the HTTP route, not the
grant. Checking only the view would have cleared this design.

→ **A dedicated `smtp_config` table.**

### 2.2 The shared encryption key already exists

DDIVault's `collector/credStore.js` derives its AES-256-GCM key from
`sha256(NEXTAUTH_SECRET)` — and `NEXTAUTH_SECRET` is **the same value in all four
apps**, because it is the SSO signing secret.

So encryption at rest here defends against the readonly diagnostic roles and
against a DB dump — **not** against a sibling app. Any app holding that secret can
already decrypt any other app's stored SMTP password. A cross-DB read needs no new
key management.

This removes the main argument for a hub-relayed send (“the password never leaves
the hub”): it is already shared by construction.

### 2.3 The real cost is env vars, and it favours the cross-DB read

Ground truth from `installer/Install-NocVault-Suite.ps1`'s NSSM
`AppEnvironmentExtra` blocks:

| service (what it sends) | `NETVAULT_DB_*` | `NEXTAUTH_SECRET` | `NOCVAULT_HUB_URL` |
|---|---|---|---|
| LogVault-**Collector** — all LV alert mail | ✓ | ✗ | ✗ |
| LogVault-API — test email | ✓ | ✗ | ✓ |
| DDIVault-API — alerts, reports, test | ✓ | ✓ | ✗ |
| DDIVault-Collector — report scheduler | ✓ | ✓ | ✗ |
| SpanVault-API — report scheduler | ✓ (`.env.local`) | ✓ | ✓ |

- **Cross-DB read:** add `NEXTAUTH_SECRET` to **2** services. Every satellite
  already holds a `netvault` pool, and it connects as the `netvault` role — the
  same role the hub itself uses — so a new table in that DB needs **no grant
  change**.
- **HTTP relay:** add `NOCVAULT_HUB_URL` to **3** services, *and* extend
  `NocVault-TlsCutover.ps1`. That script repoints the var only on each app's
  **console** service (`LogVault-App`, `DDIVault-App`, `SpanVault-App`). A hub URL
  newly placed in `LogVault-Collector`'s or `DDIVault-API`'s NSSM env would still
  read `http://<ip>:3000` after a TLS cutover — which 301s to https and then fails
  `ERR_TLS_CERT_ALTNAME_INVALID`, measured on production 2026-11-06.

→ **Cross-DB read.** The relay buys little (§2.2) and costs a change to the most
fragile script in the suite.

### 2.4 ⛔ CORRECTED 2026-11-13 — SpanVault's alert emailing DOES exist

**This section previously claimed SpanVault had no alert emailing. That was wrong, and the
error nearly deleted a working feature.**

SpanVault sends alert email from `collector/collector.js`: `sendAlertEmail()` (line ~1285),
routed by `recipientsFor()` through `notification_routes` with `alert_email_to` as the global
fallback, throttled by `notifyCooldownOk()`, with all-clear/recovery mail in
`notifyRecovery()`. `email_alerts_enabled` is read at line ~1286 and `alert_email_to` at
~1242/1288. Escalation is real too: `escalationTick()` runs every 60 s against
`escalation_steps`, resolving the current on-call via `currentOnCall()` and claiming each step
through `alert_escalations` so it fires once per alert. All of it shipped in `8192ef8`
(1.15.0) and is still present.

**So SpanVault has TWO mail senders, not one:** `collector/collector.js` (alerts, recovery,
escalation) and `api/reportScheduler.js` (scheduled reports). They read SMTP settings through
two different paths — the collector's own `setting()` cache, and `getSmtpSettings()` in
`api/server.js`. Phase 5 must update both.

**Why the audit got it wrong, and how to not repeat it.** `collector/collector.js` contains a
single NUL byte at line 1089, inside `ruleSubjectKey()`:

```js
return `${rule.metric}\x00${rule.sensor_key || ''}`;
```

It is deliberate — a composite-key separator that cannot occur in a metric name — and was added
in `4b87514` (1.111.0). But **GNU grep treats a file containing a NUL as binary and prints
nothing**, so every `grep` of this file silently returned no matches. A bisect appeared to show
`escalationTick` vanishing at `4b87514`; it had not vanished, grep had simply gone quiet from
that commit onward.

⛔ **When auditing this suite, use `grep -a`.** A plain `grep` that returns nothing from
`spanvault/collector/collector.js` is not evidence of absence. `file --mime` reports
`charset=binary` for it, which is the tell.

⛔ **The release notes were right and the grep was wrong.** `api/server.js`'s notes describe
escalation email (lines ~824, ~1347) and this plan dismissed them, citing SpanVault's own
CLAUDE.md warning that its notes have overclaimed before. That warning is real, but "the notes
have lied once" is not evidence they are lying now. Two sources disagreed and the wrong one was
believed; the cheap tiebreak — open the file and read it — was never run.

**Consequence for Phase 3 (§6):** cancelled. There are no dead controls to remove.

### 2.5 Other defects found during the audit

- **`POST /api/smtp/test` in DDIVault returns the raw nodemailer `err.message`**
  to the caller (`api/server.js:2347` → `emailer.sendTestEmail`'s
  `{ ok: false, error: err.message }`). That string routinely embeds the host,
  port, configured username and the server's verbatim auth rejection. LogVault and
  SpanVault have both already fixed this exact class (`mailErrorSummary()` in
  SpanVault); DDIVault is the surviving instance. super_admin-gated, so lower
  severity than SpanVault's was — but it is precisely the "a fixed instance is not
  a fixed class" rule both repos' CLAUDE.md warn about.
- **DDIVault silently accepts any TLS certificate** (`tls: { rejectUnauthorized:
  false }` in `api/emailer.js`'s `buildTransport`) while the other two verify.
- **SpanVault's settings label map references `smtp_secure`**, a key no field and
  no consumer uses.

---

## 3. Design

**Centralize the transport; keep the sender identity per-app.**

- The **hub owns** host, port, secure, username, password.
- **Each app keeps** its own `from_email` / `from_name`. "LogVault Alerts" vs
  "DDIVault Alerts" in a recipient's inbox is a feature, not drift.
- **Unchanged and local:** recipient lists, severity/category filters, cooldowns,
  digest settings, HTML templates, ack tokens.

**Precedence:** hub config when its `enabled` flag is set, otherwise the app's own
local config. This is what makes the migration non-breaking — every existing
install keeps working with zero admin action, and an admin opts in by filling one
form. Local config also remains the escape hatch if the hub DB is unreachable.

**No new failure mode from the coupling:** every satellite already requires the
netvault DB for SSO and site data. If it is down, the fallback applies.

---

## 4. Phase 1 — NetVault becomes the owner

netvault, **minor** bump.

1. **`schema.sql`**
   - `smtp_config` — single row, DDIVault's columns: `host`, `port`,
     `secure BOOLEAN`, `username`, `password` (AES-256-GCM), `from_email`,
     `from_name`, `enabled`, `updated_at`.
   - `smtp_config_public` view — every column except `password`, mirroring
     DDIVault's.
   - Readonly `REVOKE`/`GRANT` for `nocvault_readonly` + `claude_readonly`
     **in its own `DO` block**. ⛔ This isolation is required, not stylistic:
     this file has a documented 2026-11-05 incident where a column-order error in
     `users_public` aborted the apply under `ON_ERROR_STOP` and silently skipped
     every privilege block after it, leaving two tables fully exposed.
2. **`lib/credStore.ts`** — `encrypt`/`decrypt`, **byte-compatible** with
   DDIVault's `iv:tag:ciphertext` hex format and its `sha256(NEXTAUTH_SECRET)`
   derivation, so a value written by either side decrypts on the other. This is a
   **contract** and must be commented as one, in the same spirit as
   `normalizeForMatch` ↔ the nocvault-eol repo.
3. **`lib/mailer.ts`** + the `nodemailer` dependency NetVault does not yet have.
   Ships with `mailErrorSummary()` (SpanVault's helper — `code`/`responseCode`
   only) from day one, so §2.5's leak class never exists here.
4. **Routes** — `GET`/`PUT /api/suite/smtp` and `POST /api/suite/smtp/test`,
   super_admin only. Password write-through uses DDIVault's `'********'`
   placeholder convention so an edit never has to re-type it. The test route is
   rate-limited via the existing `lib/rateLimit.ts` and returns only the
   sanitized error.
5. **UI** — Settings → new **Notifications** tab (`ADMIN_TABS`, super_admin),
   slotted into the existing nav grouping at `app/(app)/settings/page.tsx:861`.
6. **Tests** — credStore round-trip, **plus a fixed vector proving
   cross-compatibility with DDIVault's format**, plus an assertion that
   `mailErrorSummary` never emits host/port/username.
7. **`.ai-codex/{routes,lib,schema,pages,gotchas}.md`** in the same commit —
   mandatory per CLAUDE.md.
8. **Installer parity** — `Test-NocVault-Suite.ps1`: add `netvault`/`smtp_config`
   to the secret-base-table-denied list and `smtp_config_public` to the view list
   (around lines 1526–1551). No `Install-NocVault-Suite.ps1` change: it already
   applies netvault's `schema.sql`, and `nodemailer` arrives via `npm ci`.

---

## 5. Phase 2 — Satellites consume it

logvault / ddivault / spanvault, **patch or minor** each.

Each app gets one small `suiteSmtp` module returning
`{ source: 'hub' | 'local', cfg }`, read through the netvault pool it **already
has**, cached 5 minutes.

### ⛔ The trap: fail soft, not loud

DDIVault's `credStore.js` **throws at module load** when `NEXTAUTH_SECRET` is
absent. Copying that behaviour into LogVault's collector would **crash the
collector** on any install whose env var has not been added yet — and an installer
change only takes effect one release later, so that window is real, not
hypothetical.

The satellites' hub-read path must therefore fail **soft**: no secret → cannot
decrypt → fall back to local config, warn **once**. DDIVault's existing hard-fail
stays as it is, because it guards *writes*.

### Per app

- **LogVault** — module lives in `collector/`, required by both processes (the
  repo's existing convention: `api/server.js` already requires
  `collector/emailer.js` and `collector/safeRegex.js`).
  ⛔ **CORRECTED 2026-11-13: NO env var and NO installer change is needed.**
  This plan originally said `NEXTAUTH_SECRET` had to be added to
  LogVault-Collector and LogVault-API, which was read off the NSSM
  `AppEnvironmentExtra` blocks in §2.3 — and those genuinely do not carry it.
  But `Install-NocVault-Suite.ps1:1685` writes the **root `.env.local`** with
  both `NEXTAUTH_SECRET` and `NETVAULT_DB_*`, and `collector/collector.js:19`
  and `api/server.js:30` both `dotenv.config()` that file by explicit path.
  Reading only the NSSM block sees half the environment. The one residual is an
  install whose `.env.local` predates that line: it hits the soft fallback and
  keeps its local SMTP, which is the designed behaviour, not a break.
- **DDIVault** — **zero env changes**; already holds both halves.
- **SpanVault** — gains the 5-minute cache it never had (currently a fresh query
  per send) **and a real `secure` flag**. Today TLS is derived purely from
  `port === 465`, so a relay on 25/2525 with STARTTLS has no correct setting.
  That is a behaviour fix riding along.
- Each app's SMTP card becomes "Managed centrally in NetVault" with the From
  fields still editable.

---

## 6. Phase 3 — CANCELLED (2026-11-13)

This phase was going to remove SpanVault's Email Alerts toggle, its `alert_email_to`
recipients field and its escalation UI, on the finding that nothing consumed them.

**That finding was wrong — see §2.4.** All of it is live: the collector sends routed,
throttled alert and recovery email, and `escalationTick()` fires escalation steps every
60 s. Removing those controls would have deleted the UI for a working feature.

Nothing to do here. SpanVault's work is folded into Phase 2 instead, where it is now the
LARGEST of the three satellites rather than the smallest: two sender processes
(`collector/collector.js` and `api/reportScheduler.js`) reading SMTP through two different
paths, both of which have to learn the hub config.

## 7. Phase 4 — nodemailer 9 for the SATELLITES ONLY (corrected 2026-11-13)

**Decision 2026-11-13: not folded into this project.** Still true. But the target changed.

⛔ **"One nodemailer across the suite" is NOT achievable.** `next-auth@4.24.x` declares
`peerOptional nodemailer@"^7.0.7"`, and NetVault is a single package.json holding both, so the
hub is pinned to 7.x. This was discovered the expensive way: 1.65.0 shipped nodemailer 9.1.1,
the production updater failed at `npm install` with ERESOLVE and auto-rolled back. Fixed in
1.65.1 by pinning `^7.0.13`, which sits inside the declared range and needs no resolver luck.

The satellites are unaffected - `next-auth` lives in their `frontend/` package.json while
nodemailer lives in the ROOT one. So Phase 4 is: **logvault 8.0.10 -> 9, ddivault 8.0.10 -> 9,
spanvault 6.9.13 -> 9**, and NetVault stays on 7 until next-auth widens its range. Re-test all
mail paths in one window; note there are FIVE senders, not four (see the §2.4 correction:
spanvault has two).

⛔ **A green local build does not predict the deploy.** The dev box is node 24 / npm 11; the
server is node 22 / npm 10, and npm 11 silently overrides peer conflicts npm 10 refuses. Check
declared peer ranges directly before adding or bumping any dependency - see
`.ai-codex/gotchas.md`.

## 8. Phase 5 — drive-by fixes from this audit

Each small, each its own commit:

1. DDIVault `POST /api/smtp/test` → return a sanitized error (§2.5).
2. DDIVault `rejectUnauthorized: false` → an explicit **"Allow self-signed
   certificate"** checkbox on the hub form, **off by default**, rather than an
   invisible always-on.
3. SpanVault's unused `smtp_secure` label-map entry → removed, superseded by the
   real flag from Phase 2.

---

## 9. Out of scope

- **The hub sending mail of its own** (licence-expiry notices are the obvious
  candidate). A natural follow-on, but a new feature.
- Per-app recipient lists, filters, digests and templates — deliberately staying
  local.
- Anything applied by hand to the production DB. All schema flows through
  `schema.sql` and the installer, per the suite rule that a fix applied only by
  hand is a countdown, not a fix.
