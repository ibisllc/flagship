import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOOT_FS_MOUNT_SH } from "../src/bootFsMount.js";
import { buildUnlockPremountFile, buildWifiPremountScript } from "../src/index.js";

// The mount of FLAGSHIP_BOOT at init-premount: the by-label link may not exist yet and ext4 is not
// loaded (RELEASE-0.3-JOURNAL B0). Run the shell function itself against stub mount/modprobe.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bootfs-"));
  for (const t of ["mount", "modprobe"]) {
    writeFileSync(join(dir, t), `#!/bin/sh\necho "${t} $*" >> "${dir}/calls"\n[ "${t}" = mount ] && [ -e "${dir}/mount-fails" ] && exit 1\nexit 0\n`);
    chmodSync(join(dir, t), 0o755);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(body: string, env: Record<string, string> = {}): number {
  try {
    execFileSync("/bin/sh", ["-c", `${BOOT_FS_MOUNT_SH}\n${body}`], {
      env: { PATH: `${dir}:/usr/bin:/bin`, FLAGSHIP_BOOT_NODE: join(dir, "node"), ...env },
      stdio: "pipe",
    });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
}
const calls = () => {
  try {
    return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
};

describe("mount_boot_fs", () => {
  it("loads ext4 first and mounts the label as ext4, never by guessing the type", () => {
    writeFileSync(join(dir, "node"), "");
    expect(run('mount_boot_fs /mnt')).toBe(0);
    expect(calls()).toEqual(["modprobe ext4", `mount -t ext4 ${join(dir, "node")} /mnt`]);
  });

  it("waits for the by-label link that udev has not made yet", () => {
    execFileSync("/bin/sh", ["-c", `(sleep 1; : > "${join(dir, "node")}") &`]);
    expect(run("mount_boot_fs /mnt", { FLAGSHIP_BOOT_WAIT_SECS: "10" })).toBe(0);
    expect(calls().at(-1)).toBe(`mount -t ext4 ${join(dir, "node")} /mnt`);
  });

  it("gives up after the wait and reports the failed mount rather than hanging", () => {
    writeFileSync(join(dir, "mount-fails"), "");
    expect(run("mount_boot_fs /mnt", { FLAGSHIP_BOOT_WAIT_SECS: "0" })).toBe(1);
  });
});

describe("both premount scripts use it", () => {
  const scripts = {
    unlock: buildUnlockPremountFile(),
    wifi: buildWifiPremountScript("net", "pass1234"),
  };
  for (const [name, text] of Object.entries(scripts)) {
    it(`${name}: no bare mount of the label, and the function is defined before it is called`, () => {
      expect(text).not.toMatch(/mount \/dev\/disk\/by-label\/FLAGSHIP_BOOT/);
      expect(text.indexOf("mount_boot_fs() {")).toBeGreaterThan(-1);
      expect(text.indexOf("mount_boot_fs() {")).toBeLessThan(text.indexOf('if mount_boot_fs "'));
    });
  }
});
