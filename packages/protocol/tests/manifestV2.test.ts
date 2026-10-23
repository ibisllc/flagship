import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/manifest.js";
import { capabilitiesOf, capabilityDigest } from "../src/manifestCapabilities.js";
import { BOX_CAPABILITIES_0_3, admitApp, diffCapabilitiesV2, parseAnyManifest, type BoxRuntimeCapabilities } from "../src/manifestV2.js";

const v1 = () => ({
  schema_version: 1,
  name: "notes",
  version: "1.0.0",
  runtime: { base: "node-24", port: 8080 },
  data: { stores: { postgres: true, files: true } },
  network: { egress: [{ host: "api.example.com", why: "sync" }] },
});

const v2 = (extra: Record<string, unknown> = {}) => ({ ...v1(), schema_version: 2, ...extra });

const gpuBox: BoxRuntimeCapabilities = {
  accelerators: [{ backend: "nvidia-cuda", devices: 2, capabilities: ["compute", "video-encode"], sharing: ["exclusive", "partition"] }],
  isolation: ["sandbox", "vm"],
  wasiWorlds: ["command", "http-proxy"],
  appGroups: true,
};

function ok(input: unknown) {
  const r = parseAnyManifest(input);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.app;
}

describe("schema 1 stays as it was", () => {
  it("gives the v1 parser's manifest and the v1 capability digest", () => {
    const r1 = parseManifest(v1());
    const app = ok(v1());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(app.manifest).toEqual(r1.manifest);
    expect(app.schemaVersion).toBe(1);
    expect(app.isolation).toBe("sandbox");
    expect(app.capabilityDigest).toBe(capabilityDigest(capabilitiesOf(r1.manifest)));
  });

  it("refuses host-access fields instead of ignoring them", () => {
    for (const k of ["privileged", "devices", "cap_add", "host_network", "volumes"]) {
      const r = parseManifest({ ...v1(), [k]: true });
      expect(r.ok, k).toBe(false);
      if (!r.ok) expect(r.errors.join()).toContain(`${k} is not allowed`);
    }
    const rt = parseManifest({ ...v1(), runtime: { base: "node-24", port: 8080, privileged: true } });
    expect(rt.ok).toBe(false);
  });

  it("refuses a v2 field on a v1 manifest rather than dropping the GPU request", () => {
    const r = parseManifest({ ...v1(), accelerator: { backend: "nvidia-cuda" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("accelerator needs schema_version 2");
  });
});

describe("schema 2", () => {
  it("keeps the v1 digest when it asks for nothing new", () => {
    expect(ok(v2()).capabilityDigest).toBe(ok(v1()).capabilityDigest);
    expect(ok(v2({ resources: { memoryMiB: 1024 }, restart: "on-failure", health: { path: "/healthz" } })).capabilityDigest).toBe(ok(v1()).capabilityDigest);
  });

  it("normalizes an accelerator request with defaults", () => {
    const app = ok(v2({ accelerator: { backend: "nvidia-cuda", minimumMemoryMiB: 8192 } }));
    expect(app.accelerator).toEqual({ backend: "nvidia-cuda", count: 1, minimumMemoryMiB: 8192, capabilities: ["compute"], sharing: "exclusive", fallback: "none" });
    expect(app.capabilityDigest).not.toBe(ok(v1()).capabilityDigest);
  });

  it("makes a new accelerator a request for approval", () => {
    const before = ok(v2()).capabilities;
    const after = ok(v2({ accelerator: { backend: "amd-rocm" } })).capabilities;
    const d = diffCapabilitiesV2(before, after);
    expect(d.needsApproval).toBe(true);
    expect(d.expanded.map((c) => c.capability)).toContain("accelerator");
    expect(diffCapabilitiesV2(after, before).needsApproval).toBe(false);
  });

  it.each([
    [{ accelerator: { backend: "cuda" } }, "accelerator.backend"],
    [{ accelerator: { backend: "nvidia-cuda", count: 0 } }, "accelerator.count"],
    [{ accelerator: { backend: "nvidia-cuda", capabilities: ["compute", "compute"] } }, "accelerator.capabilities"],
    [{ accelerator: { backend: "nvidia-cuda", cdi: ["nvidia.com/gpu=all"] } }, "accelerator.cdi is not a recognized field"],
    [{ gpu: true }, "use accelerator"],
    [{ isolation: "none" }, "isolation must be one of"],
    [{ resources: { memoryMiB: 1 } }, "resources.memoryMiB"],
    [{ health: { path: "/../etc" } }, "health.path"],
    [{ health: { path: "/h", intervalSec: 5, timeoutSec: 10 } }, "cannot be longer"],
    [{ privileged: true }, "privileged is not allowed"],
    [{ runtime: { kind: "lambda", port: 80 } }, "runtime.kind"],
  ])("refuses %j", (extra, msg) => {
    const r = parseAnyManifest(v2(extra));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("; ")).toContain(msg);
  });

  it("parses a WASI runtime", () => {
    const app = ok(v2({ runtime: { kind: "wasi", module: "app.wasm", world: "http-proxy", port: 8080 } }));
    expect(app.runtimeKind).toBe("wasi");
    expect(app.wasi).toEqual({ module: "app.wasm", world: "http-proxy" });
    expect(app.capabilities.runtimeKind).toBe("wasi");
    expect(parseAnyManifest(v2({ runtime: { kind: "wasi", module: "../x.wasm", port: 1 } })).ok).toBe(false);
    expect(parseAnyManifest(v2({ runtime: { kind: "wasi", module: "a.wasm", image: "x", port: 1 } })).ok).toBe(false);
    expect(parseAnyManifest(v2({ runtime: { kind: "wasi", module: "a.wasm", port: 1 }, accelerator: { backend: "nvidia-cuda" } })).ok).toBe(false);
  });

  it("parses an app group and checks its start order", () => {
    const app = ok(
      v2({
        components: [
          { name: "worker", base: "python-3.13", start: ["python", "worker.py"], startAfter: ["cache"] },
          { name: "cache", image: "registry.example/cache@sha256:" + "a".repeat(64), port: 6379 },
        ],
      }),
    );
    expect(app.components.map((c) => c.name)).toEqual(["worker", "cache"]);
    const cyc = parseAnyManifest(v2({ components: [{ name: "a", base: "static", startAfter: ["b"] }, { name: "b", base: "static", startAfter: ["a"] }] }));
    expect(cyc.ok).toBe(false);
    const priv = parseAnyManifest(v2({ components: [{ name: "a", base: "static", devices: ["/dev/kvm"] }] }));
    expect(priv.ok).toBe(false);
    const clash = parseAnyManifest(v2({ components: [{ name: "notes", base: "static" }] }));
    expect(clash.ok).toBe(false);
  });

  it("refuses an unknown schema version", () => {
    expect(parseAnyManifest({ ...v1(), schema_version: 3 }).ok).toBe(false);
  });
});

describe("admission", () => {
  it("a 0.3 box refuses every v2 capability, with a reason", () => {
    const app = ok(
      v2({ accelerator: { backend: "nvidia-cuda" }, isolation: "vm", components: [{ name: "worker", base: "static" }] }),
    );
    const r = admitApp(app, BOX_CAPABILITIES_0_3);
    expect(r.ok).toBe(false);
    expect(r.refusals.map((x) => x.code).sort()).toEqual(["accelerator-unavailable", "app-groups-unavailable", "isolation-unavailable"]);
  });

  it("admits a plain app on a 0.3 box", () => {
    expect(admitApp(ok(v1()), BOX_CAPABILITIES_0_3)).toEqual({ ok: true, refusals: [], placement: "cpu" });
  });

  it("places a GPU app on a qualified accelerator", () => {
    const r = admitApp(ok(v2({ accelerator: { backend: "nvidia-cuda", count: 2, capabilities: ["compute", "video-encode"], sharing: "partition" } })), gpuBox);
    expect(r).toEqual({ ok: true, refusals: [], placement: "accelerator" });
  });

  it("never claims CUDA on another vendor", () => {
    const r = admitApp(ok(v2({ accelerator: { backend: "amd-rocm" } })), gpuBox);
    expect(r.ok).toBe(false);
    expect(r.refusals[0]?.code).toBe("accelerator-unavailable");
  });

  it("falls back to CPU only when the app said it can", () => {
    const want = (fallback: string) => ok(v2({ accelerator: { backend: "nvidia-cuda", capabilities: ["graphics"], fallback } }));
    expect(admitApp(want("none"), gpuBox).refusals[0]?.code).toBe("accelerator-capability");
    expect(admitApp(want("cpu-if-supported"), gpuBox)).toEqual({ ok: true, refusals: [], placement: "cpu-fallback" });
  });

  it("refuses cooperative sharing the box has not enabled", () => {
    const r = admitApp(ok(v2({ accelerator: { backend: "nvidia-cuda", sharing: "cooperative" } })), gpuBox);
    expect(r.refusals.map((x) => x.code)).toEqual(["accelerator-sharing"]);
  });
});
