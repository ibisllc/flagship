import { describe, expect, it } from "vitest";
import {
  ed,
  signEntitlementRevocationList,
  type EntitlementRevocationList,
  type Keypair,
} from "@flagship/protocol";
import { RevocationCache } from "../src/tunnel/revocationCache.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const USER = "harry";

interface CapturedFetch {
  fetches: number;
  bodyFor(username: string): unknown;
  setBody(username: string, body: unknown): void;
  setStatus(username: string, status: number): void;
  fetchImpl: typeof fetch;
}

function captureFetch(): CapturedFetch {
  const bodies = new Map<string, unknown>();
  const statuses = new Map<string, number>();
  const cap: CapturedFetch = {
    fetches: 0,
    bodyFor(u) { return bodies.get(u); },
    setBody(u, b) { bodies.set(u, b); },
    setStatus(u, s) { statuses.set(u, s); },
    fetchImpl: (async (url: unknown) => {
      cap.fetches++;
      const u = decodeURIComponent(String(url).split("/").pop()!);
      const status = statuses.get(u) ?? 200;
      const body = bodies.get(u) ?? { username: u, certIds: [], issuedAt: 0, signature: null };
      return {
        ok: status >= 200 && status < 300,
        status,
        async text() { return JSON.stringify(body); },
        async json() { return body; },
      } as Response;
    }) as unknown as typeof fetch,
  };
  return cap;
}

describe("RevocationCache", () => {
  it("returns the certId set for a properly-signed list", async () => {
    const irk = makeKey();
    const list: EntitlementRevocationList = {
      username: USER,
      certIds: ["aa".repeat(32)],
      issuedAt: 1_000,
    };
    const sig = hex(signEntitlementRevocationList(list, irk));
    const cap = captureFetch();
    cap.setBody(USER, { username: USER, certIds: list.certIds, issuedAt: list.issuedAt, signature: sig });
    const cache = new RevocationCache({
      controlPlaneBaseUrl: "https://flagshipserver.test",
      irkLookup: async (u) => (u === USER ? irk.publicKey : null),
      fetchImpl: cap.fetchImpl,
    });
    const set = await cache.lookup(USER);
    expect(set).toBeInstanceOf(Set);
    expect(set!.has("aa".repeat(32))).toBe(true);
  });

  it("returns an empty set for the never-posted case (signature: null)", async () => {
    const cap = captureFetch();
    cap.setBody(USER, { username: USER, certIds: [], issuedAt: 0, signature: null });
    const cache = new RevocationCache({
      controlPlaneBaseUrl: "https://flagshipserver.test",
      irkLookup: async () => makeKey().publicKey,
      fetchImpl: cap.fetchImpl,
    });
    const set = await cache.lookup(USER);
    expect(set).toBeInstanceOf(Set);
    expect(set!.size).toBe(0);
  });

  it("caches inside the TTL — second lookup doesn't re-fetch", async () => {
    const irk = makeKey();
    const list: EntitlementRevocationList = {
      username: USER,
      certIds: ["aa".repeat(32)],
      issuedAt: 1_000,
    };
    const sig = hex(signEntitlementRevocationList(list, irk));
    const cap = captureFetch();
    cap.setBody(USER, { username: USER, certIds: list.certIds, issuedAt: list.issuedAt, signature: sig });
    let now = 1_000;
    const cache = new RevocationCache({
      controlPlaneBaseUrl: "https://flagshipserver.test",
      irkLookup: async (u) => (u === USER ? irk.publicKey : null),
      fetchImpl: cap.fetchImpl,
      ttlMs: 60_000,
      now: () => now,
    });
    await cache.lookup(USER);
    await cache.lookup(USER);
    expect(cap.fetches).toBe(1);
  });

  it("re-fetches after the TTL", async () => {
    const irk = makeKey();
    const list: EntitlementRevocationList = {
      username: USER,
      certIds: ["aa".repeat(32)],
      issuedAt: 1_000,
    };
    const sig = hex(signEntitlementRevocationList(list, irk));
    const cap = captureFetch();
    cap.setBody(USER, { username: USER, certIds: list.certIds, issuedAt: list.issuedAt, signature: sig });
    let now = 1_000;
    const cache = new RevocationCache({
      controlPlaneBaseUrl: "https://flagshipserver.test",
      irkLookup: async () => irk.publicKey,
      fetchImpl: cap.fetchImpl,
      ttlMs: 60_000,
      now: () => now,
    });
    await cache.lookup(USER);
    now += 60_001;
    await cache.lookup(USER);
    expect(cap.fetches).toBe(2);
  });

  it("rejects a list signed by the wrong IRK (cache stays empty)", async () => {
    const realIrk = makeKey();
    const fakeIrk = makeKey();
    const list: EntitlementRevocationList = {
      username: USER,
      certIds: ["evil".repeat(8) + "00".repeat(48 - 32)],
      issuedAt: 1_000,
    };
    const sig = hex(signEntitlementRevocationList(list, fakeIrk));
    const cap = captureFetch();
    cap.setBody(USER, { username: USER, certIds: list.certIds, issuedAt: list.issuedAt, signature: sig });
    const cache = new RevocationCache({
      controlPlaneBaseUrl: "https://flagshipserver.test",
      irkLookup: async () => realIrk.publicKey,
      fetchImpl: cap.fetchImpl,
    });
    const set = await cache.lookup(USER);
    expect(set).toBeNull(); // signature failed → no cache entry
  });

  it("returns null on fetch failure (fail-open at the hub)", async () => {
    const cap = captureFetch();
    cap.setStatus(USER, 502);
    const cache = new RevocationCache({
      controlPlaneBaseUrl: "https://flagshipserver.test",
      irkLookup: async () => makeKey().publicKey,
      fetchImpl: cap.fetchImpl,
    });
    expect(await cache.lookup(USER)).toBeNull();
  });

  it("rejects an OLDER list than what's cached (replay defense)", async () => {
    const irk = makeKey();
    const newer: EntitlementRevocationList = {
      username: USER, certIds: ["aa".repeat(32), "bb".repeat(32)], issuedAt: 200,
    };
    const older: EntitlementRevocationList = {
      username: USER, certIds: [], issuedAt: 100,
    };
    let now = 1_000;
    const cap = captureFetch();
    const cache = new RevocationCache({
      controlPlaneBaseUrl: "https://flagshipserver.test",
      irkLookup: async () => irk.publicKey,
      fetchImpl: cap.fetchImpl,
      ttlMs: 60_000,
      now: () => now,
    });
    cap.setBody(USER, {
      username: USER,
      certIds: newer.certIds,
      issuedAt: newer.issuedAt,
      signature: hex(signEntitlementRevocationList(newer, irk)),
    });
    const first = await cache.lookup(USER);
    expect(first!.size).toBe(2);
    // Past TTL, server replays the OLDER list — cache should refuse.
    now += 60_001;
    cap.setBody(USER, {
      username: USER,
      certIds: older.certIds,
      issuedAt: older.issuedAt,
      signature: hex(signEntitlementRevocationList(older, irk)),
    });
    const second = await cache.lookup(USER);
    expect(second!.size).toBe(2);
  });
});
