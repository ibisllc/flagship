/**
 * The accelerator allocator as the box's runtime layer sees it (G02, IMPLEMENTATION-PLAN §9.2).
 * Two callers use it, and nothing else may grant a device:
 *
 *  - apps: a manifest v2 `accelerator` an admin approved (its capability digest) is claimed when
 *    the app is deployed and released when it stops (`AppAccelerators`, the AppRunner hook);
 *  - the AI tool broker (AI01): a local-inference, training, render or transcode job claims through
 *    `AcceleratorBroker.claim` with its own approval, attaches, runs and releases.
 *
 * flagship-gpud (Rust, root) owns the journal, the CDI specs, VFIO and MIG; this side only turns
 * manifests and approvals into its requests and its answers into container-engine arguments, which
 * are re-checked here against the same closed shape before they reach `docker`/`podman run`.
 * Errors are short sentences with no host paths; the AI broker still passes them through
 * `buildModelRedactor` before a model reads them.
 */
import { readFile } from "node:fs/promises";
import type { AppAccelerator, IsolationProfile as ManifestIsolation } from "@flagship/protocol";
import { writeFileDurable } from "../durableFile.js";
import { GpudError, type GpudCall } from "./client.js";

export type Backend = "nvidia-cuda" | "amd-rocm" | "intel-level-zero";
export type Capability = "compute" | "graphics" | "video-encode" | "video-decode";
export type Sharing = "exclusive" | "partition" | "cooperative";
export type GpuIsolation = "gvisor-nvproxy" | "vm-passthrough";

export interface AppInstallation {
  appId: string;
  installationId: string;
  generation: number;
}

/** The Rust `AcceleratorRequirement` (deny_unknown_fields). */
export interface AcceleratorRequirementWire {
  backend: Backend;
  count: number;
  minimumMemoryMiB: number;
  capabilities: Capability[];
  sharing: Sharing;
  fallback: "none" | "cpu-if-supported";
  topology?: "any" | "same-numa" | "peer-fabric";
}

/** The owner's approval as the daemon resolved it from the signed capability approval. */
export interface GpuApprovalWire {
  app: AppInstallation;
  backend: Backend;
  maxCount: number;
  capabilities: Capability[];
  policies: Sharing[];
  isolation: GpuIsolation;
  /** The app's data stays secret from every other app: it never shares a device. */
  secrecy: boolean;
  /** Cooperative sharing only: the owner's trust domain and signed consent. */
  trustDomain: string | null;
  ownerConsent: string | null;
}

/**
 * The owner's signature over the approval (`flagship/gpu-approval/v1`, @flagship/protocol
 * gpuApproval.ts), which gpud checks itself against keyd's pinned owner key. Only the box's own
 * local AI, exclusive and secret, is admitted without one.
 */
export interface GpuApprovalProof {
  issuedAt: number;
  signature: string;
}

export interface ShareLimits {
  computePercent: number;
  memoryMib: number;
}

export interface ClaimRequest {
  allocationId: string;
  /** The one container the allocation may run in; privd and the broker hold the `run` to it. */
  container: string;
  app: AppInstallation;
  operationId: string;
  requirement: AcceleratorRequirementWire;
  approval: GpuApprovalWire;
  approvalProof?: GpuApprovalProof;
  maxRuntimeMs?: number;
  share?: ShareLimits;
  /** A catalog image purpose (`cuda-13.0-runtime`); the first approved one when unset. */
  userspace?: string;
}

export interface ClaimResult {
  allocationId: string;
  state: "reserved" | "admitted" | string;
  queuePosition: number | null;
}

export interface EngineAttachment {
  allocation: string;
  args: string[];
  cdiSpecDigest: string | null;
  image: string;
}

export const ALLOCATION_LABEL = "flagship.gpu.allocation";
export const GPU_RUNTIMES = ["runsc-nvproxy", "kata-vfio"] as const;
const ALLOC_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** gpud's CDI devices: an NVIDIA device or MIG partition, or a VFIO group it bound (never a /dev path). */
const CDI_RE = /^(?:nvidia\.com\/gpu|flagship\.vfio\/group)=[A-Za-z0-9:._-]{1,32}$/;

/** The only arguments a GPU attachment may add to `run` (Rust `attach::check_gpu_args`). */
export function checkGpuArgs(args: readonly string[]): void {
  let runtime = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = args[i + 1];
    if (a === "--device") {
      if (v === undefined || !CDI_RE.test(v) || v.endsWith("=all")) {
        throw new Error(`refusing GPU attachment: ${v ?? "--device"} is not a GPU or VFIO group CDI name`);
      }
      i++;
    } else if (a === "--label") {
      const id = v?.startsWith(`${ALLOCATION_LABEL}=`) ? v.slice(ALLOCATION_LABEL.length + 1) : "";
      if (!ALLOC_RE.test(id)) throw new Error("refusing GPU attachment: only the allocation label may be set");
      i++;
    } else if (a === "-e") {
      if (!v || !/^FLAGSHIP_GPU_(MEMORY_BUDGET_MIB|COMPUTE_PERCENT)=\d+$/.test(v)) throw new Error("refusing GPU attachment: only the GPU budget variables may be set");
      i++;
    } else if (a.startsWith("--runtime=")) {
      const name = a.slice("--runtime=".length);
      if (runtime || !(GPU_RUNTIMES as readonly string[]).includes(name)) throw new Error(`refusing GPU attachment: ${name} is not a GPU runtime`);
      runtime = true;
    } else {
      throw new Error(`refusing GPU attachment: ${a} is not allowed`);
    }
  }
  if (!runtime) throw new Error("refusing GPU attachment: it names no GPU runtime");
}

