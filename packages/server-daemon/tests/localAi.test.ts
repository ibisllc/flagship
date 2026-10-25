/**
 * AI01/AI02 local AI: pinned models and images, the checked download, the model server on CPU or a
 * GPU claim, the "On this server" provider with no cloud fallback, fine-tuning on an app's own
 * staged data with checkpoints, the app SDK under the owner's signed grant, and the privileged
 * shapes. Hostile cases: a model digest mismatch, a redirect off the registry, a training job asking
 * for another app's data, a forged or stale order, an undeclared app, a spent quota.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed, signLocalAiAppGrant, signLocalAiTrainOrder, type LocalAiAppGrant, type LocalAiTrainOrder } from "@flagship/protocol";
import { LOCAL_AI_IMAGES as PRIVD_IMAGES, validateRequest, PrivdError } from "@flagship/privd";
import { AcceleratorBroker } from "../src/gpu/broker.js";
import { ALL_LOCAL_AI_IMAGES, LOCAL_MODELS, localModel, registryHostAllowed, type LocalModel } from "../src/localAi/catalog.js";
import { checkLocalAiRunArgs, datasetMount, serviceRunArgs, trainRunArgs } from "../src/localAi/containers.js";
import { ModelStore, type ModelInstaller } from "../src/localAi/modelStore.js";
import { LocalAiUnavailable, LocalInferenceService } from "../src/localAi/service.js";
import { TrainingJobs } from "../src/localAi/training.js";
import { AppGrantStore, AppSdkEndpoints, sanitizeChatBody } from "../src/localAi/appSdk.js";
import { checkAppGrant, checkTrainOrder } from "../src/localAi/orders.js";
import { LocalAi } from "../src/localAi/index.js";
import { buildLocalAiHttp } from "../src/localAi/http.js";
import { LlmHarness, LocalModelUnavailableError } from "../src/llmHarness.js";
import type { CommandRunner } from "../src/serviceRunner.js";

const FQDN = "home3.plucky-avocet.flagship.services";
const OWNER = new Uint8Array(32).fill(7);
const MALLORY = new Uint8Array(32).fill(9);
const authority = () => ({ username: "plucky-avocet", ownerIrkPub: ed.getPublicKey(OWNER) });
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-ai-"));
});

const tiny = (bytes: Buffer, over: Partial<LocalModel> = {}): LocalModel => ({
  ...localModel("stories-260k")!,
  id: "tiny",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  ...over,
});

function fakeInstaller(): ModelInstaller & { installed: string[]; removed: string[] } {
  const o = { installed: [] as string[], removed: [] as string[] };
  return Object.assign(o, {
    install: async (sha: string) => void o.installed.push(sha),
    remove: async (sha: string) => void o.removed.push(sha),
  });
}

function bodyResponse(bytes: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(new Blob([bytes]).stream(), { status: 200, headers: { "content-length": String(bytes.length), ...headers } });
}

/** Mark a real catalog model as installed, as a finished download would. */
function installed(storeDir: string, ids: string[]): void {
  mkdirSync(storeDir, { recursive: true });
  const models: Record<string, unknown> = {};
  for (const id of ids) {
    const m = localModel(id)!;
    models[id] = { state: "installed", sha256: m.sha256, sizeBytes: m.sizeBytes, at: 1 };
  }
  writeFileSync(join(storeDir, "models.json"), JSON.stringify({ models }));
}

describe("the pinned catalog", () => {
  it("pins every image by digest, the same list both brokers allow", () => {
    for (const img of ALL_LOCAL_AI_IMAGES) expect(img).toMatch(/^ghcr\.io\/ggml-org\/llama\.cpp:[a-z-]+-b11541@sha256:[0-9a-f]{64}$/);
    expect([...PRIVD_IMAGES].sort()).toEqual([...ALL_LOCAL_AI_IMAGES].sort());
  });
  it("pins every model by revision, SHA-256, size and license", () => {
    for (const m of LOCAL_MODELS) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.source.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.sizeBytes).toBeGreaterThan(0);
      expect(m.license.id).toMatch(/^(apache-2\.0|mit)$/);
    }
    expect(LOCAL_MODELS.some((m) => m.tools && m.purpose === "build")).toBe(true);
    expect(LOCAL_MODELS.filter((m) => m.trainable).every((m) => m.quantization === "F32")).toBe(true);
  });
  it("allows only the registry's own hosts", () => {
    expect(registryHostAllowed("huggingface.co")).toBe(true);
    expect(registryHostAllowed("cas-bridge.xethub.hf.co")).toBe(true);
    expect(registryHostAllowed("evil-huggingface.co")).toBe(false);
    expect(registryHostAllowed("hf.co.evil.example")).toBe(false);
  });
});

