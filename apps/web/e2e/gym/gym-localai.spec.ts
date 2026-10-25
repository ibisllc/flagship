/**
 * Local AI on the server page (docs/architecture-v2/local-ai.md §4) with no backend: the models
 * list (size, memory, speed, a download's progress until it is installed), the job queue (which
 * app holds the GPU, where each job waits, free and private), fine-tuning signed with the admin
 * root and its checkpoints, an app's access allowed with quotas and withdrawn (both signed), a
 * non-admin device's read-only view, and the build menu's "On this server" group showing the
 * box's own sentence when the model can't run.
 *
 * Sensitive orders go through gymKit `sensitive`: the admin root verifies, the IRK gets the box's 403.
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, mock, reachHome, sensitive, shot, type Keys, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const TRAIN = ["/lib/localAiOrders.js", "canonicalLocalAiTrainOrder"] as [string, string];
const GRANT = ["/lib/localAiOrders.js", "canonicalLocalAiAppGrant"] as [string, string];
const isPath = (path: string) => (u: URL) => u.hostname === HOME && u.pathname === path;

function model(id: string, extra: Record<string, unknown>) {
  return {
    id,
    descriptor: "",
    license: { id: "apache-2.0", url: "https://example.com" },
    contextTokens: 32768,
    tools: true,
    trainable: false,
    state: "available",
    progress: null,
    reason: null,
    memoryNeededMiB: 900,
    fits: true,
    speed: { tokensPerSecond: 48, measured: false, on: "cpu" },
    ...extra,
  };
}

/** The box's Local AI, stateful: a download moves to installed, signed orders change jobs and grants. */
function localAiBox(m: Mock, page: Page, keys: Keys) {
  const state = {
    available: true,
    reason: null,
    privacy: "this-server",
    cost: "none",
    settings: { useGpu: true, serveModel: null as string | null },
    hardware: {
      cpus: 4,
      memoryMiB: 7900,
      diskFreeBytes: 52_000_000_000,
      gpuService: true,
      gpus: [{ id: "0", model: "RTX 4090", vendor: "nvidia", memoryMiB: 24564, state: "in-use", holders: [{ appId: "smoketest--render", appName: "Render", allocationId: "app-smoketest--render-1", state: "running" }] }],
    },
    budget: { usedBytes: 98_357_920, budgetBytes: 68_719_476_736 },
    models: [
      model("qwen2.5-0.5b-q4", { name: "Qwen2.5 0.5B", parameters: "0.5B", quantization: "Q4_K_M", sizeBytes: 491_400_032, purpose: "chat" }),
      model("stories-15m", { name: "TinyStories 15M", parameters: "15M", quantization: "F32", sizeBytes: 98_357_920, purpose: "test", tools: false, trainable: true, state: "installed", speed: { tokensPerSecond: 210, measured: true, on: "cpu" } }),
    ] as Array<Record<string, any>>,
    service: { state: "queued", jobId: "aaaaaaaaaaaaaaaa", modelId: null, device: null, gpu: null, queuePosition: 2, startedAt: null, lastUsedAt: null, inFlight: 0, reason: null },
    jobs: [
      { id: "aaaaaaaaaaaaaaaa", kind: "inference", appId: null, appName: null, modelId: "stories-15m", state: "queued", device: null, gpu: null, queuePosition: 2, createdAt: 1, startedAt: null, endedAt: null, reason: null, epochs: null, epochsDone: null, checkpoints: null, cost: "none" },
    ] as Array<Record<string, any>>,
    apps: [{ serviceId: "smoketest--notes", name: "Notes", grant: null as Record<string, number> | null, usage: { day: "2026-10-24", requests: 0, tokens: 0 } }],
    datasets: [{ serviceId: "smoketest--notes", name: "Notes", hasSampleData: true }],
    trainableModels: [{ id: "stories-15m", name: "TinyStories 15M", installed: true, memoryNeededMiB: 934 }],
  };
  let polls = 0;
  m.get(isPath("/api/screens/local-ai"), () => {
    const dl = state.models.find((x) => x.state === "downloading");
    if (dl && ++polls >= 2) {
      dl.state = "installed";
      dl.progress = null;
    }
    return { json: state };
  });
  m.post(isPath("/api/screens/local-ai/models/download"), (c) => {
    const x = state.models.find((y) => y.id === c.body?.modelId)!;
    x.state = "downloading";
    x.progress = { state: "downloading", receivedBytes: x.sizeBytes / 2, totalBytes: x.sizeBytes };
    polls = 0;
    return { status: 202, json: { ok: true } };
  });
  m.post(
    isPath("/api/screens/local-ai/train"),
    sensitive(page, keys, TRAIN, (b) => ({ arg: b.order, sig: b.signature }), (c) => {
      const o = c.body.order;
      const job = { id: o.jobId, kind: "training", appId: o.serviceId, appName: "Notes", modelId: o.baseModel, state: "running", device: "gpu", gpu: { deviceIds: ["0"] }, queuePosition: null, createdAt: 2, startedAt: 2, endedAt: null, reason: null, epochs: o.epochs, epochsDone: 1, checkpoints: 1, cost: "none" };
      state.jobs.push(job);
      return { status: 202, json: { ok: true, job } };
    }),
  );
  m.get((u) => u.hostname === HOME && /^\/api\/screens\/local-ai\/jobs\/[0-9a-f]{16}$/.test(u.pathname), (c) => {
    const job = state.jobs.find((j) => c.url.pathname.endsWith(j.id));
    return { json: { job, datasetDigest: "cd".repeat(32), datasetBytes: 2048, checkpoints: [{ epoch: 1, sha256: "ab".repeat(32), sizeBytes: 98_357_920, at: 3, loss: 2.3456 }] } };
  });
  m.post(
    isPath("/api/screens/local-ai/apps/grant"),
    sensitive(page, keys, GRANT, (b) => ({ arg: b.order, sig: b.signature }), (c) => {
      const o = c.body.order;
      state.apps[0]!.grant = o.requestsPerDay > 0 ? o : null;
      return { json: { ok: true, grant: state.apps[0]!.grant, usage: state.apps[0]!.usage } };
    }),
  );
  return state;
}

