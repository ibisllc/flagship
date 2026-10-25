// The server page's GPU card (packages/server-daemon/src/gpu/http.ts): the words it shows for what
// GET /api/screens/accelerators answers, when it hides, and Stop (asks first, posts the allocation,
// reloads, says what happened; Cancel sends nothing; the box's own sentence when it refuses).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { pathToFileURL } from "node:url";

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

/** A box with an RTX 4090 that Plants holds, a free A2000, a Radeon set aside, and Wiki waiting. */
function fixture() {
  return {
    available: true,
    reason: null,
    admissionPaused: null as string | null,
    catalog: { status: "current", serial: 1 },
    devices: [
      { id: "0", model: "NVIDIA GeForce RTX 4090", vendor: "nvidia", memoryMiB: 24564, state: "in-use", holders: [{ appId: "smoketest--plants", allocationId: "app-smoketest--plants-k1", state: "running" }] },
      { id: "1", model: "NVIDIA RTX A2000", vendor: "nvidia", memoryMiB: 6138, state: "free", holders: [] },
      { id: "2", model: "AMD Radeon PRO W7600", vendor: "amd", memoryMiB: 8176, state: "quarantined", holders: [] },
    ],
    queue: [{ appId: "smoketest--wiki", waiting: 1 }],
  };
}

describe("GPU card words", () => {
  it("names apps, states, holders and the queue as the other apps do", async () => {
    const L = await load("lib/accelerators.js");
    expect(L.appName("smoketest--plants")).toBe("Plants");
    expect(L.appName("smoketest--my-notes")).toBe("My-Notes");
    expect(L.appName("flagship-local-ai")).toBe("Local AI");
    expect(L.deviceTitle({ id: "0", model: "RTX 4090" })).toBe("GPU 0: RTX 4090");
    expect(L.stateLabel("free")).toBe("Free");
    expect(L.stateLabel("in-use")).toBe("In use");
    expect(L.stateLabel("quarantined")).toBe("Set aside after a fault");
    expect(L.stateLabel("display")).toBe("Drives the screen, so apps can't use it");
    expect(L.stateLabel("unqualified")).toBe("Not qualified on this server");
    expect(L.holderLine({ appId: "a--plants", state: "running" })).toBe("Used by Plants");
    expect(L.holderLine({ appId: "a--wiki", state: "reserved" })).toBe("Starting for Wiki");
    expect(L.holderLine({ appId: "a--wiki", state: "releasing" })).toBe("Wiki is giving it back");
    expect(L.waitingLine({ appId: "a--wiki", waiting: 1 })).toBe("Wiki is waiting");
    expect(L.waitingLine({ appId: "a--wiki", waiting: 3 })).toBe("Wiki is waiting (3 jobs)");
    expect(L.stopTitle({ appId: "a--plants" })).toBe("Stop Plants using the GPU?");
    expect(L.stoppedLine({ appId: "a--plants" })).toBe("Plants no longer has the GPU.");
  });

  it("shows only for a box that has GPU work to show", async () => {
    const L = await load("lib/accelerators.js");
    expect(L.showsCard(fixture())).toBe(true);
    expect(L.showsCard({ available: false, reason: "no-gpu-service", devices: [], queue: [] })).toBe(false);
    expect(L.showsCard({ available: false, reason: "no-accelerators", devices: [], queue: [] })).toBe(false);
    expect(L.showsCard({ available: true, reason: null, devices: [], queue: [] })).toBe(false);
    expect(L.showsCard({ available: false, reason: "failed", devices: [], queue: [] })).toBe(true);
    expect(L.showsCard({ available: true, reason: null, admissionPaused: "maintenance", devices: [], queue: [] })).toBe(true);
    expect(L.showsCard(null)).toBe(false);
  });

  it("renders each GPU, its holder with Stop, the queue and the pause", async () => {
    const V = await load("views/accelerators.js");
    const view = { ...fixture(), admissionPaused: "maintenance" };
    const html: string = V.acceleratorsCardHtml(view);
    expect(html).toContain('id="accelerators-card"');
    expect(html).toContain("GPU 0: NVIDIA GeForce RTX 4090");
    expect(html).toContain("Used by Plants");
    expect(html).toContain('data-acc-stop="app-smoketest--plants-k1"');
    expect(html).toContain("Set aside after a fault");
    expect(html).toContain('data-acc-waiting="smoketest--wiki"');
    expect(html).toContain("Wiki is waiting");
    expect(html).toContain("data-acc-paused");
    expect(html.match(/data-acc-stop=/g)?.length).toBe(1);
    expect(V.acceleratorsCardHtml({ available: false, reason: "no-gpu-service", devices: [], queue: [] })).toBe("");
  });
});

