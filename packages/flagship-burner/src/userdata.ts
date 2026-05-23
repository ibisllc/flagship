/**
 * cloud-init `user-data` generator for the Burner.
 *
 * The generated user-data is written next to the Ubuntu Server ISO on
 * the USB drive (as a CIDATA partition or as autoinstall files).
 * Subiquity reads it on boot and runs our bootstrap unattended.
 *
 * The bootstrap script here is a direct adaptation of the cloud-demo's
 * flagship-bootstrap.sh (packages/control-plane/src/demoUsersAdminCloudInit.ts).
 * Differences vs the demo path:
 *   - No demo-IRK derivation — the real InstallBlob came from the
 *     phone's real IRK.
 *   - No Hetzner-specific package tweaks.
 *   - We DO install Node 20 from NodeSource (Ubuntu 22.04 default is
 *     nodejs 12 — too old for our protocol; same root cause as the
 *     debian-12 path).
 *   - LUKS-encrypt-root is the DEFAULT (locked). Every burn produces an
 *     encrypted box keyed by the phone (the .com-blind relay path from
 *     docs/security-phone-as-unlock-endpoint.md) — it is NOT a user choice.
 *     EXPERIMENTAL — needs live validation (brick risk on first boot). An
 *     internal escape hatch (encryptRoot:false, NOT exposed in CLI/GUI)
 *     reproduces the proven unencrypted path for debugging only.
 *
 * EXECUTION CONTEXT — the critical difference vs the demo. The demo's
 * bootstrap runs at REAL boot (cloud-init runcmd on multi-user.target),
 * so it can `systemctl start` the daemon immediately. The Burner runs
 * THIS bootstrap inside curtin's in-target CHROOT during the autoinstall
 * (`late-commands` → `curtin in-target … flagship-bootstrap.sh`), where
 * systemd is NOT the running init — so `systemctl start` does nothing
 * useful and MUST NOT be relied on. We therefore only `systemctl enable`
 * the units (which works in a chroot — it just drops the symlink) and
 * defer both registration AND the daemon to systemd oneshot/simple units
 * that fire on the first REAL boot. We do NOT register inline in the
 * chroot (no guarantee of network during install; the demo's inline
 * register is a boot-time optimisation we can't safely copy here).
 */
import type { InstallBlob } from "@flagship/protocol";

/**
 * Build the autoinstall user-data YAML.
 *
 * The InstallBlob is embedded base64-encoded inside `write_files`; the
 * bootstrap script reads it back, never re-fetches over the network.
 */
export interface UserDataOptions {
  blob: InstallBlob;
  /** Hex signature over canonical blob bytes (from build-ticket redeem). */
  blobSignatureHex: string;
  /** Repo to clone for the daemon source. */
  flagshipRepoUrl?: string;
  /** Pinned git ref. Falls back to InstallBlob.installerGitRef or "main". */
  installerGitRef?: string;
  /**
   * Encrypt the installed root with LUKS, gated on the phone (the
   * `.com`-blind unlock-relay path from
   * docs/security-phone-as-unlock-endpoint.md).
   *
   * DEFAULT (locked): undefined or true → encrypted. LUKS is a day-1 promise,
   * not a user choice — neither the CLI nor the GUI exposes a toggle. The
   * autoinstall gets a curtin custom-storage layout with a LUKS-encrypted root
   * keyed by a random key-file (install.sh's pattern), the bootstrap seals that
   * key for the phone + uploads it to `.com`, builds the `/boot/flagship-unseal`
   * helper, and installs an initramfs hook that lifts boot-stage.sh's
   * unlock_via_relay() (POST SecretRequest → poll → unseal → cryptsetup
   * luksOpen), falling back to the legacy plaintext consume path on timeout.
   *
   * EXPERIMENTAL — needs live validation (brick risk on first boot).
   *
   * encryptRoot:false is an INTERNAL debug escape hatch only (not exposed in
   * CLI/GUI): it reproduces the proven unencrypted path byte-for-byte so a boot
   * failure can be bisected against the known-good baseline. Do NOT surface it.
   */
  encryptRoot?: boolean;
}

/**
 * The two boot-unlock modes (docs/security-phone-as-unlock-endpoint.md §7a.1).
 * Read from InstallBlob.bootUnlockMode (phone-signed); absent ⇒ "auto".
 */
type BootUnlockMode = "auto" | "approve";

