# Turning HTTPS on for an installation that already exists

Written 2026-11-05, after deploying 1.57.8 to production (192.168.6.111) and
measuring what that box would actually need. It is a plan, not a change: nothing
described here has been built.

## The problem, stated plainly

**There is no supported way to turn HTTPS on for an install that is already
running.** The installer says so itself, in `Update-NetVault.ps1`:

> the installer is the only thing that performs a cutover

`Install-NocVault-Suite.ps1` STEP 12.5 holds the whole gated cutover — mint or
accept a certificate, register `NocVault-Tls`, move the four consoles to
127.0.0.1, prove HTTPS on all four ports, and commit or revert. `Update-*.ps1`
has none of it, and `NocVault-Tls.ps1` carries only certificate helpers
(`Find-NocVaultOpenSsl`, `Get-NocVaultCertInfo`, `New-NocVaultCertificate`).

So the only available path today is to re-run the whole suite installer over a
live installation. That path is worse than it looks.

### Why re-running the suite installer is the wrong answer

`Install-NocVault-Suite.ps1` writes each app's environment file **wholesale**,
from a fixed template:

```
@"
DATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault
NEXTAUTH_SECRET=$SharedSecret
NEXTAUTH_URL=http://${ServerIP}:3000
...
"@ | Out-File -FilePath "$NVAppDir\.env" -Encoding UTF8 -NoNewline
```

That template contains **no `ENTRA_*` keys at all**. So a re-install:

- resets the console address to the install-time IP, discarding whatever was set
  through Settings → Console address;
- **silently deletes `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` and
  `ENTRA_CLIENT_SECRET`** — single sign-on turns itself off;
- discards `TLS_CERT_PATH` / `TLS_KEY_PATH` set through Settings → Certificate.

Which makes it self-defeating: the operator runs the installer *in order to* get
HTTPS, and loses the directory sign-in configuration that HTTPS was a
prerequisite for. On production today that costs nothing (no `ENTRA_*` keys are
set yet — measured), but it is a trap armed for the first site that configures
SSO before it cuts over, which is the natural order.

It also re-clones and rebuilds all four apps (~20 minutes, the suite down
throughout) to change what is, in the end, a handful of service parameters and
env keys.

## What production actually needs — measured, not assumed

Taken from `192.168.6.111` on 2026-11-05 immediately after the 1.57.8 deploy:

| Prerequisite | State | Blocking? |
|---|---|---|
| Node ≥ 22 for the terminator | **v20.19.0** | **YES** |
| A hostname (not an IP) for the console | `NEXTAUTH_URL=http://192.168.6.111:3000` | **YES**, for SSO |
| A certificate | only the agent-ingest WS pins exist; no `nocvault.crt` / `.key` | YES |
| Agents to re-point at `https://` | **0 enrolled** | **No — drops out** |
| `ENTRA_*` already configured (would be destroyed by a re-install) | none set | Not yet |

Two things changed my view of the sequencing:

1. **Zero agents are enrolled.** The whole "update every agent's `hubUrl` and
   pin the fingerprint before cutting over" step — the riskiest part of the
   original ordering — does not apply to this box at all.
2. **Node 20 is a hard stop.** `installer/terminator/start.mjs` refuses to start
   on Node 20 by design (no type-stripping), and the installer's own gate 1
   refuses to install the terminator when it cannot prove the runtime executes
   TypeScript. Nothing else can proceed until this is fixed. Node 20 is also
   end-of-life, so this is worth doing regardless of TLS.

## Recommended plan

### Step 0 — Node 22 LTS on production
Independent of everything else, and already overdue: v20.19.0 is end-of-life.
The four apps run fine on 22 (staging has been on v24 throughout). Do this as
its own change, with its own verification, and let the suite settle before
touching transport.

### Step 1 — decide the hostname, and set it in Settings → Console address
Not an IP. Entra will not accept an IP-address Redirect URI (1.57.8 now says so
in the panel), and a `*.thaiunion.com` wildcard certificate cannot match one
either. This is a DNS change plus one Settings change; nothing restarts except
the hub.

### Step 2 — upload the wildcard certificate in Settings → Certificate
The route validates the pair with `checkPrivateKey()` *before* writing anything,
refuses to overwrite an existing pair without `replace: true`, and writes the
key 0600. No terminator is running yet, so this is inert until step 3.

### Step 3 — build `installer/Enable-NocVaultTls.ps1`  ← **BUILT in 1.58.0**

> Done. The preflight and the cutover were MOVED out of the installer into
> `NocVault-TlsPreflight.ps1` and `NocVault-TlsCutover.ps1`, byte-for-byte, and
> are dot-sourced by both callers — so the installer still runs the code that
> was proven on staging, and so does the new script. `Enable-NocVaultTls.ps1`
> is only the ~220 lines that discover an existing installation and the dry-run
> mode. What follows is the specification it was built to.

A standalone, re-runnable cutover for an install that already exists. It is
STEP 12.5 lifted out of the installer, with the clone/build/env-template half
left behind. It must:

- refuse early, and change nothing, unless: Node ≥ 22 proves it can execute
  TypeScript; a certificate and key exist and match; all four console services
  exist and are running;
- register `NocVault-Tls` with the same NSSM settings the installer uses —
  including `AppEnvironmentExtra` of **`NODE_ENV` only** (pinning
  `TLS_CERT_PATH`/`TLS_KEY_PATH` in a service environment would make every
  later certificate change from Settings a silent no-op), `DependOnService` on
  all four consoles, and `AppStopMethodConsole 15000`;
- move the four consoles to `127.0.0.1:1300X` by **editing the keys it owns**,
  line by line, never rewriting an env file wholesale — this is the whole
  difference from the installer;
- probe HTTPS on all four public ports with `HttpWebRequest`, **not**
  `Invoke-WebRequest` (which cannot talk to the terminator — the headline
  finding of the staging dry run, fixed in 1.57.1);
- on failure, revert everything it did and remove the service, leaving a
  working plain-HTTP suite — the installer's `Undo-TlsCutover` already does
  this and should be reused verbatim;
- be safe to run twice.

Most of this code exists and is proven on real Windows; it needs extracting and
re-testing, not designing.

### Step 4 — cut over, then verify independently
Run it, then check all four consoles over HTTPS **from another machine**, and
confirm an old `http://` bookmark gets a 301 rather than a connection error (the
same-port plaintext demux). The staging dry run is the template.

### Step 5 — only then, configure single sign-on
Redirect URI, groups claim, group mappings. In that order, because the Redirect
URI must be `https://<hostname>` and steps 1–4 are what make that true.

## Alternative, if `Enable-NocVaultTls.ps1` is not wanted

Fix the installer's env handling instead: make STEPs 8–11 **merge** into an
existing `.env` rather than overwrite it, preserving any key the template does
not own (`ENTRA_*`, `TLS_*`, and a `NEXTAUTH_URL` that no longer matches
`$ServerIP`). Then a re-install becomes a legitimate way to cut over.

This is the smaller diff but the larger risk: it changes behaviour on the path
every fresh install takes, to benefit a path only existing installs take. The
standalone script touches nothing that fresh installs rely on. I recommend the
script.

## Open question for whoever picks this up

Should `Enable-NocVaultTls.ps1` also handle the reverse — a supported way back
to plain HTTP? `Undo-TlsCutover` exists inside the installer's failure path, but
there is no way for an operator to deliberately turn HTTPS *off* after a
successful cutover, short of removing the service by hand and editing four
services' parameters back. A `-Disable` switch would be nearly free while the
revert logic is being extracted anyway, and expensive to retrofit later.
