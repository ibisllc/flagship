/**
 * The pieces of a box's early-boot unlock that live outside the release: the
 * initramfs hooks and scripts under /etc/initramfs-tools and the unseal helper
 * on /boot. The installer (userdata.ts buildLuksBootstrapBlock) and the boot
 * chain refresh (server-daemon bootChainRefresh.ts) both write exactly what
 * these functions return, so a box's boot chain can follow its release.
 */
import { APPROVED_BOOT_HOSTS, buildUnlockPremountScript, isBootHostName } from "./unlockPremount.js";

export const UNLOCK_HOOK_PATH = "/etc/initramfs-tools/hooks/flagship-unlock";
export const UNLOCK_PREMOUNT_PATH = "/etc/initramfs-tools/scripts/local-top/flagship-unlock";
export const WIFI_HOOK_PATH = "/etc/initramfs-tools/hooks/flagship-wifi";
export const WIFI_PREMOUNT_PATH = "/etc/initramfs-tools/scripts/init-premount/flagship-wifi";
/** Where the hook copies the unseal helper from. */
export const UNSEAL_HELPER_PATH = "/boot/flagship-unseal";
/** The unseal helper inside a release tree (tools/box-artifact/assemble.ts). */
export const RELEASE_UNSEAL_HELPER = "installer/flagship-unseal";
export const BOOT_CHAIN_SCRIPT_MODE = 0o755;
export const UNSEAL_HELPER_MODE = 0o755;

export interface BootChainScript {
  path: string;
  content: string;
  mode: number;
}

export interface BootChainInputs {
  /** Every host the premount accepts: the release's list, then any the box was installed with. */
  approvedHosts: readonly string[];
  /** The Wi-Fi the box was installed with; "keep" when its installed script can't be read back. */
  wifi?: { ssid: string; psk: string } | "keep";
}

/** Escape a string for a single-quoted POSIX-shell scalar (`'...'`). */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function unquoteSingle(q: string): string | null {
  if (!/^'(?:[^']|'\\'')*'$/.test(q)) return null;
  return q.slice(1, -1).replace(/'\\''/g, "'");
}

export function buildUnlockPremountFile(approvedHosts: readonly string[] = APPROVED_BOOT_HOSTS): string {
  return `${buildUnlockPremountScript(approvedHosts)}\n`;
}

/**
 * Burn-time Wi-Fi credentials are embedded in a script on the unencrypted initrd; a control
 * character could end the heredoc that writes it or the line that holds it.
 */
function assertWifiText(label: string, s: string): void {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`the Wi-Fi ${label} has a control character`);
}

/** Every script the box's initramfs needs, as written to /etc/initramfs-tools. */
export function bootChainScripts(inputs: BootChainInputs): BootChainScript[] {
  const scripts: BootChainScript[] = [
    { path: UNLOCK_HOOK_PATH, content: buildUnlockHookScript(), mode: BOOT_CHAIN_SCRIPT_MODE },
    { path: UNLOCK_PREMOUNT_PATH, content: buildUnlockPremountFile(inputs.approvedHosts), mode: BOOT_CHAIN_SCRIPT_MODE },
  ];
  if (inputs.wifi && inputs.wifi !== "keep") {
    scripts.push(
      { path: WIFI_HOOK_PATH, content: buildWifiHookScript(), mode: BOOT_CHAIN_SCRIPT_MODE },
      { path: WIFI_PREMOUNT_PATH, content: buildWifiPremountScript(inputs.wifi.ssid, inputs.wifi.psk), mode: BOOT_CHAIN_SCRIPT_MODE },
    );
  }
  return scripts;
}

/** `cat > path <<'TAG' … TAG` then `chmod +x`, refusing content that would end the heredoc early. */
export function heredocWrite(script: BootChainScript, tag: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(tag)) throw new Error(`bad heredoc tag ${tag}`);
  if (!script.content.endsWith("\n")) throw new Error(`${script.path} must end with a newline`);
  if (script.content.split("\n").includes(tag)) throw new Error(`${script.path} contains its heredoc tag`);
  return `cat > ${script.path} <<'${tag}'\n${script.content}${tag}\nchmod +x ${script.path}\n`;
}