describe("Stop", () => {
  function box(view = fixture()) {
    const calls: Array<{ path: string; init?: { method?: string; body?: string } }> = [];
    let refuse: { status: number; body: unknown } | null = null;
    return {
      calls,
      refuseWith(r: { status: number; body: unknown }) {
        refuse = r;
      },
      client: {
        fetch: async (path: string, init?: { method?: string; body?: string }) => {
          calls.push({ path, init });
          if (path === "/api/screens/accelerators") return structuredClone(view);
          if (refuse) throw Object.assign(new Error("refused"), refuse);
          const id = JSON.parse(init?.body ?? "{}").allocationId;
          for (const d of view.devices) d.holders = d.holders.filter((h) => h.allocationId !== id);
          view.devices[0].state = "free";
          return { ok: true, settle: "released" };
        },
      },
    };
  }

  it("asks first; Cancel sends nothing", async () => {
    const V = await load("views/accelerators.js");
    const b = box();
    const asked: unknown[] = [];
    const w = await V.wireAccelerators("home.smoketest.flagship.services", { client: b.client, confirm: async (o: unknown) => (asked.push(o), false) });
    await w.stop("app-smoketest--plants-k1");
    expect(asked).toEqual([
      {
        title: "Stop Plants using the GPU?",
        message: "The app loses the GPU at once and may stop working until it is started again. The next app waiting gets the GPU.",
        okLabel: "Stop",
        danger: true,
      },
    ]);
    expect(b.calls.filter((c) => c.init?.method === "POST")).toEqual([]);
  });

  it("posts the allocation, reloads and says the app no longer has the GPU", async () => {
    const V = await load("views/accelerators.js");
    const b = box();
    const w = await V.wireAccelerators("home.smoketest.flagship.services", { client: b.client, confirm: async () => true });
    await w.stop("app-smoketest--plants-k1");
    const post = b.calls.find((c) => c.init?.method === "POST");
    expect(post?.path).toBe("/api/screens/accelerators/stop");
    expect(JSON.parse(post!.init!.body!)).toEqual({ allocationId: "app-smoketest--plants-k1" });
    expect(b.calls.at(-1)?.path).toBe("/api/screens/accelerators");
    expect(w.state.notice).toBe("Plants no longer has the GPU.");
    expect(w.state.error).toBeNull();
    expect(w.state.view.devices[0].holders).toEqual([]);
  });

  it("shows the box's sentence when it refuses", async () => {
    const V = await load("views/accelerators.js");
    const b = box();
    b.refuseWith({ status: 404, body: { error: "That GPU job is not running." } });
    const w = await V.wireAccelerators("home.smoketest.flagship.services", { client: b.client, confirm: async () => true });
    await w.stop("app-smoketest--plants-k1");
    expect(w.state.error).toBe("That GPU job is not running.");
    expect(w.state.notice).toBeNull();
  });

  it("hides on a box without the GPU screen", async () => {
    const V = await load("views/accelerators.js");
    const client = { fetch: async () => { throw Object.assign(new Error("nf"), { status: 404, body: { error: "not found" } }); } };
    const w = await V.wireAccelerators("home.smoketest.flagship.services", { client });
    expect(w.state.hidden).toBe(true);
  });
});

