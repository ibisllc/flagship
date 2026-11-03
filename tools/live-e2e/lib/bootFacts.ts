/**
 * What a LUKS box's start-up left behind, read over the owner's debug SSH (the `debug` user, passwordless
 * sudo, opened by a `flagship/debug-access/v2` grant; docs/boot-chain-refresh.md, RELEASE-0.3-JOURNAL.md
 * B0). One shell script prints every fact between markers; `parseBootFacts` reads them back. Pure: the
 * lanes test it without a box.
 *
 * FLAGSHIP_BOOT is the box's /boot partition (the installer labels it): the premount mounts it by label
 * in the initramfs (packages/boot-chain/src/bootFsMount.ts, the B0 fix) and writes `flagship-unlock.log`
 * there, truncated at each boot; the daemon writes the one-shot `flagship-lock-once` marker there before a
 * Lock/restart and the premount removes it after the unlock it forced.
 */

const MARK = "@@flagship-fact:";

/** The script `sudo sh -c` runs on the box. Prints `@@flagship-fact:<name>` before each fact. */
export const BOOT_FACTS_SCRIPT = [
  `echo '${MARK}mount'; findmnt -no SOURCE,LABEL,FSTYPE /boot 2>&1 || echo 'not-a-mount'`,
  `echo '${MARK}label'; blkid -L FLAGSHIP_BOOT 2>&1 || echo 'no-label'`,
  `echo '${MARK}lockonce'; if [ -e /boot/flagship-lock-once ]; then echo present; else echo absent; fi`,
  `echo '${MARK}unlocklog'; cat /boot/flagship-unlock.log 2>&1 || echo 'no-unlock-log'`,
  `echo '${MARK}cmdline'; cat /proc/cmdline`,
  `echo '${MARK}bootid'; cat /proc/sys/kernel/random/boot_id`,
  `echo '${MARK}state'; cat /var/lib/flagship-bootchain/state.json 2>&1 || echo '{}'`,
  `echo '${MARK}grubenv'; grub-editenv /boot/grub/grubenv list 2>&1 || true`,
  `echo '${MARK}customcfg'; if [ -e /boot/grub/custom.cfg ]; then echo present; else echo absent; fi`,
  `echo '${MARK}premount'; sha256sum /etc/initramfs-tools/scripts/local-top/flagship-unlock 2>&1; tail -n 1 /etc/initramfs-tools/scripts/local-top/flagship-unlock 2>&1`,
  `echo '${MARK}luks'; blkid -t TYPE=crypto_LUKS -o device 2>&1 | head -n 1`,
  // Where the lease key lives (bootPq.ts): sealed to the TPM under `pcrs`, a file, or nothing yet.
  `echo '${MARK}custody'; if [ -d /boot/flagship-lease-kem.tpm ]; then printf 'tpm %s\\n' $(cat /boot/flagship-lease-kem.tpm/pcrs 2>/dev/null); elif [ -s /boot/flagship-lease-kem.key ]; then echo software; else echo none; fi`,
  `echo '${MARK}policy'; cat /boot/flagship-unlock-policy 2>/dev/null || echo compat`,
  // B2 #8: the UUIDs this boot's initrd pins, next to the disks' own (the boot fs and the crypttab volume).
  `echo '${MARK}uuids'; _d=$(mktemp -d); unmkinitramfs /boot/initrd.img-$(uname -r) $_d >/dev/null 2>&1; ` +
    `printf 'initrd-boot %s\\n' $(find $_d -path '*/boot/flagship-boot-fs-uuid' -exec cat {} + 2>/dev/null | head -n 1); ` +
    `printf 'initrd-luks %s\\n' $(find $_d -path '*/boot/flagship-luks-uuid' -exec cat {} + 2>/dev/null | head -n 1); rm -rf $_d; ` +
    `printf 'disk-boot %s\\n' $(findmnt -no UUID /boot 2>/dev/null); ` +
    `printf 'disk-luks %s\\n' $(blkid -s UUID -o value $(blkid -t TYPE=crypto_LUKS -o device 2>/dev/null | head -n 1) 2>/dev/null)`,
  `echo '${MARK}end'`,
].join("; ");

export interface UnlockLog {
  lines: string[];
  /** The premount's own first line was written (the B0 fix: FLAGSHIP_BOOT mounted in the initramfs). */
  premountStarted: boolean;
  /** `lock-once=yes|no` from the start line. */
  lockOnce: "yes" | "no" | null;
  mode: string | null;
  unlockedBy: "phone" | "lease" | null;
  consumedMarker: boolean;
  fatal: string | null;
  /** The premount said the TPM did not release the lease key (a boot chain the seal does not cover). */
  tpmRefused: boolean;
  /** This boot was a boot-chain trial (the premount logged its token). */
  trialBoot: boolean;
}

