// Separate access list per server, a Pro option (docs/service-access-gating.md,
// "Separate lists per server (Pro)"; feat/marketplace): the webapp's
// flagship/app-list-scope/v1 against THE reference vectors, the wire to the
// box, the plan screen's warning, and the view wiring (switch, Pro line,
// server picker that re-targets the whole screen).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { buildServer } from "../src/server.js";

type Case = { serviceRef: string; scope: string; issuedAt: number; canonical: string; signature: string };
const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/app-list-scope/vectors.json"), "utf8"),
) as { signerSeedHex: string; signerPub: string; cases: Case[]; rejects: Array<Omit<Case, "canonical" | "signature"> & { why: string }> };

const webapp = (...p: string[]) => pathToFileURL(resolve(__dirname, "..", "public", "webapp", ...p)).href;
const lib = () => import(webapp("lib", "listScope.js"));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const seed = fromHex(V.signerSeedHex);
const signer = async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, seed);

describe("app-list-scope (webapp) vs test-vectors/app-list-scope", () => {
  it("the signer seed is the vectors' key", () => {
    expect(toHex(ed.getPublicKey(seed))).toBe(V.signerPub);
  });

  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i: canonical bytes + signature", async (_i, c) => {
    const m = await lib();
    const order = { serviceRef: c.serviceRef, scope: c.scope, issuedAt: c.issuedAt };
    expect(text(m.appListScopeCanonicalBytes(order))).toBe(c.canonical);
    expect(await m.signListScope({ ...order, umk: new Uint8Array(32), signWithIrk: signer })).toEqual({ order, signature: c.signature });
  });

  it("signs under the admin root (the sensitive signer's list)", async () => {
    const { SENSITIVE_TAGS } = await import(webapp("lib", "adminRoot.js"));
    expect(SENSITIVE_TAGS.has("flagship/app-list-scope/v1")).toBe(true);
  });

  it.each(V.rejects.map((c) => [c.why, c] as const))("refuses %s", async (_why, c) => {
    const m = await lib();
    expect(() => m.appListScopeCanonicalBytes({ serviceRef: c.serviceRef, scope: c.scope, issuedAt: c.issuedAt })).toThrow();
  });
});

