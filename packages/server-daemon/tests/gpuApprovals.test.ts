/**
 * The owner's GPU approvals on the box (gpu/approvals.ts): an app that asks for a GPU waits as a
 * pending approval, only the admin root's signature (the IRK on a box that pins none) for exactly
 * its installation and generation grants it, the proof reaches every claim, and a withdrawal drops it
 * and stops the app's GPU work. Hostile: wrong signer, other server, other app or generation,
 * widened terms, stale and replayed grants and withdrawals, a corrupt state file.
 */
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ed,
  parseAnyManifest,
  signGpuApproval,
  signGpuApprovalWithdraw,
  verifyGpuApproval,
  type GpuApprovalTerms,
  type NormalizedApp,
} from "@flagship/protocol";
import { onCorruptState } from "../src/durableFile.js";
import { GpuApprovalStore, NEEDS_GPU_APPROVAL, acceleratorRequestFor, setGpuApprovals, type GpuApprovalRequestEvent, type PendingGpuApproval } from "../src/gpu/approvals.js";
import { AcceleratorBroker, AppAccelerators } from "../src/gpu/broker.js";
import { buildAcceleratorsHttp } from "../src/gpu/http.js";

const SERVER = "home.alice.flagship.services";
const NOW = 1_800_000_000_000;
const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const ADMIN = kp(0x22);
const IRK = kp(0x11);
const STRANGER = kp(0x33);