/**
 * What the scripts a box has installed say about it: the boot hosts baked into its premount and
 * the Wi-Fi in its Wi-Fi premount. Null when the box has no unlock premount (it has no
 * encrypted root, so it has no boot chain to refresh). The release's own host list always
 * comes first; hosts the box was installed with on top of it are kept.
 */
export function installedBootChainInputs(premount: string | null, wifiPremount: string | null): BootChainInputs | null {
  if (premount === null) return null;
  const m = /^APPROVED_BOOT_HOSTS="([a-z0-9. -]*)"$/m.exec(premount);
  if (!m) return null;
  const installed = m[1]!.split(" ").filter((h) => h.length > 0 && isBootHostName(h));
  const approvedHosts = [...APPROVED_BOOT_HOSTS, ...installed.filter((h) => !APPROVED_BOOT_HOSTS.includes(h))];
  if (wifiPremount === null) return { approvedHosts };
  const ssidQ = /^WIFI_SSID=(.*)$/m.exec(wifiPremount)?.[1];
  const pskQ = /^WIFI_PSK=(.*)$/m.exec(wifiPremount)?.[1];
  const ssid = ssidQ === undefined ? null : unquoteSingle(ssidQ);
  const psk = pskQ === undefined ? null : unquoteSingle(pskQ);
  if (ssid === null || psk === null || ssid.trim().length === 0) return { approvedHosts, wifi: "keep" };
  try {
    assertWifiText("name", ssid);
    assertWifiText("password", psk);
  } catch {
    return { approvedHosts, wifi: "keep" };
  }
  return { approvedHosts, wifi: { ssid, psk } };
}

export interface InitrdEntry {
  /** Path inside the initrd, without a leading slash. */
  path: string;
  /** The exact size, where the bytes are known. */
  size?: number;
}

/**
 * What a built initrd must hold for the unlock to work: the scripts at their exact size, the
 * helper at its exact size, and what the unlock hook refuses to build without.
 */
export function initrdExpectations(scripts: readonly BootChainScript[], helperSize: number): InitrdEntry[] {
  const bytes = (s: string) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        n += 4;
        i++;
      } else {
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      }
    }
    return n;
  };
  const out: InitrdEntry[] = [];
  for (const s of scripts) {
    if (s.path === UNLOCK_PREMOUNT_PATH) out.push({ path: "scripts/local-top/flagship-unlock", size: bytes(s.content) });
    if (s.path === WIFI_PREMOUNT_PATH) out.push({ path: "scripts/init-premount/flagship-wifi", size: bytes(s.content) });
  }
  out.push({ path: "bin/flagship-unseal", size: helperSize });
  for (const p of ["bin/openssl", "bin/curl", "bin/xxd", "sbin/cryptsetup", "etc/ssl/certs/ca-certificates.crt", "boot/flagship-boot-key.pem", "boot/server-domain", "boot/flagship-boot-host"]) {
    out.push({ path: p });
  }
  return out;
}