describe("downloading a model", () => {
  it("keeps a file only when its size and digest match, then hands it to root", async () => {
    const bytes = Buffer.from("GGUF model bytes");
    const inst = fakeInstaller();
    const store = new ModelStore({ dir, installer: inst, catalog: [tiny(bytes)], freeBytes: async () => 1e12, fetch: async () => bodyResponse(bytes) });
    await store.load();
    const r = await store.download("tiny");
    expect(r.ok).toBe(true);
    if (r.ok) await r.done;
    expect(store.stateOf("tiny").state).toBe("installed");
    expect(inst.installed).toEqual([tiny(bytes).sha256]);
  });

  it("hostile: a model digest mismatch keeps nothing", async () => {
    const bytes = Buffer.from("GGUF model bytes");
    const inst = fakeInstaller();
    const store = new ModelStore({ dir, installer: inst, catalog: [tiny(bytes)], freeBytes: async () => 1e12, fetch: async () => bodyResponse(Buffer.from("GGUF model bytez")) });
    await store.load();
    const r = await store.download("tiny");
    if (r.ok) await r.done;
    const s = store.stateOf("tiny");
    expect(s.state).toBe("failed");
    expect(s.reason).toMatch(/pinned digest/);
    expect(inst.installed).toEqual([]);
    expect(store.installed("tiny")).toBeNull();
  });

  it("hostile: a redirect off the registry, a wrong size, an oversized body", async () => {
    const bytes = Buffer.from("0123456789");
    const cases: Array<[() => Promise<Response>, RegExp]> = [
      [async () => new Response(null, { status: 302, headers: { location: "https://evil.example/model.gguf" } }), /doesn't download models/],
      [async () => new Response(null, { status: 302, headers: { location: "http://huggingface.co/x" } }), /doesn't download models/],
      [async () => bodyResponse(Buffer.from("01234"), { "content-length": "5" }), /wrong size/],
      [async () => new Response(new Blob([Buffer.alloc(64)]).stream(), { status: 200 }), /larger than the pinned/],
    ];
    for (const [fetch, why] of cases) {
      const inst = fakeInstaller();
      const store = new ModelStore({ dir: mkdtempSync(join(tmpdir(), "la-")), installer: inst, catalog: [tiny(bytes)], freeBytes: async () => 1e12, fetch });
      await store.load();
      const r = await store.download("tiny");
      if (r.ok) await r.done;
      expect(store.stateOf("tiny").reason).toMatch(why);
      expect(inst.installed).toEqual([]);
    }
  });

  it("refuses over the space allowance or when the disk is full; unknown models don't exist", async () => {
    const bytes = Buffer.alloc(1000);
    const over = new ModelStore({ dir, installer: fakeInstaller(), catalog: [tiny(bytes)], freeBytes: async () => 1e12, budgetBytes: 10 });
    expect(await over.download("tiny")).toEqual({ ok: false, refusal: "over-budget" });
    const full = new ModelStore({ dir, installer: fakeInstaller(), catalog: [tiny(bytes)], freeBytes: async () => 100 });
    expect(await full.download("tiny")).toEqual({ ok: false, refusal: "disk-full" });
    expect(await full.download("../../etc/passwd")).toEqual({ ok: false, refusal: "unknown-model" });
  });

  it("an installed record whose digest no longer matches the catalog is not installed", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "models.json"), JSON.stringify({ models: { "stories-260k": { state: "installed", sha256: "0".repeat(64), sizeBytes: 1185376, at: 1 } } }));
    const store = new ModelStore({ dir, installer: fakeInstaller() });
    await store.load();
    expect(store.installed("stories-260k")).toBeNull();
  });
});

const BROKER_CTX = { engine: "docker" as const, mounts: () => "", trust: { keys: ["a".repeat(64)], threshold: 1, nodeFloor: "24.0.0", minSequence: 1 }, arch: "amd64" };

