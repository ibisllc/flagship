import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCESS_LIST,
  accessListSha256,
  deriveIRK,
  signAppAccessGrant,
  signAppEgressGrant,
  withRule,
  type AppAccessGrant,
  type AppEgressGrant,
} from "@flagship/protocol";
import { AppAccessStore } from "../../src/egress/accessStore.js";
import { accessAuthorizer, accessSummary, buildAppAccessHttp, egressView, type AppAccessHttpOptions } from "../../src/egress/approvals.js";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import type { HttpRequest } from "../../src/runtime.js";

const BOX = "home.harry.flagship.services";
const NOW = 1_800_000_000_000;
const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const adminRoot = deriveIRK({ seed: new Uint8Array(32).fill(7) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(9) });

/** A stand-in SWK seal: reversible, and visibly not plaintext on disk. */
const swk = {
  sealWithSwk: (pt: Uint8Array) => ({ nonce: new Uint8Array(12).fill(1), ciphertext: Uint8Array.from(pt, (b) => b ^ 0x5a) }),
  openWithSwk: (b: { nonce: Uint8Array; ciphertext: Uint8Array }) => Uint8Array.from(b.ciphertext, (x) => x ^ 0x5a),
};
const unseal = (path: string) =>
  JSON.parse(Buffer.from(swk.openWithSwk({ nonce: new Uint8Array(12), ciphertext: Buffer.from(readFileSync(path, "utf8"), "hex").subarray(12) })).toString());
const reseal = (path: string, obj: unknown) => {
  const b = swk.sealWithSwk(new TextEncoder().encode(JSON.stringify(obj)));
  writeFileSync(path, Buffer.concat([Buffer.from(b.nonce), Buffer.from(b.ciphertext)]).toString("hex"));
};

const APPS: Record<string, { name: string; declared: string[] }> = {
  "harry-weather": { name: "weather", declared: ["api.open-meteo.com", "*.tile.openstreetmap.org"] },
  "harry-notes": { name: "notes", declared: [] },
};

function setup(extra: Partial<AppAccessHttpOptions> = {}, path: string | null = null, legacyPath: string | null = null) {
  const store = new AppAccessStore(path, path ? swk : null, { legacyPath, now: () => NOW });
  const changes: string[] = [];
  const handle = buildAppAccessHttp({
    serverDomain: BOX,
    username: "harry",
    ownerIrkPub: owner.publicKey,
    store,
    app: (id) => APPS[id] ?? null,
    onChange: (id) => changes.push(id),
    now: () => NOW,
    ...extra,
  });
  return { store, handle, changes };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const req = (method: string, path: string, body?: unknown): HttpRequest =>
  ({ method, path, headers: {}, body: body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) }) as HttpRequest;
type Handle = ReturnType<typeof setup>["handle"];
async function call(h: Handle, method: string, path: string, body?: unknown) {
  const res = await h(path, method, req(method, path, body));
  return { status: res!.status, body: JSON.parse(String(res!.body)) as Record<string, any> };
}

// ---- v2: access lists -------------------------------------------------------

const A = "/api/screens/services/harry-weather/access";
const accessGrant = (list: string, o: Partial<AppAccessGrant> = {}): AppAccessGrant => ({
  serverDomain: BOX,
  serviceId: "harry-weather",
  listSha256: accessListSha256(list),
  issuedAt: NOW - 1000,
  ...o,
});
function sendList(h: Handle, list: string, o: Partial<AppAccessGrant> = {}, signer = owner, path = A) {
  const g = accessGrant(list, o);
  return call(h, "POST", path, { list, grant: g, signature: hex(signAppAccessGrant(g, signer)) });
}

