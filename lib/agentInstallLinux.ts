//
// lib/agentInstallLinux.ts — builds the Linux (systemd) agent installer script.
//
// Lives in lib/ rather than inside the route for the same reason
// lib/tlsTransport.ts#buildWrapperScript and lib/serviceRestart.ts#buildRestartWrapper
// do: a generated script must be syntax-checked and asserted on, and tests here
// import from lib/, never from app/api/**. See tests/agentInstallLinux.test.ts,
// which renders this and runs `bash -n` over it.
//
// ⛔ WRITTEN WITH String.raw, AND THE BASH DELIBERATELY AVOIDS ${...} AND BACKTICKS.
// A bash script inside a TypeScript template literal has to survive two escaping
// layers, and the first attempt at this file got it wrong in a way that reviewed
// fine and rendered a DEAD script: `\\\$VAR` produced the text `\$VAR`, which bash
// reads as a literal dollar sign, not a variable. Every expansion in the installer
// would have silently become a string.
//
// String.raw removes the backslash layer (so `\033` and `\n` pass through as
// written), which leaves only two sequences that still interpolate: `${` and a
// backtick. So the script below uses:
//   - `$VAR`, never `${VAR}`  — plain expansions only
//   - `$(printenv X || true)` instead of `${X:-}`   (works under `set -u`)
//   - `sed` instead of `${X%/}`                      (suffix stripping)
//   - `$(...)`, never backticks
// If you add a line needing braces or a backtick, escape it explicitly AND make
// sure the bash -n test still passes — that test is the only thing standing
// between a typo here and a broken install on a customer's server.
//
export function buildLinuxInstallScript(hubOrigin: string): string {
  // hubOrigin is server-derived (resolveOrigin validates host shape) — safe to
  // inline as the HUB_URL default.
  return String.raw`#!/usr/bin/env bash
#
# NocVault Agent installer (Linux / systemd).
#
#   curl -fsSL ${hubOrigin}/api/agents/install.sh | sudo bash -s -- --token "enr_..."
#
# Installs the agent to /opt/nocvault-agent, runs it as a dedicated unprivileged
# system user under systemd, and verifies it came up.
#
# The token appears in the process list when passed as an argument. It is a
# one-time, short-lived enrollment token redeemed on first contact, so that is
# usually acceptable - but on a shared host prefer the environment form, which
# keeps it out of the process list:
#   curl -fsSL <hub>/api/agents/install.sh -o /tmp/nv.sh
#   sudo NOCVAULT_ENROLL_TOKEN='enr_...' bash /tmp/nv.sh
#
set -euo pipefail

# printenv-with-fallback rather than brace parameter-default syntax: see the
# header note on why this file uses no brace expansions at all.
HUB_URL="$(printenv NOCVAULT_HUB_URL || true)"
TOKEN="$(printenv NOCVAULT_ENROLL_TOKEN || true)"
API_KEY="$(printenv NOCVAULT_API_KEY || true)"
if [ -z "$HUB_URL" ]; then HUB_URL="${hubOrigin}"; fi

SERVER_URL=""
WS_PORT="3010"
MODULES=""
WS_FP=""
WS_FP_DDI=""
INSTALL_DIR="/opt/nocvault-agent"
SVC_USER="nocvault-agent"
SVC_NAME="nocvault-agent"
UNINSTALL="0"

step() { printf '\033[1;33m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
die()  { fail "$*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token)              TOKEN="$2"; shift 2 ;;
    --hub-url)            HUB_URL="$2"; shift 2 ;;
    --server-url)         SERVER_URL="$2"; shift 2 ;;
    --api-key)            API_KEY="$2"; shift 2 ;;
    --ws-port)            WS_PORT="$2"; shift 2 ;;
    --modules)            MODULES="$2"; shift 2 ;;
    --ws-fingerprint)     WS_FP="$2"; shift 2 ;;
    --ws-fingerprint-ddi) WS_FP_DDI="$2"; shift 2 ;;
    --install-dir)        INSTALL_DIR="$2"; shift 2 ;;
    --service-user)       SVC_USER="$2"; shift 2 ;;
    --uninstall)          UNINSTALL="1"; shift ;;
    -h|--help)            sed -n '2,18p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

HUB_URL="$(printf '%s' "$HUB_URL" | sed 's:/*$::')"
if [ -n "$SERVER_URL" ]; then SERVER_URL="$(printf '%s' "$SERVER_URL" | sed 's:/*$::')"; fi

printf '\033[1;36m=== NocVault Agent Installer (Linux) ===\033[0m\n'

if [ "$(id -u)" -ne 0 ]; then die "This installer must run as root (it installs a systemd unit). Re-run with sudo."; fi

# -- Uninstall -----------------------------------------------------------------
# Handled BEFORE the token check: removing an agent must not require minting a new
# enrollment token. The Windows side gets this from Uninstall-NocVault-Suite.ps1;
# without an equivalent here a Linux agent could be installed and never cleanly
# removed, which also makes it unsafe to trial on a machine you care about.
if [ "$UNINSTALL" = "1" ]; then
  step "Uninstalling $SVC_NAME ..."
  # This block runs rm -rf as root against an operator-supplied path. Refuse the
  # obvious catastrophes outright, then require positive proof the directory is
  # actually an agent install rather than trusting the default.
  case "$INSTALL_DIR" in
    ""|"/"|"/usr"|"/usr/"*|"/etc"|"/etc/"|"/var"|"/var/"|"/opt"|"/opt/"|"/home"|"/home/"|"/root"|"/boot"|"/bin"|"/sbin"|"/lib")
      die "Refusing to remove $INSTALL_DIR - that is not an agent install directory." ;;
  esac
  if [ ! -f "$INSTALL_DIR/nocvault-agent.js" ]; then
    die "Refusing to remove $INSTALL_DIR - no nocvault-agent.js there, so it is not an agent install."
  fi

  if systemctl list-unit-files | grep -q "^$SVC_NAME.service"; then
    systemctl stop "$SVC_NAME" 2>/dev/null || true
    systemctl disable "$SVC_NAME" 2>/dev/null || true
    ok "  Stopped and disabled $SVC_NAME."
  else
    ok "  No $SVC_NAME unit registered."
  fi
  rm -f "/etc/systemd/system/$SVC_NAME.service"
  systemctl daemon-reload
  systemctl reset-failed "$SVC_NAME" 2>/dev/null || true

  rm -rf "$INSTALL_DIR"
  ok "  Removed $INSTALL_DIR."

  # Only remove the account this installer would have created, and only if it owns
  # nothing else. A pre-existing account supplied via --service-user may be shared.
  if id -u "$SVC_USER" >/dev/null 2>&1; then
    if [ "$SVC_USER" = "nocvault-agent" ]; then
      userdel "$SVC_USER" 2>/dev/null && ok "  Removed service user $SVC_USER." \
        || fail "  Could not remove service user $SVC_USER - remove it by hand if unused."
    else
      ok "  Left service user $SVC_USER in place (not created by this installer)."
    fi
  fi

  ok ""
  ok "NocVault Agent uninstalled."
  printf 'The hub still lists this agent - revoke it there if it is gone for good.\n'
  exit 0
fi

if [ -z "$TOKEN" ]; then die "An enrollment token is required: --token enr_... (or NOCVAULT_ENROLL_TOKEN=...)."; fi

command -v systemctl >/dev/null 2>&1 || die "systemd not found. This installer targets systemd hosts."
command -v curl >/dev/null 2>&1 || die "curl is required but not installed."

# -- Preflight: confirm the hub is reachable BEFORE changing anything ----------
step "Checking connectivity to $HUB_URL ..."
# -k: the suite commonly terminates TLS with a self-signed or internal-CA cert at
# this stage. Enrollment integrity rests on the one-time token and, for the data
# plane, the pinned fingerprint below - not on this bootstrap fetch.
curl -fsSk --max-time 10 "$HUB_URL/api/health" >/dev/null 2>&1 \
  || die "Cannot reach $HUB_URL/api/health. Check the hub URL, routing from this host, and the port."
ok "  Hub reachable."

# Non-fatal: warn if the span data path's WebSocket port looks closed.
if [ -n "$SERVER_URL" ]; then
  WS_HOST="$(printf '%s' "$SERVER_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
  if timeout 5 bash -c "echo > /dev/tcp/$WS_HOST/$WS_PORT" 2>/dev/null; then
    ok "  WebSocket port $WS_PORT reachable on $WS_HOST."
  else
    fail "  Warning: WebSocket port $WS_PORT on $WS_HOST did not respond. The agent will keep retrying; open that port if it stays offline."
  fi
fi

# -- Node.js -------------------------------------------------------------------
# Deliberately NOT auto-installed. The Windows installer can fetch one MSI; on
# Linux the correct package source differs per distro and release, and silently
# adding a third-party apt/dnf repo to a customer's server is not something an
# agent installer should do uninvited. Fail with instructions instead.
command -v node >/dev/null 2>&1 \
  || die "Node.js not found. Install Node 20 LTS or newer (distro package, nodesource, or nvm) and re-run."
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then die "Node $(node -v) is too old - the agent needs Node 20 or newer."; fi
ok "  Node $(node -v) at $NODE_BIN"

# -- Dedicated unprivileged service account ------------------------------------
# The Windows installer locks the agent directory with icacls because it holds
# hub-issued secrets: config.json (enrollment credentials) and hub-identity.json
# (the hub-signed JWT this agent authenticates to every app with). The Linux
# equivalent is a system user owning a 0700 directory - without it any local user
# could read the JWT off disk and impersonate this agent.
if id -u "$SVC_USER" >/dev/null 2>&1; then
  ok "  Service user $SVC_USER already exists."
else
  step "Creating service user $SVC_USER ..."
  useradd --system --no-create-home --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null \
    || useradd --system --no-create-home --home-dir "$INSTALL_DIR" --shell /sbin/nologin "$SVC_USER" \
    || die "Could not create the service user $SVC_USER."
fi

mkdir -p "$INSTALL_DIR"

# -- Agent files: manifest, then each file ------------------------------------
step "Downloading agent bundle from $HUB_URL ..."
MANIFEST="$(curl -fsSk --max-time 30 "$HUB_URL/api/agents/bundle")" \
  || die "Failed to fetch the agent bundle manifest from $HUB_URL."
# node, not jq: node is a hard requirement above, jq is absent from most server
# images, and hand-rolling JSON parsing in bash is how installers rot.
FILES="$(printf '%s' "$MANIFEST" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    let m; try { m = JSON.parse(s); } catch (e) { process.exit(2); }
    const f = Array.isArray(m.files) ? m.files : [];
    if (!f.length) process.exit(3);
    for (const rel of f) {
      // Confine to relative paths. The manifest is trusted, but this loop writes
      // as root, so a traversal would land anywhere on the filesystem.
      if (typeof rel !== "string") continue;
      if (rel.startsWith("/")) continue;
      if (rel.split("/").includes("..")) continue;
      console.log(rel);
    }
  });
')" || die "Agent bundle manifest was empty or unreadable."

COUNT=0
while IFS= read -r rel; do
  if [ -z "$rel" ]; then continue; fi
  dest="$INSTALL_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  curl -fsSk --max-time 60 "$HUB_URL/api/agents/bundle/$rel" -o "$dest" \
    || die "Failed to download $rel from the hub bundle."
  COUNT=$((COUNT + 1))
done <<EOF
$FILES
EOF
ok "  Downloaded $COUNT agent file(s)."
if [ ! -f "$INSTALL_DIR/nocvault-agent.js" ]; then die "Agent bundle did not include nocvault-agent.js - aborting."; fi

# -- config.json ---------------------------------------------------------------
# Written by node so the JSON is encoded correctly, and fed through the ENVIRONMENT
# rather than argv so the token, API key and pins never appear in the process list.
# (Same lesson as the 2026-11 incident, where a credential sat in a command line.)
step "Writing config.json ..."
NV_HUB="$HUB_URL" NV_TOKEN="$TOKEN" NV_SERVER="$SERVER_URL" NV_APIKEY="$API_KEY" \
NV_WSPORT="$WS_PORT" NV_MODULES="$MODULES" NV_FP="$WS_FP" NV_FPDDI="$WS_FP_DDI" \
NV_OUT="$INSTALL_DIR/config.json" node -e '
  const fs = require("fs"), e = process.env;
  const cfg = { hubUrl: e.NV_HUB, enrollToken: e.NV_TOKEN };
  if (e.NV_SERVER && e.NV_APIKEY) {
    cfg.serverUrl = e.NV_SERVER;
    cfg.apiKey = e.NV_APIKEY;
    cfg.wsPort = parseInt(e.NV_WSPORT, 10) || 3010;
  }
  if (e.NV_MODULES) {
    const mods = {};
    for (const raw of e.NV_MODULES.split(",")) {
      const slug = raw.trim().toLowerCase();
      if (!slug) continue;
      // ddi is Windows-only (WinRM / DHCP logs / registry IPAM). Accepting it here
      // would have the agent dial DDIVault and fail every poll on a host that
      // cannot speak WinRM, reporting a wrong platform as a collection fault.
      if (slug === "ddi" || slug === "ddivault") {
        console.error("  ! ignoring module " + slug + " - not supported on Linux (WinRM-based)");
        continue;
      }
      mods[slug] = { enabled: true };
    }
    if (Object.keys(mods).length) cfg.modules = mods;
  }
  if (e.NV_FP || e.NV_FPDDI) {
    const fps = {};
    if (e.NV_FP) fps.span = e.NV_FP;
    if (e.NV_FPDDI) fps.ddi = e.NV_FPDDI; else if (e.NV_FP) fps.ddi = e.NV_FP;
    cfg.wsFingerprints = fps;
  }
  fs.writeFileSync(e.NV_OUT, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
' || die "Could not write config.json."

# -- Dependencies --------------------------------------------------------------
if [ -d "$INSTALL_DIR/node_modules/ws" ]; then
  ok "Dependencies already present (offline bundle) - skipping npm install."
else
  step "Installing dependencies..."
  command -v npm >/dev/null 2>&1 || die "npm not found but node is present - install npm and re-run."
  ( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
    || die "npm install failed. Agent dependencies are incomplete - aborting before service registration."
fi

# -- Ownership and permissions LAST, so npm's own files are covered too --------
chown -R "$SVC_USER":"$SVC_USER" "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR"
ok "  $INSTALL_DIR owned by $SVC_USER, mode 0700."

# -- systemd unit --------------------------------------------------------------
step "Registering systemd service..."
# UNQUOTED heredoc delimiter, deliberately: the unit must bake in the RESOLVED
# values of $NODE_BIN, $INSTALL_DIR and $SVC_USER, because systemd performs no
# shell expansion of its own when it reads the unit later. Quoting the delimiter
# would write the literal text "ExecStart=$NODE_BIN ..." and the service would
# fail to start with a confusing "executable path is not absolute".
cat > "/etc/systemd/system/$SVC_NAME.service" <<EOF
[Unit]
Description=NocVault Agent
Documentation=$HUB_URL
After=network-online.target
Wants=network-online.target
# The self-updater's crash-loop ROLLBACK only fires once .update-confirm.json
# reaches attempts >= 3 (agent/core/apply-update.js), so the agent must be allowed
# to restart at least three times. systemd's default burst of 5 in 10s can latch
# the unit into 'failed' before the rollback ever runs - the same shape as the
# NSSM 'Paused' brick this design already guards against on Windows.
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/nocvault-agent.js
# MUST be 'always', never 'on-failure'. The self-update path applies its staged
# files and then deliberately exits 0 so the supervisor restarts it into the new
# build. Under on-failure a clean exit would simply stop the agent, and every
# update would quietly take the fleet offline instead of upgrading it.
Restart=always
RestartSec=5

# CAP_NET_RAW is required BECAUSE of NoNewPrivileges, not despite it. The span
# module pings via the system ping binary, which relies on a file capability
# (cap_net_raw+ep); NoNewPrivileges blocks privilege gain through execve, so that
# capability is dropped and EVERY ping reports 'down' - a total monitoring failure
# that reads as a network problem rather than a config one. Granting it ambiently
# hands the service this one capability and nothing else.
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
NoNewPrivileges=yes

PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
# The agent writes into its own directory: config.json persistence, identity
# rotation, the offline buffer, and the self-update staging/backup dirs. Under
# ProtectSystem=strict every one of those fails without this.
ReadWritePaths=$INSTALL_DIR
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
# Do NOT add MemoryDenyWriteExecute=yes. It reads as an obvious hardening win and
# breaks Node outright - V8's JIT needs writable-then-executable pages.

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SVC_NAME

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SVC_NAME" >/dev/null 2>&1 || true
systemctl restart "$SVC_NAME"

# -- Verify it actually came up ------------------------------------------------
sleep 3
if systemctl is-active --quiet "$SVC_NAME"; then
  ok ""
  ok "NocVault Agent installed and running."
  printf 'It should appear Online in the UI within ~30 seconds.\n'
  printf 'Logs:   journalctl -u %s -f\n' "$SVC_NAME"
  printf 'Status: systemctl status %s\n' "$SVC_NAME"
else
  fail ""
  fail "Service $SVC_NAME did not reach active state."
  fail "Check: journalctl -u $SVC_NAME -n 50 --no-pager"
  systemctl status "$SVC_NAME" --no-pager -n 20 || true
  exit 1
fi
`
}