describe("the container shapes pass both the daemon's tripwire and the privileged broker", () => {
  const svc = (gpuArgs: string[] = []) =>
    serviceRunArgs({
      name: "flagship-localai-0123456789abcdef",
      image: gpuArgs.length ? ALL_LOCAL_AI_IMAGES[1]! : ALL_LOCAL_AI_IMAGES[0]!,
      modelSha256: "a".repeat(64),
      hostPort: 41234,
      contextTokens: 4096,
      threads: 4,
      memoryMiB: 900,
      cpus: "4",
      apiKey: "k3y",
      gpuArgs,
      sandboxArgs: ["--runtime=runsc"],
      networkArgs: ["--network", "flagship-staging"],
    });

  it("the model server on CPU and on a GPU claim", () => {
    checkLocalAiRunArgs(svc());
    expect(() => validateRequest("docker", { argv: svc() }, BROKER_CTX)).not.toThrow();
    const gpu = ["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=0", "--label", "flagship.gpu.allocation=localai-0123456789abcdef"];
    checkLocalAiRunArgs(svc(gpu));
    const claim = { allocationId: "localai-0123456789abcdef", appId: "flagship-local-ai", container: "flagship-localai-0123456789abcdef", runtime: "runsc-nvproxy", devices: ["nvidia.com/gpu=0"] };
    expect(() => validateRequest("docker", { argv: svc(gpu) }, { ...BROKER_CTX, gpuClaims: (id) => (id === claim.allocationId ? claim : null) })).not.toThrow();
    expect(() => validateRequest("docker", { argv: svc(gpu) }, BROKER_CTX)).toThrow(PrivdError);
  });

  it("a fine-tuning run with an app's staged data; never a live app's", () => {
    const args = trainRunArgs({
      hex: "0123456789abcdef",
      image: ALL_LOCAL_AI_IMAGES[4]!,
      gpuArgs: [],
      sandboxArgs: ["--runtime=runsc"],
      networkArgs: ["--network", "flagship-staging"],
      memoryMiB: 512,
      cpus: "2",
      datasetVolume: "flagship-devfiles-alice--notes",
      entrypoint: "sh",
      command: ["-c", "true"],
    });
    checkLocalAiRunArgs(args);
    expect(() => validateRequest("docker", { argv: args }, BROKER_CTX)).not.toThrow();
    expect(() => datasetMount("flagship-files-alice--notes")).toThrow(/staged sample data/);
    const live = args.map((a) => (a.includes("flagship-devfiles-alice--notes") ? "type=volume,src=flagship-files-alice--notes,dst=/dataset,readonly" : a));
    expect(() => checkLocalAiRunArgs(live)).toThrow();
    expect(() => validateRequest("docker", { argv: live }, BROKER_CTX)).toThrow(PrivdError);
  });

  it("the tripwire refuses an unpinned image, root, the host network, a writable models volume", () => {
    const base = svc();
    expect(() => checkLocalAiRunArgs(base.map((a) => (a === ALL_LOCAL_AI_IMAGES[0] ? "ghcr.io/ggml-org/llama.cpp:server" : a)))).toThrow(/pinned/);
    expect(() => checkLocalAiRunArgs(base.map((a) => (a === "10001:10001" ? "0:0" : a)))).toThrow(/root/);
    expect(() => checkLocalAiRunArgs(base.map((a) => (a === "flagship-staging" ? "host" : a)))).toThrow(/host/);
    expect(() => checkLocalAiRunArgs(base.map((a) => (a.endsWith(",readonly") ? a.replace(",readonly", "") : a)))).toThrow(/mount/);
    expect(() => checkLocalAiRunArgs(base.map((a) => (a.startsWith("127.0.0.1:") ? "0.0.0.0:41234:8080" : a)))).toThrow(/loopback/);
  });

  it("root's model install checks the digest on its own copy", () => {
    const e = validateRequest("host", { file: "localai", argv: ["model-install", "b".repeat(64), "/var/lib/docker/volumes/flagship-models/_data"] }, BROKER_CTX);
    expect(e.copyIn?.[0]?.from).toBe(`/var/flagship/data/local-ai/incoming/sha256-${"b".repeat(64)}.gguf`);
    expect(e.args[1]).toMatch(/sha256sum -c/);
  });
});

/** A command runner that records docker calls and answers captures. */
function fakeCmd(capture?: (args: string[]) => { stdout: string; stderr?: string }): CommandRunner & { runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    run: async (_c, a) => void runs.push(a),
    capture: async (_c, a) => {
      runs.push(a);
      const r = capture?.(a) ?? { stdout: "" };
      return { stdout: r.stdout, stderr: r.stderr ?? "" };
    },
  };
}

function healthyFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url) =>
    url.endsWith("/health")
      ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "1 2 3" } }], timings: { predicted_per_second: 41.5 }, usage: { total_tokens: 12 } }), { status: 200 });
}