describe("GET/POST /api/screens/services/:id/access", () => {
  it("an app starts with the default list and no rules", async () => {
    const { handle, store } = setup();
    const r = await call(handle, "GET", A);
    expect(r).toEqual({
      status: 200,
      body: { list: DEFAULT_ACCESS_LIST, listSha256: accessListSha256(DEFAULT_ACCESS_LIST), pending: [], draft: null },
    });
    expect(accessSummary(store, "harry-weather")).toEqual({ rules: 0, pending: 0 });
  });

  it("applies an owner-signed list and tells the gateway", async () => {
    const { handle, store, changes } = setup();
    const list = withRule(DEFAULT_ACCESS_LIST, "allow", "api.open-meteo.com");
    const r = await sendList(handle, list);
    expect(r).toEqual({ status: 200, body: { ok: true, access: { list, listSha256: accessListSha256(list), pending: [], draft: null } } });
    expect(store.rules("harry-weather")).toEqual([{ line: 1, action: "allow", target: "api.open-meteo.com" }]);
    expect(changes).toEqual(["harry-weather"]);
    expect((await call(handle, "GET", A)).body.list).toBe(list);
  });

  it("names each error by line", async () => {
    const { handle, store } = setup();
    const r = await sendList(handle, "allow good.com\ndeny\nallow x..com\n");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: "the access list has 2 errors",
      errors: [
        { line: 2, message: 'say what to allow or deny, e.g. "allow example.com"' },
        { line: 3, message: '"x..com" is not a valid host name' },
      ],
    });
    expect(store.heldIssuedAt("harry-weather")).toBeNull();
  });

  it("refuses a list that isn't normalized, and malformed bodies", async () => {
    const { handle } = setup();
    const notNorm = await sendList(handle, "allow a.com\r\n");
    expect(notNorm.status).toBe(400);
    expect(notNorm.body.errors).toEqual([]);
    expect((await call(handle, "POST", A, "{")).status).toBe(400);
    expect((await call(handle, "POST", A, { grant: accessGrant("") })).status).toBe(400);
    expect((await call(handle, "POST", A, { list: "", grant: { ...accessGrant(""), listSha256: "x" }, signature: "00".repeat(64) })).status).toBe(400);
    expect((await call(handle, "POST", A, { list: "", grant: accessGrant("") })).status).toBe(400);
    expect((await call(handle, "POST", A, { list: "", grant: accessGrant(""), signature: "abcd" })).status).toBe(400);
    expect((await sendList(handle, "allow a.com\n", { serviceId: "harry-notes" })).body.error).toBe("grant is for a different service");
    expect((await call(handle, "PUT", A, {})).status).toBe(405);
  });

  it("403: bad signature, a stranger, a swapped list, another server, stale", async () => {
    const { handle, store } = setup();
    expect((await sendList(handle, "allow a.com\n", {}, stranger)).status).toBe(403);
    const g = accessGrant("allow a.com\n");
    const sig = hex(signAppAccessGrant(g, owner));
    const swapped = await call(handle, "POST", A, { list: "allow all\n", grant: g, signature: sig });
    expect(swapped).toEqual({ status: 403, body: { error: "the list is not the one that was signed" } });
    const resigned = await call(handle, "POST", A, { list: "allow all\n", grant: { ...g, listSha256: accessListSha256("allow all\n") }, signature: sig });
    expect(resigned).toEqual({ status: 403, body: { error: "invalid signature" } });
    expect((await sendList(handle, "allow a.com\n", { serverDomain: "media.harry.flagship.services" })).body.error).toBe("grant is for a different server");
    expect((await sendList(handle, "allow a.com\n", { issuedAt: NOW - 11 * 60_000 })).body.error).toBe("stale grant");
    expect((await sendList(handle, "allow a.com\n", { issuedAt: NOW + 11 * 60_000 })).status).toBe(403);
    expect(store.rules("harry-weather")).toEqual([]);
  });

  it("404 for a service that isn't installed", async () => {
    const { handle } = setup();
    const p = "/api/screens/services/harry-gone/access";
    expect((await call(handle, "GET", p)).status).toBe(404);
    expect((await sendList(handle, "", { serviceId: "harry-gone" }, owner, p)).status).toBe(404);
  });

  it("409 for a list not newer than the one held", async () => {
    const { handle } = setup();
    expect((await sendList(handle, "allow a.com\n", { issuedAt: NOW - 5000 })).status).toBe(200);
    expect((await sendList(handle, "allow b.com\n", { issuedAt: NOW - 5000 })).status).toBe(409);
    expect((await sendList(handle, "allow b.com\n", { issuedAt: NOW - 6000 })).status).toBe(409);
    expect((await sendList(handle, "allow b.com\n", { issuedAt: NOW - 4000 })).status).toBe(200);
  });

  it("with an admin root pinned, only its signature counts", async () => {
    const { handle } = setup({ adminRootPub: adminRoot.publicKey });
    expect((await sendList(handle, "allow a.com\n", { issuedAt: NOW - 2000 }, owner)).status).toBe(403);
    expect((await sendList(handle, "allow a.com\n", { issuedAt: NOW - 1000 }, adminRoot)).status).toBe(200);
  });

  it("a v1 egress signature never authorizes a list", async () => {
    const { handle } = setup();
    const g = accessGrant("allow a.com\n");
    const v1 = signAppEgressGrant({ serverDomain: BOX, serviceId: "harry-weather", hosts: ["a.com"], issuedAt: g.issuedAt }, owner);
    expect((await call(handle, "POST", A, { list: "allow a.com\n", grant: g, signature: hex(v1) })).status).toBe(403);
  });

  it("an answer clears the requests it decides; dismiss clears one without a signature", async () => {
    const { handle, store } = setup();
    for (const h of ["api.github.com", "api.open-meteo.com", "sync.example.com"]) store.recordAttempt("harry-weather", h);
    expect((await call(handle, "GET", A)).body.pending.map((p: { host: string }) => p.host).sort()).toEqual([
      "api.github.com",
      "api.open-meteo.com",
      "sync.example.com",
    ]);
    const list = withRule(DEFAULT_ACCESS_LIST, "deny", "api.github.com");
    const r = await sendList(handle, list);
    expect(r.body.access.pending.map((p: { host: string }) => p.host).sort()).toEqual(["api.open-meteo.com", "sync.example.com"]);
    const d = await call(handle, "POST", `${A}/dismiss`, { host: "API.Open-Meteo.com" });
    expect(d.status).toBe(200);
    expect(d.body.access.pending.map((p: { host: string }) => p.host)).toEqual(["sync.example.com"]);
    expect(store.list("harry-weather")).toBe(list);
    expect((await call(handle, "POST", `${A}/dismiss`, {})).status).toBe(400);
    expect((await call(handle, "POST", "/api/screens/services/harry-gone/access/dismiss", { host: "a.com" })).status).toBe(404);
  });

  it("lists every app's requests with the app's name", async () => {
    const { handle, store } = setup();
    await store.draftFromDeclared("harry-weather", [{ host: "api.open-meteo.com", why: "forecasts" }]);
    await store.draftFromDeclared("harry-gone", [{ host: "x.example.com" }]);
    store.recordAttempt("harry-notes", "sync.example.com");
    store.recordAttempt("harry-gone", "x.example.com");
    const r = await call(handle, "GET", "/api/screens/access-requests");
    expect(r.status).toBe(200);
    expect(r.body.requests).toEqual([
      {
        serviceId: "harry-weather",
        appName: "weather",
        kind: "draft",
        hosts: [{ host: "api.open-meteo.com", why: "forecasts" }],
        createdAt: NOW,
      },
      { serviceId: "harry-notes", appName: "notes", host: "sync.example.com", source: "attempt", attempts: 1, firstSeen: NOW, lastSeen: NOW },
    ]);
  });
});

