// The server page's Container stack (packages/server-daemon/src/archV2Switch.ts): the signed
// flagship/arch-v2-switch/v1 order against the shared vectors, a dry run then the same order for real,
// a re-sign near the box's 5-minute limit, a blocked plan that can't be sent, and the record's words.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

const V = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/arch-v2-switch/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const ADMIN = new Uint8Array(32).fill(0x22);
const SERVER = "home.smoketest.flagship.services";

function classic(blocked = false) {
  return {
    stack: "classic",
    engine: "docker",
    switch: null,
    plan: {
      from: "classic",
      target: "arch-v2",
      steps: ["Install Podman", "Move 4 app image(s)", "Restart on the new stack", "Keep Docker for a 24-hour trial"],
      images: 4,
      volumes: 3,
      needBytes: 6 * 2 ** 30,
      freeBytes: (blocked ? 3 : 41) * 2 ** 30,
      blockers: blocked ? [{ code: "no-podman-room", error: "Moving the apps needs about 6.0 GB free on this server; it has 3.0 GB." }] : [],
    },
  };
}

function box(status: any) {
  const posts: any[] = [];
  return {
    posts,
    client: {
      fetch: async (path: string, init?: { method?: string; body?: string }) => {
        if (path === "/api/stack") return structuredClone(status);
        const b = JSON.parse(init!.body!);
        posts.push(b);
        if (b.dryRun) return { ok: true, dryRun: true, plan: status.plan };
        status.switch = { state: "trial", target: b.order.target, startedAt: 1, trialUntil: 2 };
        status.stack = b.order.target;
        return { ok: true, state: "restarting", plan: status.plan };
      },
    },
  };
}

describe("flagship/arch-v2-switch/v1", () => {
  it("matches the shared vectors", async () => {
    const L = await load("lib/stackSwitch.js");
    for (const c of V.cases) {
      const bytes = L.canonicalArchV2SwitchOrder(c.order);
      if (c.canonical) expect(new TextDecoder().decode(bytes), c.name).toBe(c.canonical);
      expect(ed25519.verify(hex(c.signature), bytes, hex(V.signerHex)), c.name).toBe(c.expect);
      if (c.expect) expect(Buffer.from(ed25519.sign(bytes, ADMIN)).toString("hex"), c.name).toBe(c.signature);
    }
    for (const r of V.refused) expect(() => L.canonicalArchV2SwitchOrder(r.order), r.name).toThrow();
    expect(L.newNonce()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("the Container stack card", () => {
  const sign = async (b: Uint8Array) => ed25519.sign(b, ADMIN);

  it("signs once, dry-runs, then sends the same order for real", async () => {
    const S = await load("views/stack-switch.js");
    const b = box(classic());
    const w = await S.wireStackSwitch(SERVER, { client: b.client, sign, now: () => 1_800_000_000_000, sleep: async () => {} });
    expect(S.stackCardHtml(w.state)).toContain("This server runs the classic stack (Docker).");
    expect(S.stackCardHtml(w.state)).toContain("Move to the new stack");
    await w.prepare();
    expect(b.posts[0].dryRun).toBe(true);
    expect(b.posts[0].order).toMatchObject({ serverDomain: SERVER, target: "arch-v2", issuedAt: 1_800_000_000_000 });
    const html = S.stackCardHtml(w.state);
    expect(html).toContain("What the move does");
    expect(html).toContain("Needs about");
    await w.confirm();
    expect(b.posts).toHaveLength(2);
    expect(b.posts[1].dryRun).toBeUndefined();
    expect(b.posts[1].order).toEqual(b.posts[0].order);
    expect(b.posts[1].signature).toBe(b.posts[0].signature);
    expect(w.state.notice).toBe("The server is restarting for the move. This card shows how it goes.");
    expect(S.stackCardHtml(w.state)).toContain("On trial until");
    expect(S.stackCardHtml(w.state)).toContain("This server runs the new stack (Podman and the Rust services).");
  });

  it("signs again near the box's 5-minute limit", async () => {
    const S = await load("views/stack-switch.js");
    const b = box(classic());
    let t = 1_800_000_000_000;
    const w = await S.wireStackSwitch(SERVER, { client: b.client, sign, now: () => t, sleep: async () => {} });
    await w.prepare();
    t += 5 * 60_000;
    await w.confirm();
    expect(b.posts[1].order.nonce).not.toBe(b.posts[0].order.nonce);
    expect(b.posts[1].order.issuedAt).toBe(t);
  });

  it("a blocked plan shows the box's sentence and cannot be sent", async () => {
    const S = await load("views/stack-switch.js");
    const b = box(classic(true));
    const w = await S.wireStackSwitch(SERVER, { client: b.client, sign, sleep: async () => {} });
    await w.prepare();
    const html = S.stackCardHtml(w.state);
    expect(html).toContain("Moving the apps needs about 6.0 GB free on this server; it has 3.0 GB.");
    expect(html).toMatch(/id="stack-move-now" disabled/);
    await w.confirm();
    expect(b.posts).toHaveLength(1);
  });

  it("says what the record says, and hides on an older box", async () => {
    const L = await load("lib/stackSwitch.js");
    expect(L.recordLine({ state: "reverted", reason: "the server didn't report healthy on the new stack" })).toBe(
      "The move was undone: the server didn't report healthy on the new stack",
    );
    expect(L.recordLine({ state: "installing" })).toBe("Moving: the server restarts and its apps come back on the new stack.");
    expect(L.moveLabel("classic")).toBe("Go back to the classic stack");
    const S = await load("views/stack-switch.js");
    const w = await S.wireStackSwitch(SERVER, { client: { fetch: async () => { throw Object.assign(new Error("nf"), { status: 404 }); } } });
    expect(w.state.hidden).toBe(true);
    expect(S.stackCardHtml(w.state)).toBe("");
  });

  it("labels the GPU and stack events in Activity", async () => {
    const A = await load("lib/activityFeed.js");
    for (const [kind, label] of [
      ["gpu.approval.pending", "An app asked to use a GPU"],
      ["gpu.approval.granted", "Approved an app's GPU use"],
      ["gpu.approval.withdrawn", "Withdrew an app's GPU use"],
      ["server.stack.switch-started", "Started a stack move"],
      ["server.stack.switched", "Finished a stack move"],
      ["server.stack.switch-reverted", "The stack move was undone"],
    ]) {
      expect(A.boxEntryRow({ ts: 1, kind })?.title, kind).toBe(label);
    }
  });
});
