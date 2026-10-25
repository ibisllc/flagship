// Local AI on the webapp (docs/architecture-v2/local-ai.md): the two signed orders against the
// shared vectors, the Local AI screen's text for what the box answers (models, speed, GPU holders,
// queue positions, cost and privacy), signed grant / withdraw / fine-tune bodies, and the build
// menu's "On this server" group (no credit line, the box's own sentence when it can't run, no
// automatic switch to another provider).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";

const V = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/local-ai/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const SEED = hex(V.seedHex);
const sign = (bytes: Uint8Array) => ed25519.sign(bytes, SEED);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

/** What GET /api/screens/local-ai answers on a box with one GPU busy and a job waiting. */
export const VIEW = {
  available: true,
  reason: null,
  privacy: "this-server",
  cost: "none",
  settings: { useGpu: true, serveModel: null },
  hardware: {
    cpus: 4,
    memoryMiB: 7900,
    diskFreeBytes: 52_000_000_000,
    gpuService: true,
    gpus: [{ id: "0", model: "RTX 4090", vendor: "nvidia", memoryMiB: 24564, state: "in-use", holders: [{ appId: "alice--render", appName: "Render", allocationId: "app-alice--render-1", state: "running" }] }],
  },
  budget: { usedBytes: 98_357_920, budgetBytes: 68_719_476_736 },
  models: [
    { id: "qwen2.5-0.5b-q4", name: "Qwen2.5 0.5B", descriptor: "Tiny; runs on any server", parameters: "0.5B", quantization: "Q4_K_M", sizeBytes: 491_400_032, license: { id: "apache-2.0", url: "x" }, contextTokens: 32768, tools: true, purpose: "chat", trainable: false, state: "downloading", progress: { state: "downloading", receivedBytes: 245_700_016, totalBytes: 491_400_032 }, reason: null, memoryNeededMiB: 900, fits: true, speed: { tokensPerSecond: 48.8, measured: false, on: "cpu" } },
    { id: "stories-15m", name: "TinyStories 15M", descriptor: "A small model to fine-tune", parameters: "15M", quantization: "F32", sizeBytes: 98_357_920, license: { id: "mit", url: "x" }, contextTokens: 256, tools: false, purpose: "test", trainable: true, state: "installed", progress: null, reason: null, memoryNeededMiB: 370, fits: true, speed: { tokensPerSecond: 210, measured: true, on: "cpu" } },
    { id: "qwen2.5-coder-7b-q4", name: "Qwen2.5 Coder 7B", descriptor: "Best for building apps", parameters: "7B", quantization: "Q4_K_M", sizeBytes: 4_683_073_536, license: { id: "apache-2.0", url: "x" }, contextTokens: 32768, tools: true, purpose: "build", trainable: false, state: "available", progress: null, reason: null, memoryNeededMiB: 9000, fits: false, speed: { tokensPerSecond: 5.1, measured: false, on: "cpu" } },
  ],
  service: { state: "queued", jobId: "aaaaaaaaaaaaaaaa", modelId: null, device: null, gpu: null, queuePosition: 2, startedAt: null, lastUsedAt: null, inFlight: 0, reason: null },
  jobs: [
    { id: "aaaaaaaaaaaaaaaa", kind: "inference", appId: null, appName: null, modelId: "stories-15m", state: "queued", device: null, gpu: null, queuePosition: 2, createdAt: 1, startedAt: null, endedAt: null, reason: null, epochs: null, epochsDone: null, checkpoints: null, cost: "none" },
    { id: "0123456789abcdef", kind: "training", appId: "alice--notes", appName: "Notes", modelId: "stories-15m", state: "running", device: "gpu", gpu: { deviceIds: ["0"] }, queuePosition: null, createdAt: 1, startedAt: 2, endedAt: null, reason: null, epochs: 3, epochsDone: 1, checkpoints: 1, cost: "none" },
    { id: "fedcba9876543210", kind: "training", appId: "alice--notes", appName: "Notes", modelId: "stories-15m", state: "failed", device: "cpu", gpu: null, queuePosition: null, createdAt: 1, startedAt: 2, endedAt: 3, reason: "Training stopped with an error. Resume to continue from the last checkpoint.", epochs: 3, epochsDone: 2, checkpoints: 2, cost: "none" },
  ],
  apps: [
    { serviceId: "alice--notes", name: "Notes", grant: { serverDomain: "home.alice.flagship.services", serviceId: "alice--notes", requestsPerDay: 500, tokensPerDay: 200000, maxTokensPerRequest: 1024, issuedAt: 1 }, usage: { day: "2026-10-24", requests: 3, tokens: 900 } },
    { serviceId: "alice--chat", name: "Chat", grant: null, usage: { day: "2026-10-24", requests: 0, tokens: 0 } },
  ],
  datasets: [{ serviceId: "alice--notes", name: "Notes", hasSampleData: true }, { serviceId: "alice--chat", name: "Chat", hasSampleData: false }],
  trainableModels: [{ id: "stories-15m", name: "TinyStories 15M", installed: true, memoryNeededMiB: 934 }],
};