// ---- suggested lists (drafts) ------------------------------------------------

describe("drafts from the manifest's network.egress", () => {
  const WEATHER = [
    { host: "api.open-meteo.com", why: "weather forecasts" },
    { host: "*.tile.openstreetmap.org" },
  ];

  it("puts an allow line per suggested host on top of the current list, with its reason", async () => {
    const { store } = setup();
    const d = await store.draftFromDeclared("harry-weather", WEATHER);
    expect(d).not.toBeNull();
    expect(d!.list).toBe(`allow api.open-meteo.com   # weather forecasts\nallow *.tile.openstreetmap.org\n${DEFAULT_ACCESS_LIST}`);
    expect(d!.listSha256).toBe(accessListSha256(d!.list));
    expect(d!.hosts).toEqual(WEATHER);
    // A draft opens nothing and is not a per-host request.
    expect(store.rules("harry-weather")).toEqual([]);
    expect(store.pending("harry-weather")).toEqual([]);
    expect(accessSummary(store, "harry-weather")).toEqual({ rules: 0, pending: 0, draft: true });
  });

  it("drafts nothing when nothing is new, and only hosts the list doesn't decide", async () => {
    const { handle, store } = setup();
    const signed = `${withRule(withRule(DEFAULT_ACCESS_LIST, "deny", "ads.example.com"), "allow", "api.open-meteo.com")}deny all\n`;
    expect((await sendList(handle, signed)).status).toBe(200);
    expect(await store.draftFromDeclared("harry-weather", [{ host: "api.open-meteo.com" }, { host: "ads.example.com" }])).toBeNull();
    // `deny all` is not an answer about one host: still suggested.
    const d = await store.draftFromDeclared("harry-weather", [{ host: "api.open-meteo.com" }, { host: "cdn.example.com", why: "images" }]);
    expect(d!.hosts).toEqual([{ host: "cdn.example.com", why: "images" }]);
    expect(d!.list).toBe(`allow cdn.example.com   # images\n${signed}`);
    // The same hosts again (a redeploy that adds nothing): no new draft, the old one stays.
    expect(await store.draftFromDeclared("harry-weather", [{ host: "cdn.example.com", why: "images" }])).toBeNull();
    expect(store.draft("harry-weather")!.list).toBe(d!.list);
  });

  it("an edit that adds a host replaces the unanswered draft; a dismissed one stays quiet until then", async () => {
    const { handle, store } = setup();
    await store.draftFromDeclared("harry-weather", [WEATHER[0]!]);
    const g = await call(handle, "GET", A);
    expect(g.body.draft.hosts).toEqual([WEATHER[0]]);
    const dis = await call(handle, "POST", `${A}/draft/dismiss`);
    expect(dis.status).toBe(200);
    expect(dis.body.access.draft).toBeNull();
    expect(await store.draftFromDeclared("harry-weather", [WEATHER[0]!])).toBeNull();
    const next = await store.draftFromDeclared("harry-weather", WEATHER);
    expect(next!.hosts.map((h) => h.host)).toEqual(["api.open-meteo.com", "*.tile.openstreetmap.org"]);
    expect((await call(handle, "GET", A)).body.draft.list).toBe(next!.list);
    expect((await call(handle, "GET", `${A}/draft/dismiss`)).status).toBe(405);
    expect((await call(handle, "POST", "/api/screens/services/harry-gone/access/draft/dismiss")).status).toBe(404);
  });

  it("approving it (possibly edited) applies the list and drops the draft", async () => {
    const { handle, store } = setup();
    const d = await store.draftFromDeclared("harry-weather", WEATHER);
    const edited = d!.list.replace("allow *.tile.openstreetmap.org\n", "");
    const r = await sendList(handle, edited);
    expect(r.status).toBe(200);
    expect(r.body.access.draft).toBeNull();
    expect(store.rules("harry-weather").map((x) => x.target)).toEqual(["api.open-meteo.com"]);
    expect((await call(handle, "GET", "/api/screens/access-requests")).body.requests).toEqual([]);
  });

  it("survives a restart, sealed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "access-draft-"));
    const path = join(dir, "app-access.sealed");
    const a = setup({}, path);
    await a.store.draftFromDeclared("harry-weather", WEATHER);
    await a.store.flush();
    expect(readFileSync(path, "utf8")).not.toContain("open-meteo");
    const b = setup({}, path);
    await b.store.load(accessAuthorizer({ username: "harry", ownerIrkPub: owner.publicKey }), BOX);
    expect(b.store.draft("harry-weather")!.hosts).toEqual(WEATHER);
    expect(await b.store.draftFromDeclared("harry-weather", WEATHER)).toBeNull();
    await b.store.forget("harry-weather");
    expect(b.store.draft("harry-weather")).toBeNull();
  });
});

