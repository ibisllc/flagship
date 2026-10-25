/**
 * The owner's view of this server's GPUs (paired-session gated, mounted under /api/screens):
 * which app holds which device, what waits in the queue, what is quarantined or unqualified, and
 * a way to stop a GPU workload. The simulated-device self-test is here too, for the live gym and
 * for support: it touches no real device.
 *
 *   GET  /api/screens/accelerators               … + pendingApprovals, approvals (gpu/approvals.ts)
 *   POST /api/screens/accelerators/stop          { allocationId }
 *   POST /api/screens/accelerators/self-test
 *   POST /api/screens/accelerators/approvals     { server, appId, installationId, generation, backend, maxCount,
 *                                                  caps, policies, isolation, secrecy, trustDomain, ownerConsent,
 *                                                  issuedAt, signature }   (`flagship/gpu-approval/v1`)
 *   POST /api/screens/accelerators/approvals/withdraw
 *                                                { appId, installationId, generation, issuedAt, signature }
 *                                                  (`flagship/gpu-approval-withdraw/v1`)
 * Writes are refused for a Remote (companion) session.
 */
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { GpudError } from "./client.js";
import type { AcceleratorBroker, InventoryView, StatusView } from "./broker.js";
import type { GpuApprovalStore, GrantedGpuApproval, PendingGpuApproval } from "./approvals.js";

export const ACCELERATORS_PATH = "/api/screens/accelerators";
export const ACCELERATORS_STOP_PATH = "/api/screens/accelerators/stop";
export const ACCELERATORS_SELFTEST_PATH = "/api/screens/accelerators/self-test";
export const GPU_APPROVALS_PATH = "/api/screens/accelerators/approvals";
export const GPU_APPROVALS_WITHDRAW_PATH = "/api/screens/accelerators/approvals/withdraw";

export function isAcceleratorsPath(p: string): boolean {
  return p === ACCELERATORS_PATH || p === ACCELERATORS_STOP_PATH || p === ACCELERATORS_SELFTEST_PATH || p === GPU_APPROVALS_PATH || p === GPU_APPROVALS_WITHDRAW_PATH;
}

export type DeviceState = "free" | "in-use" | "quarantined" | "unqualified" | "display";

export interface AcceleratorsResponse {
  available: boolean;
  /** `no-accelerators`, `no-gpu-service`, or null. */
  reason: string | null;
  admissionPaused: string | null;
  catalog: { status: string; serial: number | null };
  devices: {
    id: string;
    model: string;
    vendor: string;
    memoryMiB: number;
    state: DeviceState;
    holders: { appId: string; allocationId: string; state: string }[];
  }[];
  queue: { appId: string; waiting: number }[];
  /** Apps that ask for a GPU and hold no owner approval for their installation and generation. */
  pendingApprovals: PendingGpuApproval[];
  approvals: GrantedGpuApproval[];
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

export function toAcceleratorsResponse(inv: InventoryView, st: StatusView | null): AcceleratorsResponse {
  return {
    available: inv.available,
    reason: inv.reason,
    admissionPaused: inv.admissionPaused ?? st?.admissionPaused ?? null,
    catalog: { status: inv.catalog?.status ?? "unknown", serial: inv.catalog?.serial ?? null },
    devices: inv.devices.map((d) => ({
      id: d.id,
      model: d.model,
      vendor: d.vendor,
      memoryMiB: d.memoryMiB,
      state: d.displayOwned ? "display" : d.quarantined ? "quarantined" : d.holders.length ? "in-use" : d.qualified.length ? "free" : "unqualified",
      holders: d.holders.map((h) => ({ appId: h.appId, allocationId: h.allocationId, state: h.state })),
    })),
    queue: (st?.queue ?? []).map((q) => ({ appId: q.appId, waiting: q.allocations.length })),
    pendingApprovals: [],
    approvals: [],
  };
}

export function buildAcceleratorsHttp(deps: {
  broker: AcceleratorBroker;
  denyCompanion: (req: HttpRequest) => HttpResponse | null;
  approvals?: () => GpuApprovalStore | null;
}) {
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (!isAcceleratorsPath(path)) return null;
    if (path === ACCELERATORS_PATH) {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const inv = await deps.broker.inventory();
      const st = inv.reason === "no-gpu-service" ? null : await deps.broker.status().catch(() => null);
      const lists = (await deps.approvals?.()?.lists()) ?? { pendingApprovals: [], approvals: [] };
      return json(200, { ...toAcceleratorsResponse(inv, st), ...lists });
    }
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const denied = deps.denyCompanion(req);
    if (denied) return denied;
    if (path === GPU_APPROVALS_PATH || path === GPU_APPROVALS_WITHDRAW_PATH) {
      const store = deps.approvals?.();
      if (!store) return json(503, { error: "This server can't take GPU approvals yet.", code: "unavailable" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString("utf8"));
      } catch {
        return json(400, { error: "body must be JSON", code: "bad-request" });
      }
      const r = path === GPU_APPROVALS_PATH ? await store.grant(parsed) : await store.withdraw(parsed);
      return r.ok ? json(200, { ok: true, approval: r.approval }) : json(r.status, { error: r.error, code: r.code });
    }
    if (path === ACCELERATORS_SELFTEST_PATH) {
      try {
        return json(200, await deps.broker.selfTest());
      } catch (e) {
        return json(503, { error: "The GPU service is not running on this server.", code: e instanceof GpudError ? e.code : "failed" });
      }
    }
    let body: { allocationId?: unknown } | null = null;
    try {
      body = req.body.length ? (JSON.parse(req.body.toString("utf8")) as { allocationId?: unknown }) : null;
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    const id = body?.allocationId;
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) return json(400, { error: "allocationId is required" });
    try {
      const settle = await deps.broker.release(id, "stopped by the owner");
      return json(200, { ok: true, settle });
    } catch (e) {
      if (e instanceof GpudError && e.code === "not-found") return json(404, { error: "That GPU job is not running." });
      return json(503, { error: "The GPU service could not stop it." });
    }
  };
}