async function openLocalAi(page: Page): Promise<void> {
  await page.evaluate(async (fqdn) => {
    const { enterLocalAi } = await import("/views/local-ai.js");
    enterLocalAi(fqdn);
  }, HOME);
  await expect(page.locator("#view-local-ai")).toBeVisible({ timeout: 10_000 });
}

test.describe("gym webapp Local AI", () => {
  test("gym localai models show size, speed and a download's progress until installed; the queue shows the GPU holder and position", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    localAiBox(m, page, keys);
    await openLocalAi(page);
    const root = page.locator("#local-ai-content");
    await expect(root.locator("[data-la-privacy]")).toContainText("Runs only on this server. Nothing is sent anywhere.", { timeout: 10_000 });
    await expect(root.locator('[data-la-gpu="0"]')).toHaveText("RTX 4090 (24.0 GB): in use by Render");
    await expect(root.locator('[data-la-job="aaaaaaaaaaaaaaaa"]')).toContainText("1 job ahead");
    await expect(root.locator('[data-la-job="aaaaaaaaaaaaaaaa"]')).toContainText("Free: runs on this server");
    await expect(root.locator('[data-la-model="stories-15m"] [data-la-speed]')).toHaveText("About 210 tokens a second on this server's processor (measured).");
    await root.locator('[data-la-download="qwen2.5-0.5b-q4"]').click();
    await expect(root.locator('[data-la-model="qwen2.5-0.5b-q4"] [data-la-state]')).toHaveText("Downloading… 50%", { timeout: 10_000 });
    await shot(page, testInfo, "localai-downloading");
    await expect(root.locator('[data-la-model="qwen2.5-0.5b-q4"] [data-la-state]')).toHaveText("On this server", { timeout: 15_000 });
    expect(m.sent("/api/screens/local-ai/models/download")[0]!.body).toEqual({ modelId: "qwen2.5-0.5b-q4" });
  });

  test("gym localai fine-tuning signs the train order under the admin root and shows its checkpoints", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    localAiBox(m, page, keys);
    await openLocalAi(page);
    const root = page.locator("#local-ai-content");
    await expect(root.locator("#la-train-start")).toBeVisible({ timeout: 10_000 });
    await root.locator("#la-train-epochs").fill("2");
    await root.locator("#la-train-start").click();
    const call = await m.waitFor("/api/screens/local-ai/train");
    expect(call.body.order).toMatchObject({ serviceId: "smoketest--notes", baseModel: "stories-15m", epochs: 2 });
    expect(call.body.order.jobId).toMatch(/^[0-9a-f]{16}$/);
    const job = root.locator(`[data-la-job="${call.body.order.jobId}"]`);
    await expect(job).toContainText("On the GPU (0)", { timeout: 10_000 });
    await expect(job).toContainText("Epoch 1 of 2");
    await job.locator("[data-la-job-open]").click();
    await expect(root.locator("[data-la-checkpoint]")).toContainText("Epoch 1 · 94 MB · abababababab… · loss 2.346", { timeout: 10_000 });
    await shot(page, testInfo, "localai-checkpoints");
  });

  test("gym localai an app is allowed with quotas and withdrawn, each order signed", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    localAiBox(m, page, keys);
    await openLocalAi(page);
    const app = page.locator('#local-ai-content [data-la-app="smoketest--notes"]');
    await expect(app).toContainText("Not allowed", { timeout: 10_000 });
    await app.locator("[data-la-q-requests]").fill("50");
    await app.locator('[data-la-grant="smoketest--notes"]').click();
    await m.waitFor("/api/screens/local-ai/apps/grant");
    expect(m.last("/api/screens/local-ai/apps/grant")!.body.order).toMatchObject({ serviceId: "smoketest--notes", requestsPerDay: 50, tokensPerDay: 200000, maxTokensPerRequest: 1024 });
    await expect(app.locator("[data-la-usage]")).toHaveText("Today: 0 of 50 requests, 0 of 200,000 tokens", { timeout: 10_000 });
    await shot(page, testInfo, "localai-app-allowed");
    await app.locator('[data-la-withdraw="smoketest--notes"]').click();
    await page.locator("[data-modal-ok]").click();
    await m.waitFor("/api/screens/local-ai/apps/grant", "POST", 2);
    expect(m.last("/api/screens/local-ai/apps/grant")!.body.order).toMatchObject({ requestsPerDay: 0, tokensPerDay: 0, maxTokensPerRequest: 0 });
    await expect(app).toContainText("Not allowed", { timeout: 10_000 });
  });

  test("gym localai a non-admin device sees Local AI read-only", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    localAiBox(m, page, keys);
    await openLocalAi(page);
    const root = page.locator("#local-ai-content");
    await expect(root.locator("[data-la-admin-only]")).toHaveText("Only an admin device can change Local AI. This device can see it.", { timeout: 10_000 });
    await expect(root.locator("[data-la-download]")).toHaveCount(0);
    await expect(root.locator("#la-train-start")).toHaveCount(0);
    await expect(root.locator("[data-la-grant]")).toHaveCount(0);
    await shot(page, testInfo, "localai-read-only");
    expect(m.sent("/api/screens/local-ai/")).toEqual([]);
  });

  test("gym localai the build menu's On this server group shows the box's sentence and switches nothing", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.post(isPath("/api/screens/ai/models"), (c) =>
      c.body?.credential?.provider === "flagship-local"
        ? { status: 503, json: { error: "This model needs more memory than this server has." } }
        : { status: 400, json: { error: "credential required" } },
    );
    const html = await page.evaluate(async (fqdn) => {
      const G = await import("/lib/modelGroups.js");
      const { boxClient } = await import("/lib/api.js");
      const groups = G.buildGroups({ localUsable: true });
      groups[0].menu = await G.loadLocalMenu((p: string, i: RequestInit) => boxClient(fqdn).fetch(p, i));
      const host = document.createElement("div");
      host.id = "gym-local-menu";
      document.body.appendChild(host);
      host.innerHTML = G.groupedPanelHtml(groups, { group: G.LOCAL_GROUP, model: null });
      return { html: host.innerHTML, group: G.groupForProvider(groups, "flagship-local")?.id ?? null };
    }, HOME);
    expect(html.group).toBe("flagship-local");
    await expect(page.locator("#gym-local-menu [data-mm-local-error]")).toHaveText("This model needs more memory than this server has.");
    await expect(page.locator("#gym-local-menu [data-mm-local-privacy]")).toHaveText("Runs only on this server. Nothing is sent anywhere.");
    expect(html.html).not.toMatch(/credit/i);
    expect(m.sent("/api/screens/ai/models")[0]!.body).toEqual({ credential: { provider: "flagship-local", apiKey: "local" } });
    await shot(page, testInfo, "localai-menu-unavailable");
  });
});
