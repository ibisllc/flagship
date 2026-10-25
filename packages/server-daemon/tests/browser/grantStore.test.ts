import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { InMemoryAlertInbox } from "../../src/alertInbox.js";
import { InMemoryAppAuthTokens } from "../../src/serviceAuthToken.js";
import { BrowserManager } from "../../src/browser/browserManager.js";
import { bootstrapBrowserBundle } from "../../src/browser/bootstrap.js";
import { BrowserGrants, type BrowserGrant } from "../../src/browser/policy/grants.js";
import { BrowserGrantRequests, canonicalBrowserGrantAnswer, canonicalBrowserGrantRevoke, normalizeAsk, type BrowserGrantAnswer } from "../../src/browser/grantRequests.js";
import { BrowserGrantStore } from "../../src/browser/grantStore.js";
import { FakeCdpServer } from "./fakeCdpServer.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const SERVER = "home.alice.flagship.services";
const owner = new Uint8Array(32).fill(4);
const T0 = 1_760_000_000_000;

function box(file: string, t: { now: number }, manifest: Record<string, string[] | null> = {}) {
  const grants = new BrowserGrants(() => t.now);
  const req = new BrowserGrantRequests({
    grants,
    serverDomain: SERVER,
    authority: () => ({ username: "alice", ownerIrkPub: ed.getPublicKey(owner) }),
    now: () => t.now,
    store: new BrowserGrantStore(file, () => t.now),
    manifestDomains: (s) => manifest[s] ?? null,
  });
  const give = (serviceId: string, duration: "once" | "session" | "service", origins = ["shop.example.com"]) => {
    const r = req.ask(normalizeAsk(serviceId, { capabilities: ["navigate"], origins, duration })) as { requestId: string };
    const p = req.pending().find((x) => x.requestId === r.requestId)!;
    const order: BrowserGrantAnswer = { serverDomain: SERVER, requestId: r.requestId, serviceId, decision: "allow", duration, capabilities: p.capabilities, origins: p.origins, localNetwork: p.localNetwork, issuedAt: t.now };
    const out = req.answer({ requestId: r.requestId, decision: "allow", issuedAt: t.now, signatureHex: hex(ed.sign(canonicalBrowserGrantAnswer(order), owner)) });
    return (out as { grantId: string }).grantId;
  };
  const revoke = (serviceId: string, grantId: string) =>
    req.revoke({ serviceId, grantId, issuedAt: t.now, signatureHex: hex(ed.sign(canonicalBrowserGrantRevoke({ serverDomain: SERVER, serviceId, grantId, issuedAt: t.now }), owner)) });
  return { grants, req, give, revoke };
}

const stored = (over: Partial<BrowserGrant> = {}, manifestDomains: string[] | null = null) => ({
  grant: {
    id: "bg-00000000-0000-4000-8000-000000000001",
    serviceId: "alice--shop",
    capabilities: ["navigate"],
    origins: ["shop.example.com"],
    urlPrefixes: [],
    schemes: ["https"],
    ports: [],
    localNetwork: null,
    duration: "service",
    explanation: "",
    sessionId: null,
    issuedAt: T0,
    expiresAt: null,
    revokedAt: null,
    spentAt: null,
    ...over,
  },
  manifestDomains,
});

