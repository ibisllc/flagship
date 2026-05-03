import { describe, expect, it } from "vitest";
import type { FetchLike } from "@flagship/llm-providers";
import { provisionForgejo } from "../src/forgejoProvisioning.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeForgejo(behaviors: {
  readyAfterCalls?: number;
  orgExists?: boolean;
  installFails?: boolean;
}): { f: FetchLike; calls: Call[]; mintedToken: string } {
  const calls: Call[] = [];
  let versionPolls = 0;
  const mintedToken = "tok-" + Math.random().toString(16).slice(2);

  const f: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });

    if (url.endsWith("/api/v1/version")) {
      versionPolls += 1;
      const ok = versionPolls > (behaviors.readyAfterCalls ?? 0);
      return {
        ok,
        status: ok ? 200 : 503,
        async text() {
          return ok ? "ok" : "starting";
        },
        async json() {
          return { version: "9.0.0" };
        },
      };
    }
    if (url.endsWith("/-/install")) {
      const ok = !behaviors.installFails;
      return { ok, status: ok ? 200 : 422, async text() { return ok ? "" : "already installed"; }, async json() { return {}; } };
    }
    if (url.includes("/api/v1/orgs/") && init?.method === "GET") {
      const ok = !!behaviors.orgExists;
      return { ok, status: ok ? 200 : 404, async text() { return ""; }, async json() { return {}; } };
    }
    if (url.endsWith("/api/v1/orgs") && init?.method === "POST") {
      return { ok: true, status: 201, async text() { return ""; }, async json() { return {}; } };
    }
    if (url.includes("/tokens/") && init?.method === "DELETE") {
      return { ok: true, status: 204, async text() { return ""; }, async json() { return {}; } };
    }
    if (url.endsWith("/tokens") && init?.method === "POST") {
      return {
        ok: true,
        status: 201,
        async text() {
          return JSON.stringify({ sha1: mintedToken });
        },
        async json() {
          return { sha1: mintedToken };
        },
      };
    }
    return { ok: false, status: 404, async text() { return ""; }, async json() { return {}; } };
  };
  return { f, calls, mintedToken };
}

describe("provisionForgejo", () => {
  it("waits for Forgejo to come up before issuing any provisioning calls", async () => {
    const { f, calls } = fakeForgejo({ readyAfterCalls: 2 });
    await provisionForgejo({
      baseUrl: "http://forgejo.local",
      userId: "harry",
      ownerEmail: "h@x.com",
      adminPassword: "p",
      fetchImpl: f,
      readinessIntervalMs: 1,
    });
    const versionCalls = calls.filter((c) => c.url.endsWith("/api/v1/version"));
    expect(versionCalls.length).toBeGreaterThanOrEqual(3);
    // First non-version call should be /-/install, never a mutation before readiness.
    const firstNonVersion = calls.find((c) => !c.url.endsWith("/api/v1/version"));
    expect(firstNonVersion!.url).toContain("/-/install");
  });

  it("creates an organization named '<userId>-flagship' and binds it to the admin user", async () => {
    const { f, calls } = fakeForgejo({});
    const result = await provisionForgejo({
      baseUrl: "http://forgejo.local",
      userId: "harry",
      ownerEmail: "h@x.com",
      adminPassword: "p",
      fetchImpl: f,
    });
    expect(result.orgName).toBe("harry-flagship");
    const orgPost = calls.find((c) => c.url.endsWith("/api/v1/orgs") && c.method === "POST")!;
    expect(orgPost).toBeDefined();
    const body = JSON.parse(orgPost.body as string);
    expect(body.username).toBe("harry-flagship");
    expect(body.visibility).toBe("private");
  });

  it("skips org creation when the org already exists (idempotent re-provisioning)", async () => {
    const { f, calls } = fakeForgejo({ orgExists: true });
    await provisionForgejo({
      baseUrl: "http://forgejo.local",
      userId: "harry",
      ownerEmail: "h@x.com",
      adminPassword: "p",
      fetchImpl: f,
    });
    const orgPost = calls.find((c) => c.url.endsWith("/api/v1/orgs") && c.method === "POST");
    expect(orgPost).toBeUndefined();
  });

  it("mints a 'flagship-llm-harness' token with repo + org scopes and returns it", async () => {
    const { f, calls, mintedToken } = fakeForgejo({});
    const result = await provisionForgejo({
      baseUrl: "http://forgejo.local",
      userId: "harry",
      ownerEmail: "h@x.com",
      adminPassword: "p",
      fetchImpl: f,
    });
    expect(result.llmServiceToken).toBe(mintedToken);
    const tokenPost = calls.find((c) => c.url.endsWith("/tokens") && c.method === "POST")!;
    const body = JSON.parse(tokenPost.body as string);
    expect(body.name).toBe("flagship-llm-harness");
    expect(body.scopes).toContain("write:repository");
    expect(body.scopes).toContain("write:organization");
  });

  it("uses HTTP basic auth (admin:password) for admin-protected calls", async () => {
    const { f, calls } = fakeForgejo({});
    await provisionForgejo({
      baseUrl: "http://forgejo.local",
      userId: "harry",
      ownerEmail: "h@x.com",
      adminPassword: "topsecret",
      fetchImpl: f,
    });
    const orgGet = calls.find((c) => c.url.includes("/api/v1/orgs/harry-flagship") && c.method === "GET")!;
    expect(orgGet.headers.authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(orgGet.headers.authorization.slice(6), "base64").toString();
    expect(decoded).toBe("harry-admin:topsecret");
  });

  it("times out (and throws) when Forgejo never becomes ready", async () => {
    const { f } = fakeForgejo({ readyAfterCalls: 1000 });
    await expect(
      provisionForgejo({
        baseUrl: "http://forgejo.local",
        userId: "harry",
        ownerEmail: "h@x.com",
        adminPassword: "p",
        fetchImpl: f,
        readinessTimeoutMs: 50,
        readinessIntervalMs: 5,
      }),
    ).rejects.toThrow(/not ready/);
  });
});
