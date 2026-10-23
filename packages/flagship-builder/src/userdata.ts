/**
 * First-boot bootstrap + install-blob generator for the Builder.
 *
 * `buildBootstrapScript` is the script debian-installer runs in the target
 * chroot (preseed `late_command` -> `in-target`, see preseed.ts) to finish a
 * box: clone + build the daemon, mint the identity, register with `.com`, and
 * (the locked default) re-key the LUKS root to a random key sealed for the
 * phone, with the initramfs unlock hook that talks to the unlock relay.
 *
 *   - LUKS-encrypt-root is the DEFAULT (locked). Every burn produces an
 *     encrypted box keyed by the phone (the .com-blind relay path from
 *     docs/security-phone-as-unlock-endpoint.md) - it is NOT a user choice.
 *     An internal escape hatch (encryptRoot:false, NOT exposed in CLI/GUI)
 *     reproduces the unencrypted path for debugging only.
 *
 * EXECUTION CONTEXT. The bootstrap runs inside d-i's in-target CHROOT, where
 * systemd is NOT the running init - so `systemctl start` does nothing useful
 * and MUST NOT be relied on. We therefore only `systemctl enable` the units
 * (which works in a chroot - it just drops the symlink) and defer the daemon to
 * systemd units that fire on the first REAL boot.
 */
import { INSTALL_BOX_ARTIFACT_SH, VERIFY_BOX_ARTIFACT_SH } from "./boxInstallerScripts.js";
import { BOX_RELEASE } from "./boxReleaseConfig.js";
import type { InstallBlob } from "@flagship/protocol";
import { utf8ToBase64 } from "./base64.js";

/**
 * Options for the install config generators. The InstallBlob is embedded
 * base64-encoded in the preseed; the bootstrap script reads it back, never
 * re-fetches over the network.
 */
export interface UserDataOptions {
  blob: InstallBlob;
  /** Hex signature over canonical blob bytes (from build-ticket redeem). */
  blobSignatureHex: string;
  /** Repo to clone for the daemon source. */
  flagshipRepoUrl?: string;
  /** Exact 40-hex commit to install. Falls back to InstallBlob.installerGitRef; a branch or tag is refused. */
  installerGitRef?: string;
  /**
   * Encrypt the installed root with LUKS, gated on the phone (the
   * `.com`-blind unlock-relay path from
   * docs/security-phone-as-unlock-endpoint.md).
   *
   * DEFAULT (locked): undefined or true → encrypted. LUKS is a day-1 promise,
   * not a user choice — neither the CLI nor the GUI exposes a toggle. The
   * preseed gets a partman-crypto LVM-on-LUKS root, the bootstrap re-keys it to
   * a random key (install.sh's pattern), seals that
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
  /**
   * DEBUG-ONLY (never set by the CLI/GUI): when present, the bootstrap is
   * replaced by a minimal remote-access stub (sshd + this authorized key + the
   * Wi-Fi safety-net; NO provisioning, NO LUKS re-key) so provisioning can be
   * iterated over SSH instead of blind in-target. The preseed builds such an
   * image UNENCRYPTED (nothing would ever re-key it).
   */
  debugSshAuthorizedKey?: string;
  /**
   * The dedicated boot worker the box's boot-stage talks to for its LUKS
   * unlock (lease GET / approval request POST / response poll), baked to
   * /boot/flagship-boot-host so the initramfs unlock hook reads it on every
   * boot. Defaults to {@link DEFAULT_BOOT_HOST} (boot.flagshipserver.com).
   *
   * Overridable so an ENTERPRISE CLONE can repoint the boot plane without
   * touching code. The InstallBlob does not yet carry a boot-host field; a
   * follow-up can add one and thread it here. Until then this is the bake-time
   * default constant (or an explicit caller override).
   */
  bootHost?: string;
  /**
   * Optional Wi-Fi for a box with no Ethernet. A burn-time local input — NEVER
   * part of the signed InstallBlob. When an SSID is given, d-i joins the AP for
   * the install and the installed system gets a networkd + wpa_supplicant config
   * (and `wpasupplicant`) so it can drive the radio on the first real boot.
   * Empty ⇒ the default wired-DHCP behaviour, byte-identical to before.
   */
  wifiSSID?: string;
  wifiPassword?: string;
  /**
   * OFFLINE secret-free pairing (advanced/embed mode): the owner-IRK-signed
   * `add-paired-session` order embedded in PLAINTEXT (`{request, signature}`
   * JSON). The daemon reads it at first boot, verifies the owner-IRK signature,
   * and adds the paired session LOCALLY — no `.com` call — so the box comes
   * online ALREADY paired with NO secret in the recipe. An UNSIGNED recipe
   * sibling — NOT part of the signed InstallBlob — so it never affects the recipe
   * signature; absent ⇒ the on-disk blob is byte-identical to before (and the
   * default online recipe leaves it absent: the phone deposits the order sealed
   * to the box identity into `.com` AFTER registration instead).
   * Carried from the recipe via {@link LoadedBlob.pairingOrder}.
   */
  pairingOrder?: string;
  /**
   * SWK provisioning: the Service Workload Key (32-byte hex, = `deriveSWK(umk,
   * serverId)`). The daemon reads it at first boot, persists it to
   * /var/flagship/swk.hex, and turns on the service/build platform (and
   * peer-backup participation, which stays inert until the owner toggles it).
   * An UNSIGNED recipe sibling — NOT part of the signed InstallBlob — so it never
   * affects the recipe signature; absent ⇒ the on-disk blob is byte-identical to
   * before. Carried from the recipe via {@link LoadedBlob.swkHex}.
   */
  swkHex?: string;
  /** The owner's signed commitment to {@link swkHex} (JSON), carried to the box for it to check again. */
  offlineSecrets?: string;
  /**
   * The one-time enrollment secret (32 bytes hex) the creating device put in the recipe and kept a
   * copy of: the box proves its new key with it at first contact (protocol enrollment.ts), so the
   * phone pins the key built from ITS recipe and nothing `.com` could substitute. An UNSIGNED
   * sibling like {@link swkHex}; the box removes it after the phone's blessing.
   */
  enrollmentKeyHex?: string;
  /**
   * Owner debug access (`flagship/debug-access/v2`) as the JSON string
   * `{grant,signatureHex}`: an SSH key and an end time, signed behind Face ID
   * by an admin device. Embedded into install-blob.json as the UNSIGNED
   * `debugGrant` sibling so the box (server-daemon `debugAccessGate`) can
   * verify it under its pinned admin root before letting that key in as
   * `debug` until the end time — no valid grant ⇒ a production image. NOT part
   * of the signed InstallBlob; absent ⇒ byte-identical to before. Carried from
   * the recipe via {@link LoadedBlob.debugGrant}.
   */
  debugGrant?: string;
}

/**
 * The dedicated boot worker (boot.flagshipserver.com). The box's boot-stage
 * hits its identity-gated /api/boot/* contract for the LUKS unlock. Baked to
 * /boot/flagship-boot-host; enterprise clones override via UserDataOptions.bootHost.
 */
export const DEFAULT_BOOT_HOST = "https://boot.flagshipserver.com";

/**
 * The boot worker of the control plane this builder is pointed at
 * (FLAGSHIP_CONTROL_HOST, e.g. the gym), or undefined for production. Without
 * it a sealed disk built against another control plane asks prod's boot worker
 * for its unlock and gets "unknown server". A value that is not a plain host
 * (letters, digits, dots, dashes, optional port) is ignored.
 */
export function bootHostForControlHost(controlHost: string | undefined): string | undefined {
  const host = controlHost?.trim();
  if (!host || !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$/.test(host)) return undefined;
  return `https://boot.${host}`;
}

/**
 * The two boot-unlock modes (docs/security-phone-as-unlock-endpoint.md §7a.1).
 * Read from InstallBlob.bootUnlockMode (phone-signed); absent ⇒ "auto".
 */
export type BootUnlockMode = "auto" | "approve";

/**
 * The validated, defaulted inputs both generators derive from UserDataOptions.
 * Centralised so the preseed and the engine's bootstrap/blob entry points can
 * never drift on the git-ref/repo/bootHost validation or the
 * encryptRoot/bootUnlockMode defaults. The bootHost default (boot.flagshipserver.com) is overridable by an
 * enterprise clone; encryptRoot is the locked default (false = internal debug
 * escape only); bootUnlockMode is phone-signed in the blob (absent ⇒ "auto").
 */
export interface ResolvedBootstrapInputs {
  blobB64: string;
  ref: string;
  repo: string;
  bootHost: string;
  encryptRoot: boolean;
  bootUnlockMode: BootUnlockMode;
}

export function resolveBootstrapInputs(opts: UserDataOptions): ResolvedBootstrapInputs {
  const ref = (opts.installerGitRef ?? opts.blob.installerGitRef).trim();
  // SEC-INSTALL-001: the recipe names an exact commit, never a branch, a tag or a
  // shortened hash. The signed artifact manifest for that commit is what installs.
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    throw new Error(
      `the installer must name an exact 40-character commit, not ${JSON.stringify(ref)}: a branch or tag can move after the recipe is signed`,
    );
  }
  const repo = opts.flagshipRepoUrl ?? "https://github.com/ibisllc/flagship.git";
  if (!repo.startsWith("https://")) {
    throw new Error("flagshipRepoUrl must be https://");
  }
  const bootHost = (opts.bootHost ?? DEFAULT_BOOT_HOST).replace(/\/+$/, "");
  if (!bootHost.startsWith("https://")) {
    throw new Error("bootHost must be https://");
  }
  return {
    blobB64: utf8ToBase64(
      JSON.stringify(
        installBlobToJson(
          opts.blob,
          opts.blobSignatureHex,
          opts.pairingOrder,
          opts.swkHex,
          opts.debugGrant,
          opts.offlineSecrets,
          opts.enrollmentKeyHex,
        ),
      ),
    ),
    ref,
    repo,
    bootHost,
    // Disk encryption is phone-signed in the blob (InstallBlob.diskEncryption);
    // an explicit "none" opts out of LUKS (the Wi-Fi-only fallback), otherwise
    // (present "luks" OR absent) the box encrypts. The builder-local
    // `encryptRoot` flag can still force-disable for dev, but it can never
    // RE-enable a box the signed recipe said to leave unencrypted.
    encryptRoot: opts.blob.diskEncryption === "none" ? false : opts.encryptRoot !== false,
    bootUnlockMode: opts.blob.bootUnlockMode === "approve" ? "approve" : "auto",
  };
}

/**
 * Runtime Wi-Fi setup, run IN-TARGET (chroot for the installed system; the live
 * env too). networkd rejects `match:` for wifis ("only by interface
 * name") and the name (wlan0 / wlp2s0 / wlo1 …) isn't known at burn time, so we
 * detect it at runtime. `$1` = root prefix: "" when run inside the target (the
 * live installer, and the d-i in-target chroot), "/target" when run from the
 * installer host instead of chrooted.
 *
 * DISTRO BRANCH (the whole point of this rewrite). The config is written for the
 * network stack actually present in the target:
 *   - netplan present (Ubuntu) — write the netplan file (unchanged; works).
 *   - else (Debian) — netplan isn't installed, so the netplan file is a no-op.
 *     Configure the lowest common denominator present on BOTH distros instead:
 *     systemd-networkd (DHCP .network) + wpa_supplicant (per-iface conf), and
 *     NEUTRALIZE d-i's ifupdown `wpa-ssid/wpa-psk` stanza so ifupdown's
 *     wpa_supplicant and ours don't fight over the same radio. We enable units
 *     by dropping the `.wants` symlinks directly (what `systemctl enable` does)
 *     so it works whether we're chrooted or writing through a $ROOT prefix, and
 *     whether or not systemd is the running init.
 *
 * base64-embedded into the early/late commands, so this body needs no
 * YAML/shell escaping; the SSID/password sit in quoted heredocs, so
 * only double-quoted-scalar escaping (yamlEscape — same rules for netplan YAML
 * and wpa_supplicant's quoted strings) applies. Byte-identical to the Swift port
 * (UserData.wifiSetupScript) — keep the two in lockstep (cross-language sha pin).
 */
