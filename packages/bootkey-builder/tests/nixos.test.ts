import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBuild, type BuildSpec } from "../src/buildPlan.js";
import { renderNixosFiles, nixosConfigFiles } from "../src/nixos.js";
import { materializePlan } from "../src/imageBuilder.js";

function spec(over: Partial<BuildSpec> = {}): BuildSpec {
  return {
    userId: "harry",
    newServerId: "srv-001",
    irkPublicKey: new Uint8Array(32).fill(1),
    bakPublicKey: new Uint8Array(32).fill(2),
    swkProvisioningTokenHash: new Uint8Array(32).fill(3),
    wifi: { ssid: "HomeNet", psk: "supersecret" },
    shareRatio: 0.5,
    totalDiskGb: 100,
    issuedAt: 1700000000000,
    ...over,
  };
}

describe("renderNixosFiles", () => {
  it("disables sshd (the no-SSH policy)", () => {
    const out = renderNixosFiles(planBuild(spec()));
    expect(out.configuration).toContain("services.openssh.enable = false");
  });

  it("encodes the Wi-Fi SSID into a wireless network", () => {
    const out = renderNixosFiles(planBuild(spec({ wifi: { ssid: "MyWifi", psk: "x" } })));
    expect(out.configuration).toContain('networks."MyWifi"');
  });

  it("escapes hostile SSID characters (no shell-injection through nix strings)", () => {
    const out = renderNixosFiles(
      planBuild(spec({ wifi: { ssid: 'evil"; ${something}', psk: "x" } })),
    );
    // String must remain inside quotes — we don't allow $ or " to break out.
    expect(out.configuration).not.toMatch(/networks\.evil";/);
    expect(out.configuration).toContain("\\$");
  });

  it("declares oci-containers backed by podman with the planned system containers", () => {
    const out = renderNixosFiles(planBuild(spec()));
    expect(out.containers).toContain('virtualisation.oci-containers.backend = "podman"');
    expect(out.containers).toContain("forgejo");
    expect(out.containers).toContain("caddy");
    expect(out.containers).toContain("codeberg.org/forgejo/forgejo");
  });

  it("turns on nix-ld so users can run dynamically-linked binaries on the host as a fallback", () => {
    const out = renderNixosFiles(planBuild(spec()));
    expect(out.configuration).toContain("programs.nix-ld.enable = true");
  });

  it("declares LUKS devices for every encrypted partition by partlabel", () => {
    const plan = planBuild(spec({ shareRatio: 0.5 }));
    const out = renderNixosFiles(plan);
    expect(out.hardware).toContain('"luks-system"');
    expect(out.hardware).toContain('"luks-user-data"');
    expect(out.hardware).toContain('"luks-peer-backup-pool"');
    expect(out.hardware).toContain("preLVM = true");
  });

  it("references the materialized server.json as FLAGSHIP_CONFIG and runs server-daemon under the flagship user", () => {
    const out = renderNixosFiles(planBuild(spec()));
    expect(out.configuration).toContain('FLAGSHIP_CONFIG=/etc/flagship/server.json');
    expect(out.configuration).toContain("User = \"flagship\"");
  });
});

describe("nixosConfigFiles output paths", () => {
  it("emits flake.nix, configuration.nix, containers.nix, and hardware-configuration.nix at /etc/nixos/", () => {
    const files = nixosConfigFiles(planBuild(spec()));
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "/etc/nixos/configuration.nix",
      "/etc/nixos/containers.nix",
      "/etc/nixos/flake.nix",
      "/etc/nixos/hardware-configuration.nix",
    ]);
  });

  it("flake declares a system named 'flagship'", () => {
    const files = nixosConfigFiles(planBuild(spec()));
    const flake = files.find((f) => f.path.endsWith("flake.nix"))!;
    expect(flake.content).toContain("nixosConfigurations.flagship");
  });
});

describe("materializePlan integration with NixOS files", () => {
  it("writes the four nixos files into the rootfs tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flagship-nixos-"));
    const artifacts = await materializePlan(planBuild(spec()), dir);
    const flake = await readFile(join(artifacts.rootfsDir, "etc/nixos/flake.nix"), "utf8");
    expect(flake).toContain("nixosConfigurations.flagship");
    const cfg = await readFile(join(artifacts.rootfsDir, "etc/nixos/configuration.nix"), "utf8");
    expect(cfg).toContain("services.openssh.enable = false");
  });
});
