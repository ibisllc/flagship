// The retail layer on top of a generalized appliance (docs/retail-box-setup.md §2, §11.1): what turns
// the published appliance into the image every unit of a retail SKU is written with. It runs once in
// the factory's chroot, after buildAppliancePrepareScript, and adds only hardware-independent pieces:
// BlueZ and the claim service's host files (boot-chain retailHost.ts), the retail marker, keyd's unit
// so a box makes its own identity on its first boot (keyd reset.ts ensureRetailFirstIdentity), the
// daemon's unit (the claim service runs before any owner exists), the specializer as the first boot
// after a claim, and a check that no box key, owner file or Bluetooth identity is on the image.
//
// Waits for the chosen hardware (docs/retail-box-setup.md §16): the partition layout with a recovery
// partition (the marker's devices stay null until then, so a reset stops at the lock instead of
// guessing a device), the SKU's firmware packages and power button, and the Wi-Fi stack.

import { RETAIL_HOST_FILES, retailHostSetupScript } from "@flagship/boot-chain";
import { APPLIANCE_FORBIDDEN_PATHS, RETAIL_CLAIMED_RECIPE } from "./appliance.js";
import { DAEMON_UNIT_PATH, daemonServiceUnit } from "./daemonUnit.js";

export const RETAIL_IMAGE_MARKER_PATH = "/etc/flagship/retail-image.json";

export const SPECIALIZER_RETAIL_DROP_IN_PATH = "/etc/systemd/system/flagship-appliance-specialize.service.d/50-retail.conf";
/** Conditions add up: the unit's own "not specialized yet" and "a claim left a recipe". */
export const SPECIALIZER_RETAIL_DROP_IN = `[Unit]
ConditionPathExists=${RETAIL_CLAIMED_RECIPE}
Before=flagship-daemon.service
`;

/** Paths a retail image must not carry: the appliance's, plus every box key and Bluetooth identity. */
export const RETAIL_FORBIDDEN_PATHS = [
  ...APPLIANCE_FORBIDDEN_PATHS,
  "/var/lib/flagship-keyd/identity.key",
  "/var/lib/flagship-keyd/identity-mldsa.key",
  "/var/lib/flagship-keyd/swk.key",
  "/var/lib/flagship-keyd/cgk.key",
  "/var/lib/flagship-keyd/owner.json",
  "/var/lib/flagship-retail",
] as const;

const DEVICE = /^\/dev\/(?:disk\/by-(?:partlabel|partuuid|uuid|id)\/[A-Za-z0-9._:-]{1,128}|[a-z][a-z0-9]{1,31})$/;

export interface RetailImageOptions {
  /** The LUKS volume a reset crypto-erases; null until a SKU's layout keeps the OS apart from it. */
  dataLuksDevice?: string | null;
  /** The factory image's partition; null until a SKU's layout has one. */
  recoveryPartition?: string | null;
}

export function retailImageMarker(opts: RetailImageOptions = {}): string {
  const dev = (v: string | null | undefined, what: string) => {
    if (v == null) return null;
    if (!DEVICE.test(v)) throw new Error(`invalid ${what}`);
    return v;
  };
  return `${JSON.stringify({ v: 1, dataLuksDevice: dev(opts.dataLuksDevice, "data LUKS device"), recoveryPartition: dev(opts.recoveryPartition, "recovery partition") })}\n`;
}

function writeFile(path: string, content: string, mode: number, tag: string): string {
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(path)) throw new Error(`unsafe path ${path}`);
  if (content.split("\n").includes(tag)) throw new Error(`${path} contains its heredoc tag`);
  return `install -d -m 0755 "$(dirname ${path})"\ncat > ${path} <<'${tag}'\n${content}${tag}\nchmod ${mode.toString(8)} ${path}\n`;
}

export function buildRetailImageLayerScript(opts: RetailImageOptions = {}): string {
  const marker = retailImageMarker(opts);
  const files = RETAIL_HOST_FILES.map((f) => writeFile(f.path, f.content, f.mode, "FLAGSHIP_RETAIL_HOST_EOF")).join("");
  return `#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/flagship-retail-image.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
echo "[retail-image] adding the retail layer"
[ -f /etc/flagship/appliance-ready ] || { echo "[retail-image] run the appliance prepare step first"; exit 1; }

timeout -k 15 300 apt-get -o Acquire::Retries=3 update
timeout -k 15 600 apt-get -o Acquire::Retries=3 install -y --no-install-recommends bluez
apt-get clean
rm -rf /var/lib/apt/lists/*
echo "[retail-image] BlueZ installed"

${retailHostSetupScript()}${files}systemctl enable bluetooth.service
echo "[retail-image] claim service host files written"

# keyd from the installed release, so a box's first boot makes its own identity (keyd migrate).
/usr/local/bin/node --input-type=module -e '
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { keydServiceUnit, keydSetupScript, daemonKeydDropIn, KEYD_UNIT_PATH, KEYD_DAEMON_DROPIN_PATH } from "/opt/flagship/packages/keyd/dist/index.js";
for (const line of keydSetupScript().trim().split("\\n")) execFileSync("sh", ["-c", line], { stdio: "inherit" });
writeFileSync(KEYD_UNIT_PATH, keydServiceUnit(), { mode: 0o644 });
mkdirSync("/etc/systemd/system/flagship-daemon.service.d", { recursive: true });
writeFileSync(KEYD_DAEMON_DROPIN_PATH, daemonKeydDropIn(), { mode: 0o644 });
'
systemctl enable flagship-keyd.service
echo "[retail-image] keyd unit installed"

# The daemon from the first boot, with no daemon.env yet: it runs the claim service alone until a
# claim's first boot gives it an owner.
cat > ${DAEMON_UNIT_PATH} <<'FLAGSHIP_RETAIL_DAEMON_EOF'
${daemonServiceUnit({ envFileOptional: true })}FLAGSHIP_RETAIL_DAEMON_EOF
chmod 644 ${DAEMON_UNIT_PATH}
systemctl enable flagship-daemon.service
echo "[retail-image] daemon unit installed"

# The appliance specializer is the retail first boot: it runs only once a claim left a recipe, makes
# the seed from it on the box, keeps keyd's key, and restarts sealed (appliance.ts, RETAIL=1).
${writeFile(SPECIALIZER_RETAIL_DROP_IN_PATH, SPECIALIZER_RETAIL_DROP_IN, 0o644, "FLAGSHIP_RETAIL_HOST_EOF")}
install -d -m 0755 /etc/flagship
cat > ${RETAIL_IMAGE_MARKER_PATH} <<'FLAGSHIP_RETAIL_MARKER_EOF'
${marker}FLAGSHIP_RETAIL_MARKER_EOF
chmod 644 ${RETAIL_IMAGE_MARKER_PATH}

# Nothing that names one box: no keyd state, no claim state, no Bluetooth pairing or adapter identity.
find /var/lib/flagship-keyd -mindepth 1 -delete 2>/dev/null || true
rm -rf /var/flagship/identity /var/lib/flagship-retail /var/lib/bluetooth/*
for p in ${RETAIL_FORBIDDEN_PATHS.join(" ")}; do
    [ ! -e "$p" ] || { echo "[retail-image] refusing: $p is on the image"; exit 1; }
done
[ -z "$(find /var/lib/flagship-keyd -mindepth 1 -print -quit 2>/dev/null)" ] || { echo "[retail-image] refusing: keyd state on the image"; exit 1; }
rm -f /etc/machine-id
: > /etc/machine-id
sync
echo "[retail-image] retail layer ready"
`;
}