describe("local AI orders (shared vectors)", () => {
  it("canonical bytes and signatures match, refused orders throw", async () => {
    const O = await load("lib/localAiOrders.js");
    for (const g of V.grants) {
      const bytes = O.canonicalLocalAiAppGrant(g.grant);
      expect(new TextDecoder().decode(bytes)).toBe(g.canonical);
      expect(ed25519.verify(hex(g.signatureHex), bytes, hex(V.pubHex))).toBe(true);
    }
    for (const t of V.trains) {
      const bytes = O.canonicalLocalAiTrainOrder(t.order);
      expect(new TextDecoder().decode(bytes)).toBe(t.canonical);
      expect(ed25519.verify(hex(t.signatureHex), bytes, hex(V.pubHex))).toBe(true);
    }
    for (const r of V.refusedGrants) expect(() => O.canonicalLocalAiAppGrant(r.grant), r.name).toThrow();
    for (const r of V.refusedTrains) expect(() => O.canonicalLocalAiTrainOrder(r.order), r.name).toThrow();
  });

  it("builds exactly the bodies the box checks", async () => {
    const O = await load("lib/localAiOrders.js");
    const g = V.grants[0];
    expect(await O.appGrantBody(g.grant, sign)).toEqual({ order: g.grant, signature: g.signatureHex });
    const t = V.trains[0];
    expect(await O.trainOrderBody(t.order, sign)).toEqual({ order: t.order, signature: t.signatureHex });
    expect(O.newJobId()).toMatch(/^[0-9a-f]{16}$/);
    expect(O.withdrawal("a.b", "x--y", 5)).toEqual({ serverDomain: "a.b", serviceId: "x--y", requestsPerDay: 0, tokensPerDay: 0, maxTokensPerRequest: 0, issuedAt: 5 });
  });

  it("both tags sign under the admin root on an admin device", async () => {
    const { SENSITIVE_TAGS } = await load("lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/local-ai-app-grant/v1")).toBe(true);
    expect(SENSITIVE_TAGS.has("flagship/local-ai-train/v1")).toBe(true);
  });
});

