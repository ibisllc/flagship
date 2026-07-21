import type { InstallBlob } from "@flagship/protocol";
import { bytesToHex } from "./hex.js";

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
  /**
   * gating v2 — the owner's STABLE AID pubkey (hex). Pinned into the box config
   * (ownerAidPubHex) so the daemon verifies AID-signed service-invite create/
   * revoke + the box-as-authority redeem. Deterministic-from-KEK for demo; a
   * real install would carry it from the signed blob. OPTIONAL: absent ⇒ the
   * config omits it and the box falls back to owner-IRK verification.
   */
  ownerAidPubHex?: string;
}): string {
  const blobB64 = b64Utf8(args.installBlobJson);
  if (!/^[0-9a-f]{64}$/i.test(args.demoUserIrkPrivHex)) {
    throw new Error("buildCloudConfigUserData: demoUserIrkPrivHex must be 32-byte hex");
  }
  if (args.ownerAidPubHex !== undefined && !/^[0-9a-f]{64}$/i.test(args.ownerAidPubHex)) {
    throw new Error("buildCloudConfigUserData: ownerAidPubHex must be 32-byte hex");
  }
  // Pinned at TEMPLATE time (deterministic-from-KEK, like the git-ref) — it is
  // NOT in the install blob the bootstrap reads on the VPS.
  const ownerAidConfigField = args.ownerAidPubHex
    ? `,"ownerAidPubHex":"${args.ownerAidPubHex}"`
    : "";
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
    git curl jq ca-certificates xxd cryptsetup lvm2 gnupg openssl \\
    || echo "[flagship-bootstrap] WARNING: some apt packages failed; check above"
# Docker on a SEPARATE line so a docker failure can never break the core
# packages (git/curl/jq) the bootstrap depends on — a single bad name aborts the
# whole apt invocation. On Debian, docker.io bundles the CLI (there is NO
# docker-cli package — listing it aborts the install).
apt-get install -y --no-install-recommends docker.io docker-compose apparmor \\
    || echo "[flagship-bootstrap] WARNING: docker install failed; apps won't run"
# apparmor provides apparmor_parser — Debian enables AppArmor, and without the
# parser \`docker run\` fails to load the docker-default profile (exit 127), so
# NO container ever starts. (Surfaced installing a real service on a gym box.)
systemctl enable --now docker.service 2>/dev/null || echo "[flagship-bootstrap] WARNING: docker enable failed"

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
# The account (owner) IRK pubkey. The box pins this as the verifier for every
# owner-signed request (front-page / journal / power / dead-man). On the demo
# path it's the deterministic demo User IRK the admin minted into the blob.
USER_IRK_PUB="$(jq -r .authCode.userPubKey "$BLOB_JSON")"
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
#     FLAGSHIP_CONTROL_PLANE_BASE_URL pins the daemon to the SAME control
#     plane that provisioned it (CTRL_BASE, derived from the blob's
#     registrationUrl), so hub-discovery (/api/services/endpoints), ACME
#     DNS-01, and the status heartbeat all target this env. Prod boxes get
#     the default flagshipserver.com; a test env (gym) gets
#     gym.flagshipserver.com → the box lands in the gym's hub + DNS zone
#     instead of contaminating (or vanishing into) prod.
mkdir -p /etc/flagship
# Server config (FLAGSHIP_CONFIG). Gives the daemon the owner IRK so
# wireOwnerHandlers() mounts the owner-signed API — front-page (owner-assignable
# apex), journal (IRK-signed diagnostics), power, dead-man. WITHOUT a config the
# daemon logs "FLAGSHIP_CONFIG not provided; skipping local HTTP API" and every
# one of those endpoints 404s (the cfg===null short-circuit). bakPublicKey reuses
# the phone-delegated key — a valid 32-byte pub, and it's NOT on the owner-verify
# path (that's irkPublicKey). A malformed config fails closed (daemon falls back
# to no-cfg), so this never blocks the cert/serving bring-up.
cat > /etc/flagship/config.json <<CFGEOF
{"serverId":"$SERVER_DOMAIN","userId":"$USERNAME","bakPublicKey":"$PHONE_DELEGATED_PUBKEY","irkPublicKey":"$USER_IRK_PUB"${ownerAidConfigField}}
CFGEOF
chmod 600 /etc/flagship/config.json
# Sealing key (SWK). The daemon constructs the ServicePlatform — i.e. the whole
# services / build / deploy / screens / vibe surface — ONLY when it has
# host{username,irkPub} (the config above) AND an SWK. Nothing else mints one, so
# generate a random 32-byte SWK here: this is what flips a demo box from
# "cert+serve only" (GET /api/services → 503) to a full app-hosting box. (The
# demo root is plaintext, so this is a TEST sealing key, not a real at-rest key.)
openssl rand -hex 32 > /var/flagship/swk.hex 2>/dev/null \\
    || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /var/flagship/swk.hex
chmod 600 /var/flagship/swk.hex
cat > /etc/flagship/daemon.env <<ENVEOF
FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN
FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
FLAGSHIP_CONTROL_PLANE_BASE_URL=$CTRL_BASE
FLAGSHIP_CONFIG=/etc/flagship/config.json
FLAGSHIP_SWK_HEX=$(cat /var/flagship/swk.hex)
FLAGSHIP_PSK_PUB_HEX=$PHONE_DELEGATED_PUBKEY
FLAGSHIP_LLM_DEFAULT_MODEL=gpt-4o-mini
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
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=/opt/flagship
EnvironmentFile=/etc/flagship/daemon.env
ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon
# always, NOT on-failure: the daemon exits 0 to request a self-restart after
# provisioning a post-boot secret (SWK/CGK deposit), rotating the admin root, or
# committing an update (server-daemon/src/index.ts). on-failure would treat
# exit 0 as success and leave the box dead after it consumes its SWK.
Restart=always
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

# Data-services oneshot — brings up the docker stack (postgres/minio/redis/
# forgejo/chromium) that data-backed apps + the git/vibe BUILD path need. Gated
# on the env file NOT existing (init.sh writes it), so it's idempotent. The
# daemon degrades gracefully if it's not up yet (data layer disabled) and picks
# up the creds on its next restart, so this never blocks the cert/serve bring-up.
cat > /etc/systemd/system/flagship-data-services.service <<'DSUNIT'
[Unit]
Description=Flagship data-services (docker stack)
After=docker.service network-online.target
Wants=docker.service network-online.target
ConditionPathExists=!/var/flagship/data-services.env

[Service]
Type=oneshot
WorkingDirectory=/opt/flagship
ExecStart=/bin/bash /opt/flagship/installer/data-services/init.sh
RemainAfterExit=yes
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
DSUNIT

systemctl daemon-reload
systemctl enable flagship-daemon.service flagship-first-boot-register.service flagship-data-services.service
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
    adminRootPubKey?: string;
  };
  authCodeUserSignature: string;
  installerGitRef: string;
  rckPubKey: string;
  /** Present iff the blob carries diskEncryption ("none") — the box reads
   *  this from the embedded recipe to decide whether to LUKS-encrypt root. */
  diskEncryption?: "luks" | "none";
}

export function installBlobJsonShortString(b: InstallBlob, _sig: Uint8Array): string {
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
      ...(b.authCode.adminRootPubKey !== undefined
        ? { adminRootPubKey: bytesToHex(b.authCode.adminRootPubKey) }
        : {}),
    },
    authCodeUserSignature: bytesToHex(b.authCodeUserSignature),
    installerGitRef: b.installerGitRef,
    rckPubKey: bytesToHex(b.rckPubKey),
    // Echo diskEncryption exactly as signed (present iff "none").
    ...(b.diskEncryption !== undefined ? { diskEncryption: b.diskEncryption } : {}),
  };
  return JSON.stringify(json);
}

