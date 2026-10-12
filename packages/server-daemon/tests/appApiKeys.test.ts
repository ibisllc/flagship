import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveIRK, ed, signAppApiKeyGrant, type AppApiKeyGrant, type Keypair } from "@flagship/protocol";
import {
  AppApiKeyStore,
  apiKeyAuthorizer,
  buildAppApiKeysHttp,
  isAppApiKeysPath,
} from "../src/appApiKeys.js";
import { buildScreensHttp } from "../src/screens/screensHttp.js";
import type { HttpRequest } from "../src/runtime.js";
import { swkOps } from "./helpers/keyCustody.js";

const FQDN = "home.harry.flagship.services";
const SVC = "harry-weather";
const NOW = 1_700_000_000_000;
const owner: Keypair = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const authorize = apiKeyAuthorizer({ username: "harry", ownerIrkPub: owner.publicKey });

function grant(over: Partial<AppApiKeyGrant> = {}): AppApiKeyGrant {
  return { serverDomain: FQDN, serviceId: SVC, keyId: "0123456789abcdef", scope: "read", expiresAt: 0, issuedAt: NOW, ...over };
}

function body(g: AppApiKeyGrant, label = "  my script  ", signer: Keypair = owner): Buffer {
  const sig = Buffer.from(signAppApiKeyGrant(g, signer)).toString("hex");
  return Buffer.from(JSON.stringify({ grant: g, signature: sig, label }));
}

function req(method: string, path: string, b: Buffer = Buffer.alloc(0)): HttpRequest {
  return { method, path, headers: {}, body: b };
}

function harness(opts: { now?: () => number; installed?: (id: string) => boolean; path?: string | null } = {}) {
  const swk = swkOps(new Uint8Array(32).fill(7));
  const now = opts.now ?? (() => NOW);
  const store = new AppApiKeyStore(opts.path ?? null, opts.path ? swk : null, { now });
  const http = buildAppApiKeysHttp({
    serverDomain: FQDN,
    store,
    authorize,
    installed: opts.installed ?? ((id) => id === SVC),
    now,
  });
  const call = async (method: string, path: string, b?: Buffer, companion = false) => {
    const r = await http.handle(path, method, req(method, path, b), { companion });
    if (!r) throw new Error("not handled");
    return { status: r.status, json: JSON.parse(String(r.body)) as Record<string, unknown> };
  };
  return { store, http, call, swk };
}

const KEYS = `/api/screens/services/${SVC}/api-keys`;