describe("the Local AI screen", () => {
  it("shows size, memory, speed, progress, privacy and cost", async () => {
    const view = await load("views/local-ai.js");
    const html = view.localAiHtml(VIEW, { canChange: true });
    expect(html).toContain("Runs only on this server. Nothing is sent anywhere.");
    expect(html).toContain("Free: runs on this server");
    expect(html).toContain("Downloading… 50%");
    expect(html).toContain("About 210 tokens a second on this server's processor (measured).");
    expect(html).toContain("About 49 tokens a second on this server's processor (estimate).");
    expect(html).toContain("more than this server has");
    expect(html).toMatch(/data-la-download="qwen2.5-coder-7b-q4" disabled/);
    expect(html).toContain('data-la-cancel="qwen2.5-0.5b-q4"');
    expect(html).toContain("RTX 4090 (24.0 GB): in use by Render");
    expect(html).toContain("4 processor cores");
  });

  it("the job queue: who holds the GPU, where each job waits, what can be done", async () => {
    const view = await load("views/local-ai.js");
    const html = view.localAiHtml(VIEW, { canChange: true });
    expect(html).toContain("1 job ahead");
    expect(html).toContain("On the GPU (0)");
    expect(html).toContain("Epoch 1 of 3");
    expect(html).toContain('data-la-job-cancel="0123456789abcdef"');
    expect(html).toContain('data-la-job-resume="fedcba9876543210"');
    expect(html).toContain('data-la-job-delete="fedcba9876543210"');
    const L = await load("lib/localAi.js");
    expect(L.queueLine({ queuePosition: 1 })).toBe("Next in line");
    expect(L.queueLine({ queuePosition: null })).toBe("");
  });

  it("fine-tuning offers only apps with staged sample data and downloaded bases", async () => {
    const view = await load("views/local-ai.js");
    const html = view.localAiHtml(VIEW, { canChange: true });
    expect(html).toContain('<option value="alice--notes">Notes</option>');
    expect(html).not.toContain('<option value="alice--chat">');
    expect(view.localAiHtml({ ...VIEW, datasets: [] }, { canChange: true })).toContain("No app has sample data to learn from yet.");
  });

  it("other devices see it read-only", async () => {
    const view = await load("views/local-ai.js");
    const html = view.localAiHtml(VIEW, { canChange: false });
    expect(html).toContain("Only an admin device can change Local AI.");
    expect(html).not.toContain("data-la-download");
    expect(html).not.toContain("la-train-start");
    expect(html).not.toContain("data-la-grant");
  });

  it("an unavailable box says why", async () => {
    const view = await load("views/local-ai.js");
    expect(view.localAiHtml({ available: false, reason: "Local AI runs on a Flagship server, not here." })).toContain("Local AI runs on a Flagship server, not here.");
  });

  it("checkpoints show epoch, size, a short digest and the loss", async () => {
    const view = await load("views/local-ai.js");
    const html = view.jobDetailHtml({ job: VIEW.jobs[1], checkpoints: [{ epoch: 1, sha256: "ab".repeat(32), sizeBytes: 98_357_920, at: 1, loss: 2.3456 }] });
    expect(html).toContain("Epoch 1 · 94 MB · abababababab… · loss 2.346");
  });

  it("allow, withdraw and fine-tune send signed orders", async () => {
    const view = await load("views/local-ai.js");
    const posts: Array<{ path: string; body: { order: Record<string, unknown>; signature: string } }> = [];
    const post = async (path: string, body: { order: Record<string, unknown>; signature: string }) => (posts.push({ path, body }), { ok: true });
    await view.submitAppGrant({ serverDomain: "Home.Alice.flagship.services", serviceId: "alice--chat", quotas: { requestsPerDay: 500, tokensPerDay: 200000, maxTokensPerRequest: 1024 }, issuedAt: 10 }, { sign, post });
    await view.submitWithdraw({ serverDomain: "home.alice.flagship.services", serviceId: "alice--notes", issuedAt: 11 }, { sign, post });
    await view.submitTrain({ serverDomain: "home.alice.flagship.services", serviceId: "alice--notes", baseModel: "stories-15m", epochs: 3, issuedAt: 12, jobId: "0123456789abcdef" }, { sign, post });
    expect(posts.map((p) => p.path)).toEqual(["/apps/grant", "/apps/grant", "/train"]);
    expect(posts[1]!.body.order).toMatchObject({ requestsPerDay: 0, tokensPerDay: 0, maxTokensPerRequest: 0 });
    const O = await load("lib/localAiOrders.js");
    expect(ed25519.verify(hex(posts[0]!.body.signature), O.canonicalLocalAiAppGrant(posts[0]!.body.order), hex(V.pubHex))).toBe(true);
    expect(ed25519.verify(hex(posts[2]!.body.signature), O.canonicalLocalAiTrainOrder(posts[2]!.body.order), hex(V.pubHex))).toBe(true);
  });
});