export function wifiSetupScript(ssid: string, password: string): string {
  return `#!/bin/bash
set -u
ROOT="\${1:-}"
IF=""
for d in /sys/class/net/*/wireless; do
  [ -e "\$d" ] || continue
  IF="\$(basename "\$(dirname "\$d")")"
  break
done
if [ -z "\$IF" ]; then
  echo "[flagship-wifi] no wireless interface found; skipping" >&2
  exit 0
fi
echo "[flagship-wifi] interface=\$IF root=\${ROOT:-/}"
if [ -d "\${ROOT}/etc/netplan" ]; then
  # Ubuntu: netplan drives networkd (which spawns wpa_supplicant@<iface>).
  echo "[flagship-wifi] netplan present — writing 99-flagship-wifi.yaml"
  cat > "\${ROOT}/etc/netplan/99-flagship-wifi.yaml" <<'FLAGSHIP_WIFI_EOF'
network:
  version: 2
  wifis:
    __IFACE__:
      dhcp4: true
      optional: true
      access-points:
        "${yamlEscape(ssid)}":
          password: "${yamlEscape(password)}"
FLAGSHIP_WIFI_EOF
  sed -i "s/__IFACE__/\${IF}/" "\${ROOT}/etc/netplan/99-flagship-wifi.yaml"
  chmod 600 "\${ROOT}/etc/netplan/99-flagship-wifi.yaml"
else
  # Debian (no netplan): systemd-networkd + wpa_supplicant, the common stack.
  echo "[flagship-wifi] no netplan — configuring systemd-networkd + wpa_supplicant for \$IF"
  mkdir -p "\${ROOT}/etc/systemd/network" "\${ROOT}/etc/wpa_supplicant"
  cat > "\${ROOT}/etc/systemd/network/10-flagship-wifi.network" <<'FLAGSHIP_NETWORKD_EOF'
[Match]
Name=__IFACE__
[Network]
DHCP=yes
IgnoreCarrierLoss=3s
FLAGSHIP_NETWORKD_EOF
  sed -i "s/__IFACE__/\${IF}/" "\${ROOT}/etc/systemd/network/10-flagship-wifi.network"
  chmod 644 "\${ROOT}/etc/systemd/network/10-flagship-wifi.network"
  # The wpa_supplicant@<iface>.service template (shipped by wpasupplicant) reads
  # exactly this path. Quoted-plaintext PSK is valid; 0600 (it holds the secret).
  cat > "\${ROOT}/etc/wpa_supplicant/wpa_supplicant-\${IF}.conf" <<'FLAGSHIP_WPA_EOF'
ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev
update_config=1
country=00
network={
  ssid="${yamlEscape(ssid)}"
  psk="${yamlEscape(password)}"
  scan_ssid=1
}
FLAGSHIP_WPA_EOF
  chmod 600 "\${ROOT}/etc/wpa_supplicant/wpa_supplicant-\${IF}.conf"
  # Neutralize d-i's ifupdown wireless stanza: netcfg writes an
  #   allow-hotplug <if> / iface <if> inet dhcp / wpa-ssid / wpa-psk / wpa-conf
  # block to /etc/network/interfaces; ifupdown would start its OWN wpa_supplicant
  # on that iface and fight ours. Comment out every wireless/wpa line for our
  # iface (leave lo + any wired stanza untouched).
  IFACES_FILE="\${ROOT}/etc/network/interfaces"
  if [ -f "\$IFACES_FILE" ]; then
    sed -i -E "/(allow-hotplug|auto|iface)[[:space:]]+\${IF}([[:space:]]|\\.|\$)/ s/^([^#])/# \\1/" "\$IFACES_FILE"
    sed -i -E "/^[[:space:]]*wpa-/ s/^([[:space:]]*)([^#[:space:]])/\\1# \\2/" "\$IFACES_FILE"
    echo "[flagship-wifi] neutralized ifupdown wireless stanza for \$IF in \$IFACES_FILE"
  fi
  # Enable systemd-networkd + wpa_supplicant@<iface> by dropping the .wants
  # symlinks directly (what \`systemctl enable\` does) — works chrooted or via a
  # \$ROOT prefix, and with systemd not running.
  mkdir -p "\${ROOT}/etc/systemd/system/multi-user.target.wants" \\
           "\${ROOT}/etc/systemd/system/sockets.target.wants"
  ln -sf /lib/systemd/system/systemd-networkd.service \\
    "\${ROOT}/etc/systemd/system/multi-user.target.wants/systemd-networkd.service"
  ln -sf /lib/systemd/system/systemd-networkd.socket \\
    "\${ROOT}/etc/systemd/system/sockets.target.wants/systemd-networkd.socket"
  ln -sf "/lib/systemd/system/wpa_supplicant@.service" \\
    "\${ROOT}/etc/systemd/system/multi-user.target.wants/wpa_supplicant@\${IF}.service"
fi`;
}

/** Escape a string for a YAML double-quoted scalar. */
export function yamlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The install-time LUKS passphrase is never a constant. The debian-installer
 * generates a fresh random one inside the installer on every install (see
 * preseed.ts) and keeps it only in installer RAM; late_command copies it into
 * the target root (itself the freshly formatted LUKS volume) at this path so
 * the bootstrap can authorize `luksAddKey` of the phone-sealed key, and
 * `luksRemoveKey` it again. The VM appliance's factory key file is separate
 * (appliance.ts).
 */
export const LUKS_BURN_KEYFILE = "/var/flagship/luks-burn.key";
/** Where the installer keeps the generated passphrase (d-i RAM disk only). */
export const LUKS_BURN_STAGING_PATH = "/tmp/flagship-luks-burn";
/** Length of the generated install-time passphrase (alphanumerics). */
export const LUKS_BURN_PASSPHRASE_LENGTH = 48;
/** The key file a generalized VM appliance is unlocked with until it specializes. */
export const APPLIANCE_BUILD_KEYFILE = "/etc/flagship/appliance-build.key";

/**
 * Shell function installed into the bootstrap (and the appliance specializer)
 * that proves the LUKS root ends with exactly one usable key slot and that it is
 * the phone-sealed key. Any failure prints `[flagship-bootstrap] FATAL: ...` and
 * exits 1, which fails the install loudly.
 *
 *   flagship_assert_single_luks_slot <luks device> <removed key file> <real key file>
 *
 * Checks, in order: the removed key no longer opens the device; the real key
 * does; `cryptsetup luksDump` can be read and shows exactly one enabled key
 * slot (LUKS2 `N: luks2` lines under `Keyslots:`; LUKS1 `Key Slot N: ENABLED`).
 */
export const LUKS_ASSERT_SINGLE_SLOT_FN = `flagship_luks_enabled_slots() {
    local dump
    dump="$(cryptsetup luksDump "$1" 2>/dev/null)" || return 1
    [ -n "$dump" ] || return 1
    if grep -q '^Version:[[:space:]]*1[[:space:]]*$' <<<"$dump"; then
        grep -c '^Key Slot [0-9]*: ENABLED' <<<"$dump" || true
    else
        awk '/^Keyslots:/{f=1;next} /^[A-Za-z]/{f=0} f && /^[[:space:]]+[0-9]+:[[:space:]]*luks2/{n++} END{print n+0}' <<<"$dump"
    fi
}
flagship_assert_single_luks_slot() {
    local dev="$1" removed="$2" real="$3" slots
    if cryptsetup open --test-passphrase --key-file "$removed" "$dev" >/dev/null 2>&1; then
        echo "[flagship-bootstrap] FATAL: the install-time LUKS key still opens $dev after removal"
        exit 1
    fi
    if ! cryptsetup open --test-passphrase --key-file "$real" "$dev" >/dev/null 2>&1; then
        echo "[flagship-bootstrap] FATAL: the phone-sealed LUKS key does not open $dev"
        exit 1
    fi
    if ! slots="$(flagship_luks_enabled_slots "$dev")"; then
        echo "[flagship-bootstrap] FATAL: cannot read the LUKS header of $dev to count key slots"
        exit 1
    fi
    if [ "$slots" != "1" ]; then
        echo "[flagship-bootstrap] FATAL: $dev has $slots enabled LUKS key slots, expected exactly 1"
        exit 1
    fi
    echo "[flagship-bootstrap] LUKS verified: exactly 1 enabled key slot on $dev, the install-time key is gone"
}`;

/**
 * Step C of the LUKS re-key: remove the install-time key and prove the result.
 * Runs only after the random key is added (A) and sealed + uploaded (B), so
 * every earlier failure stays recoverable. Needs ROOT_LUKS_PART,
 * LUKS_BURN_KEYFILE and LUKS_KEY set. Exported so the tests can run the real
 * text against a stub cryptsetup.
 */
export function buildLuksBurnSlotRemovalBlock(): string {
  return `# C. The phone-sealed key is safely stored. Remove the install-time key so the
#    phone is the ONLY unlock, then PROVE it: the removed key must no longer open
#    the disk, the sealed key must, and exactly one key slot may remain. Any
#    failure here aborts the install (a box that still opens with a key nobody
#    sealed must never look finished).
${LUKS_ASSERT_SINGLE_SLOT_FN}
if ! cryptsetup open --test-passphrase --key-file "$LUKS_KEY" "$ROOT_LUKS_PART" >/dev/null 2>&1; then
    echo "[flagship-bootstrap] FATAL: the new LUKS key does not open $ROOT_LUKS_PART — refusing to remove the install-time key"
    exit 1
fi
if [ "\${FLAGSHIP_APPLIANCE_PREINSTALLED:-0}" = "1" ]; then
    # The appliance specializer owns the removal of its factory key (and the
    # crypttab/initramfs changes that go with it), verifies it the same way and
    # then shreds the new key (it lives on /run, a RAM disk).
    echo "[flagship-bootstrap] appliance: factory key removal is left to the specializer"
else
    if ! cryptsetup luksRemoveKey "$ROOT_LUKS_PART" --key-file "$LUKS_BURN_KEYFILE"; then
        echo "[flagship-bootstrap] FATAL: could not remove the install-time LUKS key from $ROOT_LUKS_PART"
        exit 1
    fi
    flagship_assert_single_luks_slot "$ROOT_LUKS_PART" "$LUKS_BURN_KEYFILE" "$LUKS_KEY"
    report_phase sealing "Disk key secured: one unlock key slot, install key removed"
    shred -u "$LUKS_BURN_KEYFILE" 2>/dev/null || rm -f "$LUKS_BURN_KEYFILE"
    shred -u "$LUKS_KEY" 2>/dev/null || rm -f "$LUKS_KEY"
fi`;
}

export interface BootstrapTemplateArgs {
  ref: string;
  repoUrl: string;
  encryptRoot: boolean;
  bootUnlockMode: BootUnlockMode;
  /** Boot worker host baked to /boot/flagship-boot-host (default boot.flagshipserver.com). */
  bootHost: string;
  /**
   * Burn-time Wi-Fi (never in the signed blob). When an SSID is given, the
   * bootstrap bakes a first-boot Wi-Fi SAFETY-NET unit + adds wpasupplicant to
   * its apt line. Absent (the wired case) ⇒ no safety-net, no apt change, so the
   * bootstrap is byte-identical to before (the cross-language pins + the
   * wired-burn equality tests depend on this). The creds are embedded base64 so
   * an SSID/PSK with shell metacharacters can never inject into the script.
   */
  wifiSSID?: string;
  wifiPassword?: string;
  /** DEBUG-ONLY: replace the bootstrap with a minimal sshd+key remote-access stub. */
  debugSshAuthorizedKey?: string;
}

/**
 * Build the first-boot bootstrap, run by the Debian preseed's d-i late_command in
 * the in-target chroot at install time (and by the VM appliance's first-boot
 * specialization). Exported so preseed.ts and the engine reuse the exact same
 * script.
 */
export function buildBootstrapScript(args: BootstrapTemplateArgs): string {
  if (!/^[0-9a-f]{40}$/.test(args.ref)) {
    throw new Error(`the installer must name an exact 40-character commit, not ${JSON.stringify(args.ref)}`);
  }
  // The sshd remote-access stub is its own dev-only debug mechanism (never
  // CLI/GUI), separate from the runtime owner-grant-gated debug-access path.
  if (args.debugSshAuthorizedKey) return buildBootstrapScriptDebug(args);
  // PRODUCTION ONLY: the bootstrap no longer bakes any console-login account or
  // banner. Debug access is 100% runtime + owner-grant-gated (the daemon's
  // debugAccessGate lets an SSH key in as its own `debug` user only on a
  // verified admin-signed `flagship/debug-access/v2` grant, until it ends), so
  // there is no inline backdoor to keep or strip — and the `flagship` admin
  // ships with a LOCKED password.
  return args.encryptRoot
    ? buildBootstrapScriptEncrypted(args)
    : buildBootstrapScriptPlain(args);
}

/**
 * DEBUG-ONLY bootstrap (emitted only when debugSshAuthorizedKey is supplied —
 * never by the CLI/GUI). The opposite of provisioning-blind-in-target: it makes
 * the box REACHABLE so the real provisioning (clone/build/identity/register/
 * re-key) can be run + iterated over SSH and then baked back into the production
 * bootstrap. It installs sshd + the dev's authorized key + the Wi-Fi safety-net,
 * drops the install-blob, and does NOTHING else — crucially NO LUKS re-key, so
 * the disk keeps whatever key it was built with (a plain disk for an installer
 * image, the factory key file for a VM appliance) and the box actually boots.
 */
function buildBootstrapScriptDebug(args: BootstrapTemplateArgs): string {
  const wpaPkg = (args.wifiSSID ?? "").trim().length ? " wpasupplicant" : "";
  const wifiSafetyNet = buildWifiSafetyNetBlock(
    args.wifiSSID ?? "",
    args.wifiPassword ?? "",
  );
  const key = (args.debugSshAuthorizedKey ?? "").trim();
  return `#!/bin/bash
# Flagship DEBUG bootstrap — remote access only. NO provisioning, NO LUKS re-key.
set -uo pipefail
exec >>/var/log/flagship-debug-bootstrap.log 2>&1
date
echo "[flagship-debug] sshd + key + wifi; no LUKS re-key"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends openssh-server ca-certificates curl jq xxd cryptsetup lvm2${wpaPkg}

# Dev SSH key for the flagship user (key auth; the baked password is unknown).
install -d -m 700 /home/flagship/.ssh
cat > /home/flagship/.ssh/authorized_keys <<'PUBKEY'
${key}
PUBKEY
chmod 600 /home/flagship/.ssh/authorized_keys
chown -R flagship:flagship /home/flagship/.ssh
systemctl enable ssh 2>/dev/null || systemctl enable sshd 2>/dev/null || true
# \`systemctl enable\` can silently fail in the installer chroot (there is no
# running systemd/D-Bus). Make debug access deterministic on the first real
# boot, just like the production units below.
mkdir -p /etc/systemd/system/multi-user.target.wants
if [ -e /lib/systemd/system/ssh.service ]; then
    ln -sf /lib/systemd/system/ssh.service /etc/systemd/system/multi-user.target.wants/ssh.service
elif [ -e /usr/lib/systemd/system/ssh.service ]; then
    ln -sf /usr/lib/systemd/system/ssh.service /etc/systemd/system/multi-user.target.wants/ssh.service
elif [ -e /lib/systemd/system/sshd.service ]; then
    ln -sf /lib/systemd/system/sshd.service /etc/systemd/system/multi-user.target.wants/sshd.service
fi

# Persist a couple of install facts for the manual provisioning over SSH.
mkdir -p /var/flagship
if [ -f /var/flagship/install-blob.json ]; then
    jq -r .serverDomain /var/flagship/install-blob.json > /var/flagship/server-domain 2>/dev/null || true
    jq -r .username     /var/flagship/install-blob.json > /var/flagship/username      2>/dev/null || true
fi
${wifiSafetyNet}
date > /var/flagship/debug-ready.flag
echo "[flagship-debug] done — ssh flagship@<box-ip>"
`;
}