function app(extra: Record<string, unknown> = {}): NormalizedApp {
  const r = parseAnyManifest({
    schema_version: 2,
    name: "render",
    version: "1.0.0",
    runtime: { base: "node-24", port: 8080 },
    accelerator: { backend: "nvidia-cuda", minimumMemoryMiB: 4096, capabilities: ["compute"] },
    ...extra,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.app;
}

let dir: string;
let t: number;
let events: GpuApprovalRequestEvent[];
let pushes: number;
let notes: string[];
let revoked: string[];
let restarted: string[];

function store(keys: { irkPub: Uint8Array | null; adminRootPub: Uint8Array | null } = { irkPub: IRK.publicKey, adminRootPub: ADMIN.publicKey }): GpuApprovalStore {
  const s = new GpuApprovalStore({ path: join(dir, "gpu-approvals.json"), serverDomain: () => SERVER, keys: () => keys, note: (k) => notes.push(k), now: () => t });
  s.setSinks(() => ({ emit: (e) => events.push(e), push: () => void pushes++ }));
  s.setEffects({ granted: (id) => restarted.push(id), revoke: async (id) => void revoked.push(id) });
  return s;
}

function terms(p: PendingGpuApproval, over: Partial<GpuApprovalTerms> = {}): GpuApprovalTerms {
  return {
    app: { appId: p.appId, installationId: p.installationId, generation: p.generation },
    backend: p.backend,
    maxCount: p.maxCount,
    capabilities: p.caps,
    policies: p.policies,
    isolation: p.isolation,
    secrecy: p.secrecy,
    trustDomain: p.trustDomain,
    ownerConsent: p.ownerConsent,
    ...over,
  };
}

function grantBody(p: PendingGpuApproval, by = ADMIN, o: { server?: string; issuedAt?: number; terms?: Partial<GpuApprovalTerms> } = {}) {
  const tm = terms(p, o.terms);
  const issuedAt = o.issuedAt ?? t;
  const server = o.server ?? SERVER;
  return {
    server: p.server,
    appId: tm.app.appId,
    installationId: tm.app.installationId,
    generation: tm.app.generation,
    backend: tm.backend,
    maxCount: tm.maxCount,
    caps: tm.capabilities,
    policies: tm.policies,
    isolation: tm.isolation,
    secrecy: tm.secrecy,
    trustDomain: tm.trustDomain,
    ownerConsent: tm.ownerConsent,
    issuedAt,
    signature: Buffer.from(signGpuApproval(server, tm, issuedAt, by)).toString("hex"),
  };
}

function withdrawBody(p: { appId: string; installationId: string; generation: number }, by = ADMIN, issuedAt = t, server = SERVER) {
  const w = { appId: p.appId, installationId: p.installationId, generation: p.generation, issuedAt };
  return { ...w, signature: Buffer.from(signGpuApprovalWithdraw(server, w, by)).toString("hex") };
}

async function pendingOf(s: GpuApprovalStore, serviceId = "alice-render", a = app()): Promise<PendingGpuApproval> {
  const req = await s.requestFor(serviceId, a);
  expect(req?.approvalProof).toBeUndefined();
  const p = (await s.lists()).pendingApprovals.find((x) => x.appId === serviceId);
  expect(p).toBeDefined();
  return p!;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gpu-approvals-"));
  t = NOW;
  events = [];
  pushes = 0;
  notes = [];
  revoked = [];
  restarted = [];
});

describe("an app that asks for a GPU", () => {
  it("waits as a pending approval, announced once per generation, and never claims without a proof", async () => {
    const s = store();
    const p = await pendingOf(s);
    expect(p).toEqual({
      server: SERVER,
      appId: "alice-render",
      installationId: expect.stringMatching(/^[0-9a-f]{16}$/),
      generation: 1,
      backend: "nvidia-cuda",
      maxCount: 1,
      caps: ["compute"],
      policies: ["exclusive"],
      isolation: "gvisor-nvproxy",
      secrecy: true,
      trustDomain: null,
      ownerConsent: null,
    });
    expect(events).toEqual([{ type: "gpu-approval-request", appId: "alice-render" }]);
    expect(pushes).toBe(1);
    expect(notes).toEqual(["gpu.approval.pending"]);
    await s.requestFor("alice-render", app());
    expect(pushes).toBe(1);

    const calls: string[] = [];
    const broker = new AcceleratorBroker(async (op) => void calls.push(op), { engine: "podman" });
    const hook = new AppAccelerators(broker, join(dir, "held.json"));
    const req = (await s.requestFor("alice-render", app()))!;
    expect(req.pendingReason).toBe(NEEDS_GPU_APPROVAL);
    expect(await hook.beforeRun("alice-render", req)).toEqual({ kind: "refused", reason: NEEDS_GPU_APPROVAL });
    expect(calls).toEqual([]);
  });

  it("an owner-signed approval reaches every claim for that generation, and gpud's own check passes", async () => {
    const s = store();
    const p = await pendingOf(s);
    const r = await s.grant(grantBody(p));
    expect(r).toMatchObject({ ok: true, approval: { appId: "alice-render", issuedAt: NOW } });
    expect(restarted).toEqual(["alice-render"]);
    const lists = await s.lists();
    expect(lists.pendingApprovals).toEqual([]);
    expect(lists.approvals).toEqual([{ ...p, issuedAt: NOW }]);

    const seen: Record<string, unknown>[] = [];
    const broker = new AcceleratorBroker(
      async (op, args) => {
        if (op === "gpu.inventory") return { available: true, reason: null, devices: [{ id: "d0", backend: "nvidia-cuda", displayOwned: false, holders: [], qualified: [{}] }], unavailable: [], admissionPaused: null, catalog: { status: "verified" } };
        if (op === "gpu.claim") {
          seen.push(args!);
          return { allocationId: args!.allocationId, state: "reserved", queuePosition: null };
        }
        if (op === "gpu.attach") return { allocation: args!.allocationId, args: ["--runtime=runsc-nvproxy", "--device", "nvidia.com/gpu=0"], cdiSpecDigest: null, image: "i" };
        return {};
      },
      { engine: "podman" },
    );
    const req = (await s.requestFor("alice-render", app()))!;
    expect((await new AppAccelerators(broker, join(dir, "held.json")).beforeRun("alice-render", req)).kind).toBe("gpu");
    const claim = seen[0]!;
    expect(claim.approvalProof).toEqual({ issuedAt: NOW, signature: grantBody(p).signature });
    expect(claim.app).toEqual({ appId: "alice-render", installationId: p.installationId, generation: 1 });
    const proof = claim.approvalProof as { issuedAt: number; signature: string };
    expect(verifyGpuApproval(SERVER, claim.approval as GpuApprovalTerms, proof.issuedAt, Buffer.from(proof.signature, "hex"), ADMIN.publicKey)).toBe(true);

    const again = new GpuApprovalStore({ path: join(dir, "gpu-approvals.json"), serverDomain: () => SERVER, keys: () => ({ irkPub: IRK.publicKey, adminRootPub: ADMIN.publicKey }), now: () => t });
    expect((await again.requestFor("alice-render", app()))?.approvalProof).toEqual(proof);
  });

  it("refuses a wrong signer, the IRK on an admin-pinned box, another server, app, installation or generation", async () => {
    const s = store();
    const p = await pendingOf(s);
    const q = await pendingOf(s, "bob-paint");
    const code = async (b: unknown) => {
      const r = await s.grant(b);
      return r.ok ? "ok" : r.code;
    };
    expect(await code(grantBody(p, STRANGER))).toBe("bad-signature");
    expect(await code(grantBody(p, IRK))).toBe("admin-only");
    expect(await code(grantBody(p, ADMIN, { server: "home2.alice.flagship.services" }))).toBe("bad-signature");
    expect(await code({ ...grantBody(p), server: "home2.alice.flagship.services" })).toBe("other-server");
    const forBob = grantBody(p);
    expect(await code({ ...forBob, appId: q.appId, installationId: q.installationId })).toBe("bad-signature");
    expect(await code(grantBody(p, ADMIN, { terms: { app: { appId: p.appId, installationId: "0".repeat(16), generation: 1 } } }))).toBe("stale-installation");
    expect(await code(grantBody(p, ADMIN, { terms: { app: { appId: p.appId, installationId: p.installationId, generation: 2 } } }))).toBe("stale-installation");
    expect(await code(grantBody(p, ADMIN, { terms: { maxCount: 4 } }))).toBe("terms-mismatch");
    expect(await code(grantBody(p, ADMIN, { terms: { capabilities: ["compute", "graphics"] } }))).toBe("terms-mismatch");
    expect(await code(grantBody(p, ADMIN, { terms: { policies: ["exclusive", "cooperative"] } }))).toBe("terms-mismatch");
    expect(await code(grantBody(p, ADMIN, { terms: { isolation: "vm-passthrough" } }))).toBe("terms-mismatch");
    expect(await code(grantBody(p, ADMIN, { issuedAt: NOW - 11 * 60_000 }))).toBe("stale");
    expect(await code({ ...grantBody(p), approved: true })).toBe("bad-request");
    expect(await code({ ...grantBody(p), signature: "AB".repeat(64) })).toBe("bad-request");
    expect((await s.lists()).approvals).toEqual([]);
    expect(restarted).toEqual([]);
  });

  it("takes the IRK on a box that pins no admin root, and nothing on a box that pins no key", async () => {
    const irkOnly = store({ irkPub: IRK.publicKey, adminRootPub: null });
    const p = await pendingOf(irkOnly);
    expect((await irkOnly.grant(grantBody(p, ADMIN))).ok).toBe(false);
    expect((await irkOnly.grant(grantBody(p, IRK))).ok).toBe(true);
    dir = await mkdtemp(join(tmpdir(), "gpu-approvals-"));
    const none = store({ irkPub: null, adminRootPub: null });
    const q = await pendingOf(none);
    expect(await none.grant(grantBody(q, ADMIN))).toMatchObject({ ok: false, code: "no-owner-key" });
  });

  it("a new generation needs a new approval; a rollback to the approved one gets it back", async () => {
    const s = store();
    const p = await pendingOf(s);
    expect((await s.grant(grantBody(p))).ok).toBe(true);
    const updated = app({ network: { egress: [{ host: "api.example.com", why: "sync" }] } });
    const req = await s.requestFor("alice-render", updated);
    expect(req?.approvalProof).toBeUndefined();
    expect(req?.installation.generation).toBe(2);
    const p2 = (await s.lists()).pendingApprovals[0]!;
    expect(p2.generation).toBe(2);
    expect(events.length).toBe(2);
    expect(await s.grant(grantBody(p))).toMatchObject({ ok: false, code: "stale-installation" });
    const back = await s.requestFor("alice-render", app());
    expect(back?.installation.generation).toBe(1);
    expect(back?.approvalProof?.issuedAt).toBe(NOW);
  });

  it("a withdrawal drops the approval and stops the GPU work; a replayed one, or an IRK one on an admin box, is refused", async () => {
    const s = store();
    const p = await pendingOf(s);
    const first = grantBody(p);
    expect((await s.grant(first)).ok).toBe(true);
    t += 1000;
    expect(await s.withdraw(withdrawBody(p, IRK))).toMatchObject({ ok: false, code: "admin-only" });
    expect(await s.withdraw(withdrawBody(p, STRANGER))).toMatchObject({ ok: false, code: "bad-signature" });
    expect(await s.withdraw(withdrawBody(p, ADMIN, t, "home2.alice.flagship.services"))).toMatchObject({ ok: false, code: "bad-signature" });
    expect(await s.withdraw(withdrawBody({ ...p, generation: 2 }))).toMatchObject({ ok: false, code: "not-approved" });
    expect(await s.withdraw(withdrawBody(p, ADMIN, NOW - 1))).toMatchObject({ ok: false, code: "replayed" });
    const w = withdrawBody(p);
    expect(await s.withdraw(w)).toEqual({ ok: true, approval: null });
    expect(revoked).toEqual(["alice-render"]);
    expect(notes).toContain("gpu.approval.withdrawn");
    expect((await s.requestFor("alice-render", app()))?.approvalProof).toBeUndefined();

    expect(await s.grant(first)).toMatchObject({ ok: false, code: "replayed" });
    t += 1000;
    expect((await s.grant(grantBody(p))).ok).toBe(true);
    expect(await s.withdraw(w)).toMatchObject({ ok: false, code: "replayed" });
    expect((await s.lists()).approvals.length).toBe(1);
  });

  it("an unreadable state file is set aside and every GPU app waits for the owner again", async () => {
    const s = store();
    const p = await pendingOf(s);
    expect((await s.grant(grantBody(p))).ok).toBe(true);
    const reports: string[] = [];
    onCorruptState((r) => reports.push(r.effect));
    for (const bad of ["{not json", JSON.stringify({ v: 1, installations: {}, approvals: { x: { terms: {}, issuedAt: 1, signature: "zz" } }, floors: {} }), JSON.stringify({ v: 2 })]) {
      await writeFile(join(dir, "gpu-approvals.json"), bad);
      const again = store();
      expect((await again.requestFor("alice-render", app()))?.approvalProof).toBeUndefined();
      expect((await again.lists()).approvals).toEqual([]);
    }
    onCorruptState(null);
    expect(reports.length).toBe(3);
    expect((await readdir(dir)).filter((f) => f.includes(".corrupt-")).length).toBe(3);
  });

  it("forgets an uninstalled app, and an app that stops asking", async () => {
    const s = store();
    const p = await pendingOf(s);
    expect((await s.grant(grantBody(p))).ok).toBe(true);
    await s.forget("alice-render");
    const p2 = await pendingOf(s);
    expect(p2.installationId).not.toBe(p.installationId);
    expect(await s.requestFor("alice-render", app({ accelerator: undefined }))).toBeUndefined();
    expect(await s.lists()).toEqual({ pendingApprovals: [], approvals: [] });
    expect(JSON.parse(await readFile(join(dir, "gpu-approvals.json"), "utf8")).installations).toEqual({});
  });

  it("an AMD request under the container sandbox can never be approved", async () => {
    const s = store();
    const req = await s.requestFor("alice-rocm", app({ accelerator: { backend: "amd-rocm", capabilities: ["compute"] } }));
    expect(req?.pendingReason).toMatch(/dedicated VM/);
    expect((await s.lists()).pendingApprovals).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("the deploy path (servicePlatform's containerSpec)", () => {
  it("turns the manifest's accelerator into AppSpec.accelerator, with the proof once approved", async () => {
    setGpuApprovals(null);
    const unconfigured = await acceleratorRequestFor("alice-render", app());
    expect(unconfigured?.approvalProof).toBeUndefined();
    expect(unconfigured?.pendingReason).toBeTruthy();
    expect(await acceleratorRequestFor("alice-notes", app({ accelerator: undefined }))).toBeUndefined();
    const s = store();
    setGpuApprovals(s);
    try {
      const pending = await acceleratorRequestFor("alice-render", app());
      expect(pending).toMatchObject({ installation: { appId: "alice-render", generation: 1 }, requirement: { backend: "nvidia-cuda", count: 1, minimumMemoryMiB: 4096, sharing: "exclusive" }, pendingReason: NEEDS_GPU_APPROVAL });
      const p = (await s.lists()).pendingApprovals[0]!;
      expect((await s.grant(grantBody(p))).ok).toBe(true);
      expect((await acceleratorRequestFor("alice-render", app()))?.approvalProof?.issuedAt).toBe(NOW);
    } finally {
      setGpuApprovals(null);
    }
  });
});

describe("the owner's screen", () => {
  it("lists pending approvals, takes grants and withdrawals from the owner, never from a companion", async () => {
    const s = store();
    const p = await pendingOf(s);
    const broker = new AcceleratorBroker(async (op) => (op === "gpu.inventory" ? { available: false, reason: "no-accelerators", devices: [], unavailable: [], admissionPaused: null, catalog: { status: "missing" } } : {}), { engine: "podman" });
    const owner = buildAcceleratorsHttp({ broker, denyCompanion: () => null, approvals: () => s });
    const companion = buildAcceleratorsHttp({ broker, denyCompanion: () => ({ status: 403, headers: {}, body: "no" }), approvals: () => s });
    const req = (path: string, method: string, body?: unknown) => ({ method, path, headers: {}, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) });
    const get = await owner("/api/screens/accelerators", "GET", req("/api/screens/accelerators", "GET"));
    expect(JSON.parse(String(get!.body))).toMatchObject({ pendingApprovals: [p], approvals: [] });
    const path = "/api/screens/accelerators/approvals";
    expect((await companion(path, "POST", req(path, "POST", grantBody(p))))?.status).toBe(403);
    expect((await owner(path, "POST", req(path, "POST", grantBody(p, IRK))))?.status).toBe(403);
    const ok = await owner(path, "POST", req(path, "POST", grantBody(p)));
    expect(ok?.status).toBe(200);
    expect(JSON.parse(String(ok!.body))).toMatchObject({ ok: true, approval: { appId: p.appId, issuedAt: NOW } });
    t += 1000;
    const wpath = "/api/screens/accelerators/approvals/withdraw";
    expect((await companion(wpath, "POST", req(wpath, "POST", withdrawBody(p))))?.status).toBe(403);
    expect((await owner(wpath, "POST", req(wpath, "POST", withdrawBody(p))))?.status).toBe(200);
    expect(revoked).toEqual(["alice-render"]);
  });
});