describe("the build menu's On this server group", () => {
  it("appears once a model is downloaded, or when the chat already uses it", async () => {
    const G = await load("lib/modelGroups.js");
    const L = await load("lib/localAi.js");
    expect(L.localUsable(VIEW)).toBe(true);
    expect(L.localUsable({ ...VIEW, models: VIEW.models.map((m) => ({ ...m, state: "available" })) })).toBe(false);
    expect(G.buildGroups({ localUsable: true }).map((g: { id: string }) => g.id)).toEqual(["flagship-local"]);
    expect(G.buildGroups({ localUsable: false })).toEqual([]);
    expect(G.buildGroups({ currentProvider: "flagship-local" })[0].title).toBe("On this server");
    const groups = G.buildGroups({ localUsable: true });
    expect(G.groupForCredential(groups, { provider: "flagship-local", apiKey: "local" })?.id).toBe("flagship-local");
    expect(G.groupForProvider(groups, "flagship-local")?.id).toBe("flagship-local");
  });

  it("sends the box's own credential, never a key, and lists models without a credit line", async () => {
    const G = await load("lib/modelGroups.js");
    const local = { id: "flagship-local", kind: "local", title: "On this server", menu: null };
    expect(await G.credentialForMessage(local, { picked: true })).toEqual({ provider: "flagship-local", apiKey: "local" });
    expect(await G.credentialForMessage(local, {})).toBeNull();
    const menu = await G.loadLocalMenu(async (path: string, init: { body: string }) => {
      expect(path).toBe("/api/screens/ai/models");
      expect(JSON.parse(init.body)).toEqual({ credential: { provider: "flagship-local", apiKey: "local" } });
      return { provider: "flagship-local", kind: "own", listed: true, models: [{ id: "stories-15m", label: "TinyStories 15M", vision: false, tools: false, known: true }], defaultModel: "stories-15m" };
    });
    const html = G.groupedPanelHtml([{ ...local, menu }], { group: "flagship-local", model: "stories-15m" });
    expect(html).toContain("Runs only on this server. Nothing is sent anywhere.");
    expect(html).toContain('data-mm-model="stories-15m"');
    expect(html).not.toMatch(/credit/i);
  });

  it("when the box can't run the model, its sentence shows and nothing switches provider", async () => {
    const G = await load("lib/modelGroups.js");
    const { ScreensError } = await load("lib/api.js");
    const menu = await G.loadLocalMenu(async () => {
      throw new ScreensError("This model needs more memory than this server has.", 503, null);
    });
    const groups = [{ id: "flagship-local", kind: "local", title: "On this server", menu }];
    const html = G.groupedPanelHtml(groups, { group: "flagship-local", model: null });
    expect(html).toContain("This model needs more memory than this server has.");
    // The choice stays on the local group: no other group exists to fall back to.
    expect(G.groupForProvider(groups, "flagship-local")?.id).toBe("flagship-local");
    const empty = await G.loadLocalMenu(async () => ({ provider: "flagship-local", kind: "own", listed: true, models: [] }));
    expect(G.groupedPanelHtml([{ ...groups[0], menu: empty }], {})).toContain("No model is downloaded on this server yet.");
  });

  it("the AI-key step offers On this server only when the box has a model", async () => {
    const view = await load("views/build-key.js");
    expect(view.localRowHtml(false)).toBe("");
    expect(view.localRowHtml(true)).toContain('id="build-key-local-use"');
  });
});