function buildBootstrapScriptPlain(args: BootstrapTemplateArgs): string {
  // wpasupplicant only on the Wi-Fi path — the safety-net needs the binary, and
  // we don't assume the installer's package list ran. Wired ⇒ "" so the plain
  // bootstrap stays byte-identical (the wired-equality + cross-language tests).
  const wpaPkg = (args.wifiSSID ?? "").trim().length > 0 ? " wpasupplicant" : "";
  const wifiSafetyNet = buildWifiSafetyNetBlock(args.wifiSSID ?? "", args.wifiPassword ?? "");
  return `#!/bin/bash
# Flagship first-boot bootstrap.
# Runs once at install time under d-i's in-target chroot. Idempotent.
set -uo pipefail
exec >>/var/log/flagship-bootstrap.log 2>&1
date
echo "[flagship-bootstrap] starting"

REPO_URL="\${FLAGSHIP_REPO_URL:-${args.repoUrl}}"
GIT_REF="${args.ref}"

# Install the host tools the bootstrap and the initramfs hook need. Node is NOT one of
# them: the box runs the Node that ships inside its verified release artifact
# (SEC-NODE-001), so nothing here adds NodeSource, another package repository, git,
# npm or a compiler. Do NOT assume the installer's packages: list ran — a missing jq
# once parsed the recipe into empty values and mis-sealed the LUKS key.
#
# docker.io/docker-cli/docker-compose: the daemon runs every marketplace app as
# a hardened container and brings up the data-layer (postgres/forgejo/...)
# via compose, so docker is REQUIRED — without it the daemon's ensureNetwork
# (\`docker network create\`) used to crash the process at startup. docker-cli is
# listed explicitly because --no-install-recommends drops it (it's only a
# Recommends of docker.io); docker-compose ships the \`docker compose\` subcommand
# the data-services init.sh calls.
export DEBIAN_FRONTEND=noninteractive
if [ "\${FLAGSHIP_APPLIANCE_PREINSTALLED:-0}" != "1" ]; then
apt-get install -y --no-install-recommends jq curl ca-certificates cryptsetup lvm2 xxd openssl docker.io docker-cli docker-compose${wpaPkg}
else
    echo "[flagship-bootstrap] generalized appliance detected — packages already present"
    for _cmd in jq curl cryptsetup openssl docker xxd; do
        command -v "$_cmd" >/dev/null 2>&1 || { echo "[flagship-bootstrap] FATAL: appliance missing $_cmd"; exit 1; }
    done
fi

# Read the install-blob fields the daemon needs.
BLOB_JSON=/var/flagship/install-blob.json
SERVER_DOMAIN="$(jq -r .serverDomain "$BLOB_JSON")"
USERNAME="$(jq -r .username "$BLOB_JSON")"
SERVER_NAME="$(jq -r .serverName "$BLOB_JSON")"
REGISTRATION_URL="$(jq -r .registrationUrl "$BLOB_JSON")"
PHONE_DELEGATED_PUBKEY="$(jq -r .phoneDelegatedPubKey "$BLOB_JSON")"
AUTH_CODE_SERIAL="$(jq -r .authCode.serial "$BLOB_JSON")"
echo "[flagship-bootstrap] domain=$SERVER_DOMAIN user=$USERNAME ref=$GIT_REF"

# ── Brand the box. /etc/issue is shown by getty ABOVE the login prompt (where
#    you see "flagship-pod login:"); /etc/motd is shown right after login.
#    PURE ASCII ONLY: the VT decodes UTF-8 but Debian's default console font
#    (Lat15) has no glyphs for block elements or em-dashes — every non-ASCII
#    char rendered as the missing-glyph box on real hardware (2026-06-12
#    photo). Single-quoted heredocs ⇒ the art is static and agetty never
#    sees a backslash escape; the one colored line is appended with printf
#    so a LITERAL ESC byte lands in the file (the console's 16-color
#    palette has no teal — bright cyan is the nearest).
cat > /etc/issue <<'FLAGSHIP_ISSUE'

  ###### ##     ###### ###### ###### ##  ## ###### ######
  ##     ##     ##  ## ##     ##     ##  ##   ##   ##  ##
  #####  ##     ###### ## ### ###### ######   ##   ######
  ##     ##     ##  ## ##  ##     ## ##  ##   ##   ##
  ##     ###### ##  ## ###### ###### ##  ## ###### ##

  This is a Flagship server - your personal cloud. You hold the keys.
FLAGSHIP_ISSUE
printf '  Get yours at \\033[96mflagshipserver.com\\033[0m\\n' >> /etc/issue
# MOTD (post-login) names this specific box. Unquoted heredoc ⇒ vars expand.
cat > /etc/motd <<FLAGSHIP_MOTD

  Flagship - $SERVER_NAME
  https://$SERVER_DOMAIN - TLS terminates here, on your hardware.
  flagship.services is a blind pipe; it never sees your data.

FLAGSHIP_MOTD

# Provisioning-status → .com so the phone renders a live install timeline.
# Best-effort: a failed report NEVER fails the install. (The Alpine live
# installer can also report the earlier downloading/partitioning phases; the
# d-i late_command can only report from here on — clone/build onward.)
CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
report_phase() {
    # $1 = canonical ProvisionStatusPhase, $2 = optional detail (error string)
    if [ -n "\${2:-}" ]; then
        curl -fsS -m 8 -X POST -H 'content-type: application/json' \\
            --data '{"phase":"'"$1"'","detail":"'"$2"'"}' \\
            "$CONTROL_PLANE_BASE/api/order/$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
    else
        curl -fsS -m 8 -X POST -H 'content-type: application/json' \\
            --data '{"phase":"'"$1"'"}' \\
            "$CONTROL_PLANE_BASE/api/order/$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
    fi
}
# Error trap — any fatal bootstrap failure reports the terminal canonical
# error phase so the phone's timeline shows the stall instead of hanging on the
# last good phase. Fires once, only on a non-zero exit (a clean exit clears it
# first). Best-effort + never re-raises, so the trap can't itself wedge the
# install. The captured exit code is preserved.
flagship_on_error() {
    _rc=$?
    [ "$_rc" -eq 0 ] && return 0
    report_phase error "bootstrap exited $_rc"
}
trap flagship_on_error EXIT
if [ "\${FLAGSHIP_APPLIANCE_PREINSTALLED:-0}" = "1" ]; then
    report_phase installing "Specializing prebuilt server"
else
    report_phase downloading
fi

# Persist install-time facts the daemon reads on every boot.
mkdir -p /var/flagship /boot/flagship
echo "$SERVER_DOMAIN"          > /var/flagship/server-domain
echo "$USERNAME"               > /var/flagship/username
echo "$SERVER_NAME"            > /var/flagship/server-name
echo "$PHONE_DELEGATED_PUBKEY" > /var/flagship/phone-delegated.pub
echo "$AUTH_CODE_SERIAL"       > /var/flagship/auth-code-serial
cp "$BLOB_JSON" /boot/install-blob.json

# Install the signed box release (SEC-INSTALL-001). GIT_REF is the exact commit the
# owner's phone signed into the recipe. The installer below checks, before anything
# of the artifact runs: the file's digest and size, that the commit and architecture
# are the ones asked for, that enough release keys signed this exact manifest, that
# the sequence is not older than this installer's, and that the Node inside meets
# the security floor. It resolves nothing from npm, apt, git or any package repository.
if [ "\${FLAGSHIP_APPLIANCE_PREINSTALLED:-0}" = "1" ]; then
    [ -L /opt/flagship ] || { echo "[flagship-bootstrap] FATAL: appliance release link missing"; exit 1; }
    APPLIANCE_COMMIT="$(jq -r .commit /var/flagship/artifact-current.json 2>/dev/null || true)"
    [ "$APPLIANCE_COMMIT" = "$GIT_REF" ] || { echo "[flagship-bootstrap] FATAL: appliance release $APPLIANCE_COMMIT does not match signed recipe commit $GIT_REF"; exit 1; }
    cd /opt/flagship
    [ -e node_modules/@flagship/protocol/package.json ] || { echo "[flagship-bootstrap] FATAL: appliance release incomplete"; exit 1; }
    echo "[flagship-bootstrap] reusing the prebuilt release commit=$APPLIANCE_COMMIT"
else
case "$(dpkg --print-architecture)" in
    amd64) BOX_ARCH=amd64 ;;
    arm64) BOX_ARCH=arm64 ;;
    *) echo "[flagship-bootstrap] FATAL: unsupported architecture $(dpkg --print-architecture)"; exit 1 ;;
esac
BOX_ARTIFACT_NAME="flagship-box-\${GIT_REF:0:12}-$BOX_ARCH"
BOX_ARTIFACT_BASE="${BOX_RELEASE.artifactBase}"
mkdir -p /usr/local/lib/flagship-installer /var/flagship
cat > /usr/local/lib/flagship-installer/verify-box-artifact.sh <<'FLAGSHIP_VERIFY_BOX_ARTIFACT_EOF'
${VERIFY_BOX_ARTIFACT_SH}
FLAGSHIP_VERIFY_BOX_ARTIFACT_EOF
cat > /usr/local/lib/flagship-installer/install-box-artifact.sh <<'FLAGSHIP_INSTALL_BOX_ARTIFACT_EOF'
${INSTALL_BOX_ARTIFACT_SH}
FLAGSHIP_INSTALL_BOX_ARTIFACT_EOF
chmod 755 /usr/local/lib/flagship-installer/verify-box-artifact.sh /usr/local/lib/flagship-installer/install-box-artifact.sh
for _ext in tar.gz manifest.json; do
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 5 --max-time 1800 \\
        -o "/var/tmp/$BOX_ARTIFACT_NAME.$_ext" "$BOX_ARTIFACT_BASE/$BOX_ARTIFACT_NAME.$_ext" \\
        || { echo "[flagship-bootstrap] FATAL: could not download $BOX_ARTIFACT_NAME.$_ext"; exit 1; }
done
BOX_ARTIFACT_SHA="$(jq -er .manifest.artifactSha256 "/var/tmp/$BOX_ARTIFACT_NAME.manifest.json")" \\
    || { echo "[flagship-bootstrap] FATAL: the release manifest has no digest"; exit 1; }
bash /usr/local/lib/flagship-installer/install-box-artifact.sh \\
    --manifest "/var/tmp/$BOX_ARTIFACT_NAME.manifest.json" \\
    --artifact "/var/tmp/$BOX_ARTIFACT_NAME.tar.gz" \\
    --trust-keys "${BOX_RELEASE.trust.keys.join(",")}" \\
    --threshold ${BOX_RELEASE.trust.threshold} \\
    --expect-sha256 "$BOX_ARTIFACT_SHA" \\
    --expect-commit "$GIT_REF" \\
    --arch "$BOX_ARCH" \\
    --node-floor ${BOX_RELEASE.nodeFloor} \\
    --min-sequence ${BOX_RELEASE.minSequence} \\
    | tee /var/log/flagship-install-artifact.log \\
    || { echo "[flagship-bootstrap] FATAL: the box release was refused; see /var/log/flagship-install-artifact.log"; exit 1; }
rm -f "/var/tmp/$BOX_ARTIFACT_NAME.tar.gz" "/var/tmp/$BOX_ARTIFACT_NAME.manifest.json"
cd /opt/flagship
fi

# Generate server identity.
mkdir -p /var/flagship/identity
chmod 700 /var/flagship/identity
flagship-tsx scripts/install-helper.ts gen-identity \\
    --out-priv /var/flagship/identity/identity.priv.hex \\
    --out-pub  /var/flagship/identity/identity.pub.hex \\
    --out-pem  /boot/identity.pem
chmod 600 /var/flagship/identity/identity.priv.hex /boot/identity.pem
SERVER_IDENTITY_PRIV_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.priv.hex)"
SERVER_IDENTITY_PUB_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.pub.hex)"

# Entitlement bundle: deliberately NOT minted here. The daemon hard-
# requires an IRK-signed RootEntitlement on every tunnel HELLO, and the
# production hub verifies that signature against the owner IRK (irkLookup,
# live since 2026-06-16), so a box-self-signed bundle is REJECTED at the
# hub ("rootEntitlement signature failed verification"). The real (Builder)
# path has no user IRK on the box (the phone holds it), so we write NOTHING
# here and let the daemon fetch an IRK-signed entitlement from the phone on
# first boot via .com's blind mailbox (server-daemon entitlementRelay.ts,
# which fires only when no bundle is on disk). The phone signs an
# EntitlementBundle for THIS box's STK and the daemon persists it to
# /var/flagship/entitlements.json.

# Daemon environment. server-daemon reads its two REQUIRED inputs
# (FLAGSHIP_SUBDOMAIN + FLAGSHIP_IDENTITY_PRIV_HEX) from the process env
# only; systemd loads this via EnvironmentFile= in the unit below.
mkdir -p /etc/flagship
cat > /etc/flagship/daemon.env <<ENVEOF
FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN
FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
ENVEOF
chmod 600 /etc/flagship/daemon.env

# Write systemd units. We run inside d-i's in-target chroot where
# systemd is NOT running, so we ENABLE (drops the symlink, takes effect
# on first real boot) and never rely on \`systemctl start\`. Two units:
#   flagship-first-boot-register — oneshot, POSTs /api/server/register
#   flagship-daemon              — the long-running server-daemon
cat > /etc/sysctl.d/90-flagship-hardening.conf <<'SYSCTL'
# SEC-KEY-003: no core dumps anywhere; a crashed daemon must not leave key material on disk.
fs.suid_dumpable = 0
kernel.core_pattern = |/bin/false
SYSCTL
sysctl -q -p /etc/sysctl.d/90-flagship-hardening.conf 2>/dev/null || true
cat > /etc/systemd/system/flagship-daemon.service <<'UNIT'
[Unit]
Description=Flagship server daemon
After=network-online.target flagship-first-boot-register.service
Wants=network-online.target
# Never stop restarting on a headless box: with a start-limit the daemon's
# legitimate self-restarts (below) could trip StartLimitBurst and systemd would
# give up, stranding the box with no console to recover it.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=/opt/flagship
EnvironmentFile=/etc/flagship/daemon.env
# SEC-KEY-003: a crash must never write key material to disk, and files the daemon
# creates are private by default.
LimitCORE=0
UMask=0077
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning packages/server-daemon/dist/index.js
# MUST be always, NOT on-failure. The daemon deliberately exits 0 to ask the
# supervisor to restart it once it has provisioned a post-boot secret or staged
# an update: the SWK-deposit + CGK-deposit consumers, the admin-root rotation
# consumer, and the self-update commit all exit with code 0 so the next boot
# re-reads the new state (server-daemon/src/index.ts). Under on-failure systemd
# treats exit 0 as success and does NOT restart, so a secret-free-recipe box
# dies the instant it consumes its SWK, before it ever claims its entitlement,
# opens the tunnel, runs ACME, or serves HTTPS. The real host power-off/reboot is
# a separate systemctl poweroff (deadMan.ts), so always never strands a shutdown.
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
StartLimitIntervalSec=0

[Service]
Type=oneshot
WorkingDirectory=/opt/flagship
ExecStart=/usr/local/sbin/flagship-first-boot-register.sh
Restart=on-failure
RestartSec=10

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
# Canonical provisioning-status report (POST /api/order/<serial>/status). On the
# plain path the deferred register is where the registering phase first fires —
# the encrypted path already reported it inline before its in-target register,
# so its registered.flag makes this unit skip (no double-emit). Best-effort.
CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
report_phase() {
    curl -fsS --connect-timeout 3 --max-time 8 -X POST -H 'content-type: application/json' \\
        --data '{"phase":"'"$1"'"}' \\
        "$CONTROL_PLANE_BASE/api/order/$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
}
wait_for_registration_network() {
    # network-online.target is only meaningful when the installed networking
    # stack enables a wait-online implementation. Debian images vary, so guard
    # the actual invariant here: a default route plus working DNS/TCP/TLS.
    _deadline=$(( $(date +%s) + 120 ))
    _attempt=0
    while [ "$(date +%s)" -lt "$_deadline" ]; do
        _attempt=$((_attempt + 1))
        if ip route show default 2>/dev/null | grep -q . && \\
           curl -sS -o /dev/null --connect-timeout 3 --max-time 8 "$CONTROL_PLANE_BASE/"; then
            echo "[register] network ready (attempt $_attempt)"
            return 0
        fi
        echo "[register] waiting for route/DNS/HTTPS (attempt $_attempt)"
        sleep 5
    done
    echo "[register] network unavailable after 120s"
    return 1
}
wait_for_registration_network
report_phase registering
# Once flagship-keyd holds the key the register step signs through it (the key is no longer in this file).
if [ -n "\${SERVER_IDENTITY_PRIV_HEX:-}" ]; then ID_ARGS=(--priv-hex "$SERVER_IDENTITY_PRIV_HEX"); else ID_ARGS=(--keyd-socket /run/flagship-keyd/keyd.sock); fi
flagship-tsx scripts/install-helper.ts sign-server-register "\${ID_ARGS[@]}" \\
    --auth-code-blob /var/flagship/install-blob.json \\
    > /run/register-payload.json
echo "[register] POST $REGISTRATION_URL"
curl -fsS --connect-timeout 5 --max-time 30 -X POST -H "content-type: application/json" \\
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
AUTH_CODE_SERIAL=$AUTH_CODE_SERIAL
SERVER_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
ENV
chmod 600 /etc/flagship-bootstrap.env

# Data-layer bring-up. The daemon hands every app a provisioned Postgres
# database via the compose stack in the clone (files are per-app docker
# volumes); init.sh generates the secrets file (/var/flagship/data-services.env
# — the exact path the daemon reads), brings up Postgres and waits for it, then
# starts the optional services. It is idempotent and runs on EVERY boot, and a
# failed run is retried (Restart=on-failure, bounded by the start limit), so a
# box that once failed (no network, a registry outage) still gets its data
# layer. Deliberately NOT ordered before flagship-daemon: pulling the images can
# take minutes and must never delay the box reaching its green padlock; the
# daemon picks the stack up once it is healthy. Keep this unit identical to
# installer/data-services/flagship-data-services.service (the daemon installs
# that file over an older unit at boot; a test pins the two together).
cat > /etc/systemd/system/flagship-data-services.service <<'UNIT'
[Unit]
Description=Flagship data-layer (postgres/forgejo/chromium)
After=docker.service network-online.target
Wants=docker.service network-online.target
StartLimitIntervalSec=2h
StartLimitBurst=40

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/flagship/installer/data-services
ExecStart=/opt/flagship/installer/data-services/init.sh
TimeoutStartSec=20min
Restart=on-failure
RestartSec=60s

[Install]
WantedBy=multi-user.target
UNIT

# daemon-reload is a no-op (and may warn) in the install chroot; the
# enable symlinks are what matter and they persist into the booted
# system. Do NOT \`systemctl start\` — systemd isn't the init here.
systemctl daemon-reload 2>/dev/null || true
# docker.io's postinst already enables docker/containerd, but enable again
# explicitly so a recommends-stripped or partial install still comes up.
systemctl enable docker.service containerd.service 2>/dev/null || \\
    echo "[flagship-bootstrap] WARNING: could not enable docker (daemon will retry network setup on boot)"
systemctl enable flagship-daemon.service flagship-first-boot-register.service flagship-data-services.service || \\
    echo "[flagship-bootstrap] WARNING: systemctl enable failed (will retry would be needed on real boot)"
# ── FIRST-BOOT AUTOSTART: enable the units DETERMINISTICALLY. ────────────────
# ROOT CAUSE of the "installed but DEAD at the login prompt" box (live-proven on
# the Windows VM e2e): this bootstrap runs in the installer's in-target CHROOT,
# where \`systemctl enable\` is unreliable — with no running systemd/D-Bus it can
# return without creating the [Install] WantedBy symlinks, and the \`|| echo\`
# above SWALLOWS that failure, so first-boot-register + the daemon never fire,
# no phone-home beacon is sent, and .com never publishes DNS. The WORKING
# cloud-init path (demoUsersAdminCloudInit.ts) never hits this: it runs at REAL
# boot under a live systemd AND starts register + daemon INLINE, so its enable
# always takes. We can't \`systemctl start\` in the chroot, so instead we make the
# enable itself chroot-proof: drop the multi-user.target.wants symlinks BY HAND
# (exactly what \`systemctl enable\` does, and precisely the pattern the Wi-Fi
# setup already relies on). This needs no running systemd and can't be a no-op,
# so the units are GUARANTEED enabled for the first real boot.
mkdir -p /etc/systemd/system/multi-user.target.wants
for _u in flagship-daemon flagship-first-boot-register flagship-data-services; do
    ln -sf "/etc/systemd/system/\${_u}.service" \\
        "/etc/systemd/system/multi-user.target.wants/\${_u}.service"
done
echo "[flagship-bootstrap] systemd units installed + enabled (start deferred to first real boot)"
${wifiSafetyNet}
# Reached the end cleanly — disarm the error trap so the EXIT handler doesn't
# misfire a terminal error phase on a 0 exit. On the encrypted path the LUKS
# block is spliced in just ABOVE this line, so the trap still covers the re-key.
trap - EXIT
date > /var/flagship/installed.flag
echo "[flagship-bootstrap] done"
`;
}

