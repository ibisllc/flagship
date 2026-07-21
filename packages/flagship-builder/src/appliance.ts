import { createHash } from "node:crypto";
import { BURN_PASSPHRASE } from "./userdata.js";

export const APPLIANCE_SEED_MAGIC = "FLSHSD01";
export const APPLIANCE_SEED_HEADER_BYTES = 80;
export const APPLIANCE_SEED_SIZE_BYTES = 8 * 1024 * 1024;

export interface ApplianceSeedPayload {
  version: 1;
  recipeBase64: string;
  bootstrapBase64: string;
  recipeSha256: string;
}

export function encodeApplianceSeed(recipe: Uint8Array, bootstrap: string): Uint8Array {
  const recipeBytes = Buffer.from(recipe);
  const payload: ApplianceSeedPayload = {
    version: 1,
    recipeBase64: recipeBytes.toString("base64"),
    bootstrapBase64: Buffer.from(bootstrap, "utf8").toString("base64"),
    recipeSha256: createHash("sha256").update(recipeBytes).digest("hex"),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > APPLIANCE_SEED_SIZE_BYTES - APPLIANCE_SEED_HEADER_BYTES) {
    throw new Error("appliance seed payload is too large");
  }
  const lengthHex = body.length.toString(16).padStart(8, "0");
  const bodySha = createHash("sha256").update(body).digest("hex");
  const header = Buffer.from(`${APPLIANCE_SEED_MAGIC}${lengthHex}${bodySha}`, "ascii");
  const out = Buffer.alloc(APPLIANCE_SEED_SIZE_BYTES);
  header.copy(out, 0);
  body.copy(out, APPLIANCE_SEED_HEADER_BYTES);
  return out;
}

/** Installed in every generalized base. It accepts only the fixed raw seed
 * format, verifies the payload hash before decoding anything, then invokes the
 * canonical bootstrap in its preinstalled mode. The public build key remains
 * available after failure so the same seed can retry; it is removed from disk,
 * crypttab, and the rebuilt initramfs only after registration + LUKS re-key
 * complete. */
