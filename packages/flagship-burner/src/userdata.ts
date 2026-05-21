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
 *   - No subiquity-managed LUKS yet — Phase 2 will add proper
 *     LUKS-encrypt-root in the subiquity storage section. Phase 1
 *     installs the daemon on top of an unencrypted root for the
 *     happy-path proof.
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
}

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
  const bootstrap = buildBootstrapScript({ ref, repoUrl: repo });
  const bootstrapB64 = utf8ToBase64(bootstrap);
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
  late-commands:
    - curtin in-target --target=/target -- bash -c 'mkdir -p /var/flagship && echo "${blobB64}" | base64 -d > /var/flagship/install-blob.json && chmod 600 /var/flagship/install-blob.json'
    - curtin in-target --target=/target -- bash -c 'echo "${bootstrapB64}" | base64 -d > /usr/local/sbin/flagship-bootstrap.sh && chmod +x /usr/local/sbin/flagship-bootstrap.sh'
    - curtin in-target --target=/target -- /usr/local/sbin/flagship-bootstrap.sh
`;
}

interface BootstrapTemplateArgs {
  ref: string;
  repoUrl: string;
}

function buildBootstrapScript(args: BootstrapTemplateArgs): string {
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
git clone --depth 50 --branch "$GIT_REF" "$REPO_URL" /opt/flagship || \
    (git clone --depth 50 "$REPO_URL" /opt/flagship && \
     git -C /opt/flagship fetch --depth 50 origin "$GIT_REF" && \
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

# Register with .com.
NOW=$(date +%s%3N)
npx tsx scripts/install-helper.ts sign-server-register \\
    --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \\
    --auth-code-blob /var/flagship/install-blob.json \\
    > /run/register-payload.json
curl -fsS -X POST -H "content-type: application/json" \\
    --data @/run/register-payload.json \\
    "$REGISTRATION_URL"
date > /var/flagship/registered.flag
echo "[flagship-bootstrap] done"
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
      serial: b.authCode.serial,
      username: b.authCode.username,
      userPubKey: bytesToHex(b.authCode.userPubKey),
      issuedAt: b.authCode.issuedAt,
      expiresAt: b.authCode.expiresAt,
    },
    authCodeUserSignature: bytesToHex(b.authCodeUserSignature),
    issuedAt: b.issuedAt,
    expiresAt: b.expiresAt,
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