/**
 * First-boot Wi-Fi SAFETY-NET (the strongest reliability win). A headless
 * appliance has no console user to fix networking, so even if the primary config
 * (netplan on Ubuntu / networkd+wpa_supplicant on Debian) is imperfect, this
 * backstop guarantees the baked SSID comes up. A oneshot unit runs at every
 * boot: it waits a grace period for a default route and EXITS if one appears
 * (so it never fights a working config), otherwise it brings the radio up
 * directly (wpa_supplicant + DHCP via networkd, with dhclient/dhcpcd/udhcpc
 * fallbacks) and retries. Works on both distros (only systemd + wpa_supplicant
 * are assumed). Returns "" when there's no Wi-Fi, so wired burns are unchanged.
 *
 * The SSID/PSK are embedded base64 (decoded into /etc/flagship/wifi.env at 0600)
 * so a value with shell metacharacters can never inject into the generated
 * bootstrap. Byte-identical to the Swift port (UserData.wifiSafetyNetBlock) —
 * exported so the cross-language sha256 pin can assert the two stay in lockstep.
 */
export function buildWifiSafetyNetBlock(ssid: string, password: string): string {
  if (ssid.trim().length === 0) return "";
  const ssidB64 = utf8ToBase64(ssid);
  const pskB64 = utf8ToBase64(password);
  return `
# ── First-boot Wi-Fi safety-net (headless box has no console to fix net) ──
# Brings up the baked SSID directly IF the box is offline after boot — a backstop
# behind the primary netplan/networkd config. Only acts when there's no default
# route, so it never fights a working primary. Credentials embedded base64
# (injection-safe), decoded to /etc/flagship/wifi.env at 0600.
mkdir -p /etc/flagship
cat > /etc/flagship/wifi.env <<'WIFIENV'
FLAGSHIP_WIFI_SSID_B64=${ssidB64}
FLAGSHIP_WIFI_PSK_B64=${pskB64}
WIFIENV
chmod 600 /etc/flagship/wifi.env

cat > /usr/local/sbin/flagship-wifi-safetynet.sh <<'SAFETYNET'
#!/bin/bash
set -u
exec >>/var/log/flagship-wifi-safetynet.log 2>&1
date
# The initramfs premount's /run log survives the pivot (initramfs-tools moves
# /run onto the root) — persist a copy where logs belong.
cp /run/flagship-wifi.log /var/log/flagship-wifi-initramfs.log 2>/dev/null || true
. /etc/flagship/wifi.env 2>/dev/null || exit 0
SSID="\$(printf '%s' "\${FLAGSHIP_WIFI_SSID_B64:-}" | base64 -d 2>/dev/null)"
PSK="\$(printf '%s' "\${FLAGSHIP_WIFI_PSK_B64:-}" | base64 -d 2>/dev/null)"
[ -n "\$SSID" ] || { echo "[safety-net] no baked SSID; nothing to do"; exit 0; }
has_route() { ip route show default 2>/dev/null | grep -q .; }
# Grace: let the primary config bring up a route (~45s). If it does, do nothing.
for _ in \$(seq 1 15); do
  has_route && { echo "[safety-net] default route present — primary config OK"; exit 0; }
  sleep 3
done
echo "[safety-net] still offline after grace — bringing up baked Wi-Fi directly"
IF=""
for d in /sys/class/net/*/wireless; do
  [ -e "\$d" ] || continue
  IF="\$(basename "\$(dirname "\$d")")"
  break
done
if [ -z "\$IF" ]; then
  # A loaded wireless core with refcount 0 and no interface = its runtime-
  # requested op-mode module (e.g. iwlmvm) never loaded; a reload re-requests it.
  echo "[safety-net] no wireless interface — reloading idle wireless modules"
  for m in /sys/module/*; do
    m="\${m##*/}"
    modinfo -n "\$m" 2>/dev/null | grep -q /drivers/net/wireless/ || continue
    [ "\$(cat "/sys/module/\$m/refcnt" 2>/dev/null || echo 1)" = "0" ] || continue
    echo "[safety-net] reloading \$m"
    modprobe -r "\$m" 2>/dev/null || true
    modprobe "\$m" 2>/dev/null || true
  done
  sleep 5
  for d in /sys/class/net/*/wireless; do
    [ -e "\$d" ] || continue
    IF="\$(basename "\$(dirname "\$d")")"
    break
  done
fi
[ -n "\$IF" ] || { echo "[safety-net] no wireless interface; giving up"; exit 0; }
echo "[safety-net] interface=\$IF ssid=\$SSID"
CONF=/run/flagship-wifi-safetynet.conf
{
  echo "ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev"
  echo "country=00"
  echo "network={"
  printf '  ssid="%s"\\n' "\$SSID"
  printf '  psk="%s"\\n' "\$PSK"
  echo "  scan_ssid=1"
  echo "}"
} > "\$CONF"
chmod 600 "\$CONF"
ip link set "\$IF" up 2>/dev/null || true
# Replace any stale supplicant on this iface with ours (idempotent).
pkill -f "wpa_supplicant.*-i *\$IF" 2>/dev/null || true
sleep 1
wpa_supplicant -B -i "\$IF" -c "\$CONF" -Dnl80211,wext 2>/dev/null \\
  || wpa_supplicant -B -i "\$IF" -c "\$CONF" 2>/dev/null || true
# DHCP: prefer systemd-networkd (present on both distros); leave any existing
# flagship .network/netplan in place, only add one if neither primary wrote it.
mkdir -p /etc/systemd/network
if [ ! -e /etc/systemd/network/10-flagship-wifi.network ] && [ ! -e /etc/netplan/99-flagship-wifi.yaml ]; then
  printf '[Match]\\nName=%s\\n[Network]\\nDHCP=yes\\n' "\$IF" > /etc/systemd/network/10-flagship-wifi.network
fi
systemctl restart systemd-networkd 2>/dev/null || true
# Retry up to ~60s; fall back to explicit DHCP clients if networkd isn't running.
for _ in \$(seq 1 20); do
  has_route && { echo "[safety-net] default route up"; exit 0; }
  for c in "dhclient -1 \$IF" "dhcpcd -t 20 \$IF" "udhcpc -i \$IF -n -q"; do
    command -v "\${c%% *}" >/dev/null 2>&1 && \$c >/dev/null 2>&1 && break
  done
  sleep 3
done
echo "[safety-net] finished (route up: \$(has_route && echo yes || echo no))"
SAFETYNET
chmod +x /usr/local/sbin/flagship-wifi-safetynet.sh

cat > /etc/systemd/system/flagship-wifi-safetynet.service <<'WIFIUNIT'
[Unit]
Description=Flagship Wi-Fi safety-net (bring up the baked SSID if the box is offline)
# Deliberately NO network ordering at all: network-online.target waits for
# online (defeating the point), and on a Wi-Fi-only box even network.target can
# be delayed by a wedged network manager — the chicken-and-egg this unit exists
# to break. The script does its own offline detection + ~45s grace wait, by
# which time udev has long settled the radio device.
Before=flagship-first-boot-register.service flagship-daemon.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/flagship-wifi-safetynet.sh

[Install]
WantedBy=multi-user.target
WIFIUNIT
systemctl enable flagship-wifi-safetynet.service 2>/dev/null || \\
    echo "[flagship-bootstrap] WARNING: could not enable flagship-wifi-safetynet.service"
echo "[flagship-bootstrap] Wi-Fi safety-net installed + enabled"
`;
}

