import { describe, expect, it } from "vitest";
import { CHECKS, runChecks } from "./mirror-dns-check.mjs";

function fakeFetch(missing: Set<string>, codes: Record<string, number>) {
  return async (url: string) => {
    if (url.startsWith("https://cloudflare-dns.com/")) {
      const name = new URL(url).searchParams.get("name")!;
      const Answer = missing.has(name) ? undefined : [{ type: 28, data: "100::" }];
      return { ok: true, json: async () => ({ Answer }) } as Response;
    }
    return { status: codes[url] ?? 200 } as Response;
  };
}

const redirects = { "https://www.fshp.tech/": 308, "https://fshp.app/": 308 };

describe("mirror-dns-check", () => {
  it("passes when every record resolves and answers", async () => {
    const r = await runChecks(fakeFetch(new Set(), redirects));
    expect(r.every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect(r).toHaveLength(CHECKS.length);
  });

  it("fails on a missing fshp.tech apex (the 2026-11-27 outage)", async () => {
    const r = await runChecks(fakeFetch(new Set(["fshp.tech"]), redirects));
    const apex = r.find((x: { name: string }) => x.name === "fshp.tech");
    expect(apex.ok).toBe(false);
    expect(apex.detail).toMatch(/AAAA @ 100::/);
  });

  it("fails when the apex answers with the wrong status", async () => {
    const r = await runChecks(fakeFetch(new Set(), { ...redirects, "https://fshp.tech/": 522 }));
    expect(r.find((x: { name: string }) => x.name === "fshp.tech").ok).toBe(false);
  });
});