function fakeBroker(o: { devices?: boolean; queue?: boolean } = {}) {
  const calls: string[] = [];
  const call = async (op: string, args?: Record<string, unknown>) => {
    calls.push(op);
    switch (op) {
      case "gpu.inventory":
        return o.devices
          ? { available: true, reason: null, devices: [{ id: "0", vendor: "nvidia", backend: "nvidia-cuda", model: "RTX 4090", memoryMiB: 24564, displayOwned: false, qualified: [{ profile: "gvisor-nvproxy", entry: "x" }], unqualifiedReasons: [], quarantined: null, holders: o.queue ? [{ allocationId: "app-x", appId: "alice--render", state: "running", partition: null }] : [], partitions: [] }], unavailable: [], admissionPaused: null, catalog: { status: "verified" } }
          : { available: false, reason: "no-accelerators", devices: [], unavailable: [], admissionPaused: null, catalog: { status: "unknown" } };
      case "gpu.claim":
        return { allocationId: args!.allocationId, state: o.queue ? "admitted" : "reserved", queuePosition: o.queue ? 2 : null };
      case "gpu.status":
        return { allocations: [{ allocationId: "localai-x", appId: "flagship-local-ai", state: o.queue ? "admitted" : "reserved", policy: "exclusive", reason: null, devices: [{ device: "0", partition: null }] }], queue: [], admissionPaused: null };
      case "gpu.attach":
        return { allocation: args!.allocationId, args: ["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=0", "--label", `flagship.gpu.allocation=${args!.allocationId}`], cdiSpecDigest: null, image: "x" };
      default:
        return { settle: "released" };
    }
  };
  let t = 0;
  return { broker: new AcceleratorBroker(call, { engine: "docker", now: () => (t += 1000), sleep: async () => {}, pollMs: 1 }), calls };
}

function service(o: { ids?: string[]; broker?: AcceleratorBroker | null; memoryMiB?: number; cmd?: CommandRunner } = {}) {
  installed(dir, o.ids ?? ["stories-260k"]);
  const store = new ModelStore({ dir, installer: fakeInstaller() });
  const cmd = o.cmd ?? fakeCmd();
  const svc = new LocalInferenceService({
    cmd,
    store,
    broker: o.broker ?? null,
    hardware: () => ({ cpus: 4, memoryMiB: o.memoryMiB ?? 8000 }),
    sandboxArgs: async () => ["--runtime=runsc"],
    networkArgs: () => ["--network", "flagship-staging"],
    ensureNetwork: async () => {},
    settings: () => ({ useGpu: true, serveModel: null }),
    fetch: healthyFetch(),
    freePort: async () => 41234,
    sleep: async () => {},
    idleStopMs: 60_000,
    gpuQueueWaitMs: 5_000,
  });
  return { svc, store, cmd };
}

describe("the model server: CPU, a GPU claim, or an honest no", () => {
  it("no model downloaded: unavailable, with the reason", async () => {
    const { svc } = service({ ids: [] });
    await expect(svc.lease()).rejects.toThrow(LocalAiUnavailable);
  });

  it("on CPU under gVisor when there is no GPU; the measured speed is recorded", async () => {
    const { svc, cmd, store } = service();
    await store.load();
    const l = await svc.lease();
    expect(l.baseUrl).toBe("http://127.0.0.1:41234");
    expect(l.device).toBe("cpu");
    const run = (cmd as ReturnType<typeof fakeCmd>).runs.find((a) => a[0] === "run")!;
    expect(run).toContain("--runtime=runsc");
    expect(run).not.toContain("--device");
    l.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(store.installed("stories-260k")?.measuredTokensPerSecond).toBe(41.5);
  });

  it("on a qualified GPU through the allocator, released when stopped", async () => {
    const { broker, calls } = fakeBroker({ devices: true });
    const { svc, cmd, store } = service({ broker });
    await store.load();
    const l = await svc.lease();
    expect(l.device).toBe("gpu");
    const run = (cmd as ReturnType<typeof fakeCmd>).runs.find((a) => a[0] === "run")!;
    expect(run).toContain("--runtime=runsc-nvproxy");
    expect(run).not.toContain("--runtime=runsc");
    expect(run.some((a) => a.includes("server-cuda-b11541"))).toBe(true);
    l.release();
    await svc.stop();
    expect(calls).toEqual(expect.arrayContaining(["gpu.claim", "gpu.attach", "gpu.started", "gpu.release"]));
  });

  it("every GPU busy past the wait: the CPU, with the reason in the queue view", async () => {
    const { broker, calls } = fakeBroker({ devices: true, queue: true });
    const { svc, store } = service({ broker });
    await store.load();
    const l = await svc.lease();
    expect(l.device).toBe("cpu");
    expect(calls).toContain("gpu.release");
  });

  it("too big for memory and no GPU: refused, never sent elsewhere", async () => {
    const { svc, store } = service({ ids: ["qwen2.5-coder-7b-q4"], memoryMiB: 2000 });
    await store.load();
    await expect(svc.lease()).rejects.toMatchObject({ code: "too-big" });
  });
});