/** Escape a string for a single-quoted POSIX-shell scalar (`'...'`). */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * INITRAMFS Wi-Fi support for the phone-gated LUKS unlock. The unlock premount
 * (local-top/flagship-unlock) curls the boot relay assuming the network is
 * ALREADY up — true on Ethernet (the initramfs auto-configures wired DHCP) but
 * NOT on Wi-Fi, where the early-boot environment brings up no radio. Without
 * this a headless Wi-Fi-only box installs + bootstraps fine, then HANGS at the
 * LUKS unlock on every reboot. This adds, into the encrypted bootstrap:
 *
 *   (a) /etc/initramfs-tools/hooks/flagship-wifi — at initramfs-BUILD time
 *       detects the box's actual wl* driver (the bootstrap runs in-target on the
 *       real hardware, so the driver is present + loaded), pulls it + its
 *       cfg80211/mac80211 deps + the driver-declared firmware + the regulatory
 *       db + wpa_supplicant into the initramfs.
 *   (b) /etc/initramfs-tools/scripts/init-premount/flagship-wifi — at BOOT time,
 *       BEFORE local-top (where the unlock hook lives), re-detects the wl*
 *       interface, modprobes the driver, runs wpa_supplicant against the baked
 *       SSID/PSK, then DHCPs (klibc ipconfig, busybox udhcpc fallback). Fully
 *       best-effort + wall-clock bounded so it can NEVER hang the boot — if Wi-Fi
 *       doesn't come up it falls through (Ethernet/lease path / recovery
 *       passphrase still apply). init-premount runs strictly before local-top,
 *       so the radio is up before the unlock relay curls.
 *
 * Only emitted when Wi-Fi creds are present AND encryptRoot is on; absent ⇒ "",
 * so a wired encrypted burn is byte-identical to before. The SSID/PSK are
 * embedded single-quote-escaped (the initramfs is a /bin/sh env with no base64
 * guaranteed); they live on the unencrypted /boot initramfs regardless, so this
 * is not a new secret exposure. Byte-identical to the Swift port
 * (UserData.initramfsWifiBlock) — exported so the cross-language sha256 pin can
 * assert the two stay in lockstep.
 */
export function buildInitramfsWifiBlock(ssid: string, password: string): string {
  if (ssid.trim().length === 0) return "";
  const ssidQ = shSingleQuote(ssid);
  const pskQ = shSingleQuote(password);
  return `
# ── INITRAMFS Wi-Fi (phone-gated unlock needs network in early boot) ────────
# The unlock premount curls the boot relay; on Wi-Fi the initramfs has NO net
# unless we bake the radio in. Hook = build-time driver/firmware staging;
# init-premount = boot-time bring-up, strictly BEFORE local-top/flagship-unlock.
# Only present on the Wi-Fi path; never blocks boot (Ethernet/recovery still apply).
apt-get install -y --no-install-recommends wpasupplicant || true

# OBSERVABILITY: bake the order serial to /boot so the boot-time premount can
# beacon its accumulated bring-up log home (see the post-DHCP wget below). The
# serial is the same one the bootstrap's other beacons use (\$AUTH_CODE_SERIAL,
# in scope here); the premount reads the initrd copy the hook stages. Best-effort.
echo "$AUTH_CODE_SERIAL" > /boot/flagship-beacon-serial 2>/dev/null || true

cat > /etc/initramfs-tools/hooks/flagship-wifi <<'WIFIHOOK'
#!/bin/sh
# Build-time: stage the box's actual wl* driver + firmware + the premount's
# tools (wpa_supplicant, wpa_cli, ip, wget) into the initramfs. Detection runs
# HERE (build time, in-target on real hardware) so it reflects this box's radio.
# Every stage is validated AND logged to /boot/flagship-wifi-build.log (best-
# effort) so an initrd missing the radio is diagnosable on-box; every stage is
# guarded so a hiccup never aborts update-initramfs. If the driver can't be
# resolved, fall back to staging the whole wireless module class (bounded:
# modules only — per-driver firmware can't be enumerated unprobed).
PREREQ=""
prereqs() { echo "$PREREQ"; }
case "$1" in prereqs) prereqs; exit 0;; esac
. /usr/share/initramfs-tools/hook-functions
BLOG=/boot/flagship-wifi-build.log
blog() { echo "flagship-wifi-hook: $*" >> "$BLOG" 2>/dev/null || true; }
blog "hook start ($(date 2>/dev/null || echo -))"
stage_fw() {
  for _v in "" .xz .zst; do
    if [ -f "/lib/firmware/$1$_v" ]; then
      mkdir -p "$DESTDIR/lib/firmware/$(dirname "$1")" 2>/dev/null || true
      if cp -a "/lib/firmware/$1$_v" "$DESTDIR/lib/firmware/$1$_v" 2>/dev/null; then
        blog "firmware staged: $1$_v"
      else
        blog "firmware COPY FAILED: $1$_v"
      fi
      return 0
    fi
  done
  blog "firmware MISSING: $1 (no plain/.xz/.zst variant in /lib/firmware)"
}
WLIF=$(ls /sys/class/net 2>/dev/null | grep -E '^wl' | head -1)
DRV=""
if [ -n "$WLIF" ]; then
  blog "interface detected: $WLIF"
  DRV=$(basename "$(readlink -f "/sys/class/net/$WLIF/device/driver" 2>/dev/null)" 2>/dev/null)
else
  blog "NO wl* interface visible at build time"
fi
if [ -n "$DRV" ]; then
  blog "driver resolved: $DRV"
  if manual_add_modules "$DRV" 2>/dev/null; then blog "module staged: $DRV"; else blog "module STAGING FAILED: $DRV"; fi
  for _m in "$DRV" $(modprobe --show-depends "$DRV" 2>/dev/null | sed -n 's|^insmod .*/||p' | sed 's|\\.ko.*||'); do
    for fw in $(modinfo -F firmware "$_m" 2>/dev/null); do stage_fw "$fw"; done
  done
else
  blog "driver UNRESOLVED — falling back to the whole wireless module class"
  if copy_modules_dir kernel/drivers/net/wireless 2>/dev/null; then blog "fallback staged: kernel/drivers/net/wireless"; else blog "fallback STAGING FAILED: kernel/drivers/net/wireless"; fi
fi
manual_add_modules cfg80211 2>/dev/null || blog "module STAGING FAILED: cfg80211"
manual_add_modules mac80211 2>/dev/null || blog "module STAGING FAILED: mac80211"
# Op-mode modules (iwlmvm/iwlmld/iwldvm/...) are REVERSE deps of the core
# driver — request_module'd at runtime, invisible to manual_add_modules —
# without them the core loads firmware but never creates an interface. Stage
# the driver's whole module directory subtree so every op-mode + its deps land.
d=$(modinfo -n "$DRV" 2>/dev/null)
case "$d" in
  */kernel/*)
    sub="kernel/\${d#*/kernel/}"
    sub=$(dirname "$sub")
    if copy_modules_dir "$sub" 2>/dev/null; then blog "module dir staged: $sub"; else blog "module dir STAGING FAILED: $sub"; fi
    ;;
esac
mkdir -p "$DESTDIR/lib/firmware" 2>/dev/null || true
for r in regulatory.db regulatory.db.p7s; do
  if [ -f "/lib/firmware/$r" ] && cp -a "/lib/firmware/$r" "$DESTDIR/lib/firmware/" 2>/dev/null; then
    blog "staged: $r"
  else
    blog "MISSING: $r"
  fi
done
if copy_exec /sbin/wpa_supplicant /sbin/wpa_supplicant 2>/dev/null || copy_exec /usr/sbin/wpa_supplicant /sbin/wpa_supplicant 2>/dev/null; then
  blog "staged: wpa_supplicant"
else
  blog "MISSING: wpa_supplicant"
fi
if copy_exec /sbin/wpa_cli /sbin/wpa_cli 2>/dev/null || copy_exec /usr/sbin/wpa_cli /sbin/wpa_cli 2>/dev/null; then
  blog "staged: wpa_cli"
else
  blog "MISSING: wpa_cli"
fi
if copy_exec /sbin/ip /sbin/ip 2>/dev/null || copy_exec /bin/ip /sbin/ip 2>/dev/null; then
  blog "staged: ip"
else
  blog "MISSING: ip"
fi
# OBSERVABILITY: stage the serial (for the post-DHCP beacon) + the busybox wget
# the beacon uses, so the boot-time premount can phone its log home.
mkdir -p "$DESTDIR/boot" 2>/dev/null || true
if cp /boot/flagship-beacon-serial "$DESTDIR/boot/flagship-beacon-serial" 2>/dev/null; then
  blog "staged: beacon serial"
else
  blog "MISSING: /boot/flagship-beacon-serial"
fi
if copy_exec /bin/wget /bin/wget 2>/dev/null || copy_exec /usr/bin/wget /bin/wget 2>/dev/null; then
  blog "staged: wget"
else
  blog "MISSING: wget"
fi
blog "hook done"
exit 0
WIFIHOOK
chmod +x /etc/initramfs-tools/hooks/flagship-wifi

mkdir -p /etc/initramfs-tools/scripts/init-premount
cat > /etc/initramfs-tools/scripts/init-premount/flagship-wifi <<WIFIPREMOUNT
#!/bin/sh
# Boot-time: bring the baked Wi-Fi up BEFORE local-top/flagship-unlock curls the
# relay. Fully best-effort + wall-clock bounded — it can NEVER hang the boot. If
# the radio doesn't come up it falls through (Ethernet / box-lease still
# unlock the box). Creds embedded single-
# quote-escaped (they're on the unencrypted /boot initramfs regardless).
#
# OBSERVABILITY (no logic change): every stage tees a timestamped line to BOTH a
# /run accumulator AND a PERSISTENT log on the unencrypted /boot partition
# (/dev/disk/by-label/FLAGSHIP_BOOT → /flagship-wifi.log) so a box that hangs at
# the LUKS prompt is diagnosable after a recovery-passphrase hand-unlock (the
# no-network case). After DHCP we also best-effort POST the accumulator home (the
# network-up-but-unlock-still-failed case). Both are \\\`|| true\\\`, never block boot.
PREREQ=""
prereqs() { echo "\\\$PREREQ"; }
case "\\\$1" in prereqs) prereqs; exit 0;; esac

WIFI_SSID=${ssidQ}
WIFI_PSK=${pskQ}

# OBSERVABILITY: persistent bring-up log on the unencrypted /boot partition.
# /boot here is the initrd ramdisk (lost on pivot), so mount the REAL boot fs
# (label FLAGSHIP_BOOT) read-write once. Every \\\`log_stage\\\` line is timestamped
# (uptime seconds + wall-clock when available) and tee'd to the persistent log
# AND a /run accumulator the post-DHCP beacon posts. Fully best-effort.
FLAGSHIP_WIFI_LOG=/run/flagship-wifi.log
FLAGSHIP_BOOTMNT=/run/flagship-bootmnt
: > "\\\$FLAGSHIP_WIFI_LOG" 2>/dev/null || true
mkdir -p "\\\$FLAGSHIP_BOOTMNT" 2>/dev/null || true
log_stage() {
  _ts="\\\$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)"
  _wall="\\\$(date '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo -)"
  _line="flagship-wifi [up=\\\${_ts}s \\\${_wall}] \\\$*"
  echo "\\\$_line" >&2 || true
  echo "\\\$_line" >> "\\\$FLAGSHIP_WIFI_LOG" 2>/dev/null || true
  echo "\\\$_line" >> "\\\$FLAGSHIP_BOOTMNT/flagship-wifi.log" 2>/dev/null || true
}
log_stage "premount start (ssid baked)"

# The boot fs is found by label; at init-premount udev may not have settled the
# by-label symlink yet, so wait for it (bounded ~10s) before mounting. Lines
# logged before the mount accumulate in /run; the cat seeds them into the
# persistent log once mounted, so the first line is never lost — an EMPTY
# persistent log can only mean the premount never ran.
_bdeadline=\\\$(( \\\$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) + 10 ))
while [ ! -e /dev/disk/by-label/FLAGSHIP_BOOT ]; do
  [ "\\\$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999)" -ge "\\\$_bdeadline" ] && break
  sleep 1
done
if mount /dev/disk/by-label/FLAGSHIP_BOOT "\\\$FLAGSHIP_BOOTMNT" 2>/dev/null; then
  cat "\\\$FLAGSHIP_WIFI_LOG" >> "\\\$FLAGSHIP_BOOTMNT/flagship-wifi.log" 2>/dev/null || true
  log_stage "boot fs mounted (persistent log live)"
else
  log_stage "boot fs mount FAILED — log stays in /run (survives pivot)"
fi

# Re-detect the wl* interface at boot (the name can differ from build time).
IF=""
_deadline=\\\$(( \\\$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) + 30 ))
while [ -z "\\\$IF" ]; do
  IF=\\\$(ls /sys/class/net 2>/dev/null | grep -E '^wl' | head -1)
  [ -n "\\\$IF" ] && break
  [ "\\\$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999)" -ge "\\\$_deadline" ] && break
  sleep 1
done
[ -n "\\\$IF" ] || { log_stage "no wl* interface in 30s — falling through"; exit 0; }
log_stage "wl interface detected: \\\$IF"

# Load the driver (the hook staged it) and bring the link up.
DRV=\\\$(basename "\\\$(readlink -f /sys/class/net/\\\$IF/device/driver 2>/dev/null)" 2>/dev/null)
log_stage "driver resolved: \\\${DRV:-none}"
[ -n "\\\$DRV" ] && modprobe "\\\$DRV" 2>/dev/null || true
log_stage "modprobe done (driver=\\\${DRV:-none})"
# iwlwifi's op-mode (iwlmvm/iwlmld/iwldvm) is request_module'd at runtime; a
# miss leaves the core loaded with firmware but no interface. Belt-and-braces.
if [ "\\\$DRV" = iwlwifi ]; then
  for m in iwlmvm iwlmld iwldvm; do
    modprobe "\\\$m" 2>/dev/null && log_stage "op-mode loaded: \\\$m" && break
  done
fi
ip link set "\\\$IF" up 2>/dev/null || true
log_stage "link up requested on \\\$IF (oper=\\\$(cat /sys/class/net/\\\$IF/operstate 2>/dev/null || echo unknown))"

# Associate with the baked SSID.
printf 'ctrl_interface=/run/wpa_supplicant\\nnetwork={\\n  ssid="%s"\\n  psk="%s"\\n  scan_ssid=1\\n}\\n' \\\\
  "\\\$WIFI_SSID" "\\\$WIFI_PSK" > /run/flagship-wpa.conf 2>/dev/null || true
wpa_supplicant -B -i "\\\$IF" -D nl80211,wext -c /run/flagship-wpa.conf 2>/dev/null || true
log_stage "wpa_supplicant started on \\\$IF"
# Bounded ~10s wait to observe the association result (does not change the flow —
# wpa runs in the background either way; this only records wpa_cli status if any).
_a=0
while [ "\\\$_a" -lt 5 ]; do
  _wstate="\\\$(wpa_cli -i "\\\$IF" status 2>/dev/null | sed -n 's/^wpa_state=//p' | head -1)"
  [ "\\\$_wstate" = "COMPLETED" ] && break
  _a=\\\$(( _a + 1 ))
  sleep 2
done
log_stage "association result: wpa_state=\\\${_wstate:-unknown}"

# DHCP, bounded ~20s: prefer klibc ipconfig, fall back to busybox udhcpc.
if command -v ipconfig >/dev/null 2>&1; then
  log_stage "DHCP method: ipconfig"
  ipconfig -t 20 "\\\$IF" 2>/dev/null || true
else
  log_stage "DHCP method: udhcpc"
  _n=0
  while [ "\\\$_n" -lt 4 ]; do
    udhcpc -i "\\\$IF" -n -q -t 5 2>/dev/null && break
    _n=\\\$(( _n + 1 ))
  done
fi
_ip="\\\$(ip -4 -o addr show dev "\\\$IF" 2>/dev/null | awk '{print \\\$4}' | head -1)"
if [ -n "\\\$_ip" ]; then
  log_stage "DHCP result: assigned \\\$_ip on \\\$IF (route=\\\$(ip route show default 2>/dev/null | head -1))"
else
  log_stage "DHCP result: FAILED — no IPv4 address on \\\$IF"
fi
# klibc ipconfig records DNS in /run/net-<if>.conf but NOTHING writes
# /etc/resolv.conf in the initramfs — the unlock curls would die on name
# resolution even with the route up.
if [ -n "\\\$_ip" ]; then
  IPV4DNS0=""
  IPV4DNS1=""
  [ -f "/run/net-\\\$IF.conf" ] && . "/run/net-\\\$IF.conf" 2>/dev/null
  _dns=""
  for _d in "\\\$IPV4DNS0" "\\\$IPV4DNS1"; do
    [ -n "\\\$_d" ] && [ "\\\$_d" != "0.0.0.0" ] && _dns="\\\$_dns \\\$_d"
  done
  : > /etc/resolv.conf 2>/dev/null || true
  for _d in \\\$_dns; do
    echo "nameserver \\\$_d" >> /etc/resolv.conf 2>/dev/null || true
  done
  if [ -s /etc/resolv.conf ]; then
    log_stage "dns configured:\\\$_dns"
  else
    printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf 2>/dev/null || true
    log_stage "dns fallback: public resolvers"
  fi
fi
log_stage "bring-up attempt complete on \\\$IF"

umount "\\\$FLAGSHIP_BOOTMNT" 2>/dev/null || true
exit 0
WIFIPREMOUNT
chmod +x /etc/initramfs-tools/scripts/init-premount/flagship-wifi
echo "[flagship-bootstrap] initramfs Wi-Fi hook + premount installed (runs before the unlock relay)"
`;
}

