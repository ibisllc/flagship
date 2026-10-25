/**
 * The owner's GPU approvals on this box (gpu.md §5). An app whose manifest asks for an accelerator
 * gets one only with the owner's signed `flagship/gpu-approval/v1` for exactly its installation and
 * generation; flagship-gpud checks that signature again itself before it hands out a device.
 *
 * - Each app that asks gets an installation here: a random id, and a generation that moves whenever
 *   its capability digest does (an update that changes what it asks for), so a new generation always
 *   needs a new approval. Uninstalling forgets it; a reinstall is a new installation.
 * - Until approved, the app is listed as pending (`GET /api/screens/accelerators` `pendingApprovals`),
 *   an open owner app hears `{type:"gpu-approval-request", appId}` on the screens socket, Activity
 *   notes it, and the phone gets a content-free `generic` push; the app runs on the CPU only if its
 *   manifest allows that.
 * - A grant must be fresh, newer than any withdrawal of that generation, match what the app asks for,
 *   and be signed by the admin root on a box that pins one (else the IRK). A withdrawal is signed the
 *   same way (`flagship/gpu-approval-withdraw/v1`), drops the approval and stops the app's GPU work.
 *
 * Kept in `<dataDir>/gpu-approvals.json` (durable writes). An unreadable file is set aside and the
 * box starts with no approvals: every GPU app waits for the owner again.
 */