describe('"On this server" in the harness: the box\'s own endpoint, no cloud fallback', () => {
  const swk = { sealWithSwk: () => { throw new Error("x"); }, openWithSwk: () => { throw new Error("x"); } } as never;

  it("a flagship-local call goes to the box's loopback endpoint, whatever URL the request carried", async () => {
    const urls: string[] = [];
    const harness = new LlmHarness({
      swk,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }], model: "m" }), text: async () => "" } as never;
      },
      localInference: { lease: async () => ({ baseUrl: "http://127.0.0.1:41234", apiKey: "k", modelId: "stories-260k", release: () => {} }), models: () => [] },
    });
    const r = await harness.chatWithCredential({ provider: "flagship-local", apiKey: "local", baseUrl: "https://evil.example" }, { model: "auto", messages: [{ role: "user", content: "x" }] });
    expect(r.content).toBe("hi");
    expect(urls).toEqual(["http://127.0.0.1:41234/v1/chat/completions"]);
  });

  it("when the local model can't run, the call fails with the reason and nothing else is called", async () => {
    const urls: string[] = [];
    const harness = new LlmHarness({
      swk,
      fetchImpl: async (url) => (urls.push(url), { ok: true } as never),
      streamingFetchImpl: async (url) => (urls.push(url), { ok: true } as never),
      localInference: { lease: async () => { throw new LocalAiUnavailable("No model is downloaded on this server yet.", "no-model"); }, models: () => [] },
    });
    await expect(harness.chatWithCredential({ provider: "flagship-local", apiKey: "local" }, { model: "auto", messages: [] })).rejects.toThrow(LocalModelUnavailableError);
    const events: string[] = [];
    const out = await harness.chatStream({ provider: "flagship-local", apiKey: "local" }, { model: "auto", messages: [] }, (e) => events.push(e.kind === "error" ? e.message : e.kind));
    expect(out).toMatchObject({ ok: false, reason: "local-unavailable" });
    expect(events[0]).toMatch(/No model is downloaded/);
    expect(urls).toEqual([]);
  });
});

const grant = (over: Partial<LocalAiAppGrant> = {}): LocalAiAppGrant => ({ serverDomain: FQDN, serviceId: "alice--notes", requestsPerDay: 2, tokensPerDay: 1000, maxTokensPerRequest: 64, issuedAt: Date.now(), ...over });
const signGrant = (g: LocalAiAppGrant, key = OWNER) => hexOf(signLocalAiAppGrant(g, (m) => ed.sign(m, key)));
const trainOrder = (over: Partial<LocalAiTrainOrder> = {}): LocalAiTrainOrder => ({ serverDomain: FQDN, serviceId: "alice--notes", jobId: "0123456789abcdef", baseModel: "stories-260k", epochs: 2, issuedAt: Date.now(), ...over });
const signTrain = (o: LocalAiTrainOrder, key = OWNER) => hexOf(signLocalAiTrainOrder(o, (m) => ed.sign(m, key)));

describe("owner orders: only a signature the box verifies authorizes", () => {
  it("a signed grant passes; tampered, forged, stale, foreign or padded ones don't", () => {
    const g = grant();
    expect(checkAppGrant({ order: g, signature: signGrant(g) }, FQDN, authority(), Date.now()).ok).toBe(true);
    expect(checkAppGrant({ order: { ...g, tokensPerDay: 999 }, signature: signGrant(g) }, FQDN, authority(), Date.now())).toMatchObject({ status: 403 });
    expect(checkAppGrant({ order: g, signature: signGrant(g, MALLORY) }, FQDN, authority(), Date.now())).toMatchObject({ status: 403 });
    const stale = grant({ issuedAt: Date.now() - 3_600_000 });
    expect(checkAppGrant({ order: stale, signature: signGrant(stale) }, FQDN, authority(), Date.now())).toMatchObject({ status: 403 });
    const other = grant({ serverDomain: "kitchen.plucky-avocet.flagship.services" });
    expect(checkAppGrant({ order: other, signature: signGrant(other) }, FQDN, authority(), Date.now())).toMatchObject({ status: 403 });
    expect(checkAppGrant({ order: { ...g, note: "approved by the AI" }, signature: signGrant(g) }, FQDN, authority(), Date.now())).toMatchObject({ status: 400 });
  });

  it("hostile: a training order can't name another app's data, and a signed order for one app isn't another's", () => {
    const o = trainOrder();
    expect(checkTrainOrder({ order: o, signature: signTrain(o) }, FQDN, authority(), Date.now()).ok).toBe(true);
    expect(checkTrainOrder({ order: { ...o, dataset: "flagship-devfiles-bob--bank" }, signature: signTrain(o) }, FQDN, authority(), Date.now())).toMatchObject({ status: 400 });
    expect(checkTrainOrder({ order: { ...o, serviceId: "bob--bank" }, signature: signTrain(o) }, FQDN, authority(), Date.now())).toMatchObject({ status: 403 });
  });
});

