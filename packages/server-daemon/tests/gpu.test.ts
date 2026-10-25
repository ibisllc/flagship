// The daemon's side of the GPU allocator (gpu/): the gpud client and framing, the argument shape
// re-check, manifest → requirement/approval, the AppRunner claim/release hook, the owner's screen
// and the flagship-gpud installer. A fake gpud speaks the real framing on a Unix socket.
import { createServer, type Server } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppAccelerator } from "@flagship/protocol";
import { gpudClient, GpudError } from "../src/gpu/client.js";
import {
  AcceleratorBroker,
  AppAccelerators,
  approvalForApp,
  checkGpuArgs,
  gpuIsolationFor,
  requirementFromManifest,
  type AppAcceleratorRequest,
} from "../src/gpu/broker.js";
import { buildAcceleratorsHttp, toAcceleratorsResponse } from "../src/gpu/http.js";
import { gpudUnit, installGpud, type GpudInstallDeps } from "../src/gpu/unit.js";
import { AppRunner, setAcceleratorHook, type CommandRunner } from "../src/serviceRunner.js";

type Handler = (op: string, args: Record<string, unknown>) => { ok: true; result: unknown } | { ok: false; code: string; message: string };

let dir: string;
let server: Server | null = null;

function fakeGpud(handler: Handler): string {
  const sock = join(dir, "g.sock");
  server = createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (buf.length < 4 + n) return;
        const req = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
        buf = buf.subarray(4 + n);
        const r = req.op === "hello" ? { ok: true, result: { version: 1 } } : handler(req.op, req.args);
        const body = Buffer.from(JSON.stringify({ id: req.id, ...r }));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length, 0);
        c.write(Buffer.concat([head, body]));
      }
    });
  });
  server.listen(sock);
  return sock;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gpu-"));
});
afterEach(async () => {
  setAcceleratorHook(null);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

const ACC: AppAccelerator = { backend: "nvidia-cuda", count: 1, minimumMemoryMiB: 4096, capabilities: ["compute"], sharing: "exclusive", fallback: "none" };
const APP = { appId: "alice-llm", installationId: "alice-llm-1", generation: 3 };
const GPU_ARGS = ["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=0", "--label", "flagship.gpu.allocation=a1"];

function inventory(available: boolean) {
  return {
    available,
    reason: available ? null : "no-accelerators",
    devices: available
      ? [{ id: "gpu-aa", vendor: "nvidia", backend: "nvidia-cuda", model: "RTX", memoryMiB: 24564, displayOwned: false, qualified: [{ profile: "gvisor-nvproxy", entry: "e" }], unqualifiedReasons: [], quarantined: null, holders: [], partitions: [] }]
      : [],
    unavailable: [],
    admissionPaused: null,
    catalog: { status: "verified", serial: 4 },
  };
}

describe("the argument shape", () => {
  it("allows a GPU runtime, CDI names, VFIO groups, the label and the budgets only", () => {
    expect(() => checkGpuArgs(GPU_ARGS)).not.toThrow();
    expect(() => checkGpuArgs(["--runtime=kata-vfio", "--device", "flagship.vfio/group=12", "-e", "FLAGSHIP_GPU_MEMORY_BUDGET_MIB=4096"])).not.toThrow();
    for (const bad of [
      ["--device", "nvidia.com/gpu=0"],
      ["--runtime=runc"],
      ["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=all"],
      ["--runtime=runsc-nvproxy", "--device", "/dev/nvidia0"],
      ["--runtime=kata-vfio", "--device", "/dev/vfio/12"],
      ["--runtime=runsc-nvproxy", "--device", "example.com/gpu=0"],
      ["--runtime=runsc-nvproxy", "--privileged"],
      ["--runtime=runsc-nvproxy", "--gpus", "all"],
      ["--runtime=runsc-nvproxy", "-v", "/:/host"],
      ["--runtime=runsc-nvproxy", "-e", "LD_PRELOAD=/x.so"],
      ["--runtime=runsc-nvproxy", "--label", "owner=me"],
      ["--runtime=runsc-nvproxy", "--runtime=kata-vfio"],
    ]) {
      expect(() => checkGpuArgs(bad), bad.join(" ")).toThrow();
    }
  });
});

describe("manifest and approval", () => {
  it("maps the manifest's accelerator and never weakens isolation", () => {
    expect(requirementFromManifest(ACC)).toEqual({ backend: "nvidia-cuda", count: 1, minimumMemoryMiB: 4096, capabilities: ["compute"], sharing: "exclusive", fallback: "none" });
    expect(gpuIsolationFor("sandbox", "nvidia-cuda")).toBe("gvisor-nvproxy");
    expect(gpuIsolationFor("sandbox", "amd-rocm")).toBeNull();
    expect(gpuIsolationFor("vm", "intel-level-zero")).toBe("vm-passthrough");
    expect(approvalForApp(APP, { ...ACC, backend: "amd-rocm" }, "sandbox", { secrecy: true })).toHaveProperty("refused");
    expect(approvalForApp(APP, { ...ACC, sharing: "cooperative" }, "sandbox", { secrecy: false })).toHaveProperty("refused");
    const a = approvalForApp(APP, ACC, "sandbox", { secrecy: true });
    expect(a).toMatchObject({ isolation: "gvisor-nvproxy", policies: ["exclusive"], secrecy: true, trustDomain: null });
  });
});

describe("the gpud client", () => {
  it("says hello first and surfaces gpud's refusal codes", async () => {
    const seen: string[] = [];
    const sock = fakeGpud((op) => {
      seen.push(op);
      return op === "gpu.claim" ? { ok: false, code: "forbidden", message: "approval is for a different app" } : { ok: true, result: { fine: true } };
    });
    const call = gpudClient(sock, 5000);
    await expect(call("gpu.status")).resolves.toEqual({ fine: true });
    await expect(call("gpu.claim", {})).rejects.toMatchObject({ code: "forbidden" });
    expect(seen).toEqual(["gpu.status", "gpu.claim"]);
  });

  it("is honest when there is no GPU service", async () => {
    const b = new AcceleratorBroker(gpudClient(join(dir, "missing.sock"), 2000), { engine: "podman" });
    const inv = await b.inventory();
    expect(inv).toMatchObject({ available: false, reason: "no-gpu-service", devices: [] });
  });
});

/** The owner's signature reaches gpud as given: gpud, not the daemon, checks it. */
const PROOF = { issuedAt: 1_800_000_000_000, signature: "ab".repeat(64) };

function appReq(over: Partial<AppAcceleratorRequest> = {}): AppAcceleratorRequest {
  const approval = approvalForApp(APP, ACC, "sandbox", { secrecy: true });
  if ("refused" in approval) throw new Error("test approval refused");
  return { installation: APP, requirement: requirementFromManifest(ACC), approval, approvalProof: PROOF, ...over };
}

describe("the AppRunner hook", () => {
  it("claims, attaches, runs on the GPU runtime, then releases at stop", async () => {
    const calls: string[] = [];
    const sock = fakeGpud((op, args) => {
      calls.push(op);
      if (op === "gpu.inventory") return { ok: true, result: inventory(true) };
      if (op === "gpu.claim") {
        expect(args.container).toBe("flagship-alice-llm");
        expect(args.approvalProof).toEqual(PROOF);
        return { ok: true, result: { allocationId: args.allocationId, state: "reserved", queuePosition: null } };
      }
      if (op === "gpu.attach") return { ok: true, result: { allocation: args.allocationId, args: GPU_ARGS, cdiSpecDigest: "sha256:x", image: "r/i@sha256:aa" } };
      if (op === "gpu.release") return { ok: true, result: { allocationId: args.allocationId, settle: "released" } };
      return { ok: true, result: {} };
    });
    const apps = new AppAccelerators(new AcceleratorBroker(gpudClient(sock, 5000), { engine: "docker" }), join(dir, "held.json"));
    setAcceleratorHook(apps);
    const ran: string[][] = [];
    const cmd: CommandRunner = { run: async (_c, a) => void ran.push(a) };
    const runner = new AppRunner(cmd);
    await runner.deploy({ serviceId: "alice-llm", image: "img:1", accelerator: appReq({ approvalProof: PROOF }) });
    const run = ran.find((a) => a[0] === "run")!;
    expect(run).toEqual(expect.arrayContaining(["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=0"]));
    expect(run.filter((a) => a.startsWith("--runtime=")).length).toBe(1);
    expect(calls).toEqual(["gpu.inventory", "gpu.claim", "gpu.attach", "gpu.started"]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "held.json"), "utf8")))).toEqual(["alice-llm"]);
    await runner.stop("alice-llm");
    expect(calls.at(-1)).toBe("gpu.release");
    expect(JSON.parse(readFileSync(join(dir, "held.json"), "utf8"))).toEqual({});
  });

  it("falls back to CPU only when the manifest has a CPU path", async () => {
    const sock = fakeGpud((op) => (op === "gpu.inventory" ? { ok: true, result: inventory(false) } : { ok: true, result: {} }));
    setAcceleratorHook(new AppAccelerators(new AcceleratorBroker(gpudClient(sock, 5000), { engine: "docker" }), join(dir, "held.json")));
    const ran: string[][] = [];
    const runner = new AppRunner({ run: async (_c, a) => void ran.push(a) });
    await expect(runner.deploy({ serviceId: "s", image: "img:1", accelerator: appReq() })).rejects.toThrow(/no GPU/);
    expect(ran).toEqual([]);
    const cpu = appReq({ requirement: { ...requirementFromManifest(ACC), fallback: "cpu-if-supported" } });
    await runner.deploy({ serviceId: "s", image: "img:1", accelerator: cpu });
    expect(ran[0]!.some((a) => a.includes("nvidia"))).toBe(false);
  });

  it("refuses without a GPU service at all, and when the approval doesn't cover the claim", async () => {
    await expect(new AppRunner({ run: async () => {} }).deploy({ serviceId: "s", image: "i", accelerator: appReq() })).rejects.toThrow(/no GPU service/);
    const sock = fakeGpud((op) =>
      op === "gpu.inventory" ? { ok: true, result: inventory(true) } : { ok: false, code: "forbidden", message: "graphics is not approved" },
    );
    setAcceleratorHook(new AppAccelerators(new AcceleratorBroker(gpudClient(sock, 5000), { engine: "docker" }), join(dir, "held.json")));
    await expect(new AppRunner({ run: async () => {} }).deploy({ serviceId: "s", image: "i", accelerator: appReq() })).rejects.toThrow(/isn't approved/);
  });

  it("gives up a queued claim after its wait and releases it", async () => {
    const calls: string[] = [];
    const sock = fakeGpud((op, args) => {
      calls.push(op);
      if (op === "gpu.inventory") return { ok: true, result: inventory(true) };
      if (op === "gpu.claim") return { ok: true, result: { allocationId: args.allocationId, state: "admitted", queuePosition: 0 } };
      if (op === "gpu.status") return { ok: true, result: { allocations: [{ allocationId: "x", state: "admitted" }], queue: [], admissionPaused: null } };
      return { ok: true, result: { settle: "released" } };
    });
    let t = 0;
    const broker = new AcceleratorBroker(gpudClient(sock, 5000), { engine: "docker", now: () => t, sleep: async () => void (t += 1000), pollMs: 1 });
    const apps = new AppAccelerators(broker, join(dir, "held.json"));
    const r = await apps.beforeRun("s", appReq({ queueWaitMs: 3000 }));
    expect(r).toEqual({ kind: "refused", reason: expect.stringMatching(/busy/) });
    expect(calls).toContain("gpu.release");
  });
});