// ---- v1: the older egress approval -------------------------------------------

const P = "/api/screens/services/harry-weather/egress";
const grant = (o: Partial<AppEgressGrant> = {}): AppEgressGrant => ({
  serverDomain: BOX,
  serviceId: "harry-weather",
  hosts: ["api.open-meteo.com"],
  issuedAt: NOW - 1000,
  ...o,
});
function send(h: Handle, g: AppEgressGrant, signer = owner, path = P) {
  return call(h, "POST", path, { grant: g, signature: hex(signAppEgressGrant(g, signer)) });
}

describe("v1 POST /api/screens/services/:id/egress (older apps)", () => {
  it("becomes allow lines above the default list, and the v1 view is derived from the list", async () => {
    const { handle, store, changes } = setup();
    const r = await send(handle, grant({ hosts: ["api.open-meteo.com", "*.tile.openstreetmap.org"] }));
    expect(r).toEqual({ status: 200, body: { ok: true, egress: { declared: APPS["harry-weather"]!.declared, approved: APPS["harry-weather"]!.declared } } });
    expect(store.list("harry-weather")).toBe(`allow *.tile.openstreetmap.org\nallow api.open-meteo.com\n${DEFAULT_ACCESS_LIST}`);
    expect(changes).toEqual(["harry-weather"]);
    expect((await call(handle, "GET", P)).body).toEqual({ declared: APPS["harry-weather"]!.declared, approved: APPS["harry-weather"]!.declared });
  });

  it("a v2 list shows through the v1 view", async () => {
    const { handle, store } = setup();
    await sendList(handle, "deny api.open-meteo.com\nallow *.openstreetmap.org\n");
    expect(egressView(store, "harry-weather", APPS["harry-weather"]!.declared)).toEqual({
      declared: APPS["harry-weather"]!.declared,
      approved: ["*.tile.openstreetmap.org"],
    });
  });

  it("keeps its old errors", async () => {
    const { handle } = setup();
    expect((await send(handle, grant(), stranger)).status).toBe(403);
    expect((await send(handle, grant({ serviceId: "harry-notes" }))).body.error).toBe("grant is for a different service");
    expect((await send(handle, grant({ serverDomain: "media.harry.flagship.services" }))).status).toBe(403);
    expect((await send(handle, grant({ issuedAt: NOW - 11 * 60_000 }))).status).toBe(403);
    const r = await send(handle, grant({ hosts: ["api.open-meteo.com", "evil.example.com"] }));
    expect(r.status).toBe(422);
    expect(String(r.body.error)).toContain("evil.example.com");
    expect((await send(handle, grant({ serviceId: "harry-gone" }), owner, "/api/screens/services/harry-gone/egress")).status).toBe(404);
  });

  it("is ordered against v2 lists by issuedAt, both ways", async () => {
    const { handle, store } = setup();
    expect((await sendList(handle, "allow all\n", { issuedAt: NOW - 3000 })).status).toBe(200);
    expect((await send(handle, grant({ issuedAt: NOW - 4000 }))).status).toBe(409);
    expect((await send(handle, grant({ issuedAt: NOW - 2000, hosts: [] }))).status).toBe(200);
    expect(store.list("harry-weather")).toBe(DEFAULT_ACCESS_LIST);
    expect((await sendList(handle, "allow all\n", { issuedAt: NOW - 2000 })).status).toBe(409);
  });
});

