import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  constantTimeEqual,
  bearer,
  handleActiveRedirections,
  handleRedirectionLookup,
  pushRedirection,
} from "../src/customDomainRedirections.js";

describe("constantTimeEqual / bearer", () => {
  it("constantTimeEqual: true only on exact match", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false); // length differs
  });
  it("bearer parses 'Bearer <x>' case-insensitively, else null", () => {
    expect(bearer("Bearer s3cr3t")).toBe("s3cr3t");
    expect(bearer("bearer  s3cr3t")).toBe("s3cr3t");
    expect(bearer("Basic abc")).toBeNull();
    expect(bearer(null)).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });
});

describe("handleActiveRedirections (#87)", () => {
  async function withRows(s: InMemoryStorage) {
    await s.customDomainOrders.upsert({
      appId: "a1", userId: "u", fqdn: "shop.example.com", status: "active",
      podCanonical: "home.u.flagship.services",
      lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    // active but no pod yet → excluded; pending → excluded.
    await s.customDomainOrders.upsert({
      appId: "a2", userId: "u", fqdn: "nopod.example.com", status: "active",
      lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    await s.customDomainOrders.upsert({
      appId: "a3", userId: "u", fqdn: "pending.example.com", status: "pending",
      lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
  }

  it("fails closed: 503 when no secret configured", async () => {
    const s = new InMemoryStorage();
    const r = await handleActiveRedirections({ customDomainOrders: s.customDomainOrders }, "anything", undefined);
    expect(r.status).toBe(503);
  });
  it("401 on missing or wrong bearer", async () => {
    const s = new InMemoryStorage();
    expect((await handleActiveRedirections({ customDomainOrders: s.customDomainOrders }, null, "S")).status).toBe(401);
    expect((await handleActiveRedirections({ customDomainOrders: s.customDomainOrders }, "wrong", "S")).status).toBe(401);
  });
  it("200 returns only active rows that have a podCanonical", async () => {
    const s = new InMemoryStorage();
    await withRows(s);
    const r = await handleActiveRedirections({ customDomainOrders: s.customDomainOrders }, "S", "S");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ redirections: [{ fqdn: "shop.example.com", podCanonical: "home.u.flagship.services" }] });
  });
});

describe("handleRedirectionLookup (#12 lazy point lookup)", () => {
  async function rows(s: InMemoryStorage) {
    await s.customDomainOrders.upsert({
      appId: "a1", userId: "u", fqdn: "shop.example.com", status: "active",
      podCanonical: "home.u.flagship.services",
      lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    await s.customDomainOrders.upsert({
      appId: "a2", userId: "u", fqdn: "nopod.example.com", status: "active",
      lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    await s.customDomainOrders.upsert({
      appId: "a3", userId: "u", fqdn: "pending.example.com", status: "pending",
      lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
  }
  const dep = (s: InMemoryStorage) => ({ customDomainOrders: s.customDomainOrders });

  it("fails closed: 503 no secret, 401 bad bearer", async () => {
    const s = new InMemoryStorage();
    expect((await handleRedirectionLookup(dep(s), "x", undefined, "shop.example.com")).status).toBe(503);
    expect((await handleRedirectionLookup(dep(s), null, "S", "shop.example.com")).status).toBe(401);
    expect((await handleRedirectionLookup(dep(s), "wrong", "S", "shop.example.com")).status).toBe(401);
  });

  it("400 when fqdn missing / not a bare hostname", async () => {
    const s = new InMemoryStorage();
    expect((await handleRedirectionLookup(dep(s), "S", "S", null)).status).toBe(400);
    expect((await handleRedirectionLookup(dep(s), "S", "S", "")).status).toBe(400);
    expect((await handleRedirectionLookup(dep(s), "S", "S", "https://x.example.com/p")).status).toBe(400);
  });

  it("200 for an active+served fqdn (case-insensitive); 404 otherwise — no enumeration", async () => {
    const s = new InMemoryStorage();
    await rows(s);
    const hit = await handleRedirectionLookup(dep(s), "S", "S", "SHOP.EXAMPLE.COM");
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual({ found: true, fqdn: "shop.example.com", podCanonical: "home.u.flagship.services" });
    // active-but-no-pod, pending, and unknown all 404 (negative-cacheable)
    expect((await handleRedirectionLookup(dep(s), "S", "S", "nopod.example.com")).status).toBe(404);
    expect((await handleRedirectionLookup(dep(s), "S", "S", "pending.example.com")).status).toBe(404);
    expect((await handleRedirectionLookup(dep(s), "S", "S", "unknown.example.com")).status).toBe(404);
  });
});

describe("pushRedirection (#87)", () => {
  it("POSTs the op with a bearer secret; ok on 2xx", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const r = await pushRedirection(
      { servicesBaseUrl: "https://svc.example/", secret: "sek", fetchImpl },
      { op: "add", fqdn: "shop.example.com", podCanonical: "home.u.flagship.services" },
    );
    expect(r).toEqual({ ok: true, status: 200 });
    expect(seen!.url).toBe("https://svc.example/control/redirections");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer sek");
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      op: "add", fqdn: "shop.example.com", podCanonical: "home.u.flagship.services",
    });
  });
  it("returns {ok:false,status:0} on a network throw (never throws)", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await pushRedirection(
      { servicesBaseUrl: "https://svc.example", secret: "x", fetchImpl },
      { op: "delete", fqdn: "shop.example.com" },
    );
    expect(r).toEqual({ ok: false, status: 0 });
  });
});