export function buildAutoinstallUserData(opts: UserDataOptions): string {
  const blobJsonStr = JSON.stringify(installBlobToJson(opts.blob, opts.blobSignatureHex));
  const blobB64 = utf8ToBase64(blobJsonStr);
  const ref =
    opts.installerGitRef ?? (opts.blob.installerGitRef.trim() || "main");
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`refusing to embed unsafe git ref: ${ref}`);
  }
  const repo = opts.flagshipRepoUrl ?? "https://github.com/ibisllc/flagship.git";
  if (!repo.startsWith("https://")) {
    throw new Error("flagshipRepoUrl must be https://");
  }
  // LUKS is the DEFAULT (locked) — every burn produces an encrypted box. The
  // ONLY way to opt out is encryptRoot:false, an internal debug escape hatch
  // (NOT exposed in the CLI/GUI) for bisecting a boot failure against the
  // known-good plaintext path. See docs/security-phone-as-unlock-endpoint.md.
  const encryptRoot = opts.encryptRoot !== false;
  // Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
  // Phone-signed in the blob; absent ⇒ "auto" (the default). The box bakes
  // this to /boot and the initramfs hook branches on it: "auto" tries a
  // box-sealed lease first (self-unlock, no phone) then falls back to the
  // phone-gated relay; "approve" ALWAYS uses the relay and never touches a
  // lease (defense in depth — a critical server cannot self-unlock).
  const bootUnlockMode: BootUnlockMode =
    opts.blob.bootUnlockMode === "approve" ? "approve" : "auto";
  const bootstrap = buildBootstrapScript({ ref, repoUrl: repo, encryptRoot, bootUnlockMode });
  const bootstrapB64 = utf8ToBase64(bootstrap);
  // The LUKS storage block is emitted ONLY when encryptRoot is on. When off,
  // this is the empty string and the YAML is byte-identical to the working
  // unencrypted path (subiquity falls back to its default direct/whole-disk
  // layout). EXPERIMENTAL — needs live validation.
  //
  // The burn-time passphrase is a fixed constant (BURN_PASSPHRASE below): curtin
  // formats the LUKS volume with it, then the bootstrap (root already open in
  // the in-target chroot) generates a fresh random key — install.sh's
  // `head -c 64 /dev/urandom` pattern — adds it as a new key slot, removes the
  // burn-time passphrase, and seals the random key for the phone. So the only
  // recoverable key is the phone-sealed random one; the burn-time constant is
  // destroyed before first boot.
  const storageBlock = encryptRoot ? luksStorageBlock() : "";
  return `#cloud-config
# Flagship Burner — autoinstall user-data
# Generated at burn time. Don't edit by hand.
autoinstall:
  version: 1
  identity:
    hostname: flagship-pod
    username: flagship
    password: "$6$saltsaltsaltsaltsalt$Fz2j0/yjeyqQsRGfQ2DGRrXyMz9.6CljgPwQ3UlqOPLqo4kVZk.zhztOQS9rdshOMu7w5WL9.bjvKR7vCs71y0"
  ssh:
    install-server: true
    allow-pw: false
  packages:
    - git
    - curl
    - jq
    - ca-certificates
    - xxd
    - cryptsetup
    - lvm2
    - gnupg
${storageBlock}  late-commands:
    - curtin in-target --target=/target -- bash -c 'mkdir -p /var/flagship && echo "${blobB64}" | base64 -d > /var/flagship/install-blob.json && chmod 600 /var/flagship/install-blob.json'
    - curtin in-target --target=/target -- bash -c 'echo "${bootstrapB64}" | base64 -d > /usr/local/sbin/flagship-bootstrap.sh && chmod +x /usr/local/sbin/flagship-bootstrap.sh'
    - curtin in-target --target=/target -- /usr/local/sbin/flagship-bootstrap.sh
`;
}

/**
 * curtin custom-storage layout for the OPT-IN LUKS path (encryptRoot=true).
 *
 * EXPERIMENTAL — needs live validation on real hardware (brick risk).
 *
 * Ports install.sh's partitioning into subiquity/curtin: a small unencrypted
 * /boot (kernel + initramfs + identity + /boot/flagship-unseal + the unlock
 * hook) plus a LUKS2-encrypted root. curtin formats the LUKS volume with the
 * fixed burn-time passphrase BURN_PASSPHRASE; the bootstrap then re-keys it to a
 * fresh `head -c 64 /dev/urandom` random key (install.sh's pattern), removing
 * the burn-time passphrase, so the only recoverable key is the one sealed for
 * the phone.
 *
 * Emitted with a leading two-space indent so it nests under `autoinstall:` and
 * a trailing newline so `late-commands:` follows cleanly. Returns "" when off.
 */
function luksStorageBlock(): string {
  return `  # EXPERIMENTAL LUKS-on-root (opt-in; default OFF). Needs live validation.
  storage:
    config:
      - {id: disk0, type: disk, ptable: gpt, match: {size: largest}, wipe: superblock-recursive, grub_device: true, preserve: false}
      - {id: bios_grub, type: partition, device: disk0, size: 1M, flag: bios_grub, preserve: false}
      - {id: boot_part, type: partition, device: disk0, size: 512M, preserve: false}
      - {id: root_part, type: partition, device: disk0, size: -1, preserve: false}
      - {id: boot_fs, type: format, fstype: ext4, volume: boot_part, label: FLAGSHIP_BOOT, preserve: false}
      - {id: root_crypt, type: dm_crypt, volume: root_part, dm_name: flagship_root, key: "${BURN_PASSPHRASE}", preserve: false}
      - {id: root_fs, type: format, fstype: ext4, volume: root_crypt, label: FLAGSHIP_ROOT, preserve: false}
      - {id: root_mount, type: mount, device: root_fs, path: /}
      - {id: boot_mount, type: mount, device: boot_fs, path: /boot}
`;
}