/** The unlock hook: stages the helper, the tools and the /boot facts, and fails the build when any is missing. */
export function buildUnlockHookScript(): string {
  return `#!/bin/sh
# Flagship initramfs hook: stage the unseal helper, the boot key and the tools
# the premount needs (openssl curl xxd sed cryptsetup lvm ip). Fails the
# initramfs build if anything the unlock needs is missing.
set -e
PREREQ=""
prereqs() { echo "$PREREQ"; }
case "$1" in prereqs) prereqs; exit 0;; esac
. /usr/share/initramfs-tools/hook-functions
fail() { echo "flagship-unlock hook: $*" >&2; exit 1; }
copy_exec /boot/flagship-unseal /bin/flagship-unseal
copy_exec /usr/bin/openssl /bin/openssl
copy_exec /usr/bin/curl /bin/curl
copy_exec /usr/bin/xxd /bin/xxd
copy_exec /bin/sed /bin/sed 2>/dev/null || copy_exec /usr/bin/sed /bin/sed
copy_exec /sbin/ip /sbin/ip 2>/dev/null || copy_exec /bin/ip /sbin/ip
# A virtio guest needs virtio_net at premount to have any interface; MODULES=most
# does not guarantee it. Missing on this arch is a no-op.
for _netmod in virtio_net virtio_pci virtio_mmio e1000 e1000e; do
  manual_add_modules "$_netmod" 2>/dev/null || true
done
# copy_exec never sees curl's dlopen'd NSS modules, and the initrd has no
# nsswitch.conf. On glibc >= 2.34 they are built in and the .so files absent.
mkdir -p "\${DESTDIR}/etc"
echo "hosts: files dns" > "\${DESTDIR}/etc/nsswitch.conf"
for _nss in /lib/*-linux-gnu*/libnss_dns.so.2 /lib/*-linux-gnu*/libnss_files.so.2 /lib/*-linux-gnu*/libresolv.so.2; do
  [ -e "$_nss" ] && copy_exec "$_nss" || true
done
mkdir -p "\${DESTDIR}/etc/ssl/certs"
[ -s /etc/ssl/certs/ca-certificates.crt ] || fail "no CA bundle at /etc/ssl/certs/ca-certificates.crt"
cp /etc/ssl/certs/ca-certificates.crt "\${DESTDIR}/etc/ssl/certs/ca-certificates.crt"
copy_exec /sbin/cryptsetup /sbin/cryptsetup 2>/dev/null || copy_exec /usr/sbin/cryptsetup /sbin/cryptsetup
copy_exec /sbin/lvm /sbin/lvm 2>/dev/null || copy_exec /usr/sbin/lvm /sbin/lvm
mkdir -p "\${DESTDIR}/boot"
for _f in flagship-boot-key.pem server-domain flagship-boot-host flagship-boot-unlock-mode flagship-owner-key.pub; do
  [ -s "/boot/$_f" ] || fail "missing /boot/$_f"
  cp "/boot/$_f" "\${DESTDIR}/boot/$_f"
done
chmod 600 "\${DESTDIR}/boot/flagship-boot-key.pem"
# Boot unlock v2 (pq-suites.md §19): the boot key's ML-DSA half, the owner's
# hybrid key, the unlock policy and the lease key (a file, or a TPM-sealed
# object plus the tpm2-tools and TCTI to open it). All optional: a box without
# them unlocks as v1. The premount prefers the live /boot copies.
for _f in flagship-boot-mldsa.key flagship-owner-pq.pub flagship-unlock-policy flagship-lease-kem.key; do
  [ ! -s "/boot/$_f" ] || { cp "/boot/$_f" "\${DESTDIR}/boot/$_f"; chmod 600 "\${DESTDIR}/boot/$_f"; }
done
[ ! -d /boot/flagship-lease-kem.tpm ] || cp -r /boot/flagship-lease-kem.tpm "\${DESTDIR}/boot/flagship-lease-kem.tpm"
for _t in tpm2_createprimary tpm2_load tpm2_unseal tpm2_flushcontext; do
  _tp="$(command -v "$_t" 2>/dev/null || true)"
  [ -z "$_tp" ] || copy_exec "$_tp" "/bin/$_t"
done
for _tl in /usr/lib/*-linux-gnu*/libtss2-tcti-device.so*; do
  [ ! -e "$_tl" ] || copy_exec "$_tl"
done
for _tm in tpm_crb tpm_tis tpm_tis_core; do
  manual_add_modules "$_tm" 2>/dev/null || true
done
cp /boot/control-plane-url "\${DESTDIR}/boot/control-plane-url" 2>/dev/null || true
[ ! -f /boot/flagship-debug-mode ] || cp /boot/flagship-debug-mode "\${DESTDIR}/boot/flagship-debug-mode"
for _f in bin/flagship-unseal bin/openssl bin/curl bin/xxd etc/ssl/certs/ca-certificates.crt boot/flagship-boot-key.pem; do
  [ -s "\${DESTDIR}/$_f" ] || fail "the initramfs lacks /$_f"
done
`;
}