/** The manifest's `accelerator` as gpud's requirement. */
export function requirementFromManifest(acc: AppAccelerator): AcceleratorRequirementWire {
  return {
    backend: acc.backend,
    count: acc.count,
    minimumMemoryMiB: acc.minimumMemoryMiB,
    capabilities: [...acc.capabilities],
    sharing: acc.sharing,
    fallback: acc.fallback,
  };
}

/**
 * The manifest's isolation (`sandbox` = gVisor, `vm` = a dedicated VM) for this backend. gVisor
 * mediates NVIDIA only (nvproxy); AMD and Intel always need a VM, so an approval for them under
 * `sandbox` is refused here rather than weakened.
 */
export function gpuIsolationFor(manifest: ManifestIsolation, backend: Backend): GpuIsolation | null {
  if (manifest === "vm") return "vm-passthrough";
  return backend === "nvidia-cuda" ? "gvisor-nvproxy" : null;
}

/**
 * The approval for an app whose capability digest an admin signed. Secrecy, trust domain and
 * consent come from the owner, never the manifest.
 */
export function approvalForApp(
  app: AppInstallation,
  acc: AppAccelerator,
  manifestIsolation: ManifestIsolation,
  owner: { secrecy: boolean; trustDomain?: string | null; ownerConsent?: string | null },
): GpuApprovalWire | { refused: string } {
  const isolation = gpuIsolationFor(manifestIsolation, acc.backend);
  if (!isolation) return { refused: "AMD and Intel GPUs run only in a dedicated VM; this app asks for the container sandbox." };
  if (acc.sharing === "cooperative" && (!owner.trustDomain || !owner.ownerConsent)) {
    return { refused: "Sharing a GPU between apps needs your consent and a trust domain." };
  }
  return {
    app,
    backend: acc.backend,
    maxCount: acc.count,
    capabilities: [...acc.capabilities],
    policies: [acc.sharing],
    isolation,
    secrecy: owner.secrecy,
    trustDomain: owner.trustDomain ?? null,
    ownerConsent: owner.ownerConsent ?? null,
  };
}

export interface DeviceView {
  id: string;
  vendor: string;
  backend: Backend;
  model: string;
  memoryMiB: number;
  displayOwned: boolean;
  qualified: { profile: GpuIsolation; entry: string }[];
  unqualifiedReasons: string[];
  quarantined: string | null;
  holders: { allocationId: string; appId: string; state: string; partition: string | null }[];
  partitions: { id: string; memoryMiB: number }[];
}

export interface InventoryView {
  available: boolean;
  reason: string | null;
  devices: DeviceView[];
  unavailable: { backend: Backend; reason: string }[];
  admissionPaused: string | null;
  catalog: { status: string; serial?: number; reason?: string };
}

export interface StatusView {
  allocations: { allocationId: string; appId: string; state: string; policy: Sharing; reason: string | null; devices: { device: string; partition: string | null }[] }[];
  queue: { appId: string; allocations: string[] }[];
  admissionPaused: string | null;
}

export interface BrokerOptions {
  engine: "docker" | "podman";
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

/** The allocator's API for the daemon and the AI tool broker. */
export class AcceleratorBroker {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly call: GpudCall,
    private readonly opts: BrokerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Honest when there is no GPU service: `available: false` with the reason. */
  async inventory(): Promise<InventoryView> {
    try {
      return (await this.call("gpu.inventory")) as InventoryView;
    } catch (e) {
      const code = e instanceof GpudError ? e.code : "failed";
      return { available: false, reason: code === "unavailable" ? "no-gpu-service" : code, devices: [], unavailable: [], admissionPaused: null, catalog: { status: "unknown" } };
    }
  }

  async status(): Promise<StatusView> {
    return (await this.call("gpu.status")) as StatusView;
  }

  async claim(r: ClaimRequest): Promise<ClaimResult> {
    if (!ALLOC_RE.test(r.allocationId)) throw new Error("allocation ids are 1 to 128 of [A-Za-z0-9._-]");
    return (await this.call("gpu.claim", { ...r })) as ClaimResult;
  }

  /** Wait while the claim is queued; the fair queue serves it when a device frees up. */
  async waitReserved(allocationId: string, timeoutMs: number): Promise<"reserved" | "timed-out" | "closed"> {
    const until = this.now() + timeoutMs;
    for (;;) {
      const s = await this.status();
      const a = s.allocations.find((x) => x.allocationId === allocationId);
      if (!a) return "closed";
      if (a.state === "reserved") return "reserved";
      if (this.now() >= until) return "timed-out";
      await this.sleep(this.opts.pollMs ?? 2000);
    }
  }