export function parseUnlockLog(text: string): UnlockLog {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("flagship [up="));
  const start = lines.find((l) => l.includes("premount start ("));
  const m = start ? /mode=([a-z]+) lock-once=(yes|no)/.exec(start) : null;
  const fatal = lines.find((l) => l.includes("FATAL:"));
  return {
    lines,
    premountStarted: !!start,
    lockOnce: (m?.[2] as "yes" | "no" | undefined) ?? null,
    mode: m?.[1] ?? null,
    unlockedBy: lines.some((l) => l.includes("unlocked with the phone's reply")) ? "phone" : lines.some((l) => l.includes("unlocked from the auto-unlock lease")) ? "lease" : null,
    consumedMarker: lines.some((l) => l.includes("consumed the one-shot lock marker")),
    fatal: fatal ? fatal.slice(fatal.indexOf("FATAL:") + 6).trim() : null,
    tpmRefused: lines.some((l) => l.includes("the TPM did not release the lease key")),
    trialBoot: lines.some((l) => l.includes("start-up check boot (trial ")),
  };
}

export interface BootFacts {
  /** `findmnt` of /boot: source, label, filesystem. */
  bootMount: { source: string; label: string; fstype: string } | null;
  /** The device labelled FLAGSHIP_BOOT, or null. */
  labelDevice: string | null;
  lockOncePresent: boolean;
  unlockLog: UnlockLog;
  cmdline: string;
  /** The trial token on this boot's command line (`flagship.bootchain=<token>`), or null. */
  bootchainToken: string | null;
  bootId: string;
  state: { trial?: { token?: string; digest?: string }; confirmed?: { digest?: string }; failed?: { digest?: string; reason?: string } } & Record<string, unknown>;
  nextEntry: string | null;
  customCfgPresent: boolean;
  premountSha256: string | null;
  premountLastLine: string;
  luksDevice: string | null;
  /** Where the lease key is held; `pcrs` are the PCR indices a TPM seal covers. */
  custody: { kind: "tpm" | "software" | "none"; pcrs: number[] };
  unlockPolicy: string;
  /** The UUIDs this boot's initrd pins and the disks' own (null where unreadable). */
  uuids: { initrdBoot: string | null; initrdLuks: string | null; diskBoot: string | null; diskLuks: string | null };
}

export function parseCustody(text: string): BootFacts["custody"] {
  const t = text.trim();
  if (t.startsWith("tpm")) {
    const sel = /sha256:([0-9,]+)/.exec(t)?.[1] ?? "";
    return { kind: "tpm", pcrs: sel.split(",").filter((x) => x !== "").map(Number) };
  }
  return { kind: t === "software" ? "software" : "none", pcrs: [] };
}

/** True when the seal covers what GRUB measures (PCR 8 commands and command line, PCR 9 files). */
export function sealCoversGrub(c: BootFacts["custody"]): boolean {
  return c.kind === "tpm" && (c.pcrs.includes(8) || c.pcrs.includes(9));
}

export function splitFacts(out: string): Map<string, string> {
  const m = new Map<string, string>();
  let name: string | null = null;
  let buf: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith(MARK)) {
      if (name) m.set(name, buf.join("\n").trim());
      name = line.slice(MARK.length).trim();
      buf = [];
    } else if (name) {
      buf.push(line);
    }
  }
  if (name && name !== "end") m.set(name, buf.join("\n").trim());
  return m;
}