describe("api-keys endpoints (docs/app-apis.md §3)", () => {
  it("recognizes its paths", () => {
    expect(isAppApiKeysPath(KEYS)).toBe(true);
    expect(isAppApiKeysPath(`${KEYS}/0123456789abcdef`)).toBe(true);
    expect(isAppApiKeysPath(`/api/screens/services/${SVC}/access`)).toBe(false);
  });

  it("creates a key, shows it once, lists it without the secret, and revokes it", async () => {
    const h = harness();
    const created = await h.call("POST", KEYS, body(grant()));
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    expect(created.json.key).toMatch(/^fsk_0123456789abcdef_[A-Za-z0-9_-]{43}$/);

    const listed = await h.call("GET", KEYS);
    expect(listed.json).toEqual({
      keys: [{ keyId: "0123456789abcdef", label: "my script", scope: "read", createdAt: NOW, lastUsedAt: null, expiresAt: 0 }],
    });
    expect(JSON.stringify(listed.json)).not.toContain(String(created.json.key).slice(22));

    expect((await h.call("DELETE", `${KEYS}/0123456789abcdef`)).json).toEqual({ ok: true });
    expect((await h.call("GET", KEYS)).json).toEqual({ keys: [] });
    expect((await h.call("DELETE", `${KEYS}/0123456789abcdef`)).status).toBe(404);
  });

  it("409 when the keyId exists", async () => {
    const h = harness();
    expect((await h.call("POST", KEYS, body(grant()))).status).toBe(200);
    const again = await h.call("POST", KEYS, body(grant({ issuedAt: NOW + 1 })));
    expect(again.status).toBe(409);
  });

  it("400 on malformed requests and labels", async () => {
    const h = harness();
    expect((await h.call("POST", KEYS, Buffer.from("{nope"))).status).toBe(400);
    expect((await h.call("POST", KEYS, Buffer.from(JSON.stringify({ grant: { x: 1 }, signature: "00", label: "a" })))).status).toBe(400);
    expect((await h.call("POST", KEYS, body(grant(), "   "))).status).toBe(400);
    expect((await h.call("POST", KEYS, body(grant(), "x".repeat(65)))).status).toBe(400);
    expect((await h.call("POST", KEYS, body(grant(), ` ${"x".repeat(64)} `))).status).toBe(200);
    expect((await h.call("POST", KEYS, body(grant({ serviceId: "harry-other", keyId: "1111111111111111" })))).status).toBe(400);
  });

  it("403 says which check failed: other server, stale, signature, companion", async () => {
    const h = harness();
    const other = await h.call("POST", KEYS, body(grant({ serverDomain: "home.mallory.flagship.services" })));
    expect(other.status).toBe(403);
    expect(other.json.error).toMatch(/different server/);

    const stale = await h.call("POST", KEYS, body(grant({ issuedAt: NOW - 11 * 60_000 })));
    expect(stale.status).toBe(403);
    expect(stale.json.error).toMatch(/stale/);

    const mallory = deriveIRK({ seed: new Uint8Array(32).fill(9) });
    const forged = await h.call("POST", KEYS, body(grant(), "x", mallory));
    expect(forged.status).toBe(403);
    expect(forged.json.error).toMatch(/signature/);

    const companion = await h.call("POST", KEYS, body(grant()), true);
    expect(companion.status).toBe(403);
    expect(companion.json.error).toMatch(/companion/);
    const companionDelete = await h.call("DELETE", `${KEYS}/0123456789abcdef`, undefined, true);
    expect(companionDelete.status).toBe(403);
    // Companions may still list.
    expect((await h.call("GET", KEYS, undefined, true)).status).toBe(200);
  });

  it("404 for a service that isn't installed", async () => {
    const h = harness({ installed: () => false });
    expect((await h.call("GET", KEYS)).status).toBe(404);
    expect((await h.call("POST", KEYS, body(grant()))).status).toBe(404);
  });

  it("is routed by screensHttp behind the paired session, with the companion flag", async () => {
    const h = harness();
    const screens = buildScreensHttp({
      gate: { check: () => null },
      appApiKeys: h.http,
      pairedSessions: { isCompanionRequest: () => true } as never,
      serverFqdn: FQDN,
      username: "harry",
      daemonVersion: "t",
      startedAt: NOW,
    } as never);
    const r = await screens(req("POST", KEYS, body(grant())));
    expect(r?.status).toBe(403);
    expect(JSON.parse(String(r?.body)).error).toMatch(/companion/);
  });
});