// ---- the sealed store ------------------------------------------------------

describe("the sealed access store", () => {
  const authority = accessAuthorizer({ ownerIrkPub: owner.publicKey, username: "harry" });

  it("persists sealed, reloads, and drops lists that no longer verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "access-"));
    const path = join(dir, "data", "app-access.sealed");
    const { handle } = setup({}, path);
    expect((await sendList(handle, "allow api.open-meteo.com\n")).status).toBe(200);
    expect(readFileSync(path, "utf8")).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(readFileSync(path, "utf8"), "hex").toString("latin1")).not.toContain("open-meteo");

    const reloaded = new AppAccessStore(path, swk);
    expect(await reloaded.load(authority, BOX)).toEqual({ dropped: 0, migrated: 0 });
    expect(reloaded.list("harry-weather")).toBe("allow api.open-meteo.com\n");

    const rotated = new AppAccessStore(path, swk);
    expect((await rotated.load(accessAuthorizer({ ownerIrkPub: owner.publicKey, username: "harry", adminRootPub: adminRoot.publicKey }), BOX)).dropped).toBe(1);
    expect(rotated.rules("harry-weather")).toEqual([]);

    expect((await new AppAccessStore(path, swk).load(authority, "media.harry.flagship.services")).dropped).toBe(1);

    const plain = unseal(path);
    plain.lists[0].list = "allow all\n";
    reseal(path, plain);
    const tampered = new AppAccessStore(path, swk);
    expect((await tampered.load(authority, BOX)).dropped).toBe(1);
    expect(tampered.list("harry-weather")).toBe(DEFAULT_ACCESS_LIST);
  });

  it("migrates a v1 app-egress.sealed file to allow lines, keeping the v1 signature as the authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "access-"));
    const legacy = join(dir, "data", "app-egress.sealed");
    const path = join(dir, "data", "app-access.sealed");
    const g = grant({ hosts: ["api.open-meteo.com"] });
    const bad = grant({ serviceId: "harry-notes", hosts: ["a.example.com"] });
    mkdirSync(join(dir, "data"), { recursive: true });
    reseal(legacy, {
      v: 1,
      grants: [
        { grant: g, signature: hex(signAppEgressGrant(g, owner)) },
        { grant: bad, signature: hex(signAppEgressGrant(bad, stranger)) },
      ],
    });
    const store = new AppAccessStore(path, swk, { legacyPath: legacy });
    expect(await store.load(authority, BOX)).toEqual({ dropped: 1, migrated: 1 });
    expect(store.list("harry-weather")).toBe(`allow api.open-meteo.com\n${DEFAULT_ACCESS_LIST}`);
    expect(store.held("harry-weather")?.v).toBe(1);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);

    const again = new AppAccessStore(path, swk, { legacyPath: legacy });
    expect(await again.load(authority, BOX)).toEqual({ dropped: 0, migrated: 0 });
    expect(again.list("harry-weather")).toBe(`allow api.open-meteo.com\n${DEFAULT_ACCESS_LIST}`);
    expect(unseal(path).lists[0]).not.toHaveProperty("list");
  });

  it("keeps requests and alert history across a restart; uninstall forgets everything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "access-"));
    const path = join(dir, "data", "app-access.sealed");
    const { store, handle } = setup({}, path);
    await sendList(handle, "allow a.com\n");
    store.recordAttempt("harry-weather", "b.example.com");
    expect(store.takeAlert("harry-weather", "b.example.com")).toBe(true);
    await store.flush();
    const reloaded = new AppAccessStore(path, swk, { now: () => NOW });
    await reloaded.load(authority, BOX);
    expect(reloaded.pending("harry-weather").map((r) => r.host)).toEqual(["b.example.com"]);
    expect(reloaded.takeAlert("harry-weather", "b.example.com")).toBe(false);
    await reloaded.forget("harry-weather");
    expect(reloaded.list("harry-weather")).toBe(DEFAULT_ACCESS_LIST);
    expect(reloaded.pending("harry-weather")).toEqual([]);
    expect(reloaded.serviceIds()).toEqual([]);
    const after = new AppAccessStore(path, swk, { now: () => NOW });
    await after.load(authority, BOX);
    expect(after.serviceIds()).toEqual([]);
  });
});