describe("GPU approvals (flagship/gpu-approval/v1)", () => {
  const V = JSON.parse(
    readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/gpu-approval/vectors.json"), "utf8"),
  ) as {
    anchor: { server: string; signerHex: string };
    cases: Array<{ name: string; approval: any; proof: { issuedAt: number; signature: string }; canonical?: string; expect: boolean }>;
    withdraw: Array<{ name: string; withdraw: any; signature: string; canonical?: string; expect: boolean }>;
  };
  const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
  const ADMIN = new Uint8Array(32).fill(0x22);
  const listed = (a: any) => ({
    appId: a.app.appId,
    installationId: a.app.installationId,
    generation: a.app.generation,
    backend: a.backend,
    maxCount: a.maxCount,
    caps: a.capabilities,
    policies: a.policies,
    isolation: a.isolation,
    secrecy: a.secrecy,
    trustDomain: a.trustDomain,
    ownerConsent: a.ownerConsent,
  });

  it("matches the shared vectors: canonical bytes, the admin root's signatures, every tampered case refused", async () => {
    const G = await load("lib/gpuApproval.js");
    const pub = hex(V.anchor.signerHex);
    expect(V.cases.length).toBeGreaterThan(10);
    for (const c of V.cases) {
      const bytes = G.gpuApprovalCanonical(V.anchor.server, listed(c.approval), c.proof.issuedAt);
      if (c.canonical) expect(new TextDecoder().decode(bytes), c.name).toBe(c.canonical);
      const sig = /^[0-9a-f]{128}$/.test(c.proof.signature) ? hex(c.proof.signature) : new Uint8Array(64);
      expect(ed25519.verify(sig, bytes, pub), c.name).toBe(c.expect);
      if (c.expect) expect(Buffer.from(ed25519.sign(bytes, ADMIN)).toString("hex"), c.name).toBe(c.proof.signature);
    }
    expect(V.withdraw.length).toBeGreaterThan(3);
    for (const c of V.withdraw) {
      const bytes = G.gpuApprovalWithdrawCanonical(V.anchor.server, c.withdraw);
      if (c.canonical) expect(new TextDecoder().decode(bytes), c.name).toBe(c.canonical);
      const sig = /^[0-9a-f]{128}$/.test(c.signature) ? hex(c.signature) : new Uint8Array(64);
      expect(ed25519.verify(sig, bytes, pub), c.name).toBe(c.expect);
    }
  });

  it("refuses what gpud could not read back, and names a trust domain and consent for sharing", async () => {
    const G = await load("lib/gpuApproval.js");
    const r = listed(V.cases[0]!.approval);
    for (const bad of [{ ...r, appId: "a|b" }, { ...r, maxCount: 17 }, { ...r, caps: [] }, { ...r, backend: "cuda" }, { ...r, trustDomain: "a b" }]) {
      expect(() => G.gpuApprovalCanonical(V.anchor.server, bad, 1)).toThrow();
    }
    expect(() => G.gpuApprovalCanonical("Home.alice", r, 1)).toThrow();
    const coop = { ...r, policies: ["cooperative"], secrecy: false };
    expect(G.ownerTerms(coop, 42)).toMatchObject({ trustDomain: "owner-apps", ownerConsent: "owner-consent-42" });
    expect(G.ownerTerms(r, 42)).toBe(r);
  });

  function approvalsBox(server: string) {
    const view: any = {
      ...fixture(),
      pendingApprovals: [
        { server, appId: "smoketest--render", installationId: "inst-7f3a", generation: 3, backend: "nvidia-cuda", maxCount: 1, caps: ["compute"], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true, trustDomain: null, ownerConsent: null },
        { server, appId: "smoketest--stream", installationId: "inst-5", generation: 2, backend: "nvidia-cuda", maxCount: 1, caps: ["video-encode"], policies: ["cooperative"], isolation: "gvisor-nvproxy", secrecy: false, trustDomain: null, ownerConsent: null },
      ],
      approvals: [
        { server, appId: "smoketest--photos", installationId: "inst-01", generation: 1, backend: "nvidia-cuda", maxCount: 1, caps: ["compute"], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true, trustDomain: null, ownerConsent: null, issuedAt: 1 },
      ],
    };
    const posts: Array<{ path: string; body: any }> = [];
    return {
      view,
      posts,
      client: {
        fetch: async (path: string, init?: { method?: string; body?: string }) => {
          if (path === "/api/screens/accelerators") return structuredClone(view);
          const body = JSON.parse(init?.body ?? "{}");
          posts.push({ path, body });
          if (path.endsWith("/approvals")) {
            view.pendingApprovals = view.pendingApprovals.filter((r: any) => r.appId !== body.appId);
            view.approvals.push({ ...body, signature: undefined });
            return { ok: true };
          }
          view.approvals = view.approvals.filter((r: any) => r.appId !== body.appId);
          return { ok: true, approval: null };
        },
      },
    };
  }

  it("Approve signs the listed terms for this server; sharing names a trust domain; Withdraw signs the withdrawal; Decline sends nothing", async () => {
    const G = await load("lib/gpuApproval.js");
    const Vw = await load("views/accelerators.js");
    const server = "home.smoketest.flagship.services";
    const b = approvalsBox(server);
    const sign = async (bytes: Uint8Array) => ed25519.sign(bytes, ADMIN);
    const w = await Vw.wireAccelerators(server, { client: b.client, canSign: true, sign, now: () => 1_800_000_000_000 });
    const html: string = Vw.acceleratorsCardHtml(w.state.view, { canSign: true });
    expect(html).toContain("Render asks to use the GPU: 1 × NVIDIA GPU, computing, a GPU of its own, in the app sandbox, kept apart from other apps");
    expect(html).toContain("Photos may use the GPU:");
    expect(await w.approve("smoketest--render|inst-7f3a|3")).toBe(true);
    const a = b.posts[0]!;
    expect(a.path).toBe("/api/screens/accelerators/approvals");
    expect(a.body).toMatchObject({ server, appId: "smoketest--render", issuedAt: 1_800_000_000_000, trustDomain: null, ownerConsent: null });
    const bytes = G.gpuApprovalCanonical(server, a.body, a.body.issuedAt);
    expect(ed25519.verify(hex(a.body.signature), bytes, ed25519.getPublicKey(ADMIN))).toBe(true);
    expect(w.state.notice).toBe("Render can use the GPU.");
    expect(await w.approve("smoketest--stream|inst-5|2")).toBe(true);
    expect(b.posts[1]!.body).toMatchObject({ trustDomain: "owner-apps", ownerConsent: "owner-consent-1800000000000" });
    expect(await w.withdraw("smoketest--photos|inst-01|1")).toBe(true);
    expect(b.posts[2]!.path).toBe("/api/screens/accelerators/approvals/withdraw");
    expect(Object.keys(b.posts[2]!.body).sort()).toEqual(["appId", "generation", "installationId", "issuedAt", "signature"]);
    expect(w.state.notice).toBe("Photos can no longer use the GPU.");
    b.view.pendingApprovals.push({ ...b.view.approvals[0], appId: "smoketest--train", installationId: "inst-9", generation: 12 });
    await w.load();
    w.decline("smoketest--train|inst-9|12");
    expect(w.state.notice).toBe("Train won't get a GPU.");
    expect(b.posts).toHaveLength(3);
    expect(Vw.pendingFor(server, w.state.view).map((r: any) => r.appId)).not.toContain("smoketest--train");
  });

  it("never signs for another server, and a device without the admin root sees no buttons", async () => {
    const Vw = await load("views/accelerators.js");
    const b = approvalsBox("other.smoketest.flagship.services");
    const w = await Vw.wireAccelerators("home.smoketest.flagship.services", { client: b.client, canSign: true, sign: async () => { throw new Error("must not sign"); } });
    expect(await w.approve("smoketest--render|inst-7f3a|3")).toBe(false);
    expect(w.state.error).toBe("This request is for another server, so nothing was signed.");
    expect(b.posts).toHaveLength(0);
    const ro: string = Vw.acceleratorsCardHtml(w.state.view, { canSign: false });
    expect(ro).toContain("data-acc-admin-only");
    expect(ro).not.toContain("data-acc-approve");
    expect(ro).not.toContain("data-acc-withdraw");
  });
});