describe("AppApiKeyStore.authenticate (the proxy's check)", () => {
  async function withKey(scope: "read" | "write", over: Partial<AppApiKeyGrant> = {}, now = () => NOW) {
    const h = harness({ now });
    const r = await h.call("POST", KEYS, body(grant({ scope, ...over })));
    return { ...h, key: String(r.json.key) };
  }
  const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

  it("accepts a valid key; read scope only for GET/HEAD/OPTIONS", async () => {
    const { store, key } = await withKey("read");
    expect(store.authenticate(SVC, "GET", bearer(key))).toEqual({ kind: "ok", keyId: "0123456789abcdef", scope: "read" });
    expect(store.authenticate(SVC, "OPTIONS", bearer(key)).kind).toBe("ok");
    expect(store.authenticate(SVC, "POST", bearer(key))).toEqual({ kind: "scope", keyId: "0123456789abcdef", scope: "read" });
    const w = await withKey("write");
    expect(w.store.authenticate(SVC, "DELETE", bearer(w.key)).kind).toBe("ok");
  });

  it("none without an fsk_ bearer; invalid for wrong, other-app, malformed, revoked or expired", async () => {
    let t = NOW;
    const { store, key } = await withKey("write", { expiresAt: NOW + 1000 }, () => t);
    expect(store.authenticate(SVC, "GET", {})).toEqual({ kind: "none" });
    expect(store.authenticate(SVC, "GET", { authorization: "Bearer their-own-token" })).toEqual({ kind: "none" });
    const wrong = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(store.authenticate(SVC, "GET", bearer(wrong)).kind).toBe("invalid");
    expect(store.authenticate("harry-other", "GET", bearer(key)).kind).toBe("invalid");
    expect(store.authenticate(SVC, "GET", { authorization: `Bearer ${key}x` }).kind).toBe("invalid");
    expect(store.authenticate(SVC, "GET", { authorization: `Basic ${key}` }).kind).toBe("invalid");
    expect(store.authenticate(SVC, "GET", bearer(key)).kind).toBe("ok");
    t = NOW + 1000;
    expect(store.authenticate(SVC, "GET", bearer(key)).kind).toBe("invalid");
    t = NOW;
    await store.revoke(SVC, "0123456789abcdef");
    expect(store.authenticate(SVC, "GET", bearer(key)).kind).toBe("invalid");
  });

  it("rate-limits per key and records lastUsedAt", async () => {
    let t = NOW;
    const store = new AppApiKeyStore(null, null, { now: () => t, rate: { burst: 3, perSecond: 1 } });
    const http = buildAppApiKeysHttp({ serverDomain: FQDN, store, authorize, installed: () => true, now: () => t });
    const r = await http.handle(KEYS, "POST", req("POST", KEYS, body(grant())), { companion: false });
    const key = String(JSON.parse(String(r!.body)).key);
    for (let i = 0; i < 3; i++) expect(store.authenticate(SVC, "GET", bearer(key)).kind).toBe("ok");
    const limited = store.authenticate(SVC, "GET", bearer(key));
    expect(limited.kind).toBe("rate-limited");
    t += 1000;
    expect(store.authenticate(SVC, "GET", bearer(key)).kind).toBe("ok");
    expect(store.list(SVC)[0]!.lastUsedAt).toBe(t);
  });
});

describe("AppApiKeyStore persistence", () => {
  it("seals the hash only, reloads keys that still verify, and drops an uninstalled app's keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apikeys-"));
    const path = join(dir, "app-api-keys.sealed");
    const h = harness({ path });
    const created = await h.call("POST", KEYS, body(grant()));
    const key = String(created.json.key);
    await h.call("POST", KEYS, body(grant({ keyId: "1111111111111111", scope: "write" })));
    await h.store.flush();
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toMatch(/^[0-9a-f]+$/);
    expect(onDisk).not.toContain(key.slice(22));

    const reloaded = new AppApiKeyStore(path, h.swk, { now: () => NOW });
    expect(await reloaded.load(authorize, FQDN)).toEqual({ dropped: 0 });
    expect(reloaded.list(SVC).map((k) => k.keyId).sort()).toEqual(["0123456789abcdef", "1111111111111111"]);
    expect(reloaded.authenticate(SVC, "GET", { authorization: `Bearer ${key}` }).kind).toBe("ok");

    // Another owner (e.g. a rotated authority): nothing verifies, so nothing is kept.
    const other = apiKeyAuthorizer({ username: "harry", ownerIrkPub: ed.getPublicKey(new Uint8Array(32).fill(3)) });
    const strict = new AppApiKeyStore(path, h.swk, { now: () => NOW });
    expect(await strict.load(other, FQDN)).toEqual({ dropped: 2 });

    const third = new AppApiKeyStore(path, h.swk, { now: () => NOW });
    await third.load(authorize, FQDN);
    expect(third.list(SVC)).toEqual([]);

    const fresh = harness({ path: join(dir, "b.sealed") });
    await fresh.call("POST", KEYS, body(grant()));
    expect(await fresh.store.pruneTo(() => false)).toBe(1);
    expect(fresh.store.list(SVC)).toEqual([]);
  });
});
