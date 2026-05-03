import { describe, expect, it } from "vitest";
import { planBuild, type BuildSpec } from "../src/buildPlan.js";

const baseSpec: BuildSpec = {
  userId: "u1",
  newServerId: "srv-1",
  irkPublicKey: new Uint8Array(32).fill(1),
  bakPublicKey: new Uint8Array(32).fill(2),
  swkProvisioningTokenHash: new Uint8Array(32).fill(3),
  wifi: { ssid: "Home", psk: "secret123" },
  shareRatio: 0.5,
  totalDiskGb: 100,
  issuedAt: 1_700_000_000_000,
};

describe("planBuild", () => {
  it("partitions disk correctly when shareRatio = 0.5", () => {
    const plan = planBuild(baseSpec);
    const sizes = Object.fromEntries(plan.partitions.map((p) => [p.name, p.sizeGb]));
    expect(sizes.system).toBe(8);
    expect(sizes["user-data"]).toBe(46);
    expect(sizes["peer-backup-pool"]).toBe(46);
  });

  it("omits peer-backup partition when shareRatio = 0", () => {
    const plan = planBuild({ ...baseSpec, shareRatio: 0 });
    const names = plan.partitions.map((p) => p.name);
    expect(names).not.toContain("peer-backup-pool");
    expect(names).toContain("user-data");
    const userSize = plan.partitions.find((p) => p.name === "user-data")!.sizeGb;
    expect(userSize).toBe(92);
  });

  it("encrypts every partition (encrypted-by-default)", () => {
    const plan = planBuild(baseSpec);
    for (const p of plan.partitions) expect(p.encrypted).toBe(true);
  });

  it("rejects shareRatio outside [0, 0.9]", () => {
    expect(() => planBuild({ ...baseSpec, shareRatio: -0.1 })).toThrow(/shareRatio/);
    expect(() => planBuild({ ...baseSpec, shareRatio: 0.95 })).toThrow(/shareRatio/);
  });

  it("rejects too-small disks", () => {
    expect(() => planBuild({ ...baseSpec, totalDiskGb: 8 })).toThrow(/totalDiskGb/);
  });

  it("rejects malformed pubkeys", () => {
    expect(() => planBuild({ ...baseSpec, irkPublicKey: new Uint8Array(16) })).toThrow(
      /irkPublicKey/,
    );
  });

  it("emits flagship-server-daemon and tunnel as systemd units", () => {
    const plan = planBuild(baseSpec);
    expect(plan.systemdUnits).toContain("flagship-server-daemon.service");
    expect(plan.systemdUnits).toContain("flagship-tunnel.service");
  });

  it("ships forgejo and caddy as pre-installed system containers", () => {
    const plan = planBuild(baseSpec);
    const names = plan.systemContainers.map((c) => c.name);
    expect(names).toContain("forgejo");
    expect(names).toContain("caddy");
    const forgejo = plan.systemContainers.find((c) => c.name === "forgejo")!;
    expect(forgejo.subdomain).toBe("git");
    expect(forgejo.image).toMatch(/forgejo/);
  });

  it("writes wifi config with provided SSID and PSK", () => {
    const plan = planBuild({ ...baseSpec, wifi: { ssid: "MyNet", psk: "p@ss" } });
    const wifi = plan.configFiles.find((f) => f.path.includes("wpa_supplicant"));
    expect(wifi).toBeDefined();
    expect(wifi!.content).toContain('ssid="MyNet"');
    expect(wifi!.content).toContain('psk="p@ss"');
    expect(wifi!.mode).toBe(0o600);
  });

  it("escapes quote characters in WiFi SSID and PSK", () => {
    const plan = planBuild({
      ...baseSpec,
      wifi: { ssid: 'evil"net', psk: 'p"ass' },
    });
    const wifi = plan.configFiles.find((f) => f.path.includes("wpa_supplicant"))!;
    expect(wifi.content).toContain('ssid="evil\\"net"');
    expect(wifi.content).toContain('psk="p\\"ass"');
  });

  it("writes server.json with hex-encoded keys", () => {
    const plan = planBuild(baseSpec);
    const cfg = plan.configFiles.find((f) => f.path.endsWith("server.json"))!;
    const parsed = JSON.parse(cfg.content);
    expect(parsed.serverId).toBe("srv-1");
    expect(parsed.userId).toBe("u1");
    expect(parsed.irkPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.bakPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.swkProvisioningTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.mode).toBe(0o600);
  });

  it("writes share-ratio config file", () => {
    const plan = planBuild({ ...baseSpec, shareRatio: 0.33 });
    const sr = plan.configFiles.find((f) => f.path.endsWith("share-ratio"))!;
    expect(sr.content.trim()).toBe("0.33");
  });
});