/**
 * Fixed burn-time LUKS passphrase used ONLY between curtin's luksFormat and the
 * bootstrap's re-key step. It never reaches first boot: the bootstrap adds a
 * random key slot and `luksRemoveKey`s this constant before sealing. A constant
 * is safe because the window it's live in is the install itself (the same trust
 * boundary as the rest of the autoinstall), and it's destroyed before the box
 * is ever exposed. Kept identical in TS + Swift.
 */
const BURN_PASSPHRASE = "flagship-burn-time-luks-rekey-me-immediately";

interface BootstrapTemplateArgs {
  ref: string;
  repoUrl: string;
  encryptRoot: boolean;
  bootUnlockMode: BootUnlockMode;
}

function buildBootstrapScript(args: BootstrapTemplateArgs): string {
  if (args.encryptRoot) return buildBootstrapScriptEncrypted(args);
  return buildBootstrapScriptPlain(args);
}

function buildBootstrapScriptPlain(args: BootstrapTemplateArgs): string {
  return `#!/bin/bash
# Flagship first-boot bootstrap.
# Runs once at first boot under curtin's in-target chroot. Idempotent.
set -uo pipefail
exec >>/var/log/flagship-bootstrap.log 2>&1
date
echo "[flagship-bootstrap] starting"

REPO_URL="\${FLAGSHIP_REPO_URL:-${args.repoUrl}}"
GIT_REF="${args.ref}"

# Install Node 20 (Ubuntu 22.04 default nodejs is 12; protocol needs 20+).
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y --no-install-recommends nodejs

# Read the install-blob fields the daemon needs.
BLOB_JSON=/var/flagship/install-blob.json
SERVER_DOMAIN="$(jq -r .serverDomain "$BLOB_JSON")"
USERNAME="$(jq -r .username "$BLOB_JSON")"
SERVER_NAME="$(jq -r .serverName "$BLOB_JSON")"
REGISTRATION_URL="$(jq -r .registrationUrl "$BLOB_JSON")"
PHONE_DELEGATED_PUBKEY="$(jq -r .phoneDelegatedPubKey "$BLOB_JSON")"
AUTH_CODE_SERIAL="$(jq -r .authCode.serial "$BLOB_JSON")"
echo "[flagship-bootstrap] domain=$SERVER_DOMAIN user=$USERNAME ref=$GIT_REF"

# Persist install-time facts the daemon reads on every boot.
mkdir -p /var/flagship /boot/flagship
echo "$SERVER_DOMAIN"          > /var/flagship/server-domain
echo "$USERNAME"               > /var/flagship/username
echo "$SERVER_NAME"            > /var/flagship/server-name
echo "$PHONE_DELEGATED_PUBKEY" > /var/flagship/phone-delegated.pub
echo "$AUTH_CODE_SERIAL"       > /var/flagship/auth-code-serial
cp "$BLOB_JSON" /boot/install-blob.json

# Clone flagship + build daemon.
rm -rf /opt/flagship
git clone --depth 50 --branch "$GIT_REF" "$REPO_URL" /opt/flagship || \\
    (git clone --depth 50 "$REPO_URL" /opt/flagship && \\
     git -C /opt/flagship fetch --depth 50 origin "$GIT_REF" && \\
     git -C /opt/flagship checkout "$GIT_REF")
cd /opt/flagship
npm install --no-audit --no-fund --workspaces --include-workspace-root \\
    | tee /var/log/flagship-npm.log
if [ ! -e /opt/flagship/node_modules/@flagship/protocol/package.json ]; then
    echo "[flagship-bootstrap] WARN: workspace not symlinked; manual linking"
    mkdir -p /opt/flagship/node_modules/@flagship
    for pkg in /opt/flagship/packages/*/; do
        name=$(jq -r .name "$pkg/package.json" 2>/dev/null || echo "")
        [ -n "$name" ] && ln -sfn "$pkg" "/opt/flagship/node_modules/$name"
    done
fi
npx tsc -b 2>&1 | tee /var/log/flagship-tsc.log || true

# Generate server identity.
mkdir -p /var/flagship/identity
chmod 700 /var/flagship/identity
npx tsx scripts/install-helper.ts gen-identity \\
    --out-priv /var/flagship/identity/identity.priv.hex \\
    --out-pub  /var/flagship/identity/identity.pub.hex \\
    --out-pem  /boot/identity.pem
chmod 600 /var/flagship/identity/identity.priv.hex /boot/identity.pem
SERVER_IDENTITY_PRIV_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.priv.hex)"
SERVER_IDENTITY_PUB_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.pub.hex)"

# Mint the entitlement bundle the daemon hard-requires on every tunnel
# HELLO. The RootEntitlement binds this box's STK (the identity pubkey
# just generated) to its canonical FQDN.
#
# INTERIM SELF-SIGN — read this before touching it. The demo path signs
# the RootEntitlement with the deterministic demo *User IRK*. The real
# (Burner) path has NO user IRK on the box — the phone holds it — so we
# SELF-SIGN with the box's own identity key (pass the identity priv as
# the signer; --pod-pub is that same identity pubkey). This is SAFE today
# ONLY because the production tunnel hub does NOT verify the RootEntitle-
# ment's IRK signature: apps/web/src/server.ts wires startTunnelHub with
# authLookup but no irkLookup, and tunnelHub.ts skips the signature check
# when irkLookup is absent.
#
# FOLLOW-UP REQUIRED before irkLookup is enabled in production: replace
# this self-signed bundle with a phone-signed one. The proper flow is
# that after first boot the phone signs an EntitlementBundle for THIS
# box's STK (identity pubkey) with the user's real IRK and delivers it to
# /var/flagship/entitlements.json (process restart picks it up). Until
# then a self-signed bundle would be rejected the moment irkLookup goes
# live, so this MUST be cut over first.
npx tsx scripts/install-helper.ts mint-entitlements \\
    --irk-priv "$SERVER_IDENTITY_PRIV_HEX" \\
    --pod-pub "$SERVER_IDENTITY_PUB_HEX" \\
    --username "$USERNAME" \\
    --pod-canonical "$SERVER_DOMAIN" \\
    --out /var/flagship/entitlements.json \\
    || echo "[flagship-bootstrap] WARNING: mint-entitlements failed; daemon will not serve"
chmod 600 /var/flagship/entitlements.json 2>/dev/null || true

# Daemon environment. server-daemon reads its two REQUIRED inputs
# (FLAGSHIP_SUBDOMAIN + FLAGSHIP_IDENTITY_PRIV_HEX) from the process env
# only; systemd loads this via EnvironmentFile= in the unit below.
mkdir -p /etc/flagship
cat > /etc/flagship/daemon.env <<ENVEOF
FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN
FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
ENVEOF
chmod 600 /etc/flagship/daemon.env

# Write systemd units. We run inside curtin's in-target chroot where
# systemd is NOT running, so we ENABLE (drops the symlink, takes effect
# on first real boot) and never rely on \`systemctl start\`. Two units:
#   flagship-first-boot-register — oneshot, POSTs /api/server/register
#   flagship-daemon              — the long-running server-daemon
cat > /etc/systemd/system/flagship-daemon.service <<'UNIT'
[Unit]
Description=Flagship server daemon
After=network-online.target flagship-first-boot-register.service
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

# The register wrapper as a real script — easier to debug than a
# multi-line ExecStart with systemd quoting. It signs + POSTs the
# server-register payload on the first real boot (we deliberately do NOT
# register inline in the chroot: no guaranteed network during install).
cat > /usr/local/sbin/flagship-first-boot-register.sh <<'WRAPPER'
#!/bin/bash
set -uo pipefail
exec >>/var/log/flagship-first-boot-register.log 2>&1
date
echo "[register] starting"
cd /opt/flagship
. /etc/flagship-bootstrap.env
npx tsx scripts/install-helper.ts sign-server-register \\
    --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \\
    --auth-code-blob /var/flagship/install-blob.json \\
    > /run/register-payload.json
echo "[register] POST $REGISTRATION_URL"
curl -fsS -X POST -H "content-type: application/json" \\
    --data @/run/register-payload.json \\
    "$REGISTRATION_URL"
date > /var/flagship/registered.flag
echo "[register] done"
WRAPPER
chmod +x /usr/local/sbin/flagship-first-boot-register.sh

# Stash the variables the wrapper needs (the bootstrap has them in scope;
# systemd's ExecStart sees only the unit's environment).
cat > /etc/flagship-bootstrap.env <<ENV
SERVER_DOMAIN=$SERVER_DOMAIN
USERNAME=$USERNAME
SERVER_NAME=$SERVER_NAME
REGISTRATION_URL=$REGISTRATION_URL
SERVER_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
ENV
chmod 600 /etc/flagship-bootstrap.env

# daemon-reload is a no-op (and may warn) in the install chroot; the
# enable symlinks are what matter and they persist into the booted
# system. Do NOT \`systemctl start\` — systemd isn't the init here.
systemctl daemon-reload 2>/dev/null || true
systemctl enable flagship-daemon.service flagship-first-boot-register.service || \\
    echo "[flagship-bootstrap] WARNING: systemctl enable failed (will retry would be needed on real boot)"
echo "[flagship-bootstrap] systemd units installed + enabled (start deferred to first real boot)"

date > /var/flagship/installed.flag
echo "[flagship-bootstrap] done"
`;
}

