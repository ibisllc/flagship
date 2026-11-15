import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RETAIL_BLUEZ_CALLS,
  RETAIL_DAEMON_DROP_IN,
  RETAIL_DBUS_POLICY,
  RETAIL_HOST_FILES,
  RETAIL_POWER_KEY_GROUP,
  RETAIL_POWER_KEY_UDEV_RULE,
  type RetailHostFile,
} from "@flagship/boot-chain";
import { DAEMON_USER } from "../../src/privileged.js";
import { ensureRetailHostConfig } from "../../src/retailClaim/daemon.js";

const bluezSource = readFileSync(fileURLToPath(new URL("../../src/retailClaim/bluez.ts", import.meta.url)), "utf8");

/** Every `bus.call` to BlueZ in bluez.ts, as [interface, member] with the file's constants resolved. */
function bluezCalls(): Array<[string, string]> {
  const consts = new Map<string, string>();
  for (const m of bluezSource.matchAll(/^const ([A-Z_]+) = "([^"]+)";/gm)) consts.set(m[1]!, m[2]!);
  const out: Array<[string, string]> = [];
  for (const m of bluezSource.matchAll(/destination: BLUEZ, path: [^,]+, interface: ([A-Z_]+), member: "([A-Za-z]+)"/g)) {
    out.push([consts.get(m[1]!) ?? m[1]!, m[2]!]);
  }
  return out;
}

describe("retail host files", () => {
  it("the D-Bus policy allows exactly the BlueZ calls the claim peripheral makes, for the daemon's user", () => {
    const calls = bluezCalls();
    expect(calls.length).toBeGreaterThan(5);
    const key = (c: readonly [string, string]) => `${c[0]}.${c[1]}`;
    expect(new Set(calls.map(key))).toEqual(new Set(RETAIL_BLUEZ_CALLS.map(key)));
    expect(RETAIL_DBUS_POLICY).toContain(`<policy user="${DAEMON_USER}">`);
    const allows = RETAIL_DBUS_POLICY.split("\n").filter((l) => l.includes("<allow"));
    expect(allows).toHaveLength(RETAIL_BLUEZ_CALLS.length);
    for (const l of allows) expect(l).toMatch(/send_destination="org\.bluez" send_interface="[A-Za-z0-9.]+" send_member="[A-Za-z]+"/);
    expect(RETAIL_DBUS_POLICY).not.toMatch(/group=|context=|own=/);
  });

  it("no bluetooth or input group: the daemon reads only the power button", () => {
    expect(RETAIL_DAEMON_DROP_IN).toMatch(new RegExp(`^SupplementaryGroups=${RETAIL_POWER_KEY_GROUP}$`, "m"));
    expect(RETAIL_DAEMON_DROP_IN).not.toMatch(/SupplementaryGroups=.*\b(bluetooth|input)\b/);
    const rules = RETAIL_POWER_KEY_UDEV_RULE.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(rules).toHaveLength(2);
    for (const r of rules) expect(r).toMatch(new RegExp(`ATTRS\\{name\\}=="(Power Button|pwr_button)", GROUP="${RETAIL_POWER_KEY_GROUP}", MODE="0640"$`));
  });

  it("puts back what went missing, reloads only what changed, and is quiet the second time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retail-host-"));
    const files: RetailHostFile[] = RETAIL_HOST_FILES.map((f) => ({ ...f, path: join(dir, f.path) }));
    const ran: string[] = [];
    const cmd = { run: async (c: string, a: string[]) => void ran.push(`${c} ${a.join(" ")}`) };
    const reloads = await ensureRetailHostConfig(() => {}, cmd as never, { files, isRoot: true });
    expect(new Set(reloads)).toEqual(new Set(["bluetooth", "logind", "dbus", "udev", "systemd"]));
    for (const f of files) {
      expect(readFileSync(f.path, "utf8")).toBe(f.content);
      expect(statSync(f.path).mode & 0o777).toBe(0o644);
    }
    expect(ran).toContain(`sh -c getent group ${RETAIL_POWER_KEY_GROUP} >/dev/null || groupadd --system ${RETAIL_POWER_KEY_GROUP}`);
    expect(ran).toContain("systemctl reload dbus.service");
    expect(ran).toContain("udevadm control --reload");
    expect(ran).toContain("systemctl restart bluetooth");
    ran.length = 0;
    expect(await ensureRetailHostConfig(() => {}, cmd as never, { files, isRoot: true })).toEqual([]);
    expect(ran.filter((r) => !r.startsWith("sh -c getent"))).toEqual([]);
  });

  it("does nothing without root", async () => {
    const ran: string[] = [];
    const cmd = { run: async (c: string) => void ran.push(c) };
    expect(await ensureRetailHostConfig(() => {}, cmd as never, { files: [], isRoot: false })).toEqual([]);
    expect(ran).toEqual([]);
  });
});