describe("the owner's standing browser grants survive a restart", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flagship-browser-grants-"));
    file = join(dir, "browser-grants.json");
  });

  it("an 'until you remove it' grant comes back under its own id after a restart; once and session grants do not", async () => {
    const t = { now: T0 };
    const a = box(file, t);
    const kept = a.give("alice--shop", "service");
    a.give("alice--shop", "once", ["once.example.com"]);
    a.give("alice--shop", "session", ["session.example.com"]);
    await a.req.persist();
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { grants: Array<{ grant: BrowserGrant }> };
    expect(onDisk.grants.map((e) => e.grant.id)).toEqual([kept]);

    const b = box(file, t);
    expect(await b.req.restore()).toBe(1);
    expect(b.grants.live("alice--shop").map((g) => [g.id, g.origins])).toEqual([[kept, ["shop.example.com"]]]);
    expect(b.req.granted("alice--shop").map((g) => g.grantId)).toEqual([kept]);
    // Withdrawn after the restart: gone from memory and from the file.
    expect(b.revoke("alice--shop", kept)).toEqual({ ok: true });
    await b.req.persist();
    const c = box(file, t);
    expect(await c.req.restore()).toBe(0);
    expect(c.grants.live("alice--shop")).toEqual([]);
  });

  it("drops an expired grant on load", async () => {
    await writeFile(file, JSON.stringify({ v: 1, grants: [stored({ expiresAt: T0 - 1 }), stored({ id: "bg-00000000-0000-4000-8000-000000000002", expiresAt: T0 + 60_000 })] }));
    const t = { now: T0 };
    const b = box(file, t);
    expect(await b.req.restore()).toBe(1);
    expect(b.grants.live("alice--shop").map((g) => g.id)).toEqual(["bg-00000000-0000-4000-8000-000000000002"]);
  });

  it("a damaged file loads no grants at all (never a wider set) and is kept aside", async () => {
    for (const bad of [
      "{not json",
      JSON.stringify({ v: 2, grants: [] }),
      JSON.stringify({ v: 1, grants: [stored(), stored({ id: "bg-00000000-0000-4000-8000-000000000003", capabilities: ["root" as never] })] }),
      JSON.stringify({ v: 1, grants: [stored({ duration: "session" })] }),
      JSON.stringify({ v: 1, grants: [stored({ revokedAt: T0 })] }),
      JSON.stringify({ v: 1, grants: [stored({ localNetwork: { kind: "whole-lan", hosts: ["x"] } as never })] }),
      JSON.stringify({ v: 1, grants: [stored({ id: "../../etc" })] }),
    ]) {
      await writeFile(file, bad);
      const b = box(file, { now: T0 });
      expect(await b.req.restore(), bad).toBe(0);
      expect(b.grants.all(), bad).toEqual([]);
    }
    const aside = (await readdir(dir)).filter((f) => f.startsWith("browser-grants.json.corrupt-"));
    expect(aside.length).toBeGreaterThan(0);
  });

  it("a stored origin the grant rules refuse is not restored", async () => {
    await writeFile(file, JSON.stringify({ v: 1, grants: [stored({ origins: ["*"] })] }));
    const b = box(file, { now: T0 });
    expect(await b.req.restore()).toBe(0);
    expect(b.grants.all()).toEqual([]);
  });

  it("records the manifest domains a grant was given under, so only the same manifest keeps it", async () => {
    const t = { now: T0 };
    const a = box(file, t, { "alice--shop": ["Shop.example.com", "cdn.example.com"] });
    const id = a.give("alice--shop", "service");
    await a.req.persist();
    const b = box(file, t);
    await b.req.restore();
    expect([...b.req.givenUnder("alice--shop", ["cdn.example.com", "shop.example.com"])]).toEqual([id]);
    expect([...b.req.givenUnder("alice--shop", ["shop.example.com"])]).toEqual([]);
    expect([...b.req.givenUnder("alice--shop", null)]).toEqual([]);
  });
});

describe("restored grants and the app's manifest at boot", () => {
  let cdp: FakeCdpServer;
  let endpoint: string;
  let dataDir: string;
  beforeEach(async () => {
    cdp = new FakeCdpServer();
    endpoint = (await cdp.start()).endpoint;
    dataDir = await mkdtemp(join(tmpdir(), "flagship-browser-grants-boot-"));
  });
  afterEach(async () => {
    await cdp.stop();
  });

  async function boot() {
    const browser = new BrowserManager({ endpoint });
    await browser.start();
    const bundle = await bootstrapBrowserBundle({
      cdpEndpoint: endpoint,
      dataDir,
      alertInbox: new InMemoryAlertInbox(),
      browser,
      appAuthTokens: new InMemoryAppAuthTokens(),
      egress: false,
      serverDomain: SERVER,
      authority: () => ({ username: "alice", ownerIrkPub: ed.getPublicKey(owner) }),
    });
    return { bundle, stop: async () => { await bundle.close(); await browser.stop(); } };
  }

  it("the same manifest coming back at boot keeps the grant; a later manifest change ends it, on disk too", async () => {
    const id = "bg-00000000-0000-4000-8000-000000000004";
    await writeFile(join(dataDir, "browser-grants.json"), JSON.stringify({ v: 1, grants: [stored({ id, issuedAt: Date.now() }, ["cdn.example.com", "shop.example.com"])] }));
    const first = await boot();
    first.bundle.domainGate.setGrant("alice--shop", ["shop.example.com", "cdn.example.com"]);
    expect(first.bundle.grants.isLive(id)).toBe(true);
    expect(first.bundle.grantRequests!.granted("alice--shop").map((g) => g.grantId)).toEqual([id]);
    // An update after boot: the owner's grants end, as they always did.
    first.bundle.domainGate.setGrant("alice--shop", ["shop.example.com", "cdn.example.com"]);
    expect(first.bundle.grants.isLive(id)).toBe(false);
    await first.bundle.grantRequests!.persist();
    await first.stop();
    const second = await boot();
    expect(second.bundle.grants.isLive(id)).toBe(false);
    await second.stop();
  });

  it("a different manifest at boot ends the grant", async () => {
    const id = "bg-00000000-0000-4000-8000-000000000005";
    await writeFile(join(dataDir, "browser-grants.json"), JSON.stringify({ v: 1, grants: [stored({ id, issuedAt: Date.now() }, ["shop.example.com"])] }));
    const b = await boot();
    expect(b.bundle.grants.isLive(id)).toBe(true);
    b.bundle.domainGate.setGrant("alice--shop", ["shop.example.com", "evil.example.com"]);
    expect(b.bundle.grants.isLive(id)).toBe(false);
    await b.stop();
  });
});