/**
 * EXPERIMENTAL encrypted-root bootstrap (encryptRoot=true) — needs live
 * validation (brick risk). It is the plain bootstrap with three LUKS additions
 * spliced in just before the final `installed.flag`:
 *
 *   A. RE-KEY: generate a fresh `head -c 64 /dev/urandom` LUKS key (install.sh's
 *      pattern), add it as a new key slot, remove the burn-time passphrase.
 *   B. SEAL + UPLOAD: seal the random key for the phone (seal-for-bak, exactly
 *      as install.sh) and POST it to `.com`'s sealed-luks-key endpoint, so the
 *      phone can authorize future boots and `.com` only ever holds ciphertext.
 *   C. BAKE HELPER + INITRAMFS HOOK: build /opt/flagship/installer/unseal-helper
 *      with the cloned source's golang toolchain, install it to
 *      /boot/flagship-unseal, and drop an initramfs hook + premount script that
 *      lifts boot-stage.sh's unlock_via_relay() verbatim (with the legacy
 *      plaintext-consume fallback) so the root is unlocked pre-pivot on every
 *      boot. The initramfs needs openssl/curl/xxd/sed/cryptsetup pre-unlock.
 *
 * The non-LUKS body MUST stay byte-identical to buildBootstrapScriptPlain; the
 * userdata tests assert the shared lines appear in both.
 */
