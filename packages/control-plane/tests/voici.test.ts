import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { isOwnAppCanonical, mintShortLink, resolveVoiciPath } from "../src/voici.js";

const USER = "alice";
const APP = { serviceId: "alice--family", targetUrl: "https://family.home.alice.flagship.services" };

describe("mintShortLink (internal)", () => {
  it("returns a 6-char code, a digit first, by default (D2, D3)", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, now: () => 1000 },
      { username: USER, ...APP },
    );
    expect("error" in r).toBe(false);
    if ("code" in r) {
      expect(r.code).toMatch(/^[0-9][a-z0-9]{5}$/);
      expect(r.shortUrl).toBe(`https://voi.ci/${r.code}`);
    }
  });

  it("mints only for one app's own canonical address: never another URL, account or a code bound to no app", async () => {
    const s = new InMemoryStorage();
    const deps = { usernames: s.usernames, voiciLinks: s.voiciLinks };
    for (const targetUrl of [
      "javascript:alert(1)",
      "https://example.com/",
      "http://family.home.alice.flagship.services",
      "https://family.home.alice.flagship.services/login",
      "https://family.home.alice.flagship.services/?next=https://example.com",
      "https://family.alice.bob.flagship.services",
      "https://family.home.bob.flagship.services",
      "https://a.b.c.alice.flagship.services",
      "https://alice.flagship.services.example.com",
    ]) {
      expect("error" in (await mintShortLink(deps, { username: USER, serviceId: APP.serviceId, targetUrl })), targetUrl).toBe(true);
    }
    expect("error" in (await mintShortLink(deps, { username: USER, serviceId: "", targetUrl: APP.targetUrl }))).toBe(true);
    expect(isOwnAppCanonical("https://family.alice.flagship.services", USER)).toBe(true);
    expect(isOwnAppCanonical("https://family.home.alice.gym.flagship.services/", USER)).toBe(true);
  });

  it("rejects malformed usernames", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      { username: "BAD..NAME", ...APP },
    );
    expect("error" in r).toBe(true);
  });

  it("respects deps.shortHost when formatting the returned URL", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, shortHost: "staging.voi.ci" },
      { username: USER, ...APP },
    );
    if ("code" in r) {
      expect(r.shortUrl).toBe(`https://staging.voi.ci/${r.code}`);
    }
  });

  it("respects deps.codeLength", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, codeLength: 8 },
      { username: USER, ...APP },
    );
    if ("code" in r) {
      expect(r.code).toMatch(/^[0-9][a-z0-9]{7}$/);
    }
  });
});

describe("resolveVoiciPath for codes", () => {
  const resolve = (s: InMemoryStorage, path: string, extra: object = {}) =>
    resolveVoiciPath({ names: s.names, pages: s.voici, now: () => 1000, ...extra }, path);

  it("302s with the target URL on a hit", async () => {
    const s = new InMemoryStorage();
    await s.voiciLinks.insert({ code: "1bc123", username: USER, serviceId: "alice--x", targetUrl: "https://x.alice.flagship.services", createdAt: 1 });
    expect(await resolve(s, "/1bc123")).toEqual({ kind: "link", target: "https://x.alice.flagship.services" });
  });

  it("sends an app's link to the box that runs the app now; a code bound to no app (the removed shortener) is gone", async () => {
    const s = new InMemoryStorage();
    await s.voiciLinks.insert({ code: "4pp123", username: USER, serviceId: "alice--family", targetUrl: "https://family.home.alice.flagship.services", createdAt: 1 });
    await s.voiciLinks.insert({ code: "0ne123", username: USER, targetUrl: "https://example.com/x", createdAt: 1 });
    const asked: string[] = [];
    const appUrl = { resolveAppUrl: async (u: string, id: string) => (asked.push(`${u}/${id}`), "https://family.work.alice.flagship.services") };
    expect(await resolve(s, "/4pp123", appUrl)).toEqual({ kind: "link", target: "https://family.work.alice.flagship.services" });
    expect(await resolve(s, "/0ne123", appUrl)).toEqual({ kind: "gone" });
    expect(asked).toEqual(["alice/alice--family"]);
    expect(await resolve(s, "/4pp123", { resolveAppUrl: async () => null })).toEqual({ kind: "link", target: "https://family.home.alice.flagship.services" });
  });

  it("404s on a miss, 410s on an expired code", async () => {
    const s = new InMemoryStorage();
    await s.voiciLinks.insert({ code: "5tale1", username: USER, serviceId: "alice--x", targetUrl: "https://x.alice.flagship.services", createdAt: 1, expiresAt: 100 });
    expect(await resolve(s, "/n0pe42")).toEqual({ kind: "not-found" });
    expect(await resolve(s, "/5tale1")).toEqual({ kind: "gone" });
  });

  it("never reads a path with more than one segment (no path traversal)", async () => {
    const s = new InMemoryStorage();
    expect(await resolve(s, "/../../etc/passwd")).toEqual({ kind: "not-found" });
    expect(await resolve(s, "/a/b")).toEqual({ kind: "not-found" });
  });
});