/**
 * EXPERIMENTAL encrypted-root bootstrap (encryptRoot=true) — needs live
 * validation (brick risk). It is the plain bootstrap with three LUKS additions
 * spliced in just before the final `installed.flag`:
 *
 *   A. RE-KEY: generate a fresh `head -c 64 /dev/urandom` LUKS key (install.sh's
 *      pattern), add it as a new key slot, remove the install-time key.
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
  // Splice the LUKS block in just before the plain script's final lines (the
  // error-trap disarm + installed.flag + "done"), so the shared body is reused
  // verbatim AND the EXIT error-trap still covers the destructive LUKS re-key
  // (the disarm runs only after the LUKS block completes cleanly).
  const tail = `# Reached the end cleanly — disarm the error trap so the EXIT handler doesn't
# misfire a terminal error phase on a 0 exit. On the encrypted path the LUKS
# block is spliced in just ABOVE this line, so the trap still covers the re-key.
trap - EXIT
date > /var/flagship/installed.flag
echo "[flagship-bootstrap] done"
`;
  const luks = buildLuksBootstrapBlock(
    args.bootUnlockMode,
    args.bootHost,
    args.wifiSSID ?? "",
    args.wifiPassword ?? "",
  );
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
function buildLuksBootstrapBlock(
  mode: BootUnlockMode,
  bootHost: string,
  wifiSSID: string = "",
  wifiPassword: string = "",
): string {
  // INITRAMFS Wi-Fi: only on the Wi-Fi path (creds present). Emitted just before
  // update-initramfs so the hook + premount land in the rebuilt initrd. Empty on
  // a wired encrypted burn ⇒ the LUKS block is byte-identical to before.
  const initramfsWifi = buildInitramfsWifiBlock(wifiSSID, wifiPassword);
  // Debian's partman-crypto preseed only reliably supports LVM-on-LUKS, so the
  // initramfs must stage `lvm` and, after luksOpen, activate the VG before the
  // LV (FLAGSHIP_ROOT) appears.
  const lvmCopyExec = `copy_exec /sbin/cryptsetup /sbin/cryptsetup 2>/dev/null || copy_exec /usr/sbin/cryptsetup /sbin/cryptsetup
copy_exec /sbin/lvm /sbin/lvm 2>/dev/null || copy_exec /usr/sbin/lvm /sbin/lvm`;
  // Terminal unlock step: open the raw LUKS container discovered by type (the
  // LV's FLAGSHIP_ROOT label is INSIDE the container, invisible pre-open), then
  // `vgchange -ay` surfaces /dev/disk/by-label/FLAGSHIP_ROOT for the normal
  // mount that follows.
  const terminalUnlock = `ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
# Open under the CRYPTTAB target name (the installer named it e.g. sda4_crypt).
# Debian's local-top/cryptroot runs after us (its prereqs() lists every other
# local-top script) and skips an already-active target — but only under ITS
# name. Opening as flagship_root left cryptroot prompting for a passphrase
# against an in-use device: boot hung forever (proven on metal 2026-06-12).
CRYPT_NAME="$(sed -n 's/^[[:space:]]*\\([^#][^[:space:]]*\\)[[:space:]].*/\\1/p' /cryptroot/crypttab 2>/dev/null | head -n1)"
[ -n "$CRYPT_NAME" ] || CRYPT_NAME=flagship_root
xxd -r -p "$OUT_UNLOCK" | cryptsetup luksOpen --key-file - "$ROOT_LUKS_PART" "$CRYPT_NAME"
lvm vgchange -ay 2>/dev/null || vgchange -ay 2>/dev/null || true
shred -u "$OUT_UNLOCK" 2>/dev/null || rm -f "$OUT_UNLOCK"`;
  return `
# ── EXPERIMENTAL: LUKS-on-root, phone-gated unlock (encryptRoot) ─────────
# Needs live validation; brick risk. This whole block is absent on the
# default unencrypted path. docs/security-phone-as-unlock-endpoint.md.
echo "[flagship-bootstrap] encryptRoot ON — configuring phone-gated LUKS unlock"

# Fail-closed: the re-key below is DESTRUCTIVE (it removes the install-time key
# and shreds the only plaintext key). Refuse unless the recipe actually parsed —
# empty values once sealed a disk to nothing and bricked a box (jq was missing).
if [ -z "$SERVER_DOMAIN" ] || [ "$SERVER_DOMAIN" = "null" ] || [ -z "$PHONE_DELEGATED_PUBKEY" ] || [ "$PHONE_DELEGATED_PUBKEY" = "null" ]; then
    echo "[flagship-bootstrap] FATAL: empty SERVER_DOMAIN/PHONE_DELEGATED_PUBKEY — refusing LUKS re-key (would brick the box)"
    exit 1
fi

# REGISTER FIRST. The sealed-key upload (step B) requires the server to ALREADY be
# registered with .com — luksKeys.ts returns 404 "unknown server" otherwise (it
# verifies the upload against the registered server identity). The auth-code is
# single-use, so we write registered.flag and the deferred first-boot register
# service (guarded by !registered.flag) skips. Network is up here (apt + git +
# npm already used it). Fail-closed: a failure aborts BEFORE the destructive
# re-key, so the install-time key still opens the disk (recoverable).
# NOTE (design): docs/security-phone-as-unlock-endpoint.md describes first-boot
# registration, but the seal/upload runs in-target — so registration must run
# in-target too, before it. Keeping register+seal together is the invariant.
report_phase registering
echo "[flagship-bootstrap] registering server with .com (prereq for sealed-key upload)"
flagship-tsx scripts/install-helper.ts sign-server-register \\
    --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \\
    --auth-code-blob /var/flagship/install-blob.json \\
    > /run/register-payload.json
if ! curl -fsS -X POST -H 'content-type: application/json' \\
    --data @/run/register-payload.json "$REGISTRATION_URL"; then
    echo "[flagship-bootstrap] FATAL: registration failed — keeping the install-time key (recoverable), aborting"
    exit 1
fi
date > /var/flagship/registered.flag
echo "[flagship-bootstrap] registered with .com"

# A. ADD a fresh random key (install.sh's head -c 64 /dev/urandom pattern),
#    authorized by the install-time key. NON-destructive: that key still opens the
#    disk until step C, so any failure below stays recoverable. It is NOT a
#    constant: the installer generated it for this install alone and copied it
#    to a file on the target (a VM appliance uses its factory key file instead).
if [ "\${FLAGSHIP_APPLIANCE_PREINSTALLED:-0}" = "1" ]; then
    LUKS_BURN_KEYFILE=${APPLIANCE_BUILD_KEYFILE}
else
    LUKS_BURN_KEYFILE=${LUKS_BURN_KEYFILE}
fi
if [ ! -s "$LUKS_BURN_KEYFILE" ]; then
    echo "[flagship-bootstrap] FATAL: no install-time LUKS key file at $LUKS_BURN_KEYFILE — cannot re-key"
    exit 1
fi
LUKS_KEY=/run/flagship-luks.key
head -c 64 /dev/urandom > "$LUKS_KEY"
chmod 600 "$LUKS_KEY"
# The encrypted root partition (partman labelled the filesystem FLAGSHIP_ROOT;
# the underlying LUKS container is its parent block device).
ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
if [ -z "$ROOT_LUKS_PART" ]; then
    echo "[flagship-bootstrap] FATAL: no crypto_LUKS partition found; cannot re-key"
    exit 1
fi
echo "[flagship-bootstrap] adding random LUKS key on $ROOT_LUKS_PART"
cryptsetup luksAddKey "$ROOT_LUKS_PART" "$LUKS_KEY" --key-file "$LUKS_BURN_KEYFILE"

# B. SEAL the random key for the phone + upload to .com — BEFORE removing the
#    install-time key, so a seal/upload failure leaves the box still openable
#    (recoverable) instead of bricked. .com stores ciphertext only.
#
#    Seal to the account IRK (the blob's authCode.userPubKey) — a key the phone
#    can re-derive at unlock time (Keystore.deriveIRK) AND that survives cloud
#    recovery. NOT phoneDelegatedPubKey: the phone generates that per-server
#    keypair at create-time and DISCARDS the private half, so a disk key sealed
#    to it could NEVER be unsealed by any phone (the bug that made phone-approval
#    unlock fail with "couldn't unseal the disk key with this phone's keys").
report_phase sealing
USER_PUB_HEX="$(jq -r .authCode.userPubKey "$BLOB_JSON")"
SEALED_LUKS_KEY_HEX="$(flagship-tsx scripts/install-helper.ts seal-for-bak \\
    --bak-ed25519-pub "$USER_PUB_HEX" \\
    --in "$LUKS_KEY" | tr -d '\\n')"