import { randomBytes } from "node:crypto";
import {
  verifyGpuApproval,
  verifyGpuApprovalWithdraw,
  type AppAccelerator,
  type GpuApprovalTerms,
  type GpuApprovalWithdraw,
  type IsolationProfile as ManifestIsolation,
  type NormalizedApp,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "../durableFile.js";
import { gpuIsolationFor, requirementFromManifest, type AppAcceleratorRequest, type GpuApprovalWire } from "./broker.js";

/** How old a signed grant or withdrawal may be when it reaches the box. */
export const GPU_APPROVAL_FRESH_MS = 10 * 60_000;
export const NEEDS_GPU_APPROVAL = "This app needs your approval to use a GPU. Approve it on this server's page, then start the app again.";
const NO_SAFE_ISOLATION = "AMD and Intel GPUs run only in a dedicated VM; this app asks for the container sandbox.";
const PUSHES_PER_HOUR = 5;

/** What the owner signs, minus `issuedAt` (the contract the apps build against). */
export interface PendingGpuApproval {
  server: string;
  appId: string;
  installationId: string;
  generation: number;
  backend: GpuApprovalTerms["backend"];
  maxCount: number;
  caps: GpuApprovalTerms["capabilities"];
  policies: GpuApprovalTerms["policies"];
  isolation: GpuApprovalTerms["isolation"];
  secrecy: boolean;
  trustDomain: string | null;
  ownerConsent: string | null;
}

export interface GrantedGpuApproval extends PendingGpuApproval {
  issuedAt: number;
}

export interface GpuApprovalRequestEvent {
  type: "gpu-approval-request";
  appId: string;
}

export interface GpuApprovalSinks {
  emit?: (e: GpuApprovalRequestEvent) => void;
  push?: () => Promise<unknown> | void;
  alertsEnabled?: () => boolean;
}

interface Installation {
  installationId: string;
  generation: number;
  capabilityDigest: string;
  accelerator: AppAccelerator;
  isolation: ManifestIsolation;
  /** The generation the owner was last told about. */
  alerted: number;
  /** The generation before the last change, so a failed update's rollback gets its approval back. */
  previous?: { generation: number; capabilityDigest: string; accelerator: AppAccelerator; isolation: ManifestIsolation; approval: Stored | null };
}

interface Stored {
  terms: GpuApprovalTerms;
  issuedAt: number;
  signature: string;
}

interface State {
  v: 1;
  installations: Record<string, Installation>;
  approvals: Record<string, Stored>;
  /** The newest withdrawal per `<appId>|<installationId>|<generation>`: nothing signed before it counts. */
  floors: Record<string, number>;
}

export interface GpuApprovalsDeps {
  /** null: memory only (tests). */
  path: string | null;
  serverDomain: () => string;
  /** The owner's keys as this box pins them now. */
  keys: () => { irkPub: Uint8Array | null; adminRootPub: Uint8Array | null };
  note?: (kind: string, detail: string, opts: { ok?: boolean; target?: string }) => void;
  now?: () => number;
  log?: (m: string) => void;
}

export type GpuApprovalResult = { ok: true; approval: GrantedGpuApproval | null } | { ok: false; status: number; error: string; code: string };

const empty = (): State => ({ v: 1, installations: {}, approvals: {}, floors: {} });
const refuse = (status: number, code: string, error: string): GpuApprovalResult => ({ ok: false, status, code, error });
const floorKey = (a: { appId: string; installationId: string; generation: number }) => `${a.appId}|${a.installationId}|${a.generation}`;
const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
const sameSet = (a: readonly string[], b: readonly string[]) => sorted(a).join(",") === sorted(b).join(",");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const intAt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const SIG = /^[0-9a-f]{128}$/;

function onlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

function wellFormed(v: unknown): v is State {
  if (!isObj(v) || v.v !== 1 || !isObj(v.installations) || !isObj(v.approvals) || !isObj(v.floors)) return false;
  for (const i of Object.values(v.installations)) {
    if (!isObj(i) || typeof i.installationId !== "string" || !intAt(i.generation) || typeof i.capabilityDigest !== "string" || !isObj(i.accelerator) || typeof i.isolation !== "string" || !intAt(i.alerted)) return false;
    if (i.previous !== undefined && (!isObj(i.previous) || !intAt(i.previous.generation) || typeof i.previous.capabilityDigest !== "string" || !isObj(i.previous.accelerator) || (i.previous.approval !== null && !isObj(i.previous.approval)))) return false;
  }
  for (const a of Object.values(v.approvals)) {
    if (!isObj(a) || !isObj(a.terms) || !intAt(a.issuedAt) || typeof a.signature !== "string" || !SIG.test(a.signature)) return false;
  }
  return Object.values(v.floors).every(intAt);
}

export class GpuApprovalStore {
  private state: State = empty();
  readonly ready: Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private sinks: () => GpuApprovalSinks = () => ({});
  private pushes: number[] = [];
  private granted: ((serviceId: string) => void) | null = null;
  private revoker: ((appId: string) => Promise<void>) | null = null;
  private readonly now: () => number;

  constructor(private readonly d: GpuApprovalsDeps) {
    this.now = d.now ?? Date.now;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    if (!this.d.path) return;
    const r = await readStateFile(this.d.path);
    if (r.kind === "missing") return;
    let parsed: unknown = null;
    let error: unknown = null;
    if (r.kind === "ok") {
      try {
        parsed = JSON.parse(r.text);
      } catch (e) {
        error = e;
      }
    } else {
      error = r.error;
    }
    if (error === null && wellFormed(parsed)) {
      this.state = parsed;
      return;
    }
    await keepCorruptAside(this.d.path, error ?? new Error("not a GPU approvals file"), "Every app's GPU approval is set aside: each GPU app waits for your approval again.");
  }

  private save(): Promise<void> {
    const path = this.d.path;
    if (!path) return Promise.resolve();
    const text = JSON.stringify(this.state);
    const next = this.chain.then(() => writeFileDurable(path, text));
    this.chain = next.catch((e: Error) => this.d.log?.(`[gpu] the GPU approvals could not be saved: ${e.message}`));
    return next;
  }

  /** Where a pending approval is announced; set once the daemon has its socket and push relay. */
  setSinks(sinks: () => GpuApprovalSinks): void {
    this.sinks = sinks;
    for (const [appId, i] of Object.entries(this.state.installations)) {
      if (!this.valid(appId, i)) this.announce(appId, i, true);
    }
  }

  /** After a grant (start the app again so it gets its GPU), and on a withdrawal (gpud's revokeApp). */
  setEffects(e: { granted?: (serviceId: string) => void; revoke?: (appId: string) => Promise<void> }): void {
    if (e.granted) this.granted = e.granted;
    if (e.revoke) this.revoker = e.revoke;
  }

  /** The app is gone: its installation and approval go with it (withdrawal floors stay). */
  async forget(serviceId: string): Promise<void> {
    await this.ready;
    if (!this.state.installations[serviceId] && !this.state.approvals[serviceId]) return;
    delete this.state.installations[serviceId];
    delete this.state.approvals[serviceId];
    await this.save();
  }

  private valid(appId: string, i: Installation): Stored | null {
    const s = this.state.approvals[appId];
    if (!s) return null;
    const a = s.terms.app;
    return a.appId === appId && a.installationId === i.installationId && a.generation === i.generation ? s : null;
  }

  private pendingTerms(appId: string, i: Installation): GpuApprovalTerms | null {
    const isolation = gpuIsolationFor(i.isolation, i.accelerator.backend);
    if (!isolation) return null;
    const cooperative = i.accelerator.sharing === "cooperative";
    return {
      app: { appId, installationId: i.installationId, generation: i.generation },
      backend: i.accelerator.backend,
      maxCount: i.accelerator.count,
      capabilities: sorted(i.accelerator.capabilities) as GpuApprovalTerms["capabilities"],
      policies: [i.accelerator.sharing],
      isolation,
      secrecy: !cooperative,
      trustDomain: null,
      ownerConsent: null,
    };
  }

  private view(t: GpuApprovalTerms): PendingGpuApproval {
    return {
      server: this.d.serverDomain(),
      appId: t.app.appId,
      installationId: t.app.installationId,
      generation: t.app.generation,
      backend: t.backend,
      maxCount: t.maxCount,
      caps: sorted(t.capabilities) as GpuApprovalTerms["capabilities"],
      policies: sorted(t.policies) as GpuApprovalTerms["policies"],
      isolation: t.isolation,
      secrecy: t.secrecy,
      trustDomain: t.trustDomain,
      ownerConsent: t.ownerConsent,
    };
  }

  /** What the owner's screen lists. */
  async lists(): Promise<{ pendingApprovals: PendingGpuApproval[]; approvals: GrantedGpuApproval[] }> {
    await this.ready;
    const pendingApprovals: PendingGpuApproval[] = [];
    const approvals: GrantedGpuApproval[] = [];
    for (const [appId, i] of Object.entries(this.state.installations).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const s = this.valid(appId, i);
      if (s) approvals.push({ ...this.view(s.terms), issuedAt: s.issuedAt });
      else {
        const t = this.pendingTerms(appId, i);
        if (t) pendingApprovals.push(this.view(t));
      }
    }
    return { pendingApprovals, approvals };
  }

  /**
   * The deploy's accelerator request for an app (AppSpec.accelerator), or undefined when its
   * manifest asks for none. Without a valid approval it carries no proof and the reason, so the
   * AppRunner hook never claims (CPU only when the manifest allows it).
   */
  async requestFor(serviceId: string, app: NormalizedApp | undefined): Promise<AppAcceleratorRequest | undefined> {
    await this.ready;
    const acc = app?.accelerator;
    if (!app || !acc) {
      if (this.state.installations[serviceId] || this.state.approvals[serviceId]) await this.forget(serviceId);
      return undefined;
    }
    let i = this.state.installations[serviceId];
    if (!i) {
      i = { installationId: randomBytes(8).toString("hex"), generation: 1, capabilityDigest: app.capabilityDigest, accelerator: acc, isolation: app.isolation, alerted: 0 };
      this.state.installations[serviceId] = i;
      await this.save();
    } else if (i.capabilityDigest !== app.capabilityDigest || i.isolation !== app.isolation) {
      const was = { generation: i.generation, capabilityDigest: i.capabilityDigest, accelerator: i.accelerator, isolation: i.isolation, approval: this.valid(serviceId, i) };
      const back = i.previous && i.previous.capabilityDigest === app.capabilityDigest && i.previous.isolation === app.isolation ? i.previous : null;
      const top = Math.max(i.generation, i.previous?.generation ?? 0);
      i = { ...i, generation: back ? back.generation : top + 1, capabilityDigest: app.capabilityDigest, accelerator: acc, isolation: app.isolation, previous: was };
      this.state.installations[serviceId] = i;
      if (back?.approval) this.state.approvals[serviceId] = back.approval;
      else delete this.state.approvals[serviceId];
      await this.save();
    }
    const installation = { appId: serviceId, installationId: i.installationId, generation: i.generation };
    const requirement = requirementFromManifest(acc);
    const s = this.valid(serviceId, i);
    if (s) return { installation, requirement, approval: s.terms as GpuApprovalWire, approvalProof: { issuedAt: s.issuedAt, signature: s.signature } };
    const t = this.pendingTerms(serviceId, i);
    this.announce(serviceId, i, false);
    return {
      installation,
      requirement,
      approval: (t ?? { ...this.pendingTerms(serviceId, { ...i, isolation: "vm" })! }) as GpuApprovalWire,
      pendingReason: t ? NEEDS_GPU_APPROVAL : NO_SAFE_ISOLATION,
    };
  }

  private announce(appId: string, i: Installation, replay: boolean): void {
    if (!this.pendingTerms(appId, i)) return;
    const fresh = i.alerted !== i.generation;
    if (!fresh && !replay) return;
    const sinks = this.sinks();
    try {
      sinks.emit?.({ type: "gpu-approval-request", appId });
    } catch {
      // a dead socket must not lose the request
    }
    if (!fresh) return;
    this.state.installations[appId] = { ...i, alerted: i.generation };
    void this.save().catch(() => {});
    this.d.note?.("gpu.approval.pending", "An app asks to use a GPU. Approve it on this server's page.", { ok: true, target: appId });
    if (!sinks.push || sinks.alertsEnabled?.() === false) return;
    const t = this.now();
    this.pushes = this.pushes.filter((x) => t - x < 3_600_000);
    if (this.pushes.length >= PUSHES_PER_HOUR) return;
    this.pushes.push(t);
    const push = sinks.push;
    void Promise.resolve()
      .then(push)
      .catch((e: Error) => this.d.log?.(`[gpu] approval request push failed: ${e.message}`));
  }

  private signer(): { key: Uint8Array; admin: boolean; irk: Uint8Array | null } | null {
    const k = this.d.keys();
    if (k.adminRootPub) return { key: k.adminRootPub, admin: true, irk: k.irkPub };
    if (k.irkPub) return { key: k.irkPub, admin: false, irk: null };
    return null;
  }

  private fresh(issuedAt: number): boolean {
    return Math.abs(this.now() - issuedAt) <= GPU_APPROVAL_FRESH_MS;
  }

  /** `POST …/approvals`: the owner's signed grant for one app installation and generation. */
  async grant(body: unknown): Promise<GpuApprovalResult> {
    await this.ready;
    const keys = ["server", "appId", "installationId", "generation", "backend", "maxCount", "caps", "policies", "isolation", "secrecy", "trustDomain", "ownerConsent", "issuedAt", "signature"] as const;
    if (!isObj(body) || !onlyKeys(body, keys)) return refuse(400, "bad-request", "The approval has missing or unknown fields.");
    const b = body;
    if (
      typeof b.server !== "string" || typeof b.appId !== "string" || typeof b.installationId !== "string" || !intAt(b.generation) ||
      typeof b.backend !== "string" || !intAt(b.maxCount) || !Array.isArray(b.caps) || !b.caps.every((x) => typeof x === "string") ||
      !Array.isArray(b.policies) || !b.policies.every((x) => typeof x === "string") || typeof b.isolation !== "string" ||
      typeof b.secrecy !== "boolean" || !strOrNull(b.trustDomain) || !strOrNull(b.ownerConsent) || !intAt(b.issuedAt) ||
      typeof b.signature !== "string" || !SIG.test(b.signature)
    ) {
      return refuse(400, "bad-request", "The approval has missing or unknown fields.");
    }
    if (b.server !== this.d.serverDomain()) return refuse(403, "other-server", "This approval is for another server.");
    const i = this.state.installations[b.appId];
    if (!i || i.installationId !== b.installationId || i.generation !== b.generation) {
      return refuse(409, "stale-installation", "This approval is for another installation or version of the app. Approve it again from this server's page.");
    }
    const want = this.pendingTerms(b.appId, i);
    if (!want) return refuse(409, "no-safe-isolation", NO_SAFE_ISOLATION);
    const terms: GpuApprovalTerms = {
      app: { appId: b.appId, installationId: b.installationId, generation: b.generation },
      backend: b.backend as GpuApprovalTerms["backend"],
      maxCount: b.maxCount,
      capabilities: b.caps as GpuApprovalTerms["capabilities"],
      policies: b.policies as GpuApprovalTerms["policies"],
      isolation: b.isolation as GpuApprovalTerms["isolation"],
      secrecy: b.secrecy,
      trustDomain: b.trustDomain as string | null,
      ownerConsent: b.ownerConsent as string | null,
    };
    if (terms.backend !== want.backend || terms.maxCount !== want.maxCount || terms.isolation !== want.isolation || !sameSet(terms.capabilities, want.capabilities) || !sameSet(terms.policies, want.policies)) {
      return refuse(409, "terms-mismatch", "This approval doesn't match what the app asks for.");
    }
    if (terms.policies.includes("cooperative") && (!terms.trustDomain || !terms.ownerConsent)) {
      return refuse(400, "needs-trust-domain", "Sharing a GPU between apps needs your consent and a trust domain.");
    }
    if (!this.fresh(b.issuedAt)) return refuse(403, "stale", "This approval is too old. Sign it again.");
    const key = floorKey(terms.app);
    const prior = this.valid(b.appId, i);
    if (b.issuedAt <= (this.state.floors[key] ?? -1) || (prior && b.issuedAt <= prior.issuedAt)) {
      return refuse(409, "replayed", "This approval was already used or withdrawn. Sign a new one.");
    }
    const sig = Buffer.from(b.signature, "hex");
    const signer = this.signer();
    if (!signer) return refuse(403, "no-owner-key", "This server pins no owner key to check a GPU approval against.");
    if (!verifyGpuApproval(b.server, terms, b.issuedAt, sig, signer.key)) {
      if (signer.admin && signer.irk && verifyGpuApproval(b.server, terms, b.issuedAt, sig, signer.irk)) {
        return refuse(403, "admin-only", "Only an admin device of this account can approve GPU use.");
      }
      return refuse(403, "bad-signature", "The approval's signature doesn't check out.");
    }
    this.state.approvals[b.appId] = { terms, issuedAt: b.issuedAt, signature: b.signature };
    await this.save();
    this.d.note?.("gpu.approval.granted", "You approved an app's use of a GPU.", { ok: true, target: b.appId });
    try {
      this.granted?.(b.appId);
    } catch {
      // the approval is kept; the app gets its GPU at its next start
    }
    return { ok: true, approval: { ...this.view(terms), issuedAt: b.issuedAt } };
  }

  /** `POST …/approvals/withdraw`: drop the approval and stop the app's GPU work. */
  async withdraw(body: unknown): Promise<GpuApprovalResult> {
    await this.ready;
    if (!isObj(body) || !onlyKeys(body, ["appId", "installationId", "generation", "issuedAt", "signature"])) {
      return refuse(400, "bad-request", "The withdrawal has missing or unknown fields.");
    }
    const b = body;
    if (typeof b.appId !== "string" || typeof b.installationId !== "string" || !intAt(b.generation) || !intAt(b.issuedAt) || typeof b.signature !== "string" || !SIG.test(b.signature)) {
      return refuse(400, "bad-request", "The withdrawal has missing or unknown fields.");
    }
    const w: GpuApprovalWithdraw = { appId: b.appId, installationId: b.installationId, generation: b.generation, issuedAt: b.issuedAt };
    const i = this.state.installations[w.appId];
    const s = i ? this.valid(w.appId, i) : null;
    if (!i || !s || i.installationId !== w.installationId || i.generation !== w.generation) {
      return refuse(404, "not-approved", "This app has no GPU approval to withdraw.");
    }
    if (!this.fresh(w.issuedAt)) return refuse(403, "stale", "This withdrawal is too old. Sign it again.");
    const key = floorKey(w);
    if (w.issuedAt <= s.issuedAt || w.issuedAt <= (this.state.floors[key] ?? -1)) {
      return refuse(409, "replayed", "This withdrawal is older than the approval it would remove.");
    }
    const sig = Buffer.from(b.signature, "hex");
    const signer = this.signer();
    if (!signer) return refuse(403, "no-owner-key", "This server pins no owner key to check a GPU approval against.");
    const server = this.d.serverDomain();
    if (!verifyGpuApprovalWithdraw(server, w, sig, signer.key)) {
      if (signer.admin && signer.irk && verifyGpuApprovalWithdraw(server, w, sig, signer.irk)) {
        return refuse(403, "admin-only", "Only an admin device of this account can withdraw GPU use.");
      }
      return refuse(403, "bad-signature", "The withdrawal's signature doesn't check out.");
    }
    delete this.state.approvals[w.appId];
    if (i.previous) this.state.installations[w.appId] = { ...i, previous: { ...i.previous, approval: null } };
    this.state.floors[key] = w.issuedAt;
    await this.save();
    this.d.note?.("gpu.approval.withdrawn", "You withdrew an app's use of a GPU; its GPU work was stopped.", { ok: true, target: w.appId });
    await this.revoker?.(w.appId).catch((e: Error) => this.d.log?.(`[gpu] stopping ${w.appId}'s GPU work failed: ${e.message}`));
    return { ok: true, approval: null };
  }
}

let shared: GpuApprovalStore | null = null;

/** The one store the deploy path and the owner's screen share (set by the daemon at start). */
export function setGpuApprovals(s: GpuApprovalStore | null): void {
  shared = s;
}

export function gpuApprovals(): GpuApprovalStore | null {
  return shared;
}

/** servicePlatform's hook: the app's accelerator request, or undefined (no request, or no store). */
export async function acceleratorRequestFor(serviceId: string, app: NormalizedApp | undefined): Promise<AppAcceleratorRequest | undefined> {
  if (!app?.accelerator) {
    if (shared) await shared.requestFor(serviceId, app).catch(() => undefined);
    return undefined;
  }
  if (!shared) {
    return {
      installation: { appId: serviceId, installationId: "unregistered", generation: 0 },
      requirement: requirementFromManifest(app.accelerator),
      approval: { app: { appId: serviceId, installationId: "unregistered", generation: 0 }, backend: app.accelerator.backend, maxCount: app.accelerator.count, capabilities: [...app.accelerator.capabilities], policies: [app.accelerator.sharing], isolation: "vm-passthrough", secrecy: true, trustDomain: null, ownerConsent: null },
      pendingReason: "This server can't check GPU approvals yet.",
    };
  }
  return await shared.requestFor(serviceId, app);
}
