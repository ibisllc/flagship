/**
 * The owner's HTTP surface for the P04/P05 runtimes (owner sessions only):
 *
 *   POST /api/wasi/modules              body: a .wasm core module → {digest}
 *       Puts a module in the box's store so a signed install can name it
 *       (`runtime.digest`). Storing grants nothing: only the owner's signed
 *       install order makes a module run, and the worker compiles it itself.
 *   GET  /api/wasi/status               → {available, reason?, worlds}
 *   GET  /api/app-runtime/<serviceId>   → how an installed app runs: its kind,
 *       a WASI app's world and module digest, a group's members in start
 *       order with their state, and its database profile and limits.
 */
import type { PairedSessionGate } from "./alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { ServicePlatform } from "./servicePlatform.js";
import type { RuntimeRouter } from "./appRuntimes.js";
import { runtimeSummary } from "./appModel.js";
import { componentStartOrder } from "./appGroups/plan.js";
import { componentContainerName } from "./appGroups/names.js";
import type { CommandRunner } from "./serviceRunner.js";
import { MAX_MODULE_BYTES, type WasiModuleStore } from "./wasi/moduleStore.js";
import type { DedicatedPostgres } from "./dataLayer/dedicated.js";

export interface AppRuntimeHttpDeps {
  gate: PairedSessionGate;
  modules: WasiModuleStore;
  wasi: () => { available: boolean; reason?: string };
  platform: () => ServicePlatform | null;
  router: RuntimeRouter;
  cmd: CommandRunner;
  dedicated?: DedicatedPostgres | null;
}

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function containerState(cmd: CommandRunner, name: string): Promise<string> {
  if (!cmd.capture) return "unknown";
  try {
    return (await cmd.capture("docker", ["inspect", "-f", "{{.State.Status}}", name])).stdout.trim() || "unknown";
  } catch {
    return "missing";
  }
}

export function buildAppRuntimeHttp(deps: AppRuntimeHttpDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0]!;
    if (path !== "/api/wasi/modules" && path !== "/api/wasi/status" && !path.startsWith("/api/app-runtime/")) return null;
    const denied = deps.gate.check(req);
    if (denied) return denied;

    if (path === "/api/wasi/status") {
      if (req.method !== "GET") return json(405, { error: "method not allowed" });
      const w = deps.wasi();
      return json(200, { available: w.available, ...(w.reason ? { reason: w.reason } : {}), worlds: w.available ? ["command", "http-proxy"] : [] });
    }

    if (path === "/api/wasi/modules") {
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
      if (body.length === 0) return json(400, { error: "send the module's bytes as the body" });
      if (body.length > MAX_MODULE_BYTES) return json(413, { error: "the module is too large" });
      try {
        const digest = await deps.modules.put(body);
        return json(200, { digest });
      } catch (e) {
        return json(400, { error: (e as Error).message });
      }
    }

    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const serviceId = decodeURIComponent(path.slice("/api/app-runtime/".length));
    const app = deps.platform()?.byServiceId(serviceId);
    if (!app) return json(404, { error: "no such app" });
    const summary = runtimeSummary(app.app);
    const out: Record<string, unknown> = { serviceId, ...summary, running: deps.router.kindOf(serviceId) ?? null };
    if (summary.kind === "group" && app.app) {
      const order = componentStartOrder(app.app.components);
      const members = [];
      for (const name of order) {
        const container = componentContainerName(serviceId, name);
        members.push({ name, order: members.length + 1, state: await containerState(deps.cmd, container) });
      }
      members.push({ name: "main", order: members.length + 1, state: await containerState(deps.cmd, deps.router.containerName(serviceId)) });
      out.members = members;
    }
    const stores = Object.values(app.data?.postgres ?? {});
    if (stores.length > 0) {
      const dedicated = stores.some((s) => s.profile === "dedicated");
      const d = dedicated && deps.dedicated ? await deps.dedicated.describe(app.creator, app.slug) : null;
      out.database = dedicated ? { profile: "dedicated", ...(d ? { limits: d.limits } : {}) } : { profile: "shared" };
    }
    return json(200, out);
  };
}