if [ -z "$SEALED_LUKS_KEY_HEX" ]; then
    echo "[flagship-bootstrap] FATAL: seal-for-bak produced nothing — keeping the install-time key + plaintext key (recoverable), aborting"
    exit 1
fi
NOW_MS=$(date +%s%3N)
flagship-tsx scripts/install-helper.ts sign-sealed-key \\
    --priv "$SERVER_IDENTITY_PRIV_HEX" \\
    --server-id "$SERVER_DOMAIN" \\
    --sealed-hex "$SEALED_LUKS_KEY_HEX" \\
    --issued-at "$NOW_MS" \\
    > /run/sealed-key-payload.json
CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
if ! curl -fsS -X POST -H 'content-type: application/json' \\
    --data @/run/sealed-key-payload.json \\
    "\${CONTROL_PLANE_BASE}/api/server/\${SERVER_DOMAIN}/sealed-luks-key"; then
    echo "[flagship-bootstrap] FATAL: sealed-key upload failed — keeping the install-time key (recoverable), aborting"
    exit 1
fi

${buildLuksBurnSlotRemovalBlock()}

# /boot facts the initramfs unlock hook reads on every boot (mirrors the
# files boot-stage.sh expects: server-domain, identity.pem, boot host).
echo "$SERVER_DOMAIN" > /boot/server-domain
echo "$CONTROL_PLANE_BASE" > /boot/control-plane-url
# The dedicated boot worker the unlock hook talks to (lease GET / approval
# request POST / response poll). Baked so an enterprise clone can override it
# without touching code — mirrors /boot/flagship-boot-unlock-mode. Default is
# boot.flagshipserver.com.
echo "${bootHost}" > /boot/flagship-boot-host
# The identity PKCS8 PEM is already at /boot/identity.pem (gen-identity --out-pem).

# Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1). Baked
# from the phone-signed InstallBlob.bootUnlockMode (absent ⇒ "auto"). The
# initramfs premount script reads this on every boot (defaults to "auto" if the
# file is absent) and branches: "auto" self-unlocks via a box-sealed lease then
# falls back to the phone-gated relay; "approve" uses the relay EVERY boot and
# never touches a lease. The box NEVER deposits a lease itself.
echo "${mode}" > /boot/flagship-boot-unlock-mode

# C1. BAKE the unseal helper to /boot/flagship-unseal. Build-at-install from
#     the signed release artifact, which carries the static helper built in CI.
echo "[flagship-bootstrap] installing flagship-unseal from the signed release"
if [ "\${FLAGSHIP_APPLIANCE_PREINSTALLED:-0}" = "1" ] && [ -x /usr/local/lib/flagship-appliance/flagship-unseal ]; then
    install -m 755 /usr/local/lib/flagship-appliance/flagship-unseal /boot/flagship-unseal
else
    [ -x /opt/flagship/installer/flagship-unseal ] || { echo "[flagship-bootstrap] FATAL: the release has no unseal helper"; exit 1; }
    install -m 755 /opt/flagship/installer/flagship-unseal /boot/flagship-unseal
fi
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
# ip powers the premount's net-ensure (route check / link up / carrier read);
# a wired initrd does not stage it otherwise.
copy_exec /sbin/ip /sbin/ip 2>/dev/null || copy_exec /bin/ip /sbin/ip
# Network DRIVER modules for the pre-mount unlock. The installed system's initrd
# is built with MODULES=most|dep and does NOT guarantee the virtio NIC drivers,
# yet a virtio-backed guest (Apple Virtualization / QEMU-KVM) needs virtio_net
# (over PCI or MMIO transport) to have ANY interface at premount. Without it,
# net-ensure below sees only lo, gets no carrier, no DHCP, no route — so the
# unlock-key request never leaves the box and the disk stays sealed FOREVER
# (registered-at-install, then silent — the exact fingerprint of a stuck VM
# guest). The d-i INSTALLER kernel has these built in, which is why install-time
# registration succeeds even when the installed initrd lacks them. Stage them
# explicitly; harmless on metal (real NIC drivers still load from MODULES=most).
# modinfo pulls each module's deps; missing-on-this-arch is a no-op under || true.
for _netmod in virtio_net virtio_pci virtio_mmio e1000 e1000e; do
  manual_add_modules "$_netmod" 2>/dev/null || true
done
# Resolver plumbing for the glibc-linked curl: copy_exec's ldd walk never
# sees the dlopen'd NSS modules, and the initrd ships no nsswitch.conf —
# proven on metal: route + /etc/resolv.conf up yet curl(6) could-not-resolve.
# On glibc >= 2.34 dns/files are built into libc and the .so files are
# absent; the guards make that a no-op.
mkdir -p "\${DESTDIR}/etc"
echo "hosts: files dns" > "\${DESTDIR}/etc/nsswitch.conf"
for _nss in /lib/*-linux-gnu*/libnss_dns.so.2 /lib/*-linux-gnu*/libnss_files.so.2 /lib/*-linux-gnu*/libresolv.so.2; do
  [ -e "$_nss" ] && copy_exec "$_nss" || true
done
# CA bundle for the HTTPS unlock curls — copy_exec stages the curl binary but
# never the trust store data file; proven on metal once DNS resolved (curl(77)
# error setting certificate file /etc/ssl/certs/ca-certificates.crt).
mkdir -p "\${DESTDIR}/etc/ssl/certs"
cp /etc/ssl/certs/ca-certificates.crt "\${DESTDIR}/etc/ssl/certs/ca-certificates.crt" 2>/dev/null || true
${lvmCopyExec}
# Identity + boot facts the premount script signs/reads with.
mkdir -p "\${DESTDIR}/boot"
cp /boot/identity.pem "\${DESTDIR}/boot/identity.pem"
cp /boot/server-domain "\${DESTDIR}/boot/server-domain"
cp /boot/control-plane-url "\${DESTDIR}/boot/control-plane-url" 2>/dev/null || true
cp /boot/flagship-boot-host "\${DESTDIR}/boot/flagship-boot-host" 2>/dev/null || true
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
# The dedicated boot worker (boot.flagshipserver.com), baked by the bootstrap.
# Configurable so an enterprise clone can repoint it without touching code.
BOOT_HOST="$(cat /boot/flagship-boot-host 2>/dev/null || echo https://boot.flagshipserver.com)"
BOOT_HOST="\${BOOT_HOST%/}"
IDENTITY_KEY=/boot/identity.pem
UNSEAL_HELPER=/bin/flagship-unseal
RELAY_WINDOW_SECS="\${FLAGSHIP_RELAY_WINDOW_SECS:-31536000}"
OUT_UNLOCK=/run/unlock-key
# Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
# Baked by the bootstrap; default "auto" if the file is absent.
BOOT_UNLOCK_MODE="$(cat /boot/flagship-boot-unlock-mode 2>/dev/null || echo auto)"

# One-shot lock marker (packages/server-daemon BootUnlockModeSuppressor). The
# daemon writes /boot/flagship-lock-once at RUNTIME (manual "Lock and restart"
# or a dead-man lapse), so it lives on the LIVE FLAGSHIP_BOOT partition, NOT in
# the frozen initrd copy the hook staged — mount that partition here to see it.
# Present ⇒ force the approve relay for THIS boot, consumed only after a
# successful luksOpen below so a failed unlock keeps it armed for the retry.
# This is the SAME decision point boot-stage.sh makes for the unencrypted path;
# on an encrypted box only THIS premount runs, so the marker is never
# double-consumed. Best-effort throughout — it can never fail or hang the boot.
LOCK_ONCE_MOUNT=/run/flagship-lockmnt
LOCK_ONCE_FILE="$LOCK_ONCE_MOUNT/flagship-lock-once"
LOCK_ONCE="no"
mkdir -p "$LOCK_ONCE_MOUNT" 2>/dev/null || true
if mount /dev/disk/by-label/FLAGSHIP_BOOT "$LOCK_ONCE_MOUNT" 2>/dev/null; then
    if [ -f "$LOCK_ONCE_FILE" ]; then LOCK_ONCE="yes"; fi
else
    LOCK_ONCE_MOUNT=""
fi

# Persistent unlock log on the (already-mounted) FLAGSHIP_BOOT partition, so a
# box stuck at the LUKS unlock is diagnosable after a recovery-passphrase
# hand-unlock. The WIRED path otherwise only echoes to a console the host may
# not capture (a VZ/KVM guest has none) — which is exactly why a stuck box was a
# black box. Truncated per boot (only the current boot matters); best-effort;
# the console echo always happens, and we sync after each line so it survives
# even if the box then hangs in the relay wait forever. Mirrors the Wi-Fi path's
# /boot/flagship-wifi.log, reusing the mount the lock-once check already took.
UNLOCK_LOG=""
if [ -n "$LOCK_ONCE_MOUNT" ]; then
    UNLOCK_LOG="$LOCK_ONCE_MOUNT/flagship-unlock.log"
    : > "$UNLOCK_LOG" 2>/dev/null || true
fi
log_line() {
    _ts="$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)"
    _msg="flagship [up=\${_ts}s] $*"
    echo "$_msg"
    if [ -n "$UNLOCK_LOG" ]; then
        echo "$_msg" >> "$UNLOCK_LOG" 2>/dev/null || true
        sync 2>/dev/null || true
    fi
}
log_line "premount start (domain=$SERVER_DOMAIN mode=$BOOT_UNLOCK_MODE lock-once=$LOCK_ONCE)"

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

# base64url-encode stdin (base64 then +→-, /→_, strip trailing '=') — the
# encoding apps/boot/src/gate.ts parses the Authorization payload as.
b64url() {
    openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# Epoch milliseconds, PORTABLE. The full OS has GNU date (\`%3N\` = millis), but
# the initramfs has busybox date, which prints \`%N\` LITERALLY — that injected a
# non-numeric issuedAt into the signed envelope + body JSON, so the boot worker
# rejected BOTH as malformed (proven on metal). Use %3N only when it yields pure
# digits; otherwise fall back to whole seconds × 1000.
now_ms() {
    _ms=$(date +%s%3N 2>/dev/null)
    case "$_ms" in
        ''|*[!0-9]*) _ms=$(( $(date +%s) * 1000 ));;
    esac
    echo "$_ms"
}

# Build the box-STK \`Authorization: Flagship-Boot-v1 <b64url(json)>\` header
# value. Bound to (method, path, serverDomain); Ed25519 over the canonical bytes
#   flagship/boot-auth/v1|box|<serverDomain>|<METHOD>|<path>|<pub>|<nonce>|<issuedAt>
# Kept in sync with installer/boot-stage.sh + apps/boot/src/gate.ts.
# Args: \$1 = HTTP method (uppercase), \$2 = request path (no query).
# Uses PUB_HEX (the box STK pub) from the calling scope.
sign_box_auth_header() {
    _bm="$1"
    _bp="$2"
    _bnonce=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\\n')
    _bnow=$(now_ms)
    _bcanon="flagship/boot-auth/v1|box|\${SERVER_DOMAIN}|\${_bm}|\${_bp}|\${PUB_HEX}|\${_bnonce}|\${_bnow}"
    _bsig="$(sign_canonical "$_bcanon")"
    _bjson="$(printf '{"role":"box","serverDomain":"%s","method":"%s","path":"%s","pubKeyHex":"%s","nonceHex":"%s","issuedAt":%s,"signatureHex":"%s"}' \\
        "$SERVER_DOMAIN" "$_bm" "$_bp" "$PUB_HEX" "$_bnonce" "$_bnow" "$_bsig")"
    printf 'Flagship-Boot-v1 %s' "$(printf '%s' "$_bjson" | b64url)"
}

