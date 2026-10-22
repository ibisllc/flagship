import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  APPLIANCE_BUILD_KEYFILE,
  BOX_NPM_SCOPE,
  BOX_TSC_BUILD,
  LUKS_ASSERT_SINGLE_SLOT_FN,
  SETUP_POST_FN,
} from "./userdata.js";

/**
 * The factory key of a generalized VM appliance. It is published on purpose: the
 * image holds no owner data, and first-boot specialization replaces it with the
 * phone-sealed key, removes this slot and verifies exactly one slot remains. It
 * is not the installer path's passphrase (that one is generated per install).
 */
export const APPLIANCE_FACTORY_KEY = "flagship-appliance-factory-key-public-replaced-on-first-boot";

export const APPLIANCE_SEED_MAGIC = "FLSHSD01";
export const APPLIANCE_SEED_HEADER_BYTES = 80;
export const APPLIANCE_SEED_SIZE_BYTES = 8 * 1024 * 1024;

export interface ApplianceSeedPayload {
  version: 1;
  recipeBase64: string;
  bootstrapBase64: string;
  recipeSha256: string;
}

/** qcow2 when the base starts with the qcow2 magic (the published archive,
 * used as is), raw otherwise (a locally built factory disk). */
export async function applianceBaseFormat(path: string): Promise<"qcow2" | "raw"> {
  const handle = await open(path, "r");
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    return bytesRead === 4 && magic.equals(Buffer.from([0x51, 0x46, 0x49, 0xfb])) ? "qcow2" : "raw";
  } finally {
    await handle.close();
  }
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
# Progress goes to the owner's install timeline (the same public order-status
# stream the installer path uses) once the recipe names it. Details are fixed
# phrases or the bootstrap's one bounded FATAL line, never logs or secrets.
STATUS_URL=""
STEP="starting"
${SETUP_POST_FN}
report() {
    [ -n "$STATUS_URL" ] || return 0
    flagship_post "$STATUS_URL" "$(jq -cn --arg p "$1" --arg d "$2" '{phase:$p,detail:$d}')" 8 >/dev/null 2>&1 || true
}
stage() { STEP="$1"; echo "[appliance] $1"; report installing "$1"; }
trap 'rc=$?; echo "[appliance] specialization failed line=$LINENO rc=$rc"; report error "Setup stopped while $STEP"; exit "$rc"' ERR
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
SERIAL="$(jq -r '.authCode.serial // empty' /var/flagship/install-blob.json)"
REGISTRATION_URL="$(jq -r '.registrationUrl // empty' /var/flagship/install-blob.json)"
if [[ "$SERIAL" =~ ^[A-Za-z0-9]{1,64}$ ]] && [[ "$REGISTRATION_URL" =~ ^https://[A-Za-z0-9.-]+/api/server/register$ ]]; then
    STATUS_URL="\${REGISTRATION_URL%/api/server/register}/api/order/$SERIAL/status"
fi
stage "Checking the server recipe"
[ "$(jq -r '.serverDomain // empty' /var/flagship/install-blob.json)" != "" ] || { echo "[appliance] recipe has no server domain"; exit 1; }

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
    stage "Expanding the disk to $((DISK_BYTES / 1000000000)) GB"
    GROWPART_RC=0
    growpart "/dev/$ROOT_PARENT" "$ROOT_PARTITION" || GROWPART_RC=$?
    # 1 = NOCHANGE: a retry after an earlier run already grew the partition.
    # (exit "$rc") in a subshell is a failing command, so the ERR trap reports it; a bare exit would not.
    if [ "$GROWPART_RC" -gt 1 ]; then (exit "$GROWPART_RC"); fi
    udevadm settle
    # Without the key file cryptsetup asks for a passphrase on stdin, which a
    # systemd service does not have ("Nothing to read on input").
    cryptsetup resize --key-file ${APPLIANCE_BUILD_KEYFILE} "$ROOT_MAPPER"
    resize2fs "$ROOT_SOURCE"
    echo "[appliance] cloned disk expansion complete"
fi

stage "Setting up this server's identity and disk key"
# "|| rc=$?" keeps the ERR trap from firing, so the failure below is reported
# with the bootstrap's own line instead of just "line 78".
BOOTSTRAP_RC=0
FLAGSHIP_APPLIANCE_PREINSTALLED=1 /usr/local/sbin/flagship-bootstrap.sh || BOOTSTRAP_RC=$?
if [ "$BOOTSTRAP_RC" -ne 0 ]; then
    tail -n 25 /var/log/flagship-bootstrap.log 2>/dev/null | sed "s/^/[appliance] bootstrap log: /" || true
    SAFE_BOOTSTRAP_ERROR="$(grep -E '^\\[flagship-bootstrap\\] (FATAL|ERROR|WARN(ING)?):' /var/log/flagship-bootstrap.log 2>/dev/null | tail -n1 | tr -cd '[:print:]' | cut -c1-240 || true)"
    echo "[appliance] canonical bootstrap failed rc=$BOOTSTRAP_RC"
    [ -z "$SAFE_BOOTSTRAP_ERROR" ] || echo "$SAFE_BOOTSTRAP_ERROR"
    trap - ERR
    report error "Setup failed: \${SAFE_BOOTSTRAP_ERROR:-bootstrap exited $BOOTSTRAP_RC}"
    exit "$BOOTSTRAP_RC"
fi

stage "Removing the factory disk key"
ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
[ -b "$ROOT_LUKS_PART" ] || { echo "[appliance] encrypted root disappeared after specialization"; exit 1; }
LUKS_NEW_KEY=/run/flagship-luks.key
[ -s "$LUKS_NEW_KEY" ] || { echo "[appliance] the new disk key is missing; refusing to remove the factory key"; exit 1; }
${LUKS_ASSERT_SINGLE_SLOT_FN}
cryptsetup open --test-passphrase --key-file "$LUKS_NEW_KEY" "$ROOT_LUKS_PART" >/dev/null 2>&1 || { echo "[appliance] the new disk key does not open the disk; refusing to remove the factory key"; exit 1; }
cryptsetup luksRemoveKey "$ROOT_LUKS_PART" ${APPLIANCE_BUILD_KEYFILE}
flagship_assert_single_luks_slot "$ROOT_LUKS_PART" ${APPLIANCE_BUILD_KEYFILE} "$LUKS_NEW_KEY"
shred -u "$LUKS_NEW_KEY" 2>/dev/null || rm -f "$LUKS_NEW_KEY"
rm -f ${APPLIANCE_BUILD_KEYFILE}
sed -i -E 's|^(flagship_root[[:space:]]+[^[:space:]]+)[[:space:]]+[^[:space:]]+|\\1 none|' /etc/crypttab
rm -f /etc/cryptsetup-initramfs/conf-hook
update-initramfs -u
date > /var/flagship/appliance-specialized.flag
sync
echo "[appliance] specialization complete; powering off for sealed boot"
report installed "Restarting into the sealed disk"
systemctl poweroff
`;
}

export interface AppliancePrepareOptions {
  repoUrl?: string;
  /** The ref recipes name (`installerGitRef`); the image carries it as its label. */
  gitRef: string;
  /** The exact commit to install under that label (an endorsed release); absent = the ref's tip. */
  gitCommit?: string;
}

/** Runs once in the image factory's installed target. No owner material enters
 * this phase. Its output deliberately remains unlockable by the published
 * build key because it contains no user data; first specialization replaces
 * that key and removes it from the initramfs before the server can run. */
export function buildAppliancePrepareScript(opts: AppliancePrepareOptions): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(opts.gitRef) || opts.gitRef.includes("..")) {
    throw new Error("invalid appliance git ref");
  }
  if (opts.gitCommit !== undefined && !/^[0-9a-f]{40}$/.test(opts.gitCommit)) {
    throw new Error("invalid appliance git commit");
  }
  const repo = opts.repoUrl ?? "https://github.com/ibisllc/flagship.git";
  const clone = opts.gitCommit
    ? `timeout -k 10 300 git clone --depth 2 --no-checkout '${repo}' /opt/flagship && timeout -k 10 300 git -C /opt/flagship fetch --depth 2 origin '${opts.gitCommit}' && git -C /opt/flagship checkout --detach '${opts.gitCommit}'`
    : `timeout -k 10 300 git clone --depth 2 --branch '${opts.gitRef}' '${repo}' /opt/flagship || { timeout -k 10 300 git clone --depth 2 '${repo}' /opt/flagship; timeout -k 10 300 git -C /opt/flagship fetch --depth 2 origin '${opts.gitRef}'; git -C /opt/flagship checkout '${opts.gitRef}'; }`;
  if (!/^https:\/\/[A-Za-z0-9._\/-]+(?:\.git)?$/.test(repo) || repo.includes("..")) {
    throw new Error("invalid appliance repository URL");
  }
  const specializerB64 = Buffer.from(buildApplianceSpecializerScript(), "utf8").toString("base64");
  return `#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/flagship-appliance-prepare.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
echo "[appliance-factory] preparing generalized ref=${opts.gitRef}"
mkdir -p /etc/dpkg/dpkg.cfg.d
cat > /etc/dpkg/dpkg.cfg.d/flagship-appliance-lean <<'DPKGCFG'
path-exclude=/usr/share/doc/*
path-exclude=/usr/share/man/*
path-exclude=/usr/share/info/*
path-exclude=/usr/share/groff/*
path-exclude=/usr/share/lintian/*
path-exclude=/usr/share/locale/*
path-include=/usr/share/locale/en_US*
path-include=/usr/share/locale/locale.alias
DPKGCFG
timeout -k 10 90 curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
echo "[appliance-factory] installing Flagship runtime packages"
timeout -k 15 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends nodejs jq git curl ca-certificates cryptsetup cryptsetup-initramfs lvm2 xxd openssl gnupg cloud-guest-utils golang-go docker.io docker-cli docker-compose
if ! command -v npm >/dev/null 2>&1; then
    timeout -k 15 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends npm
fi
command -v npm >/dev/null 2>&1 || { echo "[appliance-factory] npm unavailable"; exit 1; }
echo "[appliance-factory] runtime packages ready"
rm -rf /opt/flagship
echo "[appliance-factory] cloning Flagship ref=${opts.gitRef}${opts.gitCommit ? ` at ${opts.gitCommit}` : ""}"
${clone}
cd /opt/flagship
echo "[appliance-factory] installing pinned workspace dependencies"
timeout -k 15 600 npm install --no-audit --no-fund ${BOX_NPM_SCOPE}
echo "[appliance-factory] compiling workspace"
timeout -k 15 300 ${BOX_TSC_BUILD}
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
echo "[appliance-factory] stripping docs, manuals, and surplus locales"
rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/info/* /usr/share/groff/* /usr/share/lintian/*
find /usr/share/locale -mindepth 1 -maxdepth 1 -type d ! -name 'C' ! -name 'C.UTF-8' ! -name 'en' ! -name 'en_US' -exec rm -rf {} + 2>/dev/null || true

mkdir -p /etc/flagship /var/flagship
printf '%s' '${APPLIANCE_FACTORY_KEY}' > /etc/flagship/appliance-build.key
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
