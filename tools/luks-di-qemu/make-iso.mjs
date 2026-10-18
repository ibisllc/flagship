// Builds a d-i test ISO from the REAL generated preseed (partman/early_command,
// late_command and the step A/C shell text are production code) with the first-boot
// bootstrap swapped for a LUKS-only harness. The harness prints the key slots to the
// serial console. Throwaway keys are echoed on purpose: this is a test disk.
// usage: node make-iso.mjs <ok|broken> <src.iso> <out.iso>
//   ok     = production removal + single-slot proof
//   broken = luksRemoveKey is made to fail (the install must NOT finish)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Needs `npx tsc -b` first (imports the built builder).
const W = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "flagship-builder");
const { buildDebianPreseed, remasterIsoWithPreseed } = await import(`${W}/dist/index.js`);
const { optionsFromRecipeJson } = await import(`${W}/dist/preseedEngine.js`);
const { buildLuksBurnSlotRemovalBlock } = await import(`${W}/dist/userdata.js`);
const [mode, src, out] = process.argv.slice(2);
const vec = JSON.parse(readFileSync(`${W}/engine/golden/preseed-vectors.json`, "utf8")).vectors.find((v) => v.name === "luks-default");
let preseed = buildDebianPreseed(optionsFromRecipeJson(vec.recipeJson, {}));

const breakRemove = mode === "broken"
  ? 'cryptsetup() { if [ "$1" = luksRemoveKey ]; then echo "[harness] simulated luksRemoveKey failure"; return 1; fi; command cryptsetup "$@"; }\n'
  : "";
const bootstrap = `#!/bin/bash
set -eo pipefail
{
set -u
report_phase() { echo "[phase] $*"; }
${breakRemove}echo "[harness] LUKS test bootstrap (real step A/C text) mode=${mode}"
LUKS_BURN_KEYFILE=/var/flagship/luks-burn.key
[ -s "$LUKS_BURN_KEYFILE" ] || { echo "[flagship-bootstrap] FATAL: no install-time LUKS key file"; exit 1; }
echo "[harness] install-time key file: $(wc -c < "$LUKS_BURN_KEYFILE") bytes, mode $(stat -c %a "$LUKS_BURN_KEYFILE")"
ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
echo "[harness] LUKS partition: $ROOT_LUKS_PART"
echo "[harness] luksDump keyslots BEFORE:"
cryptsetup luksDump "$ROOT_LUKS_PART" | sed -n '/^Keyslots:/,/^Tokens:/p'
LUKS_KEY=/run/flagship-luks.key
head -c 30 /dev/urandom | od -An -tx1 | tr -d " \n" > "$LUKS_KEY"
chmod 600 "$LUKS_KEY"
cp "$LUKS_KEY" /boot/harness-real-key
cp "$LUKS_BURN_KEYFILE" /boot/harness-old-key
echo "[harness] throwaway-test-keys REAL=$(cat "$LUKS_KEY") OLD=$(cat "$LUKS_BURN_KEYFILE")"
cryptsetup luksAddKey "$ROOT_LUKS_PART" "$LUKS_KEY" --key-file "$LUKS_BURN_KEYFILE"
echo "[harness] luksDump keyslots after ADD:"
cryptsetup luksDump "$ROOT_LUKS_PART" | sed -n '/^Keyslots:/,/^Tokens:/p'
${buildLuksBurnSlotRemovalBlock()}
echo "[harness] luksDump AFTER (full header summary):"
cryptsetup luksDump "$ROOT_LUKS_PART"
echo "[harness] ENABLED-SLOT-COUNT=$(cryptsetup luksDump "$ROOT_LUKS_PART" | awk '/^Keyslots:/{f=1;next} /^[A-Za-z]/{f=0} f && /^[[:space:]]+[0-9]+:[[:space:]]*luks2/{n++} END{print n+0}')"
echo "[harness] DONE"
} 2>&1 | tee /dev/console
`;
const b64 = Buffer.from(bootstrap).toString("base64");
const re = /(echo ')([A-Za-z0-9+/=]+)(' \| base64 -d > \/target\/usr\/local\/sbin\/flagship-bootstrap\.sh)/;
if (!re.test(preseed)) throw new Error("bootstrap payload not found");
preseed = preseed.replace(re, `$1${b64}$3`);
// Harness only: never let the install-progress beacons reach prod.
preseed = preseed.replace("d-i preseed/early_command string ", "d-i preseed/early_command string echo '127.0.0.1 flagshipserver.com' >> /etc/hosts; ");
writeFileSync(out.replace(/\.iso$/, ".preseed.cfg"), preseed);
await remasterIsoWithPreseed({ srcIsoPath: src, outIsoPath: out, preseedCfg: preseed });
console.log("wrote", out);