export function parseBootFacts(out: string): BootFacts {
  const f = splitFacts(out);
  if (!f.has("cmdline")) throw new Error(`the box printed no boot facts: ${out.slice(0, 200)}`);
  const mount = (f.get("mount") ?? "").split(/\s+/);
  const label = f.get("label") ?? "";
  const cmdline = f.get("cmdline") ?? "";
  let state: BootFacts["state"] = {};
  try {
    state = JSON.parse(f.get("state") || "{}") as BootFacts["state"];
  } catch {
    state = {};
  }
  const env = f.get("grubenv") ?? "";
  const premount = (f.get("premount") ?? "").split("\n");
  const luks = (f.get("luks") ?? "").trim();
  return {
    bootMount: mount.length >= 2 && mount[0] && mount[0] !== "not-a-mount" ? { source: mount[0], label: mount[1] ?? "", fstype: mount[2] ?? "" } : null,
    labelDevice: label.startsWith("/dev/") ? label : null,
    lockOncePresent: (f.get("lockonce") ?? "").trim() === "present",
    unlockLog: parseUnlockLog(f.get("unlocklog") ?? ""),
    cmdline,
    bootchainToken: /(?:^|\s)flagship\.bootchain=([A-Za-z0-9._-]+)/.exec(cmdline)?.[1] ?? null,
    bootId: (f.get("bootid") ?? "").trim(),
    state,
    nextEntry: /^next_entry=(.*)$/m.exec(env)?.[1]?.trim() || null,
    customCfgPresent: (f.get("customcfg") ?? "").trim() === "present",
    premountSha256: /^([0-9a-f]{64})\s/.exec(premount[0] ?? "")?.[1] ?? null,
    premountLastLine: (premount[1] ?? "").trim(),
    luksDevice: luks.startsWith("/dev/") ? luks : null,
    custody: parseCustody(f.get("custody") ?? ""),
    unlockPolicy: (f.get("policy") ?? "compat").trim() || "compat",
    uuids: {
      initrdBoot: uuidAfter(f.get("uuids"), "initrd-boot"),
      initrdLuks: uuidAfter(f.get("uuids"), "initrd-luks"),
      diskBoot: uuidAfter(f.get("uuids"), "disk-boot"),
      diskLuks: uuidAfter(f.get("uuids"), "disk-luks"),
    },
  };
}

function uuidAfter(text: string | undefined, key: string): string | null {
  const v = new RegExp(`^${key} ([0-9A-Fa-f-]+)\\s*$`, "m").exec(text ?? "")?.[1];
  return v ? v.toLowerCase() : null;
}

/** The line the lane appends to the installed premount so the box's chain differs from its release's. */
export const STALE_CHAIN_LINE = "# gym boot-chain lane: an installed chain older than the release";

/** The sudo command that makes the installed chain stale (idempotent). */
export const MAKE_CHAIN_STALE =
  `grep -qxF '${STALE_CHAIN_LINE}' /etc/initramfs-tools/scripts/local-top/flagship-unlock || ` +
  `printf '%s\\n' '${STALE_CHAIN_LINE}' >> /etc/initramfs-tools/scripts/local-top/flagship-unlock`;

/** The GRUB entry the lane boots once to change the measured boot chain without the release (B2 #7). */
export const UNENDORSED_ENTRY_ID = "gym-unendorsed-chain";

/**
 * The sudo script that boots the default kernel and initrd once with one more command-line argument,
 * through a GRUB entry of the lane's own: an unendorsed change to what GRUB measures (PCR 8). Nothing the
 * release ships changes. CLEAR_UNENDORSED removes it afterwards.
 */
export const BOOT_UNENDORSED_ONCE = [
  "set -e",
  "K=$(uname -r)",
  "U=$(findmnt -no UUID /boot)",
  "A=$(sed -e 's/^BOOT_IMAGE=[^ ]* //' -e 's/ panic=[0-9]*//' /proc/cmdline)",
  `printf "menuentry 'gym unendorsed chain' --id ${UNENDORSED_ENTRY_ID} {\\n\\tinsmod part_gpt\\n\\tinsmod part_msdos\\n\\tinsmod ext2\\n\\tinsmod gzio\\n\\tsearch --no-floppy --fs-uuid --set=root %s\\n\\tlinux /vmlinuz-%s %s gym.unendorsed=1\\n\\tinitrd /initrd.img-%s\\n}\\n" "$U" "$K" "$A" "$K" > /boot/grub/custom.cfg`,
  `grub-reboot ${UNENDORSED_ENTRY_ID}`,
  `grub-editenv /boot/grub/grubenv list | grep -qx 'next_entry=${UNENDORSED_ENTRY_ID}'`,
  "sync",
  "(sleep 2; systemctl reboot) </dev/null >/dev/null 2>&1 &",
].join("\n");

export const CLEAR_UNENDORSED = `grep -q '${UNENDORSED_ENTRY_ID}' /boot/grub/custom.cfg 2>/dev/null && rm -f /boot/grub/custom.cfg; grub-editenv /boot/grub/grubenv unset next_entry || true`;

/** A plain restart over debug SSH: no lock marker (unlike the owner's Lock-and-restart), the default entry. */
export const PLAIN_REBOOT = "sync; (sleep 2; systemctl reboot) </dev/null >/dev/null 2>&1 &";