// ---- through the screens API ------------------------------------------------

describe("through the screens API", () => {
  const app = {
    serviceId: "harry-weather",
    creator: "harry",
    slug: "weather",
    urlLabel: "weather",
    installedAt: 1,
    manifest: { name: "weather", version: "1.0.0", network: { egress: APPS["harry-weather"]!.declared } },
    membership: { members: { list: () => [] } },
  };
  const platform = { list: () => [app], byServiceId: (id: string) => (id === app.serviceId ? app : undefined) };

  function screens(companion = false) {
    const { handle, store } = setup();
    const http = buildScreensHttp({
      gate: { check: () => null },
      serverFqdn: BOX,
      username: "harry",
      daemonVersion: "t",
      startedAt: 0,
      servicePlatform: platform as never,
      pairedSessions: companion ? ({ list: () => [], isCompanionRequest: () => true } as never) : null,
      appEgress: { handle, view: (id, declared) => egressView(store, id, declared), access: (id) => accessSummary(store, id) },
    });
    return { http, store };
  }
  const r = (method: string, path: string, body?: unknown) => req(method, path, body);

  it("routes the access endpoints and shows access + egress on the list and detail", async () => {
    const { http, store } = screens();
    store.recordAttempt("harry-weather", "api.github.com");
    const list = withRule(DEFAULT_ACCESS_LIST, "allow", "api.open-meteo.com");
    const g = accessGrant(list);
    const res = await http(r("POST", A, { list, grant: g, signature: hex(signAppAccessGrant(g, owner)) }));
    expect(res!.status).toBe(200);
    const apps = JSON.parse(String((await http(r("GET", "/api/screens/apps-list")))!.body)).apps;
    expect(apps[0].access).toEqual({ rules: 1, pending: 1 });
    expect(apps[0].egress).toEqual({ declared: APPS["harry-weather"]!.declared, approved: ["api.open-meteo.com"] });
    const detail = JSON.parse(String((await http(r("GET", "/api/screens/app-detail/harry-weather")))!.body));
    expect(detail.app.access).toEqual({ rules: 1, pending: 1 });
    const reqs = JSON.parse(String((await http(r("GET", "/api/screens/access-requests")))!.body));
    expect(reqs.requests).toHaveLength(1);
    const dismissed = await http(r("POST", `${A}/dismiss`, { host: "api.github.com" }));
    expect(dismissed!.status).toBe(200);
  });

  it("a companion session can read but never post a list or dismiss", async () => {
    const { http } = screens(true);
    const g = accessGrant("");
    for (const [p, b] of [
      [A, { list: "", grant: g, signature: hex(signAppAccessGrant(g, owner)) }],
      [`${A}/dismiss`, { host: "a.com" }],
      [`${A}/draft/dismiss`, {}],
      [P, { grant: grant(), signature: hex(signAppEgressGrant(grant(), owner)) }],
    ] as const) {
      const res = await http(r("POST", p, b));
      expect(res!.status, p).toBe(403);
      expect(JSON.parse(String(res!.body)).code).toBe("companion-write-not-allowed");
    }
    expect((await http(r("GET", A)))!.status).toBe(200);
    expect((await http(r("GET", "/api/screens/access-requests")))!.status).toBe(200);
  });
});