  async attach(allocationId: string): Promise<EngineAttachment> {
    const a = (await this.call("gpu.attach", { allocationId, engine: this.opts.engine })) as EngineAttachment;
    checkGpuArgs(a.args);
    return a;
  }

  async started(allocationId: string): Promise<void> {
    await this.call("gpu.started", { allocationId, nowMs: this.now() });
  }

  async release(allocationId: string, reason?: string): Promise<string> {
    const r = (await this.call("gpu.release", { allocationId, ...(reason ? { reason } : {}) })) as { settle: string };
    return r.settle;
  }

  async revokeApp(appId: string): Promise<void> {
    await this.call("gpu.revokeApp", { appId });
  }

  async selfTest(): Promise<unknown> {
    return await this.call("gpu.selftest");
  }
}

/** What an app deploy brings: the approved accelerator, or nothing. */
export interface AppAcceleratorRequest {
  installation: AppInstallation;
  requirement: AcceleratorRequirementWire;
  approval: GpuApprovalWire;
  approvalProof?: GpuApprovalProof;
  /** Why there is no proof yet (gpu/approvals.ts): the deploy never claims without one. */
  pendingReason?: string;
  share?: ShareLimits;
  /** How long a deploy waits in the queue before it gives up. */
  queueWaitMs?: number;
}

export type AppAcceleratorOutcome =
  | { kind: "gpu"; allocationId: string; runArgs: string[] }
  | { kind: "cpu"; reason: string }
  | { kind: "refused"; reason: string };

/**
 * The AppRunner hook: claim at deploy, start, release at stop. The allocation an app holds is
 * remembered in a durable file so a restarted daemon releases it before claiming again.
 */
export class AppAccelerators {
  private held: Record<string, string> | null = null;

  constructor(
    private readonly broker: AcceleratorBroker,
    private readonly stateFile: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<Record<string, string>> {
    if (this.held) return this.held;
    try {
      const v = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown;
      this.held = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch {
      this.held = {};
    }
    return this.held;
  }

  private async save(): Promise<void> {
    await writeFileDurable(this.stateFile, JSON.stringify(this.held ?? {}));
  }

  /** Claim and attach for a deploy; CPU only when the manifest and approval allow a CPU path. */
  async beforeRun(serviceId: string, req: AppAcceleratorRequest, container = `flagship-${serviceId}`): Promise<AppAcceleratorOutcome> {
    const held = await this.load();
    if (held[serviceId]) await this.afterStop(serviceId);
    const cpu = (why: string): AppAcceleratorOutcome =>
      req.requirement.fallback === "cpu-if-supported" ? { kind: "cpu", reason: why } : { kind: "refused", reason: why };
    if (!req.approvalProof) return cpu(req.pendingReason ?? "This app needs your approval to use a GPU. Approve it on this server's page, then start the app again.");
    const inv = await this.broker.inventory();
    if (!inv.available || !inv.devices.some((d) => d.backend === req.requirement.backend && !d.displayOwned)) {
      return cpu("This server has no GPU this app can use.");
    }
    const allocationId = `app-${serviceId}-${this.now().toString(36)}`.slice(0, 128);
    let claim: ClaimResult;
    try {
      claim = await this.broker.claim({
        allocationId,
        container,
        app: req.installation,
        operationId: `deploy-${serviceId}`,
        requirement: req.requirement,
        approval: req.approval,
        ...(req.approvalProof ? { approvalProof: req.approvalProof } : {}),
        ...(req.share ? { share: req.share } : {}),
      });
    } catch (e) {
      if (e instanceof GpudError && e.code === "forbidden") return { kind: "refused", reason: "This app's GPU use isn't approved for what it asks." };
      return cpu("The GPU service refused the claim.");
    }
    held[serviceId] = allocationId;
    await this.save();
    if (claim.state !== "reserved") {
      const w = await this.broker.waitReserved(allocationId, req.queueWaitMs ?? 0);
      if (w !== "reserved") {
        await this.afterStop(serviceId);
        return cpu("Every GPU on this server is busy; the app was not started on one.");
      }
    }
    try {
      const a = await this.broker.attach(allocationId);
      return { kind: "gpu", allocationId, runArgs: a.args };
    } catch {
      await this.afterStop(serviceId);
      return { kind: "refused", reason: "The GPU could not be attached safely, so the app was not started on it." };
    }
  }

  async afterRun(serviceId: string, ok: boolean): Promise<void> {
    const id = (await this.load())[serviceId];
    if (!id) return;
    if (ok) await this.broker.started(id);
    else await this.afterStop(serviceId);
  }

  async afterStop(serviceId: string): Promise<void> {
    const held = await this.load();
    const id = held[serviceId];
    if (!id) return;
    try {
      await this.broker.release(id, "the app stopped");
    } catch (e) {
      if (!(e instanceof GpudError) || e.code !== "not-found") throw e;
    }
    delete held[serviceId];
    await this.save();
  }
}
