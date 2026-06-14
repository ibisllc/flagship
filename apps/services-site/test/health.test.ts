import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

// A stand-in for the ASSETS binding: returns a recognizable static
// response so we can assert the Worker delegated rather than handled.
function makeEnv() {
  return {
    ASSETS: {
      fetch: vi.fn(async () => new Response("<!doctype html>static", {
        headers: { "content-type": "text/html" },
      })),
    },
  };
}

describe("flagship-services-site worker", () => {
  it("/api/health returns meaningful JSON, not the SPA fallback", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://flagship.services/api/health"),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("flagship.services");
    expect(body.surface).toBe("apex-placeholder");
    expect(typeof body.now).toBe("string");
    // Health must NOT fall through to the static asset edge.
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("/api/health is not cached", async () => {
    const res = await worker.fetch(
      new Request("https://flagship.services/api/health"),
      makeEnv(),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("every other path is delegated to the static asset edge", async () => {
    const env = makeEnv();
    const req = new Request("https://flagship.services/about");
    const res = await worker.fetch(req, env);
    expect(env.ASSETS.fetch).toHaveBeenCalledWith(req);
    expect(await res.text()).toContain("static");
  });
});
