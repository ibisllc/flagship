/**
 * Where a local-AI workload runs: on a GPU through flagship-gpud's allocator when a qualified one is
 * free (or frees up within the wait), on the CPU otherwise. The box's own workloads claim like any
 * app (one fair queue, one journal), always exclusive and secret: a device is never shared with an
 * app's workload while it holds the owner's prompts.
 */
import type { AcceleratorBroker, Backend, ClaimResult, DeviceView, GpuApprovalWire } from "../gpu/broker.js";
import { gpuIsolationFor } from "../gpu/broker.js";

/** How the box's local-AI workloads appear to gpud: one app of the box's own. */
export const LOCAL_AI_APP = { appId: "flagship-local-ai", installationId: "box", generation: 1 } as const;

export type Placement =
  | { kind: "gpu"; allocationId: string; backend: Backend; deviceIds: string[]; gpuArgs: string[]; memoryMiB: number }
  | { kind: "cpu"; reason: string | null };

export interface PlacementOptions {
  broker: AcceleratorBroker | null;
  /** The owner's choice: use a GPU when one is free, or never. */
  useGpu: boolean;
  allocationId: string;
  container: string;
  memoryNeededMiB: number;
  /** How long a queued claim may wait before the workload runs on the CPU instead. */
  queueWaitMs: number;
  maxRuntimeMs?: number;
  /** The queue position, as it changes, for the job list. */
  onQueued?: (position: number | null) => void;
  /** Whether the CPU path may be used (a model too big for memory may not). */
  cpuAllowed: boolean;
  signal?: AbortSignal;
}

export function usableDevice(d: DeviceView, memoryNeededMiB: number): boolean {
  return !d.displayOwned && !d.quarantined && d.qualified.length > 0 && d.memoryMiB >= memoryNeededMiB;
}

export function approvalFor(backend: Backend): GpuApprovalWire | null {
  const isolation = gpuIsolationFor(backend === "nvidia-cuda" ? "sandbox" : "vm", backend);
  if (!isolation) return null;
  return {
    app: { ...LOCAL_AI_APP },
    backend,
    maxCount: 1,
    capabilities: ["compute"],
    policies: ["exclusive"],
    isolation,
    secrecy: true,
    trustDomain: null,
    ownerConsent: null,
  };
}

export class PlacementRefused extends Error {}

/** Claim, wait fairly, attach; or say why the CPU is used instead. */
export async function place(o: PlacementOptions): Promise<Placement> {
  const cpu = (reason: string | null): Placement => {
    if (!o.cpuAllowed) throw new PlacementRefused(reason ?? "This model needs a GPU on this server.");
    return { kind: "cpu", reason };
  };
  if (!o.useGpu || !o.broker) return cpu(o.useGpu ? "This server has no GPU service." : null);
  const inv = await o.broker.inventory();
  if (!inv.available) return cpu("This server has no GPU it can use.");
  if (inv.admissionPaused) return cpu("GPU work is paused on this server for maintenance.");
  const candidates = inv.devices.filter((d) => usableDevice(d, o.memoryNeededMiB));
  if (candidates.length === 0) {
    const any = inv.devices.some((d) => !d.displayOwned);
    return cpu(any ? "No GPU on this server is qualified with enough memory for this model." : "This server has no GPU it can use.");
  }
  // Prefer a free device's backend; otherwise the first qualified one (the claim then queues).
  const free = candidates.find((d) => d.holders.length === 0) ?? candidates[0]!;
  const approval = approvalFor(free.backend);
  if (!approval) return cpu("This GPU can't be used safely here.");
  let claim: ClaimResult;
  try {
    claim = await o.broker.claim({
      allocationId: o.allocationId,
      container: o.container,
      app: { ...LOCAL_AI_APP },
      operationId: o.allocationId,
      requirement: { backend: free.backend, count: 1, minimumMemoryMiB: o.memoryNeededMiB, capabilities: ["compute"], sharing: "exclusive", fallback: o.cpuAllowed ? "cpu-if-supported" : "none" },
      approval,
      ...(o.maxRuntimeMs ? { maxRuntimeMs: o.maxRuntimeMs } : {}),
    });
  } catch {
    return cpu("The GPU service refused the claim.");
  }
  if (claim.state !== "reserved") {
    o.onQueued?.(claim.queuePosition);
    const w = await o.broker.waitReserved(o.allocationId, o.queueWaitMs);
    o.onQueued?.(null);
    if (w !== "reserved" || o.signal?.aborted) {
      await o.broker.release(o.allocationId, "waited too long").catch(() => {});
      return cpu("Every GPU on this server was busy.");
    }
  }
  try {
    const a = await o.broker.attach(o.allocationId);
    const st = await o.broker.status().catch(() => null);
    const held = st?.allocations.find((x) => x.allocationId === o.allocationId)?.devices.map((d) => d.partition ? `${d.device}:${d.partition}` : d.device) ?? [free.id];
    return { kind: "gpu", allocationId: o.allocationId, backend: free.backend, deviceIds: held, gpuArgs: a.args, memoryMiB: free.memoryMiB };
  } catch {
    await o.broker.release(o.allocationId, "attach failed").catch(() => {});
    return cpu("The GPU could not be attached safely.");
  }
}
