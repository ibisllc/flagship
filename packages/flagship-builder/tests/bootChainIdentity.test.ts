/**
 * The installer and the boot chain refresh write the same bytes. The bootstrap's heredocs are run
 * through a real shell (so quoting and expansion are the shell's, not ours) and every file they
 * write must equal what the refresh generates, both from the install's inputs and from reading the
 * installed scripts back the way the refresh does on a box.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVED_BOOT_HOSTS,
  UNLOCK_PREMOUNT_PATH,
  WIFI_PREMOUNT_PATH,
  bootChainScripts,
  installedBootChainInputs,
  type BootChainInputs,
} from "@flagship/boot-chain";
import { buildBootstrapScript, type BootstrapTemplateArgs } from "../src/userdata.js";

const BASE: BootstrapTemplateArgs = {
  ref: "a".repeat(40),
  repoUrl: "https://github.com/ibisllc/flagship",
  encryptRoot: true,
  bootUnlockMode: "approve",
  bootHost: "https://boot.flagshipserver.com",
};

/** Run every `cat > /etc/initramfs-tools/… <<'TAG'` of the bootstrap into `root`; returns path → bytes. */
function installedByBootstrap(bootstrap: string, root: string): Map<string, { text: string; chmodX: boolean }> {
  const re = /cat > (\/etc\/initramfs-tools\/\S+) <<('?)([A-Z]+)\2\n([\s\S]*?)\n\3\n/g;
  const found = new Map<string, { text: string; chmodX: boolean }>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(bootstrap))) {
    const target = join(root, m[1]!.replace(/\//g, "_"));
    const r = spawnSync("bash", ["-c", `cat > '${target}' <<${m[2]}${m[3]}${m[2]}\n${m[4]}\n${m[3]}\n`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    found.set(m[1]!, { text: readFileSync(target, "utf8"), chmodX: bootstrap.includes(`chmod +x ${m[1]}\n`) });
  }
  return found;
}

const cases: Array<{ name: string; args: Partial<BootstrapTemplateArgs>; inputs: BootChainInputs }> = [
  { name: "wired", args: {}, inputs: { approvedHosts: APPROVED_BOOT_HOSTS } },
  { name: "auto unlock", args: { bootUnlockMode: "auto" }, inputs: { approvedHosts: APPROVED_BOOT_HOSTS } },
  {
    name: "an extra approved boot host",
    args: { approvedBootHosts: [...APPROVED_BOOT_HOSTS, "boot.acme-enterprise.example"], bootHost: "https://boot.acme-enterprise.example" },
    inputs: { approvedHosts: [...APPROVED_BOOT_HOSTS, "boot.acme-enterprise.example"] },
  },
  { name: "Wi-Fi", args: { wifiSSID: "HomeNet", wifiPassword: "hunter2hunter2" }, inputs: { approvedHosts: APPROVED_BOOT_HOSTS, wifi: { ssid: "HomeNet", psk: "hunter2hunter2" } } },
  {
    name: "Wi-Fi with shell characters",
    args: { wifiSSID: "Café O'Brien $HOME", wifiPassword: "pa ss'w\"ord `id` $(reboot) \\n" },
    inputs: { approvedHosts: APPROVED_BOOT_HOSTS, wifi: { ssid: "Café O'Brien $HOME", psk: "pa ss'w\"ord `id` $(reboot) \\n" } },
  },
];

describe("installer and refresh write the same boot chain", () => {
  for (const c of cases) {
    it(c.name, () => {
      const root = mkdtempSync(join(tmpdir(), "bootchain-id-"));
      try {
        const installed = installedByBootstrap(buildBootstrapScript({ ...BASE, ...c.args }), root);
        const generated = bootChainScripts(c.inputs);
        expect([...installed.keys()].sort()).toEqual(generated.map((s) => s.path).sort());
        for (const s of generated) {
          expect(installed.get(s.path)?.text, s.path).toBe(s.content);
          expect(installed.get(s.path)?.chmodX, s.path).toBe(true);
          expect(s.mode).toBe(0o755);
        }
        // What the refresh reads back from the box gives the same pieces again.
        const readBack = installedBootChainInputs(installed.get(UNLOCK_PREMOUNT_PATH)?.text ?? null, installed.get(WIFI_PREMOUNT_PATH)?.text ?? null);
        expect(readBack).toEqual(c.inputs);
        expect(bootChainScripts(readBack!)).toEqual(generated);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("a plain (unencrypted) install writes no boot chain", () => {
    expect(buildBootstrapScript({ ...BASE, encryptRoot: false })).not.toContain("/etc/initramfs-tools/");
  });

  it("refuses Wi-Fi text that could end the script that carries it", () => {
    expect(() => buildBootstrapScript({ ...BASE, wifiSSID: "a\nWIFIPREMOUNT\nb", wifiPassword: "12345678" })).toThrow(/control character/);
  });
});