function buildBootstrapScriptEncrypted(args: BootstrapTemplateArgs): string {
  const plain = buildBootstrapScriptPlain(args);
  // Splice the LUKS block in just before the plain script's final two lines
  // (installed.flag + "done"), so the shared body is reused verbatim.
  const tail = `date > /var/flagship/installed.flag
echo "[flagship-bootstrap] done"
`;
  const luks = buildLuksBootstrapBlock(args.bootUnlockMode);
  if (!plain.endsWith(tail)) {
    throw new Error("plain bootstrap tail drifted; encrypted splice would be wrong");
  }
  return plain.slice(0, plain.length - tail.length) + luks + tail;
}

/**
 * The LUKS additions spliced into the encrypted bootstrap. EXPERIMENTAL —
 * needs live validation (brick risk). Kept byte-identical to the Swift port.
 *
 * `mode` is the phone-signed boot-unlock policy
 * (docs/security-phone-as-unlock-endpoint.md §7a.1). It is baked to
 * /boot/flagship-boot-unlock-mode and the embedded initramfs premount script
 * branches on it:
 *   - "auto"    — try unlock_via_box_lease() (self-unlock from a box-sealed
 *                 lease, no phone); on miss fall back to unlock_via_relay().
 *   - "approve" — unlock_via_relay() EVERY boot; never read a box-sealed lease.
 * The legacy plaintext-consume path is RETIRED from this dispatch.
 */