describe("the owner's screen", () => {
  it("shows holders, the queue and why a device can't be used", async () => {
    const inv = inventory(true);
    inv.devices[0]!.holders = [{ allocationId: "a1", appId: "alice-llm", state: "running", partition: null }] as never;
    const view = toAcceleratorsResponse(inv as never, { allocations: [], queue: [{ appId: "bob-render", allocations: ["b1", "b2"] }], admissionPaused: null });
    expect(view.devices[0]).toMatchObject({ state: "in-use", holders: [{ appId: "alice-llm" }] });
    expect(view.queue).toEqual([{ appId: "bob-render", waiting: 2 }]);
  });

  it("stops a GPU job for the owner, never for a companion", async () => {
    const sock = fakeGpud((op, args) => (op === "gpu.release" ? { ok: true, result: { allocationId: args.allocationId, settle: "released" } } : { ok: true, result: inventory(false) }));
    const broker = new AcceleratorBroker(gpudClient(sock, 5000), { engine: "docker" });
    const req = (body: unknown) => ({ method: "POST", path: "/api/screens/accelerators/stop", headers: {}, body: Buffer.from(JSON.stringify(body)) });
    const owner = buildAcceleratorsHttp({ broker, denyCompanion: () => null });
    const r = await owner("/api/screens/accelerators/stop", "POST", req({ allocationId: "a1" }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(String(r!.body))).toEqual({ ok: true, settle: "released" });
    expect((await owner("/api/screens/accelerators/stop", "POST", req({})))?.status).toBe(400);
    const companion = buildAcceleratorsHttp({ broker, denyCompanion: () => ({ status: 403, body: "no" }) });
    expect((await companion("/api/screens/accelerators/stop", "POST", req({ allocationId: "a1" })))?.status).toBe(403);
    const g = await owner("/api/screens/accelerators", "GET", { method: "GET", path: "/api/screens/accelerators", headers: {}, body: Buffer.alloc(0) });
    expect(JSON.parse(String(g!.body))).toMatchObject({ available: false, reason: "no-accelerators" });
  });

  it("maps a missing service to an honest answer", () => {
    expect(new GpudError("unavailable", "x").code).toBe("unavailable");
  });
});

describe("installing flagship-gpud", () => {
  const bin = Buffer.from("gpud binary");
  const pin = createHash("sha256").update(bin).digest("hex");
  function deps(files: Record<string, Buffer | string>, accel = true): GpudInstallDeps & { written: string[]; ran: string[] } {
    const written: string[] = [];
    const ran: string[] = [];
    return {
      repoPath: "/opt/flagship",
      engine: "/usr/bin/podman",
      written,
      ran,
      hasAccelerator: async () => accel,
      exists: async (p) => p === "/usr/bin/nvidia-smi" || p in files,
      read: async (p) => (p in files ? Buffer.from(files[p] as Buffer) : null),
      write: async (p, d) => {
        written.push(p);
        files[p] = Buffer.from(d as Buffer);
      },
      run: async (c, a) => {
        ran.push(`${c} ${a.join(" ")}`);
        return { code: 1, stdout: "" };
      },
    };
  }
  it("skips a box without a GPU and a binary that doesn't match its pin", async () => {
    expect((await installGpud(deps({}, false))).reason).toBe("no-accelerators");
    const d = deps({ "/opt/flagship/installer/rust/flagship-gpud": bin, "/opt/flagship/installer/rust/PINS.json": JSON.stringify({ binaries: { "flagship-gpud": "0".repeat(64) } }) });
    expect((await installGpud(d)).reason).toMatch(/does not match/);
    expect(d.written).toEqual([]);
  });
  it("installs the pinned binary once, then leaves it", async () => {
    const files: Record<string, Buffer | string> = { "/opt/flagship/installer/rust/flagship-gpud": bin, "/opt/flagship/installer/rust/PINS.json": JSON.stringify({ binaries: { "flagship-gpud": pin } }) };
    const d = deps(files);
    expect((await installGpud(d)).action).toBe("installed");
    expect(d.written).toEqual(["/usr/local/lib/flagship-gpu/flagship-gpud", "/etc/systemd/system/flagship-gpud.service"]);
    const unit = String(files["/etc/systemd/system/flagship-gpud.service"]);
    expect(unit).toContain("--nvidia-smi /usr/bin/nvidia-smi");
    expect(unit).toContain('--runsc-version "20260921.0"');
    expect(unit).toContain("--trust /opt/flagship/release/box-artifact-trust.json");
    expect(unit).toContain("--keyd-state /var/lib/flagship-keyd");
    expect((await installGpud(deps(files))).action).toBe("unchanged");
  });
  it("refuses unsafe paths in the unit", () => {
    expect(() => gpudUnit({ releasePath: "/opt/flag ship", engine: "/usr/bin/podman", tools: {}, versions: {} })).toThrow();
    expect(() => gpudUnit({ releasePath: "/opt/flagship", engine: "/usr/bin/podman", tools: {}, versions: { cdiGenerator: "x\nExecStartPre=/bin/sh" } })).toThrow();
  });
});

describe("what the AppRunner runs for a GPU app passes the privileged broker", () => {
  it("only with the claim gpud published for that container", async () => {
    const { dockerExec } = await import("@flagship/privd");
    const sock = fakeGpud((op, args) => {
      if (op === "gpu.inventory") return { ok: true, result: inventory(true) };
      if (op === "gpu.claim") return { ok: true, result: { allocationId: args.allocationId, state: "reserved", queuePosition: null } };
      if (op === "gpu.attach") return { ok: true, result: { allocation: args.allocationId, args: ["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=0", "--label", `flagship.gpu.allocation=${args.allocationId}`], cdiSpecDigest: "sha256:x", image: "r/i@sha256:aa" } };
      return { ok: true, result: { settle: "released" } };
    });
    setAcceleratorHook(new AppAccelerators(new AcceleratorBroker(gpudClient(sock, 5000), { engine: "docker" }), join(dir, "held.json")));
    let run: string[] = [];
    await new AppRunner({ run: async (_c, a) => void (a[0] === "run" && (run = a)) }).deploy({ serviceId: "alice-llm", image: `img@sha256:${"a".repeat(64)}`, accelerator: appReq() });
    const id = run[run.indexOf("--label") + 1]!.split("=")[1]!;
    const claim = { allocationId: id, appId: "alice-llm", container: "flagship-alice-llm", runtime: "runsc-nvproxy", devices: ["nvidia.com/gpu=0"] };
    expect(() => dockerExec({ argv: run }, "docker", (x) => (x === id ? claim : null))).not.toThrow();
    expect(() => dockerExec({ argv: run }, "podman", (x) => (x === id ? claim : null))).not.toThrow();
    expect(() => dockerExec({ argv: run }, "docker")).toThrow(/no attached GPU allocation/);
    expect(() => dockerExec({ argv: run }, "docker", (x) => (x === id ? { ...claim, container: "flagship-bob" } : null))).toThrow(/another container/);
  });
});
