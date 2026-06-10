/**
 * W13 — Worker-side cloud-init-direct provisioning admin handler.
 *
 * Sibling to handleAdminSnapshotNow. Same admin gate, same idempotency,
 * same demo_users state machine, same auth-code + build-ticket +
 * primary-grant mint dance. The DIFFERENCE is what the Worker hands to
 * Hetzner:
 *
 *   W11 (admin-snapshot-now):
 *     image:     ubuntu-22.04
 *     user_data: bash that wgets a custom Debian-netinst ISO + trailer
 *                and dd's them onto /dev/sda + reboots into d-i
 *     Result:    d-i runs preseed + late-command -> registers
 *
 *   W13 (admin-cloud-init-now):
 *     image:     debian-12 (Hetzner-baked, NO custom ISO)
 *     user_data: cloud-config YAML with:
 *                  - install-blob.json inlined as base64 in write_files
 *                  - bootstrap.sh inlined in write_files that installs
 *                    Docker + Node + clones the repo + builds + writes
 *                    systemd units + enables first-boot-register
 *     Result:    debian-12 boots, cloud-init runs the bootstrap, the
 *                flagship-first-boot-register systemd unit POSTs to
 *                /api/server/register on its first multi-user.target
 *
 * Why W13 exists: the W11 d-i path is opaque (no shell access to debug
 * the late-command), and as of 2026-05-21 its POSTs aren't reaching
 * the Worker. Cloud-init-direct keeps the SAME contract surface (the
 * server-register payload is byte-identical) but runs the install
 * script in a clean Debian rootfs where journalctl + ssh-key fallback
 * give us real diagnostics.
 *
 * LUKS posture for W13: the first-boot script generates a random LUKS
 * key + seals it for the phone + uploads it via /sealed-luks-key, but
 * /var/flagship/data lives on the unencrypted root for the demo path.
 * See docs/cloud-init-direct-provisioning.md "LUKS trade-off
 * discussion" for the full rationale.
 */

import {
  signAuthCode,
  signDeviceCapabilityGrant,
  signInstallBlob,
  type AuthCode,
  type DeviceCapabilityGrant,
  type InstallBlob,
  type DeviceScope,
} from "@flagship/protocol";
import type {
  AuthCodeStorage,
  DemoUsersStorage,
  DeviceCapabilityGrantStorage,
  UsernameStorage,
} from "@flagship/storage";
import { bytesToHex } from "./hex.js";
import {
  deriveDemoDelegatedKey,
  deriveDemoRckKey,
  deriveDemoUserIrk,
  parseDiskEncryption,
  _internalDefaultDemoPrimaryScopes,
} from "./demoUsersAdmin.js";
import {
  conflict,
  malformed,
  notFound,
  type HandlerResponseWithHeaders,
} from "./types.js";
import type { ProvisioningHetznerClient } from "./demoUsersAdminProvision.js";

// ──────────────────────────────────────────────────────────────────────
// Deps + body shapes
// ──────────────────────────────────────────────────────────────────────

export interface DemoCloudInitDeps {
  storage: DemoUsersStorage;
  usernames: UsernameStorage;
  authCodes: AuthCodeStorage;
  deviceCapabilityGrants: DeviceCapabilityGrantStorage;
  hetzner: ProvisioningHetznerClient;
  demoIrkKek: Uint8Array;
  /** Optional Hetzner numeric SSH key id; attached to the VPS so an
   *  operator can ssh in and tail `/var/log/flagship-bootstrap.log` if
   *  the first-boot bootstrap stalls. NOT required by the happy path. */
  demoSshKeyId?: number;
  /** Git ref the bootstrap clones at — defaults to "main". */
  installerGitRef?: string;
  /** Default Hetzner location. */
  defaultRegion: string;
  /** Default Hetzner server_type. */
  defaultSize: string;
  /** Ordered fallback list tried on a 422. */
  fallbackServerTypes?: readonly string[];
  /** Hetzner OS image — defaults to "debian-12". Tests can override. */
  hetznerImage?: string;
  random?: (n: number) => Uint8Array;
  now?: () => number;
}

