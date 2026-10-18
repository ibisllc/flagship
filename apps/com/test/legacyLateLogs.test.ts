import { describe, expect, it } from "vitest";
import { pruneLateLogs, type LateLogBucket } from "../src/legacyLateLogs.js";
import { route, type RouteEnv } from "../src/route.js";
import { endpointFor } from "../src/rateLimit.js";

function memoryBucket(): LateLogBucket & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async list({ prefix = "", limit = 1000, cursor }) {
      const all = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

describe("leftover installer logs", () => {
  it("prunes chunks past the TTL and leaves everything else", async () => {
    const bucket = memoryBucket();
    const now = new Date("2026-10-16T00:00:00Z");
    const old = now.getTime() - 8 * 86_400_000;
    const fresh = now.getTime() - 86_400_000;
    bucket.data.set(`late-log/a/${old}-abc.txt`, "old");
    bucket.data.set(`late-log/b/${fresh}-def.txt`, "fresh");
    bucket.data.set("other/thing", "kept");
    expect(await pruneLateLogs(bucket, now)).toBe(1);
    expect([...bucket.data.keys()].sort()).toEqual([`late-log/b/${fresh}-def.txt`, "other/thing"]);
  });
});

describe("W12 debug endpoints are gone (GA close-out 5)", () => {
  it("no rate-limit budget exists for the installer log", () => {
    expect(endpointFor("POST", "/api/dev/late-log/abc-wifi")).toBeNull();
  });

  it("the Worker no longer answers late-log, rescue, destroy, server-info or upload-iso", async () => {
    const env = { FLAGSHIP_ADMIN_SECRET: "s3cret", HCLOUD_TOKEN: "t" } as unknown as RouteEnv;
    const calls: Array<[string, string]> = [
      ["POST", "/api/dev/late-log/abc"],
      ["GET", "/api/dev/late-log/abc"],
      ["POST", "/api/dev/rescue/123"],
      ["POST", "/api/dev/destroy/123"],
      ["GET", "/api/dev/server/123"],
      ["PUT", "/api/dev/upload-iso/x.iso"],
    ];
    for (const [method, path] of calls) {
      const r = await route(
        new Request(`https://flagshipserver.com${path}`, { method, headers: { "x-admin-secret": "s3cret" }, ...(method === "GET" ? {} : { body: "x" }) }),
        env,
      );
      expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(await r.text(), `${method} ${path}`).not.toMatch(/stored|rescue mode enabled|destroy \d+|uploaded/);
    }
  });
});