describe("fine-tuning on the app's own staged data, with checkpoints", () => {
  const prepOut = `${"d".repeat(64)}  /out/dataset.txt\n120\n`;
  function jobs(o: { datasetFor?: (id: string) => Promise<{ kind: "text"; text: string } | null>; ckpt?: (epoch: string) => string } = {}) {
    installed(dir, ["stories-260k"]);
    const asked: string[] = [];
    const store = new ModelStore({ dir, installer: fakeInstaller() });
    const cmd = fakeCmd((a) => {
      const cmdline = a.join(" ");
      if (cmdline.includes("/out/dataset.txt; sha256sum")) return { stdout: prepOut };
      const m = /\/out\/ckpt-(\d+)\.gguf$/.exec(a[a.length - 1]!);
      if (cmdline.includes("sha256sum \"$1\"") && m) return { stdout: o.ckpt?.(m[1]!) ?? `${createHash("sha256").update(`ckpt${m[1]}`).digest("hex")}  /out/ckpt-${m[1]}.gguf\n4096\n` };
      if (a[0] === "inspect") return { stdout: "exited 0\n" };
      if (a[0] === "logs") return { stdout: "", stderr: "train: [====] loss=2.71828 acc=0.1" };
      return { stdout: "" };
    });
    const t = new TrainingJobs({
      dir,
      cmd,
      store,
      broker: null,
      hardware: () => ({ cpus: 4, memoryMiB: 8000 }),
      sandboxArgs: async () => ["--runtime=runsc"],
      networkArgs: () => ["--network", "flagship-staging"],
      ensureNetwork: async () => {},
      settings: () => ({ useGpu: true }),
      datasetFor: o.datasetFor ?? (async (id) => (asked.push(id), { kind: "text", text: `samples of ${id}` })),
      prepareOut: async () => {},
      pollMs: 1,
      sleep: async () => {},
    });
    return { t, cmd, store, asked };
  }
  const settle = async (t: TrainingJobs, id: string) => {
    for (let i = 0; i < 200 && ["queued", "preparing", "running"].includes(t.get(id)?.state ?? ""); i++) await new Promise((r) => setTimeout(r, 2));
  };

  it("trains epoch by epoch, records an HMAC'd checkpoint for each, reads only the named app's data", async () => {
    const { t, cmd, store, asked } = jobs();
    await store.load();
    await t.load();
    await t.submit({ serviceId: "alice--notes", jobId: "0123456789abcdef", baseModel: "stories-260k", epochs: 2 });
    await settle(t, "0123456789abcdef");
    const j = t.get("0123456789abcdef")!;
    expect(j.state).toBe("completed");
    expect(j.checkpoints.map((c) => c.epoch)).toEqual([1, 2]);
    expect(j.checkpoints[1]!.loss).toBeCloseTo(2.71828);
    expect(j.checkpoints.every((c) => /^[0-9a-f]{64}$/.test(c.mac))).toBe(true);
    expect(asked).toEqual(["alice--notes"]);
    const runs = (cmd as ReturnType<typeof fakeCmd>).runs.filter((a) => a[0] === "run");
    // Each epoch runs in the background (`-d`) and is removed once its output is read.
    expect(runs.filter((r) => r.includes("/app/llama-finetune")).every((r) => r[1] === "-d")).toBe(true);
    for (const r of runs) {
      checkLocalAiRunArgs(r);
      expect(() => validateRequest("docker", { argv: r }, BROKER_CTX)).not.toThrow();
      expect(r.join(" ")).not.toMatch(/flagship-files-|bob--/);
    }
    // The second epoch starts from the first checkpoint.
    expect(runs.some((r) => r.includes("/out/ckpt-1.gguf") && r.includes("-o"))).toBe(true);
  });

  it("an app with no staged sample data: refused with the reason", async () => {
    const { t, store } = jobs({ datasetFor: async () => null });
    await store.load();
    await t.load();
    await t.submit({ serviceId: "alice--notes", jobId: "1111111111111111", baseModel: "stories-260k", epochs: 1 });
    await settle(t, "1111111111111111");
    expect(t.get("1111111111111111")).toMatchObject({ state: "failed", reason: expect.stringMatching(/no staged sample data/) });
  });

  it("resume starts after the newest checkpoint that verifies; a tampered record is not resumed from", async () => {
    const { t, store, cmd } = jobs();
    await store.load();
    await t.load();
    await t.submit({ serviceId: "alice--notes", jobId: "2222222222222222", baseModel: "stories-260k", epochs: 2 });
    await settle(t, "2222222222222222");
    const j = t.get("2222222222222222")!;
    // Tamper with the newest record (as a hostile file edit would) and ask for more epochs.
    j.checkpoints[1]!.sha256 = "e".repeat(64);
    j.state = "failed";
    j.epochs = 3;
    (cmd as ReturnType<typeof fakeCmd>).runs.length = 0;
    await t.resume("2222222222222222");
    await settle(t, "2222222222222222");
    const after = t.get("2222222222222222")!;
    expect(after.state).toBe("completed");
    const finetunes = (cmd as ReturnType<typeof fakeCmd>).runs.filter((a) => a.includes("/app/llama-finetune"));
    // Epoch 1's checkpoint verified; epochs 2 and 3 ran again.
    expect(finetunes.length).toBe(2);
    expect(after.checkpoints.map((c) => c.epoch)).toEqual([1, 2, 3]);
  });

  it("refuses a model that can't be fine-tuned, or one not downloaded", async () => {
    const { t, store } = jobs();
    await store.load();
    await t.load();
    await expect(t.submit({ serviceId: "a--b", jobId: "3333333333333333", baseModel: "qwen2.5-0.5b-q4", epochs: 1 })).rejects.toThrow(/can't be fine-tuned/);
    await expect(t.submit({ serviceId: "a--b", jobId: "3333333333333333", baseModel: "stories-15m", epochs: 1 })).rejects.toThrow(/Download/);
  });
});

describe("the app SDK: declared, granted, within quota, nothing else", () => {
  let upstream: Server;
  let upstreamUrl = "";
  const seen: Record<string, unknown>[] = [];
  beforeEach(async () => {
    seen.length = 0;
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 30 } }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  });
  afterEach(() => upstream.close());

  async function endpoint(o: { declares?: boolean; grant?: LocalAiAppGrant | null; unavailable?: boolean }) {
    const grants = new AppGrantStore(dir, () => true);
    await grants.load();
    if (o.grant) await grants.apply({ grant: o.grant, signature: "00" });
    const links = { gateway: () => "172.19.0.1", link: async () => true, unlink: async () => {} };
    let loop = 0;
    const svc = {
      lease: async () => {
        if (o.unavailable) throw new LocalAiUnavailable("No model is downloaded on this server yet.", "no-model");
        return { baseUrl: upstreamUrl, apiKey: "k", modelId: "qwen2.5-0.5b-q4", device: "cpu" as const, release: () => {} };
      },
      menuModels: () => [localModel("qwen2.5-0.5b-q4")!],
    } as unknown as LocalInferenceService;
    const sdk = new AppSdkEndpoints({
      service: svc,
      grants,
      declares: () => o.declares ?? true,
      links: () => ({ ...links, link: async (_p: number, t: { port: number }) => ((loop = t.port), true) }),
      portFor: async () => 15444,
      hostAlias: "host.flagship.internal",
    });
    const env = await sdk.envFor("alice--notes", o.declares ?? true);
    const post = (body: unknown) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = httpRequest({ host: "127.0.0.1", port: loop, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.end(JSON.stringify(body));
      });
    return { env, post, sdk, grants };
  }

  it("an app that doesn't declare the capability gets no endpoint", async () => {
    const { env } = await endpoint({ declares: false });
    expect(env).toEqual({});
  });

  it("declared but not granted: 403; granted: forwards a rebuilt body, then the quota stops it", async () => {
    const none = await endpoint({ grant: null });
    expect(none.env.FLAGSHIP_AI_URL).toBe("http://host.flagship.internal:15444/v1");
    expect((await none.post({ messages: [{ role: "user", content: "hi" }] })).status).toBe(403);
    await none.sdk.close("alice--notes");

    const ok = await endpoint({ grant: grant({ requestsPerDay: 2, tokensPerDay: 10_000 }) });
    const r = await ok.post({ messages: [{ role: "user", content: "hi" }], max_tokens: 5000, model: "gpt-x", id_slot: 0, cache_prompt: true, n_probs: 5, url: "file:///etc/passwd" });
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ max_tokens: 64, model: "qwen2.5-0.5b-q4", cache_prompt: false, n: 1 });
    expect(seen[0]).not.toHaveProperty("id_slot");
    expect(seen[0]).not.toHaveProperty("url");
    expect(seen[0]).not.toHaveProperty("n_probs");
    expect((await ok.post({ messages: [{ role: "user", content: "again" }] })).status).toBe(200);
    expect((await ok.post({ messages: [{ role: "user", content: "third" }] })).status).toBe(429);
    expect(ok.grants.usageOf("alice--notes").requests).toBe(2);
    await ok.sdk.close("alice--notes");
  });

  it("the model can't run: 503 with the reason, never another provider", async () => {
    const e = await endpoint({ grant: grant(), unavailable: true });
    const r = await e.post({ messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/No model is downloaded/);
    expect(seen).toEqual([]);
    await e.sdk.close("alice--notes");
  });

  it("sanitizeChatBody refuses what isn't a chat", () => {
    expect(sanitizeChatBody({ prompt: "x" }, grant(), "m")).toBeNull();
    expect(sanitizeChatBody([], grant(), "m")).toBeNull();
  });
});