export interface AdminCloudInitNowBody {
  region?: unknown;
  size?: unknown;
  /** Disk-encryption choice threaded into the signed InstallBlob (auth.ts
   *  `de=` field). "luks"/absent ⇒ encrypted; "none" ⇒ unencrypted boot. */
  diskEncryption?: unknown;
}

const USERNAME_RE = /^[a-z0-9-]{3,32}$/;

const DEFAULT_INSTALLER_GIT_REF = "main";

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function nowOf(deps: DemoCloudInitDeps): number {
  return (deps.now ?? Date.now)();
}

function v4Uuid(rand: (n: number) => Uint8Array): string {
  const b = rand(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DEFAULT_DEMO_PRIMARY_SCOPES: readonly DeviceScope[] =
  _internalDefaultDemoPrimaryScopes;

// ──────────────────────────────────────────────────────────────────────
// Cloud-init user_data builder
// ──────────────────────────────────────────────────────────────────────

/**
 * Encode a UTF-8 string as base64 (atob/btoa not available in Workers
 * for non-ASCII; this path is ASCII-only because install-blob fields
 * are username + hex + URLs, but use the canonical TextEncoder+btoa
 * shape anyway for safety).
 */
function b64Utf8(s: string): string {
  // The Worker's V8 has btoa. Encode the string to ASCII-safe form
  // first via TextEncoder + iteration (the input is always ASCII for
  // the install-blob shape — hex / urls / usernames / numbers).
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // Workers global btoa is available in the workerd runtime; fall back
  // to a tiny inline encoder for the unit-test (node) environment.
  if (typeof (globalThis as { btoa?: (s: string) => string }).btoa === "function") {
    return (globalThis as { btoa: (s: string) => string }).btoa(bin);
  }
  return Buffer.from(bin, "binary").toString("base64");
}

/**
 * Build the cloud-config YAML that Hetzner hands to cloud-init. The
 * resulting blob is plain ASCII ≤ ~16 KB; well under Hetzner's
 * `user_data` cap (~64 KB).
 *
 * Exported so the unit test can eyeball the script Hetzner will run
 * (same convention as buildCloudInitUserData in W11).
 *
 * Inputs:
 *   - installBlobJson  the SAME InstallBlobJsonShort shape the W11
 *                      build-ticket persists; the bootstrap drops it
 *                      verbatim at /var/flagship/install-blob.json so
 *                      install-helper.ts sign-server-register reads it.
 *   - installerGitRef  e.g. "main" — what to git-clone --branch.
 */
export function buildCloudConfigUserData(args: {
  installBlobJson: string;
  installerGitRef: string;
  /**
   * Demo User IRK private key (hex). Shipped on the demo cloud-init path
   * so the box can mint the IRK-signed entitlement bundle (N12b) after
   * generating its STK identity, then shred this file. The IRK is
   * deterministic-from-KEK for demo accounts; the KEK is the real
   * secret. Real installs deliver the bundle from the phone instead and
   * never ship the IRK priv.
   */
  demoUserIrkPrivHex: string;
}): string {
  const blobB64 = b64Utf8(args.installBlobJson);
  if (!/^[0-9a-f]{64}$/i.test(args.demoUserIrkPrivHex)) {
    throw new Error("buildCloudConfigUserData: demoUserIrkPrivHex must be 32-byte hex");
  }
  // Validate git-ref shape inline (defense in depth — the operator
  // could only have set this via the Worker's wrangler.toml or
  // env-coded default, but the ref still gets shell-substituted in the
  // bootstrap below). Same allowlist as installer-netboot's preseed
  // validator.
  if (!/^[A-Za-z0-9._/-]+$/.test(args.installerGitRef)) {
    throw new Error("buildCloudConfigUserData: installerGitRef has disallowed characters");
  }
  if (args.installerGitRef.includes("..")) {
    throw new Error("buildCloudConfigUserData: installerGitRef contains '..'");
  }
  // The bootstrap script is heredoc-quoted ('EOF') so cloud-init does
  // NOT expand its $vars at template time — they expand on the VPS.
  // Variables we want resolved at TEMPLATE time (only the git-ref)
  // are inlined directly via JS interpolation.
  const bootstrap = `#!/bin/bash
# Flagship cloud-init-direct bootstrap (W13).
#
# Runs ONCE on the freshly-booted debian-12 VPS via cloud-init runcmd.
# Does everything installer/install.sh + installer-netboot/late-command.sh
# do, minus the partman/d-i scaffolding and the trailer parse. The
# install-blob is already at /var/flagship/install-blob.json (written
# by write_files above).
#
# Failure mode: each step appends to /var/log/flagship-bootstrap.log;
# a stalled step leaves enough to debug via journalctl + ssh.

set -uo pipefail
exec >>/var/log/flagship-bootstrap.log 2>&1
date
echo "[flagship-bootstrap] starting"

REPO_URL="\${FLAGSHIP_REPO_URL:-https://github.com/ibisllc/flagship.git}"
GIT_REF="${args.installerGitRef}"

# 1. Install build deps FIRST — debian-12 cloud images do NOT ship
#    jq, git, or node by default. Install jq/git/curl/cryptsetup first,
#    then layer on Node.js 20 from NodeSource (Debian-12 only ships
#    Node 18, but flagship + @noble/curves + @peculiar/x509 all need
#    Node 20+ — specifically crypto.getRandomValues as a global, added
#    in Node 19). docker-compose-v2 is not a Debian-12 package; drop
#    it. Daemon registration doesn't need docker on the demo path.
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \\
    git curl jq ca-certificates xxd cryptsetup lvm2 gnupg \\
    || echo "[flagship-bootstrap] WARNING: some apt packages failed; check above"

# NodeSource Node 20 — official upstream Node.js apt repo. Idempotent
# even if rerun. Uses the setup script's keyring + sources.list.d entry.
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y --no-install-recommends nodejs \\
    || echo "[flagship-bootstrap] WARNING: NodeSource nodejs install failed"
echo "[flagship-bootstrap] node $(node --version) npm $(npm --version)"

# 2. Read the install-blob fields the daemon needs (jq is now installed).
BLOB_JSON=/var/flagship/install-blob.json
SERVER_DOMAIN="$(jq -r .serverDomain "$BLOB_JSON")"
USERNAME="$(jq -r .username "$BLOB_JSON")"
SERVER_NAME="$(jq -r .serverName "$BLOB_JSON")"
REGISTRATION_URL="$(jq -r .registrationUrl "$BLOB_JSON")"
PHONE_DELEGATED_PUBKEY="$(jq -r .phoneDelegatedPubKey "$BLOB_JSON")"
AUTH_CODE_SERIAL="$(jq -r .authCode.serial "$BLOB_JSON")"
echo "[flagship-bootstrap] domain=$SERVER_DOMAIN user=$USERNAME ref=$GIT_REF"

# Provisioning observability — POST a canonical ProvisionStatusPhase to the
# SINGLE order-status channel (POST /api/order/<serial>/status) so the phone's
# install-progress tracks each step instead of staring at a black box. Keyed by
# the auth-code serial the box already holds (a capability the phone + installer
# share). ALWAYS fail-open: a progress POST that errors MUST NOT abort the
# install (|| true on every call). CTRL_BASE is derived from the registration
# URL, which always points at the same .com origin.
CTRL_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
report_phase() {
    # $1 = canonical ProvisionStatusPhase, $2 = optional detail (with error)
    local _phase="$1"; local _detail="\${2:-}"
    echo "[flagship-bootstrap] phase=$_phase"
    if [ -n "$_detail" ]; then
        curl -fsS -m 10 -X POST -H "content-type: application/json" \\
            --data "{\\"phase\\":\\"$_phase\\",\\"detail\\":\\"$_detail\\"}" \\
            "$CTRL_BASE/api/order/$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
    else
        curl -fsS -m 10 -X POST -H "content-type: application/json" \\
            --data "{\\"phase\\":\\"$_phase\\"}" \\
            "$CTRL_BASE/api/order/$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
    fi
}
report_phase booting

# 3. Persist install-time facts the daemon reads on every boot.
mkdir -p /var/flagship /boot/flagship
echo "$SERVER_DOMAIN"          > /var/flagship/server-domain
echo "$USERNAME"               > /var/flagship/username
echo "$SERVER_NAME"            > /var/flagship/server-name
echo "$PHONE_DELEGATED_PUBKEY" > /var/flagship/phone-delegated.pub
echo "$AUTH_CODE_SERIAL"       > /var/flagship/auth-code-serial
cp "$BLOB_JSON" /boot/install-blob.json
echo "$PHONE_DELEGATED_PUBKEY" > /boot/phone-delegated.pub
echo "$REGISTRATION_URL"       > /boot/registration-url
echo "$SERVER_DOMAIN"          > /boot/server-domain
echo "$GIT_REF"                > /boot/installer-ref

# 4. Generate a random LUKS first-boot key. W13 demo path does NOT
#    re-key root (debian-12's rootfs stays plaintext), but we still
#    mint + seal + upload the key so the contract surface with
#    .com/sealed-luks-key is preserved — drop-in for the W13→(b) volume
#    follow-up.
LUKS_KEY=/run/flagship-luks.key
mkdir -p /run
head -c 64 /dev/urandom > "$LUKS_KEY"
chmod 600 "$LUKS_KEY"

# 5. Clone Flagship + build the daemon.
echo "[flagship-bootstrap] cloning $REPO_URL @ $GIT_REF"
rm -rf /opt/flagship
if ! git clone --depth 50 --branch "$GIT_REF" "$REPO_URL" /opt/flagship; then
    git clone --depth 50 "$REPO_URL" /opt/flagship
    git -C /opt/flagship fetch --depth 50 origin "$GIT_REF" || true
    git -C /opt/flagship checkout "$GIT_REF" || true
fi
cd /opt/flagship
report_phase installing
# Use npm-install instead of npm-ci. Debian's nodejs-18 + npm-9.2
# combo handles our workspace-heavy package-lock unreliably with ci
# (silently no-ops on workspaces). install is more forgiving and
# resolves workspaces correctly. Tee output to a dedicated log so
# the operator can post-mortem npm errors directly.
echo "[flagship-bootstrap] npm install (with workspace resolution)"
npm install --no-audit --no-fund --workspaces --include-workspace-root 2>&1 \\
    | tee /var/log/flagship-npm.log
NPM_RC=\${PIPESTATUS[0]}
echo "[flagship-bootstrap] npm install exit=$NPM_RC"
report_phase installing
# Verify the critical workspace symlink ended up in place.
if [ ! -e /opt/flagship/node_modules/@flagship/protocol/package.json ]; then
    echo "[flagship-bootstrap] WARN: workspace @flagship/protocol not symlinked — retrying with explicit symlinks"
    mkdir -p /opt/flagship/node_modules/@flagship
    for pkg in /opt/flagship/packages/*/; do
        name=$(jq -r .name "$pkg/package.json" 2>/dev/null || echo "")
        if [ -n "$name" ]; then
            short=\${name#@flagship/}
            ln -sfn "$pkg" "/opt/flagship/node_modules/$name"
            echo "[flagship-bootstrap]   linked $name -> $pkg"
        fi
    done
fi
echo "[flagship-bootstrap] tsc -b"
npx tsc -b 2>&1 | tee /var/log/flagship-tsc.log || \\
    echo "[flagship-bootstrap] warning: tsc -b reported errors"
report_phase downloading

# 6. Generate server identity.
mkdir -p /var/flagship/identity
chmod 700 /var/flagship/identity
npx tsx scripts/install-helper.ts gen-identity \\
    --out-priv /var/flagship/identity/identity.priv.hex \\
    --out-pub  /var/flagship/identity/identity.pub.hex \\
    --out-pem  /boot/identity.pem
chmod 600 /var/flagship/identity/identity.priv.hex /boot/identity.pem
SERVER_IDENTITY_PRIV_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.priv.hex)"
SERVER_IDENTITY_PUB_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.pub.hex)"
report_phase downloading

# 6b. Mint the IRK-signed entitlement bundle the daemon presents on
#     every tunnel HELLO (N12b). The RootEntitlement binds this box's
#     STK (the identity pubkey just generated) to its canonical FQDN,
#     signed by the demo User IRK. The hub routes both the pod canonical
#     AND its one-label app children off this single root canonical via
#     the registry wildcard fallback, so no ServiceEntitlement is needed
#     for the demo to serve. Without this file the daemon exits 1
#     (entitlement bundle not found) and never serves. The demo IRK priv
#     was written by cloud-init write_files at /run/flagship-demo-irk.hex;
#     we shred it right after.
DEMO_IRK_PRIV_FILE=/run/flagship-demo-irk.hex
if [ -s "$DEMO_IRK_PRIV_FILE" ]; then
    DEMO_IRK_PRIV_HEX="$(tr -d '\\n' < "$DEMO_IRK_PRIV_FILE")"
    npx tsx scripts/install-helper.ts mint-entitlements \\
        --irk-priv "$DEMO_IRK_PRIV_HEX" \\
        --pod-pub "$SERVER_IDENTITY_PUB_HEX" \\
        --username "$USERNAME" \\
        --pod-canonical "$SERVER_DOMAIN" \\
        --out /var/flagship/entitlements.json \\
        || echo "[flagship-bootstrap] WARNING: mint-entitlements failed; daemon will not serve"
    chmod 600 /var/flagship/entitlements.json 2>/dev/null || true
    shred -u "$DEMO_IRK_PRIV_FILE" 2>/dev/null || rm -f "$DEMO_IRK_PRIV_FILE"
    echo "[flagship-bootstrap] entitlement bundle minted; demo IRK priv shredded"
else
    echo "[flagship-bootstrap] WARNING: demo IRK priv missing at $DEMO_IRK_PRIV_FILE; cannot mint entitlements"
fi

# 7. Seal LUKS key for the phone (sealForRecipient — Ed25519→X25519
#    birational map, same as the Alpine install.sh path).
SEALED_LUKS_KEY_HEX="$(npx tsx scripts/install-helper.ts \\
    seal-for-bak \\
    --bak-ed25519-pub "$PHONE_DELEGATED_PUBKEY" \\
    --in "$LUKS_KEY" | tr -d '\\n' || echo '')"
shred -u "$LUKS_KEY" 2>/dev/null || rm -f "$LUKS_KEY"

# 7b. Daemon environment. server-daemon reads its two REQUIRED inputs
#     (FLAGSHIP_SUBDOMAIN + FLAGSHIP_IDENTITY_PRIV_HEX) from the process
#     env only; without them it logs "Missing required inputs" and exits
#     2. systemd loads this file via EnvironmentFile= in the unit below.
mkdir -p /etc/flagship
cat > /etc/flagship/daemon.env <<ENVEOF
FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN
FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
ENVEOF
chmod 600 /etc/flagship/daemon.env

# 8. Write systemd units. Three pieces, in order:
#      flagship-data-services  — docker-compose'd postgres/minio/redis/adminer
#      flagship-daemon         — the actual server-daemon
#      flagship-first-boot-register — one-shot, POSTs /api/server/register
cat > /etc/systemd/system/flagship-daemon.service <<'UNIT'
[Unit]
Description=Flagship server daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/flagship
EnvironmentFile=/etc/flagship/daemon.env
ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/flagship-first-boot-register.service <<UNIT
[Unit]
Description=Flagship first-boot registration with .com
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/var/flagship/registered.flag

[Service]
Type=oneshot
WorkingDirectory=/opt/flagship
ExecStart=/usr/local/sbin/flagship-first-boot-register.sh

[Install]
WantedBy=multi-user.target
UNIT

# Write the register wrapper as a real script — easier to debug than a
# multi-line ExecStart with backslash continuations + systemd quoting.
cat > /usr/local/sbin/flagship-first-boot-register.sh <<'WRAPPER'
#!/bin/bash
set -uo pipefail
exec >>/var/log/flagship-first-boot-register.log 2>&1
date
echo "[register] starting"
cd /opt/flagship
. /etc/flagship-bootstrap.env
NOW=$(date +%s%3N)
npx tsx scripts/install-helper.ts sign-server-register \
    --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \
    --auth-code-blob /var/flagship/install-blob.json \
    > /run/register-payload.json
echo "[register] POST $REGISTRATION_URL"
curl -fsS -X POST -H "content-type: application/json" \
    --data @/run/register-payload.json \
    "$REGISTRATION_URL"
CTRL_BASE=$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')
if [ -n "\${SEALED_LUKS_KEY_HEX:-}" ]; then
    npx tsx scripts/install-helper.ts sign-sealed-key \
        --priv "$SERVER_IDENTITY_PRIV_HEX" \
        --server-id "$SERVER_DOMAIN" \
        --sealed-hex "$SEALED_LUKS_KEY_HEX" \
        --issued-at "$NOW" \
        > /run/sealed-key-payload.json
    curl -fsS -X POST -H "content-type: application/json" \
        --data @/run/sealed-key-payload.json \
        "$CTRL_BASE/api/server/$SERVER_DOMAIN/sealed-luks-key"
fi
date > /var/flagship/registered.flag
echo "[register] done"
WRAPPER
chmod +x /usr/local/sbin/flagship-first-boot-register.sh

# Stash the variables the wrapper needs (the bootstrap has them in
# scope; systemd's ExecStart sees only the unit's Environment= block).
cat > /etc/flagship-bootstrap.env <<ENV
SERVER_DOMAIN=$SERVER_DOMAIN
USERNAME=$USERNAME
SERVER_NAME=$SERVER_NAME
REGISTRATION_URL=$REGISTRATION_URL
SERVER_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
SEALED_LUKS_KEY_HEX=$SEALED_LUKS_KEY_HEX
ENV
chmod 600 /etc/flagship-bootstrap.env

systemctl daemon-reload
systemctl enable flagship-daemon.service flagship-first-boot-register.service
echo "[flagship-bootstrap] systemd units installed + enabled"

# 9. Run registration INLINE here (don't wait for systemd to pick it
#    up; systemd ordering can lag and we want demoalice's pod to
#    register as soon as the bootstrap finishes).
echo "[flagship-bootstrap] running first-boot register inline"
/usr/local/sbin/flagship-first-boot-register.sh || \\
    echo "[flagship-bootstrap] warning: first-boot register exited non-zero (continuing)"
# The wrapper writes registered.flag only on a successful POST; mirror
# that as the canonical 'registering' phase. The daemon takes over the
# canonical channel from here (pairing → live, or a terminal error).
if [ -e /var/flagship/registered.flag ]; then
    report_phase registering
else
    report_phase error "first-boot register did not complete"
fi
systemctl start flagship-daemon.service || \\
    echo "[flagship-bootstrap] warning: daemon start non-zero (continuing)"

date > /var/flagship/installed.flag
echo "[flagship-bootstrap] done"
`;
  const bootstrapB64 = b64Utf8(bootstrap);
  const irkPrivB64 = b64Utf8(args.demoUserIrkPrivHex + "\n");
  // cloud-config YAML. We base64-encode each file so newlines + quotes
  // pass through unmolested. The demo IRK priv lands at
  // /run/flagship-demo-irk.hex (0600, tmpfs) so the bootstrap can mint
  // the entitlement bundle then shred it; it never persists to disk.
  return `#cloud-config
write_files:
  - path: /var/flagship/install-blob.json
    permissions: '0600'
    owner: root:root
    encoding: b64
    content: ${blobB64}
  - path: /usr/local/sbin/flagship-bootstrap.sh
    permissions: '0755'
    owner: root:root
    encoding: b64
    content: ${bootstrapB64}
  - path: /run/flagship-demo-irk.hex
    permissions: '0600'
    owner: root:root
    encoding: b64
    content: ${irkPrivB64}
runcmd:
  - [ /bin/bash, /usr/local/sbin/flagship-bootstrap.sh ]
`;
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/dev/sample-user/<u>/admin-cloud-init-now
// ──────────────────────────────────────────────────────────────────────

/**
 * Worker-side cloud-init-direct provisioning kickoff. Mirrors
 * handleAdminSnapshotNow's contract (404 / 409 / 200-reused / 202 /
 * 502) so the calling CLI / cron poller can switch endpoints with a
 * one-line change.
 */
export async function handleAdminCloudInitNow(
  deps: DemoCloudInitDeps,
  username: string,
  body?: AdminCloudInitNowBody,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) {
    return malformed("username must match [a-z0-9-]{3,32}");
  }
  const row = await deps.storage.get(u);
  if (!row) return notFound("no such demo user");

  // Idempotency: same shape as W11.
  if (row.state === "up" || row.state === "provisioning") {
    return {
      status: 200,
      body: {
        state: row.state,
        activeServerId: row.activeServerId,
        reused: true,
      },
    };
  }

  const userRow = await deps.usernames.get(u);
  if (!userRow) {
    return conflict(
      "usernames row missing; call /admin-claim-and-issue first",
    );
  }

  const rand = deps.random ?? defaultRandom;
  const now = nowOf(deps);
  const region = typeof body?.region === "string" ? body.region : deps.defaultRegion;
  const size = typeof body?.size === "string" ? body.size : deps.defaultSize;
  const diskEncryption = parseDiskEncryption(body?.diskEncryption);
  if (diskEncryption !== undefined && typeof diskEncryption === "object") {
    return malformed(diskEncryption.error);
  }
  const serverName = "home";
  const installerGitRef = deps.installerGitRef ?? DEFAULT_INSTALLER_GIT_REF;

  // Re-derive User IRK + delegated + RCK keypair. Same construction
  // path as handleAdminSnapshotNow, so trailer-free and ISO-based runs
  // sign with the exact same IRK.
  const userIrk = deriveDemoUserIrk(deps.demoIrkKek, u);
  const delegated = deriveDemoDelegatedKey(deps.demoIrkKek, u);
  const rck = deriveDemoRckKey(deps.demoIrkKek, u);
  const userIrkHex = bytesToHex(userIrk.publicKey);
  if (userRow.irkPubHex !== userIrkHex) {
    return conflict(
      "derived User IRK mismatches the claimed usernames row; KEK rotated?",
    );
  }

  const serial = bytesToHex(rand(16));
  const serverDomain = `${serverName}.${u}.flagship.services`;
  const issuedAt = now;
  const expiresAt = now + 24 * 3_600_000;

  const authCode: AuthCode = {
    version: 1,
    serial,
    username: u,
    serverName,
    serverDomain,
    delegatedPubKey: delegated.publicKey,
    userPubKey: userIrk.publicKey,
    issuedAt,
    expiresAt,
  };
  const authCodeSig = signAuthCode(authCode, userIrk);
  const acResult = await deps.authCodes.put({
    serial,
    username: u,
    serverName,
    serverDomain,
    delegatedPubKeyHex: bytesToHex(delegated.publicKey),
    userPubKeyHex: userIrkHex,
    userSignatureHex: bytesToHex(authCodeSig),
    issuedAt,
    expiresAt,
    status: "active",
    recordedAt: now,
  });
  if (!acResult.ok) {
    return conflict(`auth-code persist failed: ${acResult.reason}`);
  }

  const blob: InstallBlob = {
    version: 2,
    serverDomain,
    username: u,
    serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature: authCodeSig,
    installerGitRef,
    rckPubKey: rck.publicKey,
    // Carry diskEncryption ONLY for "none" — keeps the signed bytes
    // byte-identical to a legacy recipe for the default encrypted case.
    ...(diskEncryption === "none" ? { diskEncryption: "none" as const } : {}),
  };
  const blobSig = signInstallBlob(blob, userIrk);
  const blobJson = installBlobJsonShortString(blob, blobSig);

  // No build-ticket emission — QR-pipe is the only flow; the cloud-
  // init demo path embeds the signed blob directly into the VPS's
  // user_data, so .com never stores the blob at rest.

  // (Re-)mint the primary DeviceCapabilityGrant — same revoke-then-put
  // dance as handleAdminSnapshotNow so re-running admin-cloud-init-now
  // doesn't leave two active grants.
  const existing = await deps.deviceCapabilityGrants.getActiveForUserLabel(
    u,
    "primary",
  );
  if (existing) {
    await deps.deviceCapabilityGrants.revoke(existing.grantId, now);
  }
  const grantId = v4Uuid(rand);
  const grant: DeviceCapabilityGrant = {
    grantId,
    username: u,
    deviceLabel: "primary",
    devicePubKey: userIrk.publicKey,
    scopes: [...DEFAULT_DEMO_PRIMARY_SCOPES],
    issuedAt: now,
    expiresAt: now + 90 * 24 * 3_600_000,
  };
  const grantSig = signDeviceCapabilityGrant(grant, userIrk);
  await deps.deviceCapabilityGrants.put({
    grantId,
    username: u,
    deviceLabel: "primary",
    devicePubHex: userIrkHex,
    scopesJson: JSON.stringify(grant.scopes),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: bytesToHex(grantSig),
    revokedAt: null,
  });

  // Build cloud-config user_data. No R2, no trailer — install-blob is
  // inlined as base64.
  const userData = buildCloudConfigUserData({
    installBlobJson: blobJson,
    installerGitRef,
    demoUserIrkPrivHex: bytesToHex(userIrk.privateKey),
  });

  let prov: { serverId: string; ipv4: string | null };
  try {
    prov = await deps.hetzner.createServerWithUserData({
      name: `flagship-demo-${u}-${bytesToHex(rand(4))}`,
      location: region,
      serverType: size,
      image: deps.hetznerImage ?? "debian-12",
      userData,
      username: u,
      ...(deps.demoSshKeyId !== undefined ? { sshKeyId: deps.demoSshKeyId } : {}),
      ...(deps.fallbackServerTypes
        ? { fallbackServerTypes: deps.fallbackServerTypes }
        : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 502,
      body: { error: "hetzner upstream rejected", detail: msg.slice(0, 280) },
    };
  }

  // CAS none → provisioning. Row never carries isoR2Key on this path
  // (cloud-init-direct doesn't use R2), so we leave that field
  // explicitly null.
  const image = deps.hetznerImage ?? "debian-12";
  const transitioned = await deps.storage.transition(u, "none", "provisioning", {
    activeServerId: prov.serverId,
    activeServerIp: prov.ipv4,
    image,
    isoR2Key: null,
    lastActivityAt: now,
  });
  if (!transitioned) {
    await deps.storage.update(u, {
      activeServerId: prov.serverId,
      activeServerIp: prov.ipv4,
      image,
      isoR2Key: null,
    });
  }

  return {
    status: 202,
    body: {
      state: "provisioning",
      activeServerId: prov.serverId,
      ipv4: prov.ipv4,
      // Diagnostic — surfaces the actual image the Worker requested so
      // the operator can confirm cloud-init-direct is in play and not
      // an accidental fall-through to W11's ubuntu-22.04.
      image: deps.hetznerImage ?? "debian-12",
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Local InstallBlob → JSON serializer (mirrors W11's shape exactly so
// install-helper.ts can read it identically across both paths).
// ──────────────────────────────────────────────────────────────────────

interface InstallBlobJsonShort {
  version: 2;
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKey: string;
  registrationUrl: string;
  authCode: {
    version: number;
    serial: string;
    username: string;
    serverName: string;
    serverDomain: string;
    delegatedPubKey: string;
    userPubKey: string;
    issuedAt: number;
    expiresAt: number;
  };
  authCodeUserSignature: string;
  installerGitRef: string;
  rckPubKey: string;
  /** Present iff the blob carries diskEncryption ("none") — the box reads
   *  this from the embedded recipe to decide whether to LUKS-encrypt root. */
  diskEncryption?: "luks" | "none";
}

function installBlobJsonShortString(b: InstallBlob, _sig: Uint8Array): string {
  const json: InstallBlobJsonShort = {
    version: 2,
    serverDomain: b.serverDomain,
    username: b.username,
    serverName: b.serverName,
    phoneDelegatedPubKey: bytesToHex(b.phoneDelegatedPubKey),
    registrationUrl: b.registrationUrl,
    authCode: {
      version: 1,
      serial: b.authCode.serial,
      username: b.authCode.username,
      serverName: b.authCode.serverName,
      serverDomain: b.authCode.serverDomain,
      delegatedPubKey: bytesToHex(b.authCode.delegatedPubKey),
      userPubKey: bytesToHex(b.authCode.userPubKey),
      issuedAt: b.authCode.issuedAt,
      expiresAt: b.authCode.expiresAt,
    },
    authCodeUserSignature: bytesToHex(b.authCodeUserSignature),
    installerGitRef: b.installerGitRef,
    rckPubKey: bytesToHex(b.rckPubKey),
    // Echo diskEncryption exactly as signed (present iff "none").
    ...(b.diskEncryption !== undefined ? { diskEncryption: b.diskEncryption } : {}),
  };
  return JSON.stringify(json);
}