export function buildApplianceSpecializerScript(): string {
  return `#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/flagship-appliance-specialize.log /dev/console) 2>&1
trap 'rc=$?; echo "[appliance] specialization failed line=$LINENO rc=$rc"; exit "$rc"' ERR
echo "[appliance] specialization start"
[ -f /etc/flagship/appliance-ready ] || { echo "[appliance] generalized base readiness marker missing"; exit 1; }
echo "[appliance] generalized base verified"

SEED_DEV=""
for _dev in /dev/vd? /dev/sd? /dev/nvme*n1; do
    [ -b "$_dev" ] || continue
    [ "$(dd if="$_dev" bs=1 count=8 status=none 2>/dev/null | xxd -p || true)" = "$(printf '%s' '${APPLIANCE_SEED_MAGIC}' | xxd -p)" ] || continue
    SEED_DEV="$_dev"
    break
done
[ -n "$SEED_DEV" ] || { echo "[appliance] no verified seed device found"; exit 1; }

LEN_HEX="$(dd if="$SEED_DEV" bs=1 skip=8 count=8 status=none)"
BODY_SHA="$(dd if="$SEED_DEV" bs=1 skip=16 count=64 status=none)"
[[ "$LEN_HEX" =~ ^[0-9a-f]{8}$ ]] || { echo "[appliance] malformed seed length"; exit 1; }
[[ "$BODY_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "[appliance] malformed seed digest"; exit 1; }
BODY_LEN=$((16#$LEN_HEX))
[ "$BODY_LEN" -gt 0 ] && [ "$BODY_LEN" -le $(( ${APPLIANCE_SEED_SIZE_BYTES} - ${APPLIANCE_SEED_HEADER_BYTES} )) ] || { echo "[appliance] seed length out of range"; exit 1; }

mkdir -p /run/flagship-appliance /var/flagship
dd if="$SEED_DEV" of=/run/flagship-appliance/seed.json bs=1 skip=${APPLIANCE_SEED_HEADER_BYTES} count="$BODY_LEN" status=none
echo "$BODY_SHA  /run/flagship-appliance/seed.json" | sha256sum -c -
jq -e '.version == 1 and (.recipeBase64 | type == "string") and (.bootstrapBase64 | type == "string") and (.recipeSha256 | test("^[0-9a-f]{64}$"))' \
    /run/flagship-appliance/seed.json >/dev/null
jq -r .recipeBase64 /run/flagship-appliance/seed.json | base64 -d > /var/flagship/install-blob.json
jq -r .bootstrapBase64 /run/flagship-appliance/seed.json | base64 -d > /usr/local/sbin/flagship-bootstrap.sh
chmod 600 /var/flagship/install-blob.json
chmod 700 /usr/local/sbin/flagship-bootstrap.sh
RECIPE_SHA="$(sha256sum /var/flagship/install-blob.json | cut -d' ' -f1)"
[ "$RECIPE_SHA" = "$(jq -r .recipeSha256 /run/flagship-appliance/seed.json)" ] || { echo "[appliance] recipe digest mismatch"; exit 1; }

ROOT_SOURCE="$(findmnt -n -o SOURCE /)"
ROOT_MAPPER="$(basename "$ROOT_SOURCE")"
ROOT_LUKS_PART="$(cryptsetup status "$ROOT_MAPPER" | sed -n 's/^[[:space:]]*device:[[:space:]]*//p')"
[ -b "$ROOT_LUKS_PART" ] || { echo "[appliance] encrypted root device unavailable"; exit 1; }
ROOT_PARENT="$(lsblk -no PKNAME "$ROOT_LUKS_PART" | head -n1)"
ROOT_PARTITION="$(cat "/sys/class/block/$(basename "$ROOT_LUKS_PART")/partition")"
[ -n "$ROOT_PARENT" ] && [ -n "$ROOT_PARTITION" ] || { echo "[appliance] root partition topology unavailable"; exit 1; }
DISK_BYTES="$(blockdev --getsize64 "/dev/$ROOT_PARENT")"
PART_BYTES="$(blockdev --getsize64 "$ROOT_LUKS_PART")"
if [ $((DISK_BYTES - PART_BYTES)) -gt 1073741824 ]; then
    echo "[appliance] expanding cloned disk to $DISK_BYTES bytes"
    growpart "/dev/$ROOT_PARENT" "$ROOT_PARTITION"
    udevadm settle
    cryptsetup resize "$ROOT_MAPPER"
    resize2fs "$ROOT_SOURCE"
    echo "[appliance] cloned disk expansion complete"
fi

set +e
FLAGSHIP_APPLIANCE_PREINSTALLED=1 /usr/local/sbin/flagship-bootstrap.sh
BOOTSTRAP_RC=$?
set -e
if [ "$BOOTSTRAP_RC" -ne 0 ]; then
    SAFE_BOOTSTRAP_ERROR="$(grep -E '^\\[flagship-bootstrap\\] (FATAL|ERROR|WARN(ING)?):' /var/log/flagship-bootstrap.log 2>/dev/null | tail -n1 | tr -cd '[:print:]' | cut -c1-240 || true)"
    echo "[appliance] canonical bootstrap failed rc=$BOOTSTRAP_RC"
    [ -z "$SAFE_BOOTSTRAP_ERROR" ] || echo "$SAFE_BOOTSTRAP_ERROR"
    exit "$BOOTSTRAP_RC"
fi

ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
[ -b "$ROOT_LUKS_PART" ] || { echo "[appliance] encrypted root disappeared after specialization"; exit 1; }
cryptsetup luksRemoveKey "$ROOT_LUKS_PART" /etc/flagship/appliance-build.key
rm -f /etc/flagship/appliance-build.key
sed -i -E 's|^(flagship_root[[:space:]]+[^[:space:]]+)[[:space:]]+[^[:space:]]+|\\1 none|' /etc/crypttab
rm -f /etc/cryptsetup-initramfs/conf-hook
update-initramfs -u
date > /var/flagship/appliance-specialized.flag
sync
echo "[appliance] specialization complete; powering off for sealed boot"
systemctl poweroff
`;
}

export interface AppliancePrepareOptions {
  repoUrl?: string;
  gitRef: string;
}

/** Runs once in the image factory's installed target. No owner material enters
 * this phase. Its output deliberately remains unlockable by the published
 * build key because it contains no user data; first specialization replaces
 * that key and removes it from the initramfs before the server can run. */
