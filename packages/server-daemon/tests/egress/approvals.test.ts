import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveIRK, signAppEgressGrant, type AppEgressGrant } from "@flagship/protocol";
import { AppEgressStore, authorizeEgressGrant, buildAppEgressHttp, type AppEgressHttpOptions } from "../../src/egress/approvals.js";
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

const DECLARED: Record<string, string[]> = {
  "harry-weather": ["api.open-meteo.com", "*.tile.openstreetmap.org"],
  "harry-notes": [],
};

function setup(extra: Partial<AppEgressHttpOptions> = {}, path: string | null = null) {
  const store = new AppEgressStore(path, path ? swk : null);
  const changes: string[] = [];
  const handle = buildAppEgressHttp({
    serverDomain: BOX,
    username: "harry",
    ownerIrkPub: owner.publicKey,
    store,
    declared: (id) => DECLARED[id] ?? null,
    onChange: (id) => changes.push(id),
    now: () => NOW,
    ...extra,
  });
  return { store, handle, changes };
}

const grant = (o: Partial<AppEgressGrant> = {}): AppEgressGrant => ({
  serverDomain: BOX,
  serviceId: "harry-weather",
  hosts: ["api.open-meteo.com"],
  issuedAt: NOW - 1000,
  ...o,
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function post(path: string, body: unknown): HttpRequest {
  return { method: "POST", path, headers: {}, body: Buffer.from(JSON.stringify(body)) } as HttpRequest;
}
const P = "/api/screens/services/harry-weather/egress";

async function send(h: ReturnType<typeof setup>["handle"], g: AppEgressGrant, signer = owner, path = P) {
  const res = await h(path, "POST", post(path, { grant: g, signature: hex(signAppEgressGrant(g, signer)) }));
  return { status: res!.status, body: JSON.parse(String(res!.body)) as Record<string, unknown> };
}

describe("POST /api/screens/services/:serviceId/egress", () => {
  it("applies an owner-signed grant and shows it", async () => {
    const { handle, store, changes } = setup();
    const r = await send(handle, grant({ hosts: ["api.open-meteo.com", "*.tile.openstreetmap.org"] }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, egress: { declared: DECLARED["harry-weather"], approved: ["*.tile.openstreetmap.org", "api.open-meteo.com"] } });
    expect(store.approvedHosts("harry-weather")).toEqual(["*.tile.openstreetmap.org", "api.open-meteo.com"]);
    expect(changes).toEqual(["harry-weather"]);
    const view = await handle(P, "GET", { method: "GET", path: P, headers: {}, body: Buffer.alloc(0) } as HttpRequest);
    expect(JSON.parse(String(view!.body))).toEqual({ declared: DECLARED["harry-weather"], approved: ["*.tile.openstreetmap.org", "api.open-meteo.com"] });
  });

  it("rejects a bad signature, a stranger's key and a tampered grant", async () => {
    const { handle, store } = setup();
    expect((await send(handle, grant(), stranger)).status).toBe(403);
    const g = grant();
    const sig = hex(signAppEgressGrant(g, owner));
    const tampered = await handle(P, "POST", post(P, { grant: { ...g, hosts: ["*.tile.openstreetmap.org"] }, signature: sig }));
    expect(tampered!.status).toBe(403);
    const short = await handle(P, "POST", post(P, { grant: g, signature: "abcd" }));
    expect(short!.status).toBe(400);
    expect(store.approvedHosts("harry-weather")).toEqual([]);
  });

  it("rejects a grant for another service or another server", async () => {
    const { handle } = setup();
    const other = await send(handle, grant({ serviceId: "harry-notes" }));
    expect(other).toMatchObject({ status: 400, body: { error: "grant is for a different service" } });
    const box = await send(handle, grant({ serverDomain: "media.harry.flagship.services" }));
    expect(box).toMatchObject({ status: 403, body: { error: "grant is for a different server" } });
    expect((await send(handle, grant({ serviceId: "harry-gone" }), owner, "/api/screens/services/harry-gone/egress")).status).toBe(404);
  });

  it("refuses hosts the manifest doesn't declare", async () => {
    const { handle } = setup();
    const r = await send(handle, grant({ hosts: ["api.open-meteo.com", "evil.example.com"] }));
    expect(r).toMatchObject({ status: 422 });
    expect(String(r.body.error)).toContain("evil.example.com");
  });

  it("refuses stale and replayed grants", async () => {
    const { handle } = setup();
    expect((await send(handle, grant({ issuedAt: NOW - 11 * 60_000 }))).status).toBe(403);
    expect((await send(handle, grant({ issuedAt: NOW + 11 * 60_000 }))).status).toBe(403);
    const first = grant({ issuedAt: NOW - 5000 });
    expect((await send(handle, first)).status).toBe(200);
    expect((await send(handle, first)).status).toBe(409);
    expect((await send(handle, grant({ issuedAt: NOW - 6000, hosts: [] }))).status).toBe(409);
  });

  it("an empty host list revokes", async () => {
    const { handle, store } = setup();
    expect((await send(handle, grant({ issuedAt: NOW - 2000 }))).status).toBe(200);
    const r = await send(handle, grant({ issuedAt: NOW - 1000, hosts: [] }));
    expect(r).toEqual({ status: 200, body: { ok: true, egress: { declared: DECLARED["harry-weather"], approved: [] } } });
    expect(store.approvedHosts("harry-weather")).toEqual([]);
  });

  it("with an admin root pinned, only the admin root's signature counts", async () => {
    const { handle } = setup({ adminRootPub: adminRoot.publicKey });
    expect((await send(handle, grant({ issuedAt: NOW - 2000 }), owner)).status).toBe(403);
    expect((await send(handle, grant({ issuedAt: NOW - 1000 }), adminRoot)).status).toBe(200);
  });

  it("rejects malformed bodies", async () => {
    const { handle } = setup();
    const bad = async (b: unknown) => (await handle(P, "POST", post(P, b)))!.status;
    expect(await bad({ signature: "00" })).toBe(400);
    expect(await bad({ grant: { ...grant(), hosts: ["A.example.com"] }, signature: "00".repeat(64) })).toBe(400);
    expect(await bad({ grant: grant() })).toBe(400);
    expect((await handle(P, "PUT", post(P, {})))!.status).toBe(405);
    const notJson = await handle(P, "POST", { method: "POST", path: P, headers: {}, body: Buffer.from("{") } as HttpRequest);
    expect(notJson!.status).toBe(400);
    expect(await handle("/api/screens/services/harry-weather/env", "GET", post(P, {}))).toBeNull();
  });
});

describe("the sealed approval store", () => {
  it("persists sealed, reloads, and drops grants that no longer verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-"));
    const path = join(dir, "data", "app-egress.sealed");
    const { handle } = setup({}, path);
    expect((await send(handle, grant())).status).toBe(200);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(onDisk, "hex").toString("latin1")).not.toContain("api.open-meteo.com");

    const authority = { ownerIrkPub: owner.publicKey, username: "harry" };
    const reloaded = new AppEgressStore(path, swk);
    expect(await reloaded.load((g, s) => authorizeEgressGrant(authority, g, s))).toBe(0);
    expect(reloaded.approvedHosts("harry-weather")).toEqual(["api.open-meteo.com"]);

    const rotated = new AppEgressStore(path, swk);
    expect(await rotated.load((g, s) => authorizeEgressGrant({ ...authority, adminRootPub: adminRoot.publicKey }, g, s))).toBe(1);
    expect(rotated.approvedHosts("harry-weather")).toEqual([]);

    const plain = JSON.parse(Buffer.from(swk.openWithSwk({ nonce: new Uint8Array(12), ciphertext: Buffer.from(onDisk, "hex").subarray(12) })).toString());
    plain.grants[0].grant.hosts = ["*.tile.openstreetmap.org"];
    const forged = swk.sealWithSwk(new TextEncoder().encode(JSON.stringify(plain)));
    writeFileSync(path, Buffer.concat([Buffer.from(forged.nonce), Buffer.from(forged.ciphertext)]).toString("hex"));
    const tampered = new AppEgressStore(path, swk);
    expect(await tampered.load((g, s) => authorizeEgressGrant(authority, g, s))).toBe(1);
    expect(tampered.approvedHosts("harry-weather")).toEqual([]);
  });

  it("forgets a service", async () => {
    const { handle, store } = setup();
    await send(handle, grant());
    await store.forget("harry-weather");
    expect(store.approvedHosts("harry-weather")).toEqual([]);
    expect(store.serviceIds()).toEqual([]);
  });
});