/** The Wi-Fi hook: stages this box's radio driver, firmware and tools (best-effort). */
export function buildWifiHookScript(): string {
  return `#!/bin/sh
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
`;
}

/** The Wi-Fi bring-up that runs before the unlock (init-premount), with the burn-time credentials. */
export function buildWifiPremountScript(ssid: string, psk: string): string {
  assertWifiText("name", ssid);
  assertWifiText("password", psk);
  return `#!/bin/sh
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
# network-up-but-unlock-still-failed case). Both are \`|| true\`, never block boot.
PREREQ=""
prereqs() { echo "$PREREQ"; }
case "$1" in prereqs) prereqs; exit 0;; esac

WIFI_SSID=${shSingleQuote(ssid)}
WIFI_PSK=${shSingleQuote(psk)}

# OBSERVABILITY: persistent bring-up log on the unencrypted /boot partition.
# /boot here is the initrd ramdisk (lost on pivot), so mount the REAL boot fs
# (label FLAGSHIP_BOOT) read-write once. Every \`log_stage\` line is timestamped
# (uptime seconds + wall-clock when available) and tee'd to the persistent log
# AND a /run accumulator the post-DHCP beacon posts. Fully best-effort.
FLAGSHIP_WIFI_LOG=/run/flagship-wifi.log
FLAGSHIP_BOOTMNT=/run/flagship-bootmnt
: > "$FLAGSHIP_WIFI_LOG" 2>/dev/null || true
mkdir -p "$FLAGSHIP_BOOTMNT" 2>/dev/null || true
log_stage() {
  _ts="$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)"
  _wall="$(date '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo -)"
  _line="flagship-wifi [up=\${_ts}s \${_wall}] $*"
  echo "$_line" >&2 || true
  echo "$_line" >> "$FLAGSHIP_WIFI_LOG" 2>/dev/null || true
  echo "$_line" >> "$FLAGSHIP_BOOTMNT/flagship-wifi.log" 2>/dev/null || true
}
log_stage "premount start (ssid baked)"

# The boot fs is found by label; at init-premount udev may not have settled the
# by-label symlink yet, so wait for it (bounded ~10s) before mounting. Lines
# logged before the mount accumulate in /run; the cat seeds them into the
# persistent log once mounted, so the first line is never lost — an EMPTY
# persistent log can only mean the premount never ran.
_bdeadline=$(( $(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) + 10 ))
while [ ! -e /dev/disk/by-label/FLAGSHIP_BOOT ]; do
  [ "$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999)" -ge "$_bdeadline" ] && break
  sleep 1
done
if mount /dev/disk/by-label/FLAGSHIP_BOOT "$FLAGSHIP_BOOTMNT" 2>/dev/null; then
  cat "$FLAGSHIP_WIFI_LOG" >> "$FLAGSHIP_BOOTMNT/flagship-wifi.log" 2>/dev/null || true
  log_stage "boot fs mounted (persistent log live)"
else
  log_stage "boot fs mount FAILED — log stays in /run (survives pivot)"
fi

# Re-detect the wl* interface at boot (the name can differ from build time).
IF=""
_deadline=$(( $(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) + 30 ))
while [ -z "$IF" ]; do
  IF=$(ls /sys/class/net 2>/dev/null | grep -E '^wl' | head -1)
  [ -n "$IF" ] && break
  [ "$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999)" -ge "$_deadline" ] && break
  sleep 1
done
[ -n "$IF" ] || { log_stage "no wl* interface in 30s — falling through"; exit 0; }
log_stage "wl interface detected: $IF"

# Load the driver (the hook staged it) and bring the link up.
DRV=$(basename "$(readlink -f /sys/class/net/$IF/device/driver 2>/dev/null)" 2>/dev/null)
log_stage "driver resolved: \${DRV:-none}"
[ -n "$DRV" ] && modprobe "$DRV" 2>/dev/null || true
log_stage "modprobe done (driver=\${DRV:-none})"
# iwlwifi's op-mode (iwlmvm/iwlmld/iwldvm) is request_module'd at runtime; a
# miss leaves the core loaded with firmware but no interface. Belt-and-braces.
if [ "$DRV" = iwlwifi ]; then
  for m in iwlmvm iwlmld iwldvm; do
    modprobe "$m" 2>/dev/null && log_stage "op-mode loaded: $m" && break
  done
fi
ip link set "$IF" up 2>/dev/null || true
log_stage "link up requested on $IF (oper=$(cat /sys/class/net/$IF/operstate 2>/dev/null || echo unknown))"

# Associate with the baked SSID.
printf 'ctrl_interface=/run/wpa_supplicant\\nnetwork={\\n  ssid="%s"\\n  psk="%s"\\n  scan_ssid=1\\n}\\n' \\
  "$WIFI_SSID" "$WIFI_PSK" > /run/flagship-wpa.conf 2>/dev/null || true
wpa_supplicant -B -i "$IF" -D nl80211,wext -c /run/flagship-wpa.conf 2>/dev/null || true
log_stage "wpa_supplicant started on $IF"
# Bounded ~10s wait to observe the association result (does not change the flow —
# wpa runs in the background either way; this only records wpa_cli status if any).
_a=0
while [ "$_a" -lt 5 ]; do
  _wstate="$(wpa_cli -i "$IF" status 2>/dev/null | sed -n 's/^wpa_state=//p' | head -1)"
  [ "$_wstate" = "COMPLETED" ] && break
  _a=$(( _a + 1 ))
  sleep 2
done
log_stage "association result: wpa_state=\${_wstate:-unknown}"

# DHCP, bounded ~20s: prefer klibc ipconfig, fall back to busybox udhcpc.
if command -v ipconfig >/dev/null 2>&1; then
  log_stage "DHCP method: ipconfig"
  ipconfig -t 20 "$IF" 2>/dev/null || true
else
  log_stage "DHCP method: udhcpc"
  _n=0
  while [ "$_n" -lt 4 ]; do
    udhcpc -i "$IF" -n -q -t 5 2>/dev/null && break
    _n=$(( _n + 1 ))
  done
fi
_ip="$(ip -4 -o addr show dev "$IF" 2>/dev/null | awk '{print $4}' | head -1)"
if [ -n "$_ip" ]; then
  log_stage "DHCP result: assigned $_ip on $IF (route=$(ip route show default 2>/dev/null | head -1))"
else
  log_stage "DHCP result: FAILED — no IPv4 address on $IF"
fi
# klibc ipconfig records DNS in /run/net-<if>.conf but NOTHING writes
# /etc/resolv.conf in the initramfs — the unlock curls would die on name
# resolution even with the route up.
if [ -n "$_ip" ]; then
  IPV4DNS0=""
  IPV4DNS1=""
  [ -f "/run/net-$IF.conf" ] && . "/run/net-$IF.conf" 2>/dev/null
  _dns=""
  for _d in "$IPV4DNS0" "$IPV4DNS1"; do
    [ -n "$_d" ] && [ "$_d" != "0.0.0.0" ] && _dns="$_dns $_d"
  done
  : > /etc/resolv.conf 2>/dev/null || true
  for _d in $_dns; do
    echo "nameserver $_d" >> /etc/resolv.conf 2>/dev/null || true
  done
  if [ -s /etc/resolv.conf ]; then
    log_stage "dns configured:$_dns"
  else
    printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf 2>/dev/null || true
    log_stage "dns fallback: public resolvers"
  fi
fi
log_stage "bring-up attempt complete on $IF"

umount "$FLAGSHIP_BOOTMNT" 2>/dev/null || true
exit 0
`;
}