describe("the owner screen API", () => {
  function api() {
    installed(dir, ["stories-260k"]);
    const ai = new LocalAi({
      dataDir: dir,
      serverDomain: FQDN,
      cmd: fakeCmd(),
      broker: fakeBroker({ devices: true, queue: true }).broker,
      authority,
      apps: () => [
        { serviceId: "alice--notes", name: "Notes", declaresLocalAi: true },
        { serviceId: "bob--bank", name: "Bank", declaresLocalAi: false },
      ],
      datasetFor: async () => ({ kind: "text", text: "x" }),
      hasSampleData: (id) => id === "alice--notes",
      sandboxArgs: async () => ["--runtime=runsc"],
      networkArgs: () => ["--network", "flagship-staging"],
      ensureNetwork: async () => {},
      sdk: { links: () => null, portFor: async () => 15444, hostAlias: "host.flagship.internal" },
      installer: fakeInstaller(),
      prepareOut: async () => {},
      hardware: () => ({ cpus: 4, memoryMiB: 8000 }),
    });
    // The store and the service share `<dataDir>/data/local-ai`.
    installed(ai.dir, ["stories-260k"]);
    const http = buildLocalAiHttp({ ai, broker: ai.o.broker, serverDomain: FQDN, denyCompanion: () => null });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await http(path, method, { method, path, headers: {}, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) } as never);
      return { status: r!.status, json: JSON.parse(String(r!.body)) as Record<string, unknown> };
    };
    return { ai, call };
  }

  it("lists models with size, fit and speed, who holds each GPU, apps and datasets; cost none, this server only", async () => {
    const { ai, call } = api();
    await ai.load();
    const r = await call("GET", "/api/screens/local-ai");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ privacy: "this-server", cost: "none" });
    const models = r.json.models as Array<{ id: string; state: string; speed: { measured: boolean } }>;
    expect(models.find((m) => m.id === "stories-260k")?.state).toBe("installed");
    const gpus = (r.json.hardware as { gpus: Array<{ holders: Array<{ appName: string | null; appId: string }> }> }).gpus;
    expect(gpus[0]!.holders[0]!.appId).toBe("alice--render");
    expect((r.json.apps as unknown[]).length).toBe(1);
    expect((r.json.datasets as Array<{ hasSampleData: boolean }>).filter((d) => d.hasSampleData).length).toBe(1);
  });

  it("a signed grant for a declaring app applies; for an app that doesn't declare it, 422; an older one, 409", async () => {
    const { ai, call } = api();
    await ai.load();
    const g = grant();
    expect((await call("POST", "/api/screens/local-ai/apps/grant", { order: g, signature: signGrant(g) })).status).toBe(200);
    expect(ai.grants.get("alice--notes")?.requestsPerDay).toBe(2);
    expect((await call("POST", "/api/screens/local-ai/apps/grant", { order: g, signature: signGrant(g) })).status).toBe(409);
    const bob = grant({ serviceId: "bob--bank" });
    expect((await call("POST", "/api/screens/local-ai/apps/grant", { order: bob, signature: signGrant(bob) })).status).toBe(422);
  });

  it("a signed training order starts a job; an unsigned or padded one doesn't", async () => {
    const { ai, call } = api();
    await ai.load();
    const o = trainOrder({ jobId: "4444444444444444", epochs: 1 });
    expect((await call("POST", "/api/screens/local-ai/train", { order: o, signature: signTrain(o, MALLORY) })).status).toBe(403);
    expect((await call("POST", "/api/screens/local-ai/train", { order: { ...o, dataset: "bob" }, signature: signTrain(o) })).status).toBe(400);
    const ok = await call("POST", "/api/screens/local-ai/train", { order: o, signature: signTrain(o) });
    expect(ok.status).toBe(202);
    expect((ok.json.job as { cost: string }).cost).toBe("none");
    const missing = trainOrder({ jobId: "5555555555555555", serviceId: "carol--nope" });
    expect((await call("POST", "/api/screens/local-ai/train", { order: missing, signature: signTrain(missing) })).status).toBe(404);
  });

  it("settings and download refusals answer in sentences", async () => {
    const { ai, call } = api();
    await ai.load();
    expect((await call("POST", "/api/screens/local-ai/settings", { useGpu: false })).json).toMatchObject({ settings: { useGpu: false } });
    expect((await call("POST", "/api/screens/local-ai/settings", { serveModel: "nope" })).status).toBe(400);
    expect((await call("POST", "/api/screens/local-ai/models/download", { modelId: "stories-260k" })).json).toMatchObject({ code: "already-installed" });
  });
});