# ── unlock_via_box_lease() — LIFTED VERBATIM from installer/boot-stage.sh ──
# Self-unlock on the "auto" path: GET the box-sealed lease from the boot worker
# and unseal it LOCALLY with the STK key on /boot. The worker holds ciphertext
# only (I1). No phone, no human. Returns 0 only if it actually unsealed; 404/empty
# (first boot, or a revoked lease) ⇒ non-zero so the caller falls back to the relay.
unlock_via_box_lease() {
    if [ ! -x "$UNSEAL_HELPER" ]; then
        echo "flagship: box-lease unavailable — $UNSEAL_HELPER missing/not executable"
        return 1
    fi
    SEED_HEX="$(identity_seed_hex)"
    PUB_HEX="$(identity_pub_hex)"
    if [ "\${#SEED_HEX}" != 64 ] || [ "\${#PUB_HEX}" != 64 ]; then
        echo "flagship: box-lease aborted — could not derive 32-byte seed/pub from $IDENTITY_KEY"
        return 1
    fi

    # GET /api/boot/lease/:serverDomain — box-STK gated.
    LEASE_PATH="/api/boot/lease/\${SERVER_DOMAIN}"
    LEASE_URL="\${BOOT_HOST}\${LEASE_PATH}"
    LEASE_AUTH="$(sign_box_auth_header GET "$LEASE_PATH")"
    LEASE_RESP=/run/flagship-lease-v2.json
    LEASE_CODE=$(curl -sS -o "$LEASE_RESP" -w "%{http_code}" \\
        -H "Authorization: $LEASE_AUTH" \\
        --max-time 30 "$LEASE_URL" || echo "000")
    if [ "$LEASE_CODE" = "404" ]; then
        echo "flagship: no box-sealed lease (HTTP 404) — falling back"
        return 1
    fi
    if [ "$LEASE_CODE" != "200" ]; then
        echo "flagship: box-lease HTTP $LEASE_CODE; body: $(head -c 200 "$LEASE_RESP" 2>/dev/null)"
        return 1
    fi

    # The boot worker returns {serverDomain,leaseId,stkPub,sealedKey,...};
    # sealedKey is the box-sealed LUKS key (hex). Extract it the same way
    # unlock_via_relay() extracts "sealed". The box unseals it locally.
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
    NOW_MS=$(now_ms)
    # The SecretRequest body keeps its OWN STK signature (unchanged).
    # NONCE/NOW_MS/CANONICAL/SIG/REQ_BODY are built ONCE here and reused for every
    # (re-)announce — a heartbeat re-POST replays the SAME signed envelope.
    CANONICAL="flagship/secret-request/v1|\${SERVER_DOMAIN}|\${PUB_HEX}|unlock-key|\${NONCE}|\${NOW_MS}"
    SIG="$(sign_canonical "$CANONICAL")"

    # POST /api/boot/request — box-STK gated. Body carries the box's STK-signed
    # SecretRequest (its own signature, separate from the box-auth header).
    REQ_PATH="/api/boot/request"
    REQ_URL="\${BOOT_HOST}\${REQ_PATH}"
    REQ_BODY=$(printf '{"request":{"serverDomain":"%s","stkPub":"%s","purpose":"unlock-key","nonce":"%s","issuedAt":%s},"signature":"%s"}' \\
        "$SERVER_DOMAIN" "$PUB_HEX" "$NONCE" "$NOW_MS" "$SIG")

    # post_request: (re-)announce the SAME signed REQ_BODY with a FRESH box-auth
    # header. Idempotent on the worker (same nonce) — the first call parks the
    # request + pushes the phone; later calls only refresh the parked row's TTL.
    post_request() {
        POST_RESP=/run/flagship-secret-request-resp.json
        REQ_AUTH="$(sign_box_auth_header POST "$REQ_PATH")"
        POST_CODE=$(curl -sS -o "$POST_RESP" -w "%{http_code}" \\
            -X POST -H 'content-type: application/json' \\
            -H "Authorization: $REQ_AUTH" \\
            --max-time 30 -d "$REQ_BODY" "$REQ_URL" || echo "000")
        [ "$POST_CODE" = "200" ]
    }

    # Initial announce. A failed FIRST announce is fatal (fall through to manual);
    # later heartbeat re-announce failures are non-fatal — we keep polling.
    if ! post_request; then
        echo "flagship: relay boot-request HTTP $POST_CODE; body: $(head -c 200 "$POST_RESP" 2>/dev/null)"
        return 1
    fi
    echo "flagship: posted unlock-key boot-request; waiting for phone approval (type 'manual' then Enter to unlock by passphrase)"

    # GET /api/boot/response/:serverDomain/:nonce — box-STK gated, polled. The
    # nonce is a PATH segment now (bound into the signed Authorization envelope),
    # so a fresh header is signed per poll.
    POLL_PATH="/api/boot/response/\${SERVER_DOMAIN}/\${NONCE}"
    POLL_URL="\${BOOT_HOST}\${POLL_PATH}"
    # Effectively wait forever for the phone (default ~1 year); the DEADLINE is a
    # backstop so an env override (FLAGSHIP_RELAY_WINDOW_SECS) can still bound it.
    DEADLINE=$(( $(date +%s) + RELAY_WINDOW_SECS ))
    # Re-announce the parked request every HEARTBEAT_SECS so a short worker TTL
    # stays alive while we wait; when the box powers off the TTL lapses and the
    # phone honestly sees "box stopped".
    HEARTBEAT_SECS="\${FLAGSHIP_RELAY_HEARTBEAT_SECS:-120}"
    LAST_ANNOUNCE=$(date +%s)
    ATTEMPT=0
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        ATTEMPT=$((ATTEMPT + 1))
        RESP=/run/flagship-secret-response.json
        POLL_AUTH="$(sign_box_auth_header GET "$POLL_PATH")"
        CODE=$(curl -sS -o "$RESP" -w "%{http_code}" \\
            -H "Authorization: $POLL_AUTH" \\
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
            # Transient non-200 — we wait forever now, so log and keep polling.
            echo "flagship: relay boot-response HTTP $CODE; body: $(head -c 200 "$RESP" 2>/dev/null)"
        fi

        # Heartbeat: re-announce the parked request to refresh its TTL. A failed
        # re-post is non-fatal — keep polling.
        if [ $(( $(date +%s) - LAST_ANNOUNCE )) -ge "$HEARTBEAT_SECS" ]; then
            if post_request; then
                echo "flagship: heartbeat re-announced boot-request (TTL refreshed)"
            else
                echo "flagship: heartbeat re-announce failed (HTTP $POST_CODE); continuing"
            fi
            LAST_ANNOUNCE=$(date +%s)
        fi

        BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 3 : 15))
        echo "flagship: no phone reply yet (attempt $ATTEMPT); waiting $BACKOFF (type 'manual' then Enter to unlock by passphrase)"
        # Interruptible wait: any line typed on the console (e.g. Enter) drops to
        # the manual disk passphrase prompt. On a headless box read -t blocks for
        # BACKOFF and times out (acts as the sleep) — so it waits forever.
        if read -t "$BACKOFF" -r _key < /dev/console 2>/dev/null && [ "$_key" = "manual" ]; then
            echo "flagship: manual unlock selected — falling through to the disk passphrase prompt"
            return 1
        fi
    done

    echo "flagship: relay backstop window (\${RELAY_WINDOW_SECS}s) elapsed with no phone reply"
    return 1
}

# ── net-ensure (the wired path) ─────────────────────────────────────────────
# The initramfs brings up NO network for this script by itself (no ip=dhcp
# kernel param, no configure_networking) — the relay curls below would fail on
# every wired LUKS box. Bring up each non-lo interface and DHCP the first one
# with carrier. On Wi-Fi the init-premount already routed: the route check
# skips this instantly. Fully best-effort + wall-clock bounded (~45s worst
# case) — it can never fail or hang the boot.
if ! ip route 2>/dev/null | grep -q '^default'; then
    echo "flagship: no default route — bringing up interfaces for DHCP"
    for IFW in /sys/class/net/*; do
        IFW="\${IFW##*/}"
        if [ "$IFW" = "lo" ]; then continue; fi
        ip link set "$IFW" up 2>/dev/null || true
    done
    sleep 3
    for IFW in /sys/class/net/*; do
        IFW="\${IFW##*/}"
        if [ "$IFW" = "lo" ]; then continue; fi
        if [ "$(cat "/sys/class/net/$IFW/carrier" 2>/dev/null || echo 0)" != "1" ]; then continue; fi
        echo "flagship: carrier on $IFW — requesting DHCP"
        if command -v ipconfig >/dev/null 2>&1; then
            ipconfig -t 20 "$IFW" 2>/dev/null || true
        else
            udhcpc -i "$IFW" -n -q -t 5 2>/dev/null || true
        fi
        if ip route 2>/dev/null | grep -q '^default'; then
            echo "flagship: default route up via $IFW"
        else
            echo "flagship: DHCP on $IFW finished without a default route"
        fi
        break
    done
fi

# ── resolv-ensure (BOTH paths) ──────────────────────────────────────────────
# klibc ipconfig records DNS in /run/net-<if>.conf but NOTHING writes
# /etc/resolv.conf in the initramfs — the relay curls fail with "could not
# resolve host" even with the route up. Source every recorded lease; fall back
# to public resolvers.
if [ ! -s /etc/resolv.conf ]; then
    _rdns=""
    for _nc in /run/net-*.conf; do
        if [ ! -f "$_nc" ]; then continue; fi
        IPV4DNS0=""
        IPV4DNS1=""
        . "$_nc" 2>/dev/null || true
        for _d in "$IPV4DNS0" "$IPV4DNS1"; do
            if [ -n "$_d" ] && [ "$_d" != "0.0.0.0" ]; then _rdns="$_rdns $_d"; fi
        done
    done
    : > /etc/resolv.conf 2>/dev/null || true
    for _d in $_rdns; do
        echo "nameserver $_d" >> /etc/resolv.conf 2>/dev/null || true
    done
    if [ -s /etc/resolv.conf ]; then
        echo "flagship: dns configured:$_rdns"
    else
        printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf 2>/dev/null || true
        echo "flagship: dns fallback: public resolvers"
    fi
fi

# ── Two-tier dispatch (docs/security-phone-as-unlock-endpoint.md §7a.1) ────
# The legacy plaintext-consume path is RETIRED — never a fallback here.
#   auto:    box-sealed lease (self-unlock); fall back to the phone relay.
#   approve: phone relay EVERY boot; the box NEVER reads a box-sealed lease.
# EFFECTIVE mode = baseline OR a one-shot lock. The marker forces the approve
# relay for THIS boot on top of the baseline.
EFFECTIVE_MODE="$BOOT_UNLOCK_MODE"
if [ "$LOCK_ONCE" = "yes" ]; then
    echo "flagship: one-shot lock marker present — forcing approve relay for THIS boot"
    EFFECTIVE_MODE="approve"
fi
echo "flagship: boot-unlock mode = $EFFECTIVE_MODE (baseline=$BOOT_UNLOCK_MODE, lock-once=$LOCK_ONCE)"
# Net-state summary — the single most useful diagnostic for a box that never
# unlocks: a virtio guest whose initrd lacks the NIC driver shows ifaces=[lo]
# route=none here and then hangs in the relay wait forever. Logged just before
# the (possibly-forever) dispatch so it is always on disk for a hand-unlock.
_ifaces="$(echo $(ls /sys/class/net 2>/dev/null))"
if ip route 2>/dev/null | grep -q '^default'; then _route=up; else _route=none; fi
log_line "net state before unlock: ifaces=[$_ifaces] route=$_route mode=$EFFECTIVE_MODE"
if [ "$EFFECTIVE_MODE" = "approve" ]; then
    unlock_via_relay
else
    if ! unlock_via_box_lease; then
        unlock_via_relay
    fi
fi
log_line "unlock succeeded — luksOpen done, proceeding to mount root"

${terminalUnlock}
# CONSUME the one-shot lock marker only now — AFTER a successful luksOpen (set -e
# aborts the premount before here if the unlock failed, so the lock stays armed
# for the retry). The next boot then reverts to the baseline BOOT_UNLOCK_MODE.
if [ "$LOCK_ONCE" = "yes" ]; then
    rm -f "$LOCK_ONCE_FILE"
    echo "flagship: consumed one-shot lock marker; next boot reverts to baseline ($BOOT_UNLOCK_MODE)"
fi
[ -n "$LOCK_ONCE_MOUNT" ] && umount "$LOCK_ONCE_MOUNT" 2>/dev/null || true
PREMOUNT
chmod +x /etc/initramfs-tools/scripts/local-top/flagship-unlock
${initramfsWifi}
# Rebuild the initramfs so the hook + premount script land in /boot's initrd.
update-initramfs -u 2>&1 | tee /var/log/flagship-initramfs.log || \\
    echo "[flagship-bootstrap] WARNING: update-initramfs failed; unlock hook not embedded"
echo "[flagship-bootstrap] LUKS unlock hook installed; initramfs rebuilt"

`;
}

export function installBlobToJson(
  b: InstallBlob,
  blobSignatureHex: string,
  pairingOrder?: string,
  swkHex?: string,
  debugGrant?: string,
  offlineSecrets?: string,
  enrollmentKeyHex?: string,
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
      ...(b.authCode.adminRootPubKey
        ? { adminRootPubKey: bytesToHex(b.authCode.adminRootPubKey) }
        : {}),
    },
    authCodeUserSignature: bytesToHex(b.authCodeUserSignature),
    installerGitRef: b.installerGitRef,
    rckPubKey: bytesToHex(b.rckPubKey),
    // Signed optional fields (canonicalInstallBlob appends them when present),
    // so they belong in the box's copy of the recipe: a box that ever re-checks
    // the blob signature needs them, exactly as the ISO trailer carries them.
    // Absent ⇒ omitted, so a recipe without them serializes as before.
    ...(b.bootUnlockMode !== undefined ? { bootUnlockMode: b.bootUnlockMode } : {}),
    ...(b.diskEncryption !== undefined ? { diskEncryption: b.diskEncryption } : {}),
    blobSignatureHex,
    // OFFLINE secret-free pairing (advanced/embed): the owner-IRK-signed
    // `add-paired-session` order in PLAINTEXT (`{request, signature}` JSON),
    // which the daemon verifies + adds LOCALLY at first boot (no `.com`). An
    // UNSIGNED recipe sibling (never part of the signed InstallBlob's canonical
    // bytes), appended only when the recipe carries it — a recipe WITHOUT it
    // serializes byte-identically to before (existing burns + sha pins
    // unchanged). The default online recipe leaves it absent.
    ...(pairingOrder ? { pairingOrder } : {}),
    // SWK provisioning: the phone-derived Service Workload Key. Like
    // pairingOrder, an UNSIGNED recipe sibling (never part of the signed
    // InstallBlob's canonical bytes), appended only when the recipe carries it —
    // a recipe WITHOUT it serializes byte-identically to before (existing burns +
    // sha pins unchanged). The daemon reads it from install-blob.json at first
    // boot and persists it to /var/flagship/swk.hex.
    ...(swkHex ? { swkHex } : {}),
    // The owner's signed commitment to that key (`flagship/offline-secrets/v1`): without it the
    // box ignores the key (SEC-RECIPE-001).
    ...(swkHex && offlineSecrets ? { offlineSecrets: JSON.parse(offlineSecrets) } : {}),
    // Owner-authorized debug-access grant (`{grant,signatureHex}` JSON). Like
    // pairingOrder/swkHex, an UNSIGNED recipe sibling (never part of the signed
    // InstallBlob's canonical bytes), appended only when the recipe carries it —
    // a recipe WITHOUT it serializes byte-identically to before. The box-side
    // debug-access gate reads it from install-blob.json and verifies it under the
    // owner IRK before enabling the debug user/SSH.
    ...(debugGrant ? { debugGrant } : {}),
    // First contact (protocol enrollment.ts): the one-time secret the box proves its key with.
    ...(enrollmentKeyHex ? { enrollmentKeyHex } : {}),
  };
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
