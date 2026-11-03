import { describe, expect, it } from "vitest";
import { noCloudMetaData, qemuArgs, releaseListsArch } from "../lib/arm64Box.js";

const C = "a".repeat(40);

describe("arm64 lane helpers", () => {
  it("finds an arm64 artifact only for that exact commit", () => {
    const idx = { releases: [{ commit: C, sequence: 3, arch: ["amd64", "arm64"] }, { commit: "b".repeat(40), arch: ["amd64"] }] };
    expect(releaseListsArch(idx, C, "arm64")).toBe(true);
    expect(releaseListsArch(idx, "b".repeat(40), "arm64")).toBe(false);
    expect(releaseListsArch(idx, "c".repeat(40), "amd64")).toBe(false);
    expect(releaseListsArch({ releases: [{ commit: C, arch: "arm64" }] }, C, "arm64")).toBe(false);
    expect(releaseListsArch(null, C, "arm64")).toBe(false);
  });
  it("builds an HVF virt guest with only loopback SSH forwarded", () => {
    const a = qemuArgs({ firmwareCode: "/fw/c", firmwareVars: "/w/v", disk: "/w/d", seed: "/w/s", console: "/w/con", monitor: "/w/m", pidFile: "/w/p" }, { cpus: 4, memoryMiB: 6144, sshPort: 2241 });
    expect(a.slice(0, 6)).toEqual(["-M", "virt", "-accel", "hvf", "-cpu", "host"]);
    expect(a).toContain("user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:2241-:22");
    expect(a).toContain("file=/w/s,if=virtio,format=raw,readonly=on");
    expect(qemuArgs({ firmwareCode: "", firmwareVars: "", disk: "", seed: "", console: "", monitor: "", pidFile: "" }, { cpus: 1, memoryMiB: 1, sshPort: 1, accel: "tcg" }).slice(2, 6)).toEqual(["-accel", "tcg", "-cpu", "max"]);
  });
  it("writes NoCloud meta-data and refuses an unsafe instance id", () => {
    expect(noCloudMetaData("flagship-arm64-1a2b")).toBe("instance-id: flagship-arm64-1a2b\nlocal-hostname: flagship-pod\n");
    expect(() => noCloudMetaData("x\ny")).toThrow();
  });
});
