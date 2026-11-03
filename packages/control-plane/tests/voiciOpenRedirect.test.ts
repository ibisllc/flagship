/**
 * voi.ci must never redirect off its own host (security review M1): a path whose name part starts with `/` or `\`
 * (raw or percent-encoded) once answered `301 Location: //evil.com`, which a browser reads as another host. Every
 * redirect the resolver gives is absolute on the voi.ci origin, and anything outside the name alphabet is a 404.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { resolveVoiciPath } from "../src/voici.js";

async function world() {
  const s = new InMemoryStorage();
  await s.voici.publishPage(
    { username: "alice", pageId: "ab".repeat(16), seq: 1, issuedAt: 1, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: "cc".repeat(32), indexJson: "{}", publishedAt: 1 },
    0,
  );
  const resolve = (path: string, search = "", origin?: string) =>
    resolveVoiciPath({ names: s.names, pages: s.voici, ...(origin ? { origin } : {}) }, path, search);
  return { s, resolve };
}

describe("voi.ci never redirects to another host (M1)", () => {
  it("404s a name part that starts with a slash or a backslash, before any redirect", async () => {
    const { resolve } = await world();
    for (const p of ["//Evil.com", "//evil.com", "//x", "//X", "//x/", "///x", "/\\x", "/\\Evil.com", "/\\\\evil.com", "//evil.com/"]) {
      expect(await resolve(p), p).toEqual({ kind: "not-found" });
    }
  });

  it("404s percent-encoded slashes and backslashes, and anything outside a-z 0-9 - @ /", async () => {
    const { resolve } = await world();
    for (const p of [
      "/%2F%2Fevil.com",
      "/%2f%2fevil.com",
      "/%5C%5Cevil.com",
      "/%5cevil.com",
      "/%5C/evil.com",
      "/%2Fevil.com/",
      "/%252F%252Fevil.com",
      "/evil.com",
      "/Evil.com/",
      "/a%40b",
      "/%40alice",
      "/al ice",
      "/alice%",
      "/%E0%A4%A",
      "/alice\\",
      "/a\\b/",
      "/ali.ce",
    ]) {
      expect(await resolve(p), p).toEqual({ kind: "not-found" });
    }
  });

  it("gives an absolute https Location on the voi.ci origin, the query kept", async () => {
    const { resolve } = await world();
    expect(await resolve("/Alice/")).toEqual({ kind: "redirect", location: "https://voi.ci/alice" });
    expect(await resolve("/alice/", "?ref=card")).toEqual({ kind: "redirect", location: "https://voi.ci/alice?ref=card" });
    expect(await resolve("/ALICE", "", "https://gym.voi.ci")).toEqual({ kind: "redirect", location: "https://gym.voi.ci/alice" });
  });

  it("never yields a Location that a browser reads as another host", async () => {
    const { resolve } = await world();
    const probes = ["//Evil.com", "//evil.com/", "/\\evil.com", "/%2F%2Fevil.com", "/%5C%5Cevil.com", "/Alice//", "/A/", "/@Alice"];
    for (const p of probes) {
      const r = await resolve(p);
      if (r.kind === "redirect") {
        expect(new URL(r.location, "https://attacker.invalid/").host, p).toBe("voi.ci");
        expect(r.location.startsWith("https://voi.ci/"), p).toBe(true);
      }
    }
  });
});