export function buildAppliancePrepareScript(opts: AppliancePrepareOptions): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(opts.gitRef) || opts.gitRef.includes("..")) {
    throw new Error("invalid appliance git ref");
  }
  const repo = opts.repoUrl ?? "https://github.com/ibisllc/flagship.git";
  if (!/^https:\/\/[A-Za-z0-9._\/-]+(?:\.git)?$/.test(repo) || repo.includes("..")) {
    throw new Error("invalid appliance repository URL");
  }
  const specializerB64 = Buffer.from(buildApplianceSpecializerScript(), "utf8").toString("base64");
  return `#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/flagship-appliance-prepare.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
echo "[appliance-factory] preparing generalized ref=${opts.gitRef}"
timeout -k 10 90 curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
echo "[appliance-factory] installing Flagship runtime packages"
timeout -k 15 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends nodejs jq git curl ca-certificates cryptsetup cryptsetup-initramfs lvm2 xxd openssl gnupg cloud-guest-utils golang-go docker.io docker-cli docker-compose
if ! command -v npm >/dev/null 2>&1; then
    timeout -k 15 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends npm
fi
command -v npm >/dev/null 2>&1 || { echo "[appliance-factory] npm unavailable"; exit 1; }
echo "[appliance-factory] runtime packages ready"
rm -rf /opt/flagship
echo "[appliance-factory] cloning Flagship ref=${opts.gitRef}"
timeout -k 10 300 git clone --depth 2 --branch '${opts.gitRef}' '${repo}' /opt/flagship || { timeout -k 10 300 git clone --depth 2 '${repo}' /opt/flagship; timeout -k 10 300 git -C /opt/flagship fetch --depth 2 origin '${opts.gitRef}'; git -C /opt/flagship checkout '${opts.gitRef}'; }
cd /opt/flagship
echo "[appliance-factory] installing pinned workspace dependencies"
timeout -k 15 600 npm install --no-audit --no-fund --workspaces --include-workspace-root
echo "[appliance-factory] compiling workspace"
timeout -k 15 300 npx tsc -b
[ -e /opt/flagship/node_modules/@flagship/protocol/package.json ] || { echo "[appliance-factory] workspace link missing"; exit 1; }
printf '%s\\n' '${opts.gitRef}' > /opt/flagship/.flagship-appliance-ref
echo "[appliance-factory] compiled workspace ready"
mkdir -p /usr/local/lib/flagship-appliance
echo "[appliance-factory] compiling initramfs unseal helper"
( cd /opt/flagship/installer/unseal-helper && timeout -k 15 300 env HOME=/root GOPATH=/root/go GOMODCACHE=/root/go/pkg/mod CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false -ldflags '-s -w' -o /usr/local/lib/flagship-appliance/flagship-unseal . )
chmod 755 /usr/local/lib/flagship-appliance/flagship-unseal
echo "[appliance-factory] initramfs unseal helper ready"
[ -x /usr/local/lib/flagship-appliance/flagship-unseal ] || { echo "[appliance-factory] unseal helper missing before Go purge"; exit 1; }
echo "[appliance-factory] purging Go toolchain (static unseal helper already built)"
apt-get purge -y golang-go golang-* 2>/dev/null || true
apt-get autoremove -y --purge
rm -rf /root/go /root/.cache/go-build /root/.npm /root/.cache /usr/lib/go-* /usr/local/go
apt-get clean
rm -rf /var/lib/apt/lists/*
echo "[appliance-factory] build caches removed"

mkdir -p /etc/flagship /var/flagship
printf '%s' '${BURN_PASSPHRASE}' > /etc/flagship/appliance-build.key
chmod 600 /etc/flagship/appliance-build.key
ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
[ -n "$ROOT_LUKS_PART" ] || { echo "[appliance-factory] no LUKS root found"; exit 1; }
ROOT_LUKS_UUID="$(blkid -s UUID -o value "$ROOT_LUKS_PART")"
printf 'flagship_root UUID=%s /etc/flagship/appliance-build.key luks,initramfs\\n' "$ROOT_LUKS_UUID" > /etc/crypttab
printf 'KEYFILE_PATTERN=/etc/flagship/appliance-build.key\\n' > /etc/cryptsetup-initramfs/conf-hook

echo '${specializerB64}' | base64 -d > /usr/local/sbin/flagship-appliance-specialize.sh
chmod 700 /usr/local/sbin/flagship-appliance-specialize.sh
cat > /etc/systemd/system/flagship-appliance-specialize.service <<'UNIT'
[Unit]
Description=Specialize a generalized Flagship VM appliance
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/var/flagship/appliance-specialized.flag

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/flagship-appliance-specialize.sh
TimeoutStartSec=infinity

[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /etc/systemd/system/multi-user.target.wants
ln -sf /etc/systemd/system/flagship-appliance-specialize.service /etc/systemd/system/multi-user.target.wants/flagship-appliance-specialize.service

rm -f /etc/machine-id
: > /etc/machine-id
rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_* /var/lib/systemd/random-seed
rm -rf /var/flagship/install-blob.json /var/flagship/identity
rm -rf /var/flagship/* /boot/identity.pem /boot/install-blob.json /etc/flagship/daemon.env /etc/flagship-bootstrap.env
find /var/log -type f -exec truncate -s 0 {} +
rm -rf /tmp/* /var/tmp/*
update-initramfs -u
touch /etc/flagship/appliance-ready
sync
echo "[appliance-factory] generalized image ready"
`;
}

export const APPLIANCE_FORBIDDEN_PATHS = [
  "/var/flagship/install-blob.json",
  "/var/flagship/identity",
  "/boot/identity.pem",
  "/boot/install-blob.json",
  "/etc/flagship/daemon.env",
  "/etc/flagship-bootstrap.env",
] as const;