describe("the switch on the box", () => {
  const state = {
    serviceRef: "harry--chess-club",
    scope: "server",
    pending: false,
    plan: "pro",
    self: "Home2.harry.flagship.services",
    leader: "home.harry.flagship.services",
    servers: ["home.harry.flagship.services", "home2.harry.flagship.services"],
  };

  it("signs and posts the order to the shown server's list-scope", async () => {
    const m = await lib();
    const sent: Array<{ path: string; init: { method: string; body: string } }> = [];
    const fetchJson = async (path: string, init: { method: string; body: string }) => {
      sent.push({ path, init });
      return { ok: true, ...state };
    };
    const r = await m.setListScope({
      serviceRef: "harry--chess-club",
      scope: "server",
      umk: new Uint8Array(32),
      signWithIrk: signer,
      fetchJson,
      now: () => V.cases[0]!.issuedAt,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/api/screens/services/harry--chess-club/list-scope");
    expect(sent[0]!.init.method).toBe("POST");
    expect(JSON.parse(sent[0]!.init.body)).toEqual({
      order: { serviceRef: "harry--chess-club", scope: "server", issuedAt: V.cases[0]!.issuedAt },
      signature: V.cases[0]!.signature,
    });
    expect(r).toMatchObject({ scope: "server", self: "home2.harry.flagship.services", leader: "home.harry.flagship.services" });
  });

  it("passes a 402 from the box through (the view shows the Pro line)", async () => {
    const m = await lib();
    const e = Object.assign(new Error("A separate list on each server comes with Pro."), { status: 402, body: { code: "pro-required" } });
    await expect(
      m.setListScope({ serviceRef: "harry--chess-club", scope: "server", umk: new Uint8Array(32), signWithIrk: signer, fetchJson: async () => { throw e; } }),
    ).rejects.toBe(e);
    await expect(
      m.setListScope({ serviceRef: "harry--chess-club", scope: "server", umk: null, signWithIrk: signer, fetchJson: async () => ({}) }),
    ).rejects.toThrow(/Unlock/);
  });

  it("reads the state; an older box that can't say reads null (no switch shown)", async () => {
    const m = await lib();
    expect(await m.fetchListScope("x", { fetchJson: async () => state })).toMatchObject({ scope: "server", plan: "pro", pending: false });
    expect(await m.fetchListScope("x", { fetchJson: async () => { throw new Error("404"); } })).toBeNull();
    expect(m.normalizeListScope({ scope: "weird", plan: "gold" })).toMatchObject({ scope: "account", plan: "unknown", servers: [] });
    expect(m.canTurnOn({ plan: "pro" })).toBe(true);
    expect(m.canTurnOn({ plan: "unknown" })).toBe(false);
    expect(m.canTurnOn(null)).toBe(false);
  });

  it("the off confirm names the lead server", async () => {
    const m = await lib();
    expect(m.listScopeOffConfirm("home.harry.flagship.services")).toBe(
      "Every server will use home's list. People who joined on other servers since lose access.",
    );
  });
});

describe("the plan screen's warning", () => {
  it("says how many apps and whose list they'll use", async () => {
    const m = await lib();
    const w = (n: number, leaders: string[], plan = "pro") => m.separateListsWarning({ plan, separateApps: n, leaders });
    expect(w(1, ["home.harry.flagship.services"])).toBe(
      "1 app has a separate access list on each server. When Pro ends it will use home's list.",
    );
    expect(w(3, ["home.harry.flagship.services"])).toBe(
      "3 apps have a separate access list on each server. When Pro ends they'll all use home's list.",
    );
    expect(w(2, ["home.harry.flagship.services", "lab.harry.flagship.services"])).toBe(
      "2 apps have a separate access list on each server. When Pro ends each will use its lead server's list.",
    );
    expect(w(0, [])).toBeNull();
    expect(w(2, ["home.harry.flagship.services"], "free")).toBeNull();
    expect(m.separateListsWarning(null)).toBeNull();
  });

  it("reads the account summary best-effort", async () => {
    const m = await lib();
    expect(await m.fetchSeparateListsSummary({ fetchJson: async () => ({ plan: "pro", separateApps: 2, leaders: ["Home.x"] }) })).toEqual({
      plan: "pro",
      separateApps: 2,
      leaders: ["home.x"],
    });
    expect(await m.fetchSeparateListsSummary({ fetchJson: async () => { throw new Error("offline"); } })).toBeNull();
  });
});

describe("view wiring", () => {
  it("Access control has the Pro switch and a picker that re-targets the whole screen", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/service-access.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="sa-scope-toggle"');
    expect(r.body).toContain('id="sa-scope-pro"');
    expect(r.body).toContain('id="sa-scope-pending"');
    expect(r.body).toContain('id="sa-server-picker"');
    expect(r.body).toContain("setListScope");
    // Every call and the invite link go to the picked server.
    expect(r.body).toContain("listServer ? boxClient(listServer).fetch(path, init) : screensFetch(path, init)");
    expect(r.body).toContain("listServer ? boxClient(listServer).baseUrl : getPodBaseUrl()");
    // No picker while there is one list.
    expect(r.body).toContain('state.scope !== "server" || servers.length < 2');
  });

  it("the plan screen warns, and the shell knows the push and precaches the lib", async () => {
    const app = buildServer();
    const tier = await app.inject({ method: "GET", url: "/webapp/views/tier-status.js" });
    expect(tier.body).toContain("fetchSeparateListsSummary");
    expect(tier.body).toContain('id="tier-status-separate-lists-warning"');
    const sw = await app.inject({ method: "GET", url: "/webapp/service-worker.js" });
    expect(sw.body).toContain('"/lib/listScope.js"');
    expect(sw.body).toContain('data.category === "access-lists"');
  });
});

describe("invites on the shown server", () => {
  it("narrows .com's invites to the ones the server knows, plus unused links, only with separate lists", async () => {
    const bust = `?t=${Math.random().toString(36).slice(2)}`;
    const m = await import(webapp("views", "service-access.js") + bust);
    const invites = [
      { inviteId: "a", boundAID: "11".repeat(32) },
      { inviteId: "b", boundAID: "22".repeat(32) },
      { inviteId: "c", boundAIDs: ["33".repeat(32)], redemptions: 1 },
      { inviteId: "d" },
      { inviteId: "e", boundAIDs: [], redemptions: 2 },
    ];
    const members = { invites: [{ inviteId: "a" }], members: [{ grants: [{ inviteId: "c" }] }] };
    expect(m.invitesOnShownServer(invites, members, { scope: "server" }).map((i: { inviteId: string }) => i.inviteId)).toEqual(["a", "c", "d"]);
    expect(m.invitesOnShownServer(invites, members, { scope: "account" })).toHaveLength(5);
    expect(m.invitesOnShownServer(invites, null, { scope: "server" })).toHaveLength(5);
  });
});

describe("the activity row", () => {
  it("labels the merge the same on every app", async () => {
    const { BOX_EVENT_LABELS } = await import(webapp("lib", "activityFeed.js"));
    expect(BOX_EVENT_LABELS["access.lists.merged"].label).toBe("Back to one access list");
  });
});
