import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { route, type RouteEnv } from "../src/route.js";
import { handleRuntimeManifest } from "../src/runtimeManifest.js";

const ROOT = join(import.meta.dirname, "../../..");
const get = (path = "/api/runtime/manifest", headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://flagshipserver.com${path}`, { method, headers });
const doc = { manifest: { runtime: "node", version: "24.22.1", sequence: 3 }, signatures: [], lockJson: "{}" };

describe("GET /api/runtime/manifest", () => {
  it("serves the published document byte for byte, cacheable, with an etag", async () => {
    const res = await handleRuntimeManifest(get(), { manifest: doc });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(doc);
    expect(res.headers.get("cache-control")).toContain("public");
    const etag = res.headers.get("etag")!;
    expect((await handleRuntimeManifest(get(undefined, { "if-none-match": etag }), { manifest: doc })).status).toBe(304);
    expect(await (await handleRuntimeManifest(get(undefined, {}, "HEAD"), { manifest: doc })).text()).toBe("");
  });

  it("answers 204 while nothing is published, and refuses writes", async () => {
    expect((await handleRuntimeManifest(get(), { manifest: null })).status).toBe(204);
    expect((await handleRuntimeManifest(get(undefined, {}, "POST"), { manifest: doc })).status).toBe(405);
  });

  it("serves the committed release/runtime-manifest.json", async () => {
    const committed = JSON.parse(readFileSync(join(ROOT, "release/runtime-manifest.json"), "utf8"));
    const res = await handleRuntimeManifest(get());
    if (committed === null) expect(res.status).toBe(204);
    else expect(await res.json()).toEqual(committed);
  });
});

describe("through the Worker", () => {
  const env = (): RouteEnv => ({
    SERVICES_BASE_URL: "https://flagship.services",
    ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
  });

  it("is public: no preview cookie, no session", async () => {
    const res = await route(get(), env());
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sends /runtime to the readable page", async () => {
    for (const p of ["/runtime", "/runtime/"]) {
      const res = await route(get(p), env());
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://flagshipserver.com/security/runtime.html");
    }
  });
});