function buildLuksBootstrapBlock(mode: BootUnlockMode): string {
  return `
# ── EXPERIMENTAL: LUKS-on-root, phone-gated unlock (encryptRoot) ─────────
# Needs live validation; brick risk. This whole block is absent on the
# default unencrypted path. docs/security-phone-as-unlock-endpoint.md.
echo "[flagship-bootstrap] encryptRoot ON — configuring phone-gated LUKS unlock"

# A. RE-KEY the LUKS root: curtin formatted it with the fixed burn-time
#    passphrase; replace that with a fresh random key (install.sh's
#    head -c 64 /dev/urandom pattern), then remove the burn-time slot so the
#    only key that survives to first boot is the one we seal for the phone.
LUKS_BURN_PASSPHRASE='${BURN_PASSPHRASE}'
LUKS_KEY=/run/flagship-luks.key
head -c 64 /dev/urandom > "$LUKS_KEY"
chmod 600 "$LUKS_KEY"
# The encrypted root partition (curtin labelled the filesystem FLAGSHIP_ROOT;
# the underlying LUKS container is its parent block device).
ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
if [ -z "$ROOT_LUKS_PART" ]; then
    echo "[flagship-bootstrap] FATAL: no crypto_LUKS partition found; cannot re-key"
    exit 1
fi
echo "[flagship-bootstrap] re-keying LUKS root on $ROOT_LUKS_PART"
printf '%s' "$LUKS_BURN_PASSPHRASE" | \\
    cryptsetup luksAddKey "$ROOT_LUKS_PART" "$LUKS_KEY" --key-file=-
printf '%s' "$LUKS_BURN_PASSPHRASE" | \\
    cryptsetup luksRemoveKey "$ROOT_LUKS_PART" --key-file=-
echo "[flagship-bootstrap] LUKS re-keyed; burn-time passphrase removed"

# B. SEAL the random key for the phone + upload the sealed blob to .com. The
#    phone (and only the phone) can unseal it; .com stores ciphertext only.
#    Same seal-for-bak construction install.sh uses.
SEALED_LUKS_KEY_HEX="$(npx tsx scripts/install-helper.ts seal-for-bak \\
    --bak-ed25519-pub "$PHONE_DELEGATED_PUBKEY" \\
    --in "$LUKS_KEY" | tr -d '\\n')"
NOW_MS=$(date +%s%3N)
npx tsx scripts/install-helper.ts sign-sealed-key \\
    --priv "$SERVER_IDENTITY_PRIV_HEX" \\
    --server-id "$SERVER_DOMAIN" \\
    --sealed-hex "$SEALED_LUKS_KEY_HEX" \\
    --issued-at "$NOW_MS" \\
    > /run/sealed-key-payload.json
CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
curl -fsS -X POST -H 'content-type: application/json' \\
    --data @/run/sealed-key-payload.json \\
    "\${CONTROL_PLANE_BASE}/api/server/\${SERVER_DOMAIN}/sealed-luks-key" \\
    || echo "[flagship-bootstrap] WARNING: sealed-key upload failed; phone will need OOB"
# Shred the plaintext key — it now exists only sealed-for-phone at .com.
shred -u "$LUKS_KEY" 2>/dev/null || rm -f "$LUKS_KEY"

# /boot facts the initramfs unlock hook reads on every boot (mirrors the
# files boot-stage.sh expects: server-domain, identity.pem, control plane).
echo "$SERVER_DOMAIN" > /boot/server-domain
echo "$CONTROL_PLANE_BASE" > /boot/control-plane-url
# The identity PKCS8 PEM is already at /boot/identity.pem (gen-identity --out-pem).

# Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1). Baked
# from the phone-signed InstallBlob.bootUnlockMode (absent ⇒ "auto"). The
# initramfs premount script reads this on every boot (defaults to "auto" if the
# file is absent) and branches: "auto" self-unlocks via a box-sealed lease then
# falls back to the phone-gated relay; "approve" uses the relay EVERY boot and
# never touches a lease. The box NEVER deposits a lease itself.
echo "${mode}" > /boot/flagship-boot-unlock-mode

# C1. BAKE the unseal helper to /boot/flagship-unseal. Build-at-install from
#     the cloned source (auditable; no committed binary). golang-go from the
#     Ubuntu archive can build the CGO-free static helper (one dep, pinned).
echo "[flagship-bootstrap] building flagship-unseal from source"
apt-get install -y --no-install-recommends golang-go
( cd /opt/flagship/installer/unseal-helper && \\
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \\
    go build -trimpath -buildvcs=false -ldflags '-s -w' -o /boot/flagship-unseal . )
chmod 755 /boot/flagship-unseal
echo "[flagship-bootstrap] /boot/flagship-unseal baked ($(ls -l /boot/flagship-unseal))"

# C2. INITRAMFS HOOK. The hook copies the tools + helper into the initramfs;
#     the premount script runs unlock_via_relay() (lifted verbatim from
#     boot-stage.sh) before the root is mounted, then luksOpen's it.
mkdir -p /etc/initramfs-tools/hooks /etc/initramfs-tools/scripts/local-top
cat > /etc/initramfs-tools/hooks/flagship-unlock <<'HOOK'
#!/bin/sh
# Flagship initramfs hook: stage the unseal helper + identity + the crypto
# tools unlock_via_relay() needs (openssl curl xxd sed cryptsetup) into the
# initramfs, so the root can be unlocked pre-pivot with no encrypted-root deps.
set -e
PREREQ=""
prereqs() { echo "$PREREQ"; }
case "$1" in prereqs) prereqs; exit 0;; esac
. /usr/share/initramfs-tools/hook-functions
copy_exec /boot/flagship-unseal /bin/flagship-unseal
copy_exec /usr/bin/openssl /bin/openssl
copy_exec /usr/bin/curl /bin/curl
copy_exec /usr/bin/xxd /bin/xxd
copy_exec /bin/sed /bin/sed 2>/dev/null || copy_exec /usr/bin/sed /bin/sed
copy_exec /sbin/cryptsetup /sbin/cryptsetup 2>/dev/null || copy_exec /usr/sbin/cryptsetup /sbin/cryptsetup
# Identity + boot facts the premount script signs/reads with.
mkdir -p "\${DESTDIR}/boot"
cp /boot/identity.pem "\${DESTDIR}/boot/identity.pem"
cp /boot/server-domain "\${DESTDIR}/boot/server-domain"
cp /boot/control-plane-url "\${DESTDIR}/boot/control-plane-url" 2>/dev/null || true
cp /boot/flagship-boot-unlock-mode "\${DESTDIR}/boot/flagship-boot-unlock-mode" 2>/dev/null || true
HOOK
chmod +x /etc/initramfs-tools/hooks/flagship-unlock

# The premount script. unlock_via_relay() below is LIFTED VERBATIM from
# installer/boot-stage.sh (wave 3b owns its logic); only the surrounding
# scaffolding (paths, the luksOpen target, the fallback poll) is adapted to
# the initramfs. Keep the function body in sync with boot-stage.sh.
cat > /etc/initramfs-tools/scripts/local-top/flagship-unlock <<'PREMOUNT'
#!/bin/sh
PREREQ=""
prereqs() { echo "$PREREQ"; }
case "$1" in prereqs) prereqs; exit 0;; esac

set -eu
SERVER_DOMAIN="$(cat /boot/server-domain)"
CONTROL_PLANE="$(cat /boot/control-plane-url 2>/dev/null || echo https://flagshipserver.com)"
IDENTITY_KEY=/boot/identity.pem
UNSEAL_HELPER=/bin/flagship-unseal
RELAY_WINDOW_SECS="\${FLAGSHIP_RELAY_WINDOW_SECS:-180}"
OUT_UNLOCK=/run/unlock-key
# Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
# Baked by the bootstrap; default "auto" if the file is absent.
BOOT_UNLOCK_MODE="$(cat /boot/flagship-boot-unlock-mode 2>/dev/null || echo auto)"

[ -f "$IDENTITY_KEY" ] || { echo "flagship: missing $IDENTITY_KEY"; exit 0; }

sign_canonical() {
    canonical="$1"
    msgfile="/run/flagship-sign-msg.bin"
    printf '%s' "$canonical" > "$msgfile"
    openssl pkeyutl -sign -rawin -inkey "$IDENTITY_KEY" -in "$msgfile" 2>/dev/null \\
        | xxd -p -c 256 | tr -d '\\n'
    rm -f "$msgfile"
}
identity_seed_hex() {
    openssl pkey -in "$IDENTITY_KEY" -outform DER 2>/dev/null \\
        | xxd -p -c 256 | tr -d '\\n' | tail -c 64
}
identity_pub_hex() {
    openssl pkey -in "$IDENTITY_KEY" -pubout -outform DER 2>/dev/null \\
        | xxd -p -c 256 | tr -d '\\n' | tail -c 64
}

# ── unlock_via_box_lease() — LIFTED VERBATIM from installer/boot-stage.sh ──
# Self-unlock on the "auto" path: GET the box-sealed lease and unseal it
# LOCALLY with the STK key on /boot. .com holds ciphertext only (I1). No
# phone, no human. Returns 0 only if it actually unsealed; 404/empty (first
# boot, or a revoked lease) ⇒ non-zero so the caller falls back to the relay.
unlock_via_box_lease() {
    if [ ! -x "$UNSEAL_HELPER" ]; then
        echo "flagship: box-lease unavailable — $UNSEAL_HELPER missing/not executable"
        return 1
    fi
    SEED_HEX="$(identity_seed_hex)"
    if [ "\${#SEED_HEX}" != 64 ]; then
        echo "flagship: box-lease aborted — could not derive 32-byte seed from $IDENTITY_KEY"
        return 1
    fi

    LEASE_URL="\${CONTROL_PLANE}/api/server/\${SERVER_DOMAIN}/unlock-key/lease-v2"
    LEASE_RESP=/run/flagship-lease-v2.json
    LEASE_CODE=$(curl -sS -o "$LEASE_RESP" -w "%{http_code}" \\
        --max-time 30 "$LEASE_URL" || echo "000")
    if [ "$LEASE_CODE" = "404" ]; then
        echo "flagship: no box-sealed lease (HTTP 404) — falling back"
        return 1
    fi
    if [ "$LEASE_CODE" != "200" ]; then
        echo "flagship: box-lease HTTP $LEASE_CODE; body: $(head -c 200 "$LEASE_RESP" 2>/dev/null)"
        return 1
    fi

    # .com returns {serverDomain,leaseId,stkPub,sealedKey,...}; sealedKey is the
    # box-sealed LUKS key (hex). Extract it the same way unlock_via_relay()
    # extracts "sealed".
    SEALED_KEY=$(sed -n 's/.*"sealedKey":"\\([0-9a-fA-F]*\\)".*/\\1/p' "$LEASE_RESP")
    if [ -z "$SEALED_KEY" ]; then
        echo "flagship: box-lease 200 but no sealedKey: $(head -c 200 "$LEASE_RESP")"
        return 1
    fi

    if "$UNSEAL_HELPER" --identity-priv-hex "$SEED_HEX" --sealed-hex "$SEALED_KEY" \\
        > "$OUT_UNLOCK.hex" 2>/run/flagship-unseal.err; then
        tr -d '\\n' < "$OUT_UNLOCK.hex" > "$OUT_UNLOCK"
        chmod 600 "$OUT_UNLOCK"
        rm -f "$OUT_UNLOCK.hex"
        echo "flagship: self-unlocked from the box-sealed lease"
        return 0
    fi
    echo "flagship: $UNSEAL_HELPER failed on box-lease: $(head -c 200 /run/flagship-unseal.err 2>/dev/null)"
    rm -f "$OUT_UNLOCK.hex"
    return 1
}

# ── unlock_via_relay() — LIFTED VERBATIM from installer/boot-stage.sh ──────
unlock_via_relay() {
    if [ ! -x "$UNSEAL_HELPER" ]; then
        echo "flagship: relay unavailable — $UNSEAL_HELPER missing/not executable"
        return 1
    fi

    SEED_HEX="$(identity_seed_hex)"
    PUB_HEX="$(identity_pub_hex)"
    if [ "\${#SEED_HEX}" != 64 ] || [ "\${#PUB_HEX}" != 64 ]; then
        echo "flagship: relay aborted — could not derive 32-byte seed/pub from $IDENTITY_KEY"
        return 1
    fi

    NONCE=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\\n')
    NOW_MS=$(date +%s%3N)
    CANONICAL="flagship/secret-request/v1|\${SERVER_DOMAIN}|\${PUB_HEX}|unlock-key|\${NONCE}|\${NOW_MS}"
    SIG="$(sign_canonical "$CANONICAL")"

    REQ_URL="\${CONTROL_PLANE}/api/server/\${SERVER_DOMAIN}/secret-request"
    REQ_BODY=$(printf '{"request":{"serverDomain":"%s","stkPub":"%s","purpose":"unlock-key","nonce":"%s","issuedAt":%s},"signature":"%s"}' \\
        "$SERVER_DOMAIN" "$PUB_HEX" "$NONCE" "$NOW_MS" "$SIG")

    POST_RESP=/run/flagship-secret-request-resp.json
    POST_CODE=$(curl -sS -o "$POST_RESP" -w "%{http_code}" \\
        -X POST -H 'content-type: application/json' \\
        --max-time 30 -d "$REQ_BODY" "$REQ_URL" || echo "000")
    if [ "$POST_CODE" != "200" ]; then
        echo "flagship: relay secret-request HTTP $POST_CODE; body: $(head -c 200 "$POST_RESP" 2>/dev/null)"
        return 1
    fi
    echo "flagship: posted unlock-key secret-request; waiting up to \${RELAY_WINDOW_SECS}s for the phone"

    POLL_URL="\${CONTROL_PLANE}/api/server/\${SERVER_DOMAIN}/secret-response?nonce=\${NONCE}"
    DEADLINE=$(( $(date +%s) + RELAY_WINDOW_SECS ))
    ATTEMPT=0
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        ATTEMPT=$((ATTEMPT + 1))
        RESP=/run/flagship-secret-response.json
        CODE=$(curl -sS -o "$RESP" -w "%{http_code}" \\
            --max-time 30 "$POLL_URL" || echo "000")

        if [ "$CODE" = "200" ]; then
            SEALED=$(sed -n 's/.*"sealed":"\\([0-9a-fA-F]*\\)".*/\\1/p' "$RESP")
            if [ -z "$SEALED" ]; then
                echo "flagship: relay 200 but no sealed payload: $(head -c 200 "$RESP")"
                return 1
            fi
            HELPER_JSON=/run/flagship-unseal-input.json
            printf '{"serverDomain":"%s","requestNonceHex":"%s","purpose":"unlock-key","sealedHex":"%s","issuedAt":0}' \\
                "$SERVER_DOMAIN" "$NONCE" "$SEALED" > "$HELPER_JSON"

            if "$UNSEAL_HELPER" --identity-priv-hex "$SEED_HEX" --response-json "$HELPER_JSON" \\
                > "$OUT_UNLOCK.hex" 2>/run/flagship-unseal.err; then
                tr -d '\\n' < "$OUT_UNLOCK.hex" > "$OUT_UNLOCK"
                chmod 600 "$OUT_UNLOCK"
                rm -f "$OUT_UNLOCK.hex" "$HELPER_JSON"
                echo "flagship: relay unsealed the unlock key (attempt $ATTEMPT)"
                return 0
            fi
            echo "flagship: $UNSEAL_HELPER failed: $(head -c 200 /run/flagship-unseal.err 2>/dev/null)"
            rm -f "$OUT_UNLOCK.hex" "$HELPER_JSON"
            return 1
        elif [ "$CODE" = "404" ]; then
            : # no reply yet — expected; keep polling
        else
            echo "flagship: relay secret-response HTTP $CODE; body: $(head -c 200 "$RESP" 2>/dev/null)"
            return 1
        fi

        BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 3 : 15))
        echo "flagship: no phone reply yet (attempt $ATTEMPT); sleeping $BACKOFF"
        sleep "$BACKOFF"
    done

    echo "flagship: relay window (\${RELAY_WINDOW_SECS}s) elapsed with no phone reply"
    return 1
}

# ── Two-tier dispatch (docs/security-phone-as-unlock-endpoint.md §7a.1) ────
# The legacy plaintext-consume path is RETIRED — never a fallback here.
#   auto:    box-sealed lease (self-unlock); fall back to the phone relay.
#   approve: phone relay EVERY boot; the box NEVER reads a box-sealed lease.
echo "flagship: boot-unlock mode = $BOOT_UNLOCK_MODE"
if [ "$BOOT_UNLOCK_MODE" = "approve" ]; then
    unlock_via_relay
else
    if ! unlock_via_box_lease; then
        unlock_via_relay
    fi
fi

ROOT_PART=/dev/disk/by-label/FLAGSHIP_ROOT
xxd -r -p "$OUT_UNLOCK" | cryptsetup luksOpen --key-file - "$ROOT_PART" flagship_root
shred -u "$OUT_UNLOCK" 2>/dev/null || rm -f "$OUT_UNLOCK"
PREMOUNT
chmod +x /etc/initramfs-tools/scripts/local-top/flagship-unlock

# Rebuild the initramfs so the hook + premount script land in /boot's initrd.
update-initramfs -u 2>&1 | tee /var/log/flagship-initramfs.log || \\
    echo "[flagship-bootstrap] WARNING: update-initramfs failed; unlock hook not embedded"
echo "[flagship-bootstrap] LUKS unlock hook installed; initramfs rebuilt"

`;
}

function installBlobToJson(
  b: InstallBlob,
  blobSignatureHex: string,
): Record<string, unknown> {
  return {
    version: b.version,
    serverDomain: b.serverDomain,
    username: b.username,
    serverName: b.serverName,
    phoneDelegatedPubKey: bytesToHex(b.phoneDelegatedPubKey),
    registrationUrl: b.registrationUrl,
    authCode: {
      version: b.authCode.version,
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
    blobSignatureHex,
  };
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function utf8ToBase64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}
