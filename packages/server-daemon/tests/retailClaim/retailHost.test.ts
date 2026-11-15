import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RETAIL_BLUEZ_CALLS,
  RETAIL_CLAIM_HELPER_UNIT,
  RETAIL_CLAIM_UNIT,
  RETAIL_CLAIM_USER,
  RETAIL_DAEMON_DROP_IN,
  RETAIL_DAEMON_USER,
  retailHostSetupScript,
  RETAIL_DBUS_POLICY,
  RETAIL_HOST_FILES,
  RETAIL_POWER_KEY_GROUP,
  RETAIL_POWER_KEY_UDEV_RULE,
  type RetailHostFile,
} from "@flagship/boot-chain";
import { UNSET_ENV_LINE } from "@flagship/privd/unit";
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
    // The claim account (a box with no owner yet) and the daemon's (a box with one), the same calls each.
    expect(RETAIL_DAEMON_USER).toBe(DAEMON_USER);
    const blocks = [...RETAIL_DBUS_POLICY.matchAll(/<policy user="([a-z-]+)">([\s\S]*?)<\/policy>/g)];
    expect(blocks.map((b) => b[1])).toEqual([RETAIL_CLAIM_USER, DAEMON_USER]);
    for (const b of blocks) {
      for (const [i, m] of RETAIL_BLUEZ_CALLS) expect(b[2]).toContain(`send_interface="${i}" send_member="${m}"`);
      expect(b[2]!.split("\n").filter((l) => l.includes("<allow"))).toHaveLength(RETAIL_BLUEZ_CALLS.length);
    }
    const allows = RETAIL_DBUS_POLICY.split("\n").filter((l) => l.includes("<allow"));
    expect(allows).toHaveLength(2 * RETAIL_BLUEZ_CALLS.length);
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

  it("the claim service runs unprivileged and hardened, and only while the box has no owner", () => {
    const u = RETAIL_CLAIM_UNIT;
    const has = (line: string) => expect(u.split("\n"), line).toContain(line);
    has("User=flagship-claim");
    has("Group=flagship-claim");
    has("SupplementaryGroups=flagship-keyd-clients flagship-powerkey");
    for (const line of [
      "NoNewPrivileges=yes", "CapabilityBoundingSet=", "AmbientCapabilities=", "ProtectSystem=strict", "ReadWritePaths=/var/lib/flagship-retail",
      "ProtectHome=yes", "PrivateTmp=yes", "DevicePolicy=closed", "DeviceAllow=char-input r", "DeviceAllow=/dev/tty1 w",
      "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes", "ProtectClock=yes",
      "RestrictNamespaces=yes", "RestrictSUIDSGID=yes", "LockPersonality=yes", "SystemCallArchitectures=native", "LimitCORE=0",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK AF_BLUETOOTH",
      "Environment=FLAGSHIP_DAEMON_UNPRIVILEGED=1", "Environment=FLAGSHIP_PRIVD_SOCKET=/run/flagship-claim-helper/helper.sock",
      "ConditionPathExists=!/var/lib/flagship-retail/first-boot-done", UNSET_ENV_LINE,
    ]) has(line);
    expect(u).toContain("packages/server-daemon/dist/retailClaim/claimMain.js");
    expect(u).not.toMatch(/^User=root|^AmbientCapabilities=CAP|SupplementaryGroups=.*\b(bluetooth|input|tty|flagship)\b(?!-)/m);
    // Only the ExecStartPre that hands the claim folder to the account runs as root.
    expect(u.split("\n").filter((l) => l.includes("=+"))).toEqual([expect.stringMatching(/^ExecStartPre=\+\/bin\/sh -c 'install -d -m 0700 -o flagship-claim/)]);
    expect(retailHostSetupScript()).toContain("useradd --system --gid flagship-claim --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin flagship-claim");
  });

  it("the claim helper is the broker in its retail-claim profile, on a socket only the claim account opens", () => {
    const h = RETAIL_CLAIM_HELPER_UNIT;
    expect(h).toContain("/opt/flagship/packages/privd/dist/main.js --profile retail-claim --socket /run/flagship-claim-helper/helper.sock --socket-group flagship-claim");
    expect(h).toContain("ConditionPathExists=!/var/lib/flagship-retail/first-boot-done");
    expect(h).toContain("NoNewPrivileges=yes");
    expect(h.split("\n")).toContain(UNSET_ENV_LINE);
  });

  it("the daemon starts only once a claim's first boot is done", () => {
    expect(RETAIL_DAEMON_DROP_IN.split("\n")).toContain("ConditionPathExists=/var/lib/flagship-retail/first-boot-done");
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
    expect(ran.filter((r) => !r.startsWith("sh -c "))).toEqual([]);
  });

  it("does nothing without root", async () => {
    const ran: string[] = [];
    const cmd = { run: async (c: string) => void ran.push(c) };
    expect(await ensureRetailHostConfig(() => {}, cmd as never, { files: [], isRoot: false })).toEqual([]);
    expect(ran).toEqual([]);
  });
});
