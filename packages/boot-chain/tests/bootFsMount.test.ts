import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOOT_FS_MOUNT_SH, DISK_UUID_RECORD_SH } from "../src/bootFsMount.js";
import { buildUnlockHookScript, buildUnlockPremountFile, buildWifiPremountScript, initrdExpectations } from "../src/index.js";

// The initramfs finds the box's own boot partition and encrypted root by the UUIDs the unlock hook
// recorded at install (B2 OPEN #8): a stick labelled FLAGSHIP_BOOT or a second LUKS disk is never used.
// At init-premount ext4 is not loaded yet (B0). Run the shell itself against stub blkid/mount/modprobe.
const BOOT = "11112222-3333-4444-5555-666677778888";
const LUKS = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
let dir: string;
let disks: Array<{ dev: string; uuid: string; type: string; label?: string }>;

function writeBlkid(): void {
  // A tiny blkid: `-t UUID=x -o device`, `-t LABEL=x -o device`, `-t TYPE=x -o device`, `-s UUID|TYPE -o value <dev>`.
  const rows = disks.map((d) => `${d.dev} ${d.uuid} ${d.type} ${d.label ?? "-"}`).join("\n");
  writeFileSync(join(dir, "disks"), `${rows}\n`);
  writeFileSync(
    join(dir, "blkid"),
    `#!/bin/sh
echo "blkid $*" >> "${dir}/calls"
if [ "$1" = -t ]; then
  k="\${2%%=*}"; v="\${2#*=}"
  case "$k" in UUID) c=2;; TYPE) c=3;; LABEL) c=4;; *) exit 2;; esac
  awk -v c="$c" -v v="$v" '$c == v { print $1; f=1 } END { exit f ? 0 : 2 }' "${dir}/disks"
  exit $?
fi
if [ "$1" = -s ]; then
  case "$2" in UUID) c=2;; TYPE) c=3;; *) exit 2;; esac
  awk -v c="$c" -v d="$5" '$1 == d { print $c; f=1 } END { exit f ? 0 : 2 }' "${dir}/disks"
  exit $?
fi
exit 2
`,
  );
  chmodSync(join(dir, "blkid"), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bootfs-"));
  mkdirSync(join(dir, "root/boot"), { recursive: true });
  for (const t of ["mount", "modprobe", "findfs"]) {
    writeFileSync(join(dir, t), `#!/bin/sh\necho "${t} $*" >> "${dir}/calls"\n[ "${t}" = mount ] && [ -e "${dir}/mount-fails" ] && exit 1\n[ "${t}" = findfs ] && { echo /dev/vda3; exit 0; }\nexit 0\n`);
    chmodSync(join(dir, t), 0o755);
  }
  disks = [
    { dev: "/dev/vda2", uuid: BOOT, type: "ext4", label: "FLAGSHIP_BOOT" },
    { dev: "/dev/vda3", uuid: LUKS, type: "crypto_LUKS" },
  ];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(body: string, env: Record<string, string> = {}): { code: number; out: string } {
  writeBlkid();
  try {
    const out = execFileSync("/bin/sh", ["-c", `${BOOT_FS_MOUNT_SH}\n${DISK_UUID_RECORD_SH}\n${body}`], {
      env: { PATH: `${dir}:/usr/bin:/bin`, R: join(dir, "root"), FLAGSHIP_BOOT_WAIT_SECS: "0", ...env },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const x = e as { status: number; stdout?: string; stderr?: string };
    return { code: x.status, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}
const calls = () => {
  try {
    return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
};
const pin = (uuid = BOOT) => writeFileSync(join(dir, "root/boot/flagship-boot-fs-uuid"), `${uuid}\n`);

describe("mount_boot_fs", () => {
  it("mounts the partition whose UUID the hook recorded, as ext4, after loading ext4", () => {
    pin();
    expect(run("mount_boot_fs /mnt").code).toBe(0);
    expect(calls().filter((c) => !c.startsWith("blkid"))).toEqual(["modprobe ext4", "mount -t ext4 /dev/vda2 /mnt"]);
  });

  it("never falls back to the FLAGSHIP_BOOT label: no recorded UUID, no mount", () => {
    disks.push({ dev: "/dev/sdb1", uuid: "99999999-0000-0000-0000-000000000000", type: "ext4", label: "FLAGSHIP_BOOT" });
    expect(run("mount_boot_fs /mnt").code).toBe(1);
    expect(calls().some((c) => c.startsWith("mount"))).toBe(false);
  });

  it("ignores a stick labelled FLAGSHIP_BOOT and mounts the recorded partition", () => {
    pin();
    disks.unshift({ dev: "/dev/sda1", uuid: "99999999-0000-0000-0000-000000000000", type: "ext4", label: "FLAGSHIP_BOOT" });
    expect(run("mount_boot_fs /mnt").code).toBe(0);
    expect(calls()).toContain("mount -t ext4 /dev/vda2 /mnt");
    expect(calls().some((c) => c.includes("LABEL"))).toBe(false);
  });

  it("refuses when two devices claim the recorded UUID (a cloned stick)", () => {
    pin();
    disks.push({ dev: "/dev/sda1", uuid: BOOT, type: "ext4", label: "FLAGSHIP_BOOT" });
    expect(run("mount_boot_fs /mnt").code).toBe(1);
    expect(calls().some((c) => c.startsWith("mount"))).toBe(false);
  });

  it("refuses a recorded UUID that is not ext4, and a recorded file that isn't a UUID", () => {
    pin(LUKS);
    expect(run("mount_boot_fs /mnt").code).toBe(1);
    writeFileSync(join(dir, "root/boot/flagship-boot-fs-uuid"), "$(reboot)\n");
    expect(run("mount_boot_fs /mnt").code).toBe(1);
    expect(calls().some((c) => c.startsWith("mount"))).toBe(false);
  });

  it("gives up after the wait and reports the failed mount rather than hanging", () => {
    pin();
    writeFileSync(join(dir, "mount-fails"), "");
    expect(run("mount_boot_fs /mnt").code).toBe(1);
    disks = [];
    expect(run("mount_boot_fs /mnt").code).toBe(1);
  });
});

describe("device_by_uuid (the encrypted root)", () => {
  it("returns the one LUKS volume with the recorded UUID, never just the first LUKS disk", () => {
    disks.unshift({ dev: "/dev/sda2", uuid: "aaaaaaaa-0000-0000-0000-000000000000", type: "crypto_LUKS" });
    expect(run(`device_by_uuid ${LUKS} crypto_LUKS 0`)).toEqual({ code: 0, out: "/dev/vda3\n" });
    disks.push({ dev: "/dev/sdb2", uuid: LUKS, type: "crypto_LUKS" });
    expect(run(`device_by_uuid ${LUKS} crypto_LUKS 0`).code).toBe(2);
    expect(run(`device_by_uuid ${BOOT} crypto_LUKS 0`).code).toBe(3);
    expect(run("device_by_uuid bbbbbbbb-0000-0000-0000-000000000000 crypto_LUKS 0").code).toBe(1);
  });
});

describe("flagship_record_disk_uuids (the unlock hook, at initrd build time)", () => {
  const dest = () => join(dir, "dest");
  const fstab = (boot: string) =>
    writeFileSync(join(dir, "fstab"), `# /etc/fstab\n/dev/mapper/flagship-root / ext4 errors=remount-ro 0 1\n# /boot was on /dev/vda2\n${boot} /boot ext4 defaults 0 2\nUUID=AB12-CD34 /boot/efi vfat umask=0077 0 1\n`);
  const crypttab = (src: string) => writeFileSync(join(dir, "crypttab"), `# <target> <source> <key> <opts>\nvda3_crypt ${src} none luks,discard\n`);
  const recorded = () => [readFileSync(join(dest(), "boot/flagship-boot-fs-uuid"), "utf8"), readFileSync(join(dest(), "boot/flagship-luks-uuid"), "utf8")];

  it("records the /boot filesystem and the crypttab volume as d-i writes them (UUID=)", () => {
    fstab(`UUID=${BOOT}`);
    crypttab(`UUID=${LUKS}`);
    expect(run(`flagship_record_disk_uuids "${dir}/fstab" "${dir}/crypttab" "${dest()}"`).code).toBe(0);
    expect(recorded()).toEqual([`${BOOT}\n`, `${LUKS}\n`]);
  });

  it("resolves device paths and PARTUUID= sources through blkid", () => {
    fstab("/dev/vda2");
    crypttab("PARTUUID=0000-03");
    expect(run(`flagship_record_disk_uuids "${dir}/fstab" "${dir}/crypttab" "${dest()}"`).code).toBe(0);
    expect(recorded()).toEqual([`${BOOT}\n`, `${LUKS}\n`]);
  });

  it("fails (so the hook fails the build) without a /boot line or a crypttab entry", () => {
    fstab(`UUID=${BOOT}`);
    writeFileSync(join(dir, "crypttab"), "# nothing\n");
    const r = run(`flagship_record_disk_uuids "${dir}/fstab" "${dir}/crypttab" "${dest()}"`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no UUID for the encrypted root");
    writeFileSync(join(dir, "fstab"), "/dev/mapper/flagship-root / ext4 defaults 0 1\n");
    crypttab(`UUID=${LUKS}`);
    expect(run(`flagship_record_disk_uuids "${dir}/fstab" "${dir}/crypttab" "${dest()}"`).out).toContain("no UUID for the /boot filesystem");
  });
});

describe("the generated scripts", () => {
  const scripts = {
    unlock: buildUnlockPremountFile(),
    wifi: buildWifiPremountScript("net", "pass1234"),
  };
  for (const [name, text] of Object.entries(scripts)) {
    it(`${name}: never finds a disk by label or by type, and defines the functions before calling them`, () => {
      expect(text).not.toMatch(/by-label|LABEL=|blkid -L/);
      expect(text).not.toContain("TYPE=crypto_LUKS");
      expect(text.indexOf("mount_boot_fs() {")).toBeGreaterThan(-1);
      expect(text.indexOf("mount_boot_fs() {")).toBeLessThan(text.indexOf('if mount_boot_fs "'));
    });
  }

  it("unlock: opens the LUKS volume pinned by the recorded UUID and fails closed otherwise", () => {
    const t = scripts.unlock;
    expect(t).toContain('LUKS_UUID="$(pinned_uuid "$R/boot/flagship-luks-uuid")" || fatal');
    expect(t).toContain('ROOT_LUKS_PART="$(device_by_uuid "$LUKS_UUID" crypto_LUKS 30)" || _lrc=$?');
  });

  it("the hook records both UUIDs into every initrd it builds, and the initrd check requires them", () => {
    const hook = buildUnlockHookScript();
    expect(hook).toContain('flagship_record_disk_uuids /etc/fstab /etc/crypttab "${DESTDIR}"');
    expect(hook.indexOf("flagship_record_disk_uuids() {")).toBeLessThan(hook.indexOf("flagship_record_disk_uuids /etc/fstab"));
    const paths = initrdExpectations([], 1).map((e) => e.path);
    expect(paths).toContain("boot/flagship-boot-fs-uuid");
    expect(paths).toContain("boot/flagship-luks-uuid");
  });
});