describe("through the screens API", () => {
  const app = {
    serviceId: "harry-weather",
    creator: "harry",
    slug: "weather",
    urlLabel: "weather",
    installedAt: 1,
    manifest: { version: "1.0.0", network: { egress: DECLARED["harry-weather"] } },
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
      appEgress: { handle, view: (id, declared) => ({ declared: [...declared], approved: store.approvedHosts(id).filter((h) => declared.includes(h)) }) },
    });
    return http;
  }

  it("routes the signed POST and shows egress on the list and detail", async () => {
    const http = screens();
    const g = grant();
    const res = await http(post(P, { grant: g, signature: hex(signAppEgressGrant(g, owner)) }));
    expect(res!.status).toBe(200);
    const list = await http({ method: "GET", path: "/api/screens/apps-list", headers: {}, body: Buffer.alloc(0) } as HttpRequest);
    expect(JSON.parse(String(list!.body)).apps[0].egress).toEqual({ declared: DECLARED["harry-weather"], approved: ["api.open-meteo.com"] });
    const detail = await http({ method: "GET", path: "/api/screens/app-detail/harry-weather", headers: {}, body: Buffer.alloc(0) } as HttpRequest);
    expect(JSON.parse(String(detail!.body)).app.egress.approved).toEqual(["api.open-meteo.com"]);
  });

  it("a companion session can read but never post an approval", async () => {
    const http = screens(true);
    const g = grant();
    const res = await http(post(P, { grant: g, signature: hex(signAppEgressGrant(g, owner)) }));
    expect(res!.status).toBe(403);
    expect(JSON.parse(String(res!.body)).code).toBe("companion-write-not-allowed");
    const view = await http({ method: "GET", path: P, headers: {}, body: Buffer.alloc(0) } as HttpRequest);
    expect(view!.status).toBe(200);
  });
});
