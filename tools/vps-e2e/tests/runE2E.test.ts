import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { runE2E, plannedChain } from "../src/runE2E.js";
import { makeIdentity } from "../src/identity.js";
import {
  buildCreateServerBody,
  sanitizeServerName,
  resolveIsoSelector,
  attachIsoBody,
  parseCreateServerResponse,
  parseServerStatus,
} from "../src/providers/hetzner.js";
import type {
  E2EDeps,
  E2EPlan,
  HttpClient,
  HttpResponse,
  VpsInstance,
  VpsProvider,
  Logger,
} from "../src/ports.js";

const PLAN: E2EPlan = {
  comBase: "https://com.test",
  servicesBase: "https://svc.test",
  iso: "flagship-personalized-iso",
  username: "alice",
  serverName: "home",
  region: "nbg1",
  size: "cx22",
  pollIntervalMs: 1,
  pollMaxAttempts: 5,
};

const FQDN = "home.alice.flagship.services";

const SEEDS = {
  irk: new Uint8Array(32).fill(1),
  delegated: new Uint8Array(32).fill(2),
  rck: new Uint8Array(32).fill(3),
};

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function okJson(body: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify(body) };
}

/** A scripted HTTP fake: URL+method substring → response (or fn). */
function scriptedHttp(
  routes: Array<{
    match: (url: string) => boolean;
    reply: HttpResponse | ((url: string, n: number, body: unknown) => HttpResponse);
  }>,
): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];
  const counters = new Map<number, number>();
  function handle(method: string, url: string, body: unknown): HttpResponse {
    calls.push(`${method} ${url}`);
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i]!;
      if (r.match(url)) {
        const n = (counters.get(i) ?? 0) + 1;
        counters.set(i, n);
        return typeof r.reply === "function" ? r.reply(url, n, body) : r.reply;
      }
    }
    return { status: 404, body: `no fake route for ${url}` };
  }
  return {
    calls,
    http: {
      get: async (url) => handle("GET", url, undefined),
      post: async (url, jsonBody) => handle("POST", url, jsonBody),
    },
  };
}

function fakeProvider(
  overrides: Partial<{
    provision: () => Promise<VpsInstance>;
    destroyed: string[];
  }> = {},
): { provider: VpsProvider; destroyed: string[] } {
  const destroyed = overrides.destroyed ?? [];
  return {
    destroyed,
    provider: {
      name: "fake",
      provision:
        overrides.provision ??
        (async () => ({ id: "vps-1", ip: "203.0.113.7" })),
      awaitBoot: async () => {},
      destroy: async (id) => {
        destroyed.push(id);
      },
    },
  };
}

/** Happy-path HTTP: mint OK, pod registered+ready, padlock + health OK. */
function happyHttp() {
  // Mirrors the daemon: set-app-env stores the value; the deployed
  // app's /health then echoes it (value-in-container, never to model).
  const envState: { proof: string } = { proof: "" };
  return scriptedHttp([
    { match: (u) => u.includes("/api/username/claim"), reply: okJson({ ok: true }) },
    { match: (u) => u.includes("/api/auth-code/issue"), reply: okJson({ ok: true }) },
    { match: (u) => u.includes("/api/routing/register-rck"), reply: okJson({ ok: true }) },
    {
      match: (u) => u.includes("/api/build-tickets/issue"),
      reply: okJson({ code: "ABCD-EFGH" }),
    },
    {
      match: (u) => u.includes("/api/users/alice/pods"),
      reply: okJson([{ serverFqdn: FQDN, state: "ready" }]),
    },
    {
      match: (u) => u === `https://${FQDN}/`,
      reply: {
        status: 200,
        body: "ok",
        tls: {
          issuer: "Let's Encrypt R3",
          subjectAltNames: [FQDN],
          validFrom: 1,
          validTo: 9_999_999_999_999,
        },
      },
    },
    {
      match: (u) => u === `https://${FQDN}/api/health`,
      reply: okJson({ status: "ok" }),
    },
    // Generic per-app env (vibeAppEnv, WIRED): faithfully simulate the
    // daemon — the signed set-app-env POST records the value, then the
    // deployed app's /health echoes it (mirroring "value injected into
    // the container env, app reads it"). The proof value is random per
    // run; the mock reflects whatever the signed order carried.
    {
      match: (u) => /\/api\/services\/[^/]+\/env$/.test(u),
      reply: (_u, _n, body) => {
        const env = (body as { request?: { env?: Record<string, string> } })?.request?.env ?? {};
        envState.proof = env["E2E_ENV_PROOF"] ?? "";
        return okJson({ ok: true });
      },
    },
    { match: (u) => u.includes("/api/screens/orders/send"), reply: okJson({ orderId: "o1" }) },
    {
      match: (u) => /\/api\/services\/[^/]+\/health$/.test(u),
      reply: () => okJson({ status: "ok", E2E_ENV_PROOF: envState.proof }),
    },
    { match: (u) => u.includes("/api/services") && !u.includes("health"), reply: okJson({ serviceId: "a1" }) },
    {
      match: (u) => u.includes("/pubkey-cert"),
      reply: okJson({ pubkey: "deadbeef", caSig: "..." }),
    },
  ]);
}

function deps(http: HttpClient, provider: VpsProvider): E2EDeps {
  let t = 1_000;
  return {
    provider,
    http,
    clock: () => t++,
    sleep: async () => {},
    logger: silentLogger,
    identity: makeIdentity(SEEDS),
  };
}

describe("runE2E orchestration core", () => {
  // Drives every wired stage in order (incl. the now-wired generic
  // per-app env stage) and returns all-pass + the CA pillar honestly
  // reported known-gated.
  it("happy path: wired stages pass in order, CA gated, teardown destroys", async () => {
    const { http } = happyHttp();
    const { provider, destroyed } = fakeProvider();
    const report = await runE2E(PLAN, deps(http, provider));

    expect(report.stages.map((s) => s.name)).toEqual([
      "mintBuildCode",
      "provisionVps",
      "awaitInstallRegistered",
      "awaitUnlock",
      "probeGreenPadlock",
      "createAccountServer",
      "vibeAppEnv",
      "assertCaAuthorized",
      "teardown",
    ]);
    const byName = Object.fromEntries(report.stages.map((s) => [s.name, s]));
    for (const n of [
      "mintBuildCode",
      "provisionVps",
      "awaitInstallRegistered",
      "awaitUnlock",
      "probeGreenPadlock",
      "createAccountServer",
      "vibeAppEnv",
      "teardown",
    ]) {
      expect(byName[n]!.status).toBe("pass");
    }
    expect(byName["vibeAppEnv"]!.detail).toMatch(/injected env value/);
    expect(byName["assertCaAuthorized"]!.status).toBe("known-gated");
    expect(byName["assertCaAuthorized"]!.gatedReason).toMatch(
      /CaEndorsement|caTrustChain\.ts/,
    );
    expect(report.ok).toBe(true);
    expect(destroyed).toEqual(["vps-1"]);
  });

  // A mid-chain provider failure must still run teardown is moot (no
  // instance) — but the failing stage is reported and the run is red.
  it("provision failure: reports the failing stage and run is not ok; nothing to destroy", async () => {
    const { http } = happyHttp();
    const { provider, destroyed } = fakeProvider({
      provision: async () => {
        throw new Error("quota exceeded");
      },
    });
    const report = await runE2E(PLAN, deps(http, provider));
    const prov = report.stages.find((s) => s.name === "provisionVps")!;
    expect(prov.status).toBe("fail");
    expect(prov.detail).toMatch(/quota exceeded/);
    expect(report.ok).toBe(false);
    // No instance ever existed → teardown is a no-op skip, not a crash.
    const td = report.stages.find((s) => s.name === "teardown")!;
    expect(td.status).toBe("skipped");
    expect(destroyed).toEqual([]);
  });

  // Failure AFTER a VPS exists must still destroy it (try/finally).
  it("mid-chain failure after provision still calls destroy (teardown always runs)", async () => {
    const { http } = scriptedHttp([
      { match: (u) => u.includes("/api/username/claim"), reply: okJson({ ok: true }) },
      { match: (u) => u.includes("/api/auth-code/issue"), reply: okJson({ ok: true }) },
      { match: (u) => u.includes("/api/routing/register-rck"), reply: okJson({ ok: true }) },
      { match: (u) => u.includes("/api/build-tickets/issue"), reply: okJson({ code: "X" }) },
      // pods never shows the FQDN → awaitInstallRegistered times out.
      { match: (u) => u.includes("/api/users/alice/pods"), reply: okJson([]) },
    ]);
    const { provider, destroyed } = fakeProvider();
    const report = await runE2E(PLAN, deps(http, provider));
    const reg = report.stages.find((s) => s.name === "awaitInstallRegistered")!;
    expect(reg.status).toBe("fail");
    expect(reg.detail).toMatch(/timed out/);
    // Subsequent wired stages are skipped, gated stages still recorded.
    expect(
      report.stages.find((s) => s.name === "probeGreenPadlock")!.status,
    ).toBe("skipped");
    expect(
      report.stages.find((s) => s.name === "vibeAppEnv")!.status,
    ).toBe("skipped");
    // Teardown ran despite the mid-chain failure.
    expect(destroyed).toEqual(["vps-1"]);
    expect(report.ok).toBe(false);
  });

  // A failing KNOWN-GATED stage is the documented gap — it must NOT
  // turn the overall run red. (Only the CA stage remains gated; the
  // generic per-app env stage is now WIRED and asserted.)
  it("known-gated CA stage failing its assertion does not fail the run", async () => {
    const { http } = happyHttp();
    const { provider } = fakeProvider();
    const report = await runE2E(PLAN, deps(http, provider));
    expect(
      report.stages.find((s) => s.name === "vibeAppEnv")!.status,
    ).toBe("pass");
    expect(
      report.stages.find((s) => s.name === "assertCaAuthorized")!.status,
    ).toBe("known-gated");
    expect(report.ok).toBe(true);
  });

  // runE2E never throws — even a provider that throws in destroy is
  // captured as a (real, non-gated) teardown failure.
  it("never throws; a destroy failure is a real teardown fail", async () => {
    const { http } = happyHttp();
    const provider: VpsProvider = {
      name: "fake",
      provision: async () => ({ id: "vps-9", ip: "1.2.3.4" }),
      awaitBoot: async () => {},
      destroy: async () => {
        throw new Error("API down");
      },
    };
    const report = await runE2E(PLAN, deps(http, provider));
    const td = report.stages.find((s) => s.name === "teardown")!;
    expect(td.status).toBe("fail");
    expect(td.detail).toMatch(/manual cleanup required/);
    expect(report.ok).toBe(false);
  });

  // --keep leaves the box up: teardown is a deliberate skip, not a
  // destroy.
  it("keep flag skips destroy", async () => {
    const { http } = happyHttp();
    const { provider, destroyed } = fakeProvider();
    const report = await runE2E({ ...PLAN, keep: true }, deps(http, provider));
    const td = report.stages.find((s) => s.name === "teardown")!;
    expect(td.status).toBe("skipped");
    expect(td.detail).toMatch(/--keep/);
    expect(destroyed).toEqual([]);
  });

  // The IRK signature the core sends must verify against the same
  // canonical bytes — proves we mirror the live wire format.
  it("mintBuildCode signs claim with a verifiable IRK signature", async () => {
    let claimBody: { request: { username: string; irkPub: string; issuedAt: number }; signature: string } | undefined;
    const http: HttpClient = {
      get: async (u) =>
        u.includes("/pods")
          ? okJson([{ serverFqdn: FQDN, state: "ready" }])
          : u === `https://${FQDN}/`
            ? {
                status: 200,
                body: "ok",
                tls: {
                  issuer: "Let's Encrypt",
                  subjectAltNames: [FQDN],
                  validFrom: 1,
                  validTo: 9e15,
                },
              }
            : okJson({ status: "ok" }),
      post: async (u, body) => {
        if (u.includes("/api/username/claim")) {
          claimBody = body as typeof claimBody;
        }
        if (u.includes("/api/build-tickets/issue")) return okJson({ code: "C" });
        return okJson({ ok: true });
      },
    };
    const { provider } = fakeProvider();
    await runE2E(PLAN, deps(http, provider));
    expect(claimBody).toBeDefined();
    const c = claimBody!;
    const msg = new TextEncoder().encode(
      ["flagship/claim-username/v1", c.request.username, c.request.irkPub, c.request.issuedAt].join("|"),
    );
    const sig = Uint8Array.from(
      c.signature.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    const pub = Uint8Array.from(
      c.request.irkPub.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(ed.verify(sig, msg, pub)).toBe(true);
  });
});

describe("plannedChain", () => {
  // The static plan must list exactly the executed chain; only the CA
  // stage remains known-gated (vibeAppEnv is now WIRED).
  it("matches the executed stage order and flags the CA gate", () => {
    const chain = plannedChain();
    expect(chain.map((s) => s.name)).toEqual([
      "mintBuildCode",
      "provisionVps",
      "awaitInstallRegistered",
      "awaitUnlock",
      "probeGreenPadlock",
      "createAccountServer",
      "vibeAppEnv",
      "assertCaAuthorized",
      "teardown",
    ]);
    expect(chain.find((s) => s.name === "vibeAppEnv")!.kind).toBe("wired");
    const gated = chain.filter((s) => s.kind === "known-gated");
    expect(gated.map((s) => s.name)).toEqual(["assertCaAuthorized"]);
    expect(gated.every((s) => (s.gatedReason ?? "").length > 20)).toBe(true);
  });
});

describe("hetzner adapter pure helpers", () => {
  // Server name sanitization to Hetzner's RFC-1035-ish constraint.
  it("sanitizeServerName lowercases, strips, and caps at 63", () => {
    expect(sanitizeServerName("Flagship E2E Alice/Home!")).toBe(
      "flagship-e2e-alice-home",
    );
    expect(sanitizeServerName("--__--")).toBe("flagship-e2e");
    expect(sanitizeServerName("a".repeat(80)).length).toBe(63);
  });

  // create body shape uses size as server_type, region as location.
  it("buildCreateServerBody maps size→server_type, region→location", () => {
    const b = buildCreateServerBody({
      iso: "iso-x",
      region: "nbg1",
      size: "cx22",
      label: "flagship-e2e-alice-home",
    });
    expect(b["server_type"]).toBe("cx22");
    expect(b["location"]).toBe("nbg1");
    expect(b["start_after_create"]).toBe(false);
    expect(b["name"]).toBe("flagship-e2e-alice-home");
  });

  // ISO must be a Hetzner name/id; a path/url is a fail-closed error.
  it("resolveIsoSelector rejects path/url, accepts a name", () => {
    expect(resolveIsoSelector("alpine-flagship-v1")).toBe(
      "alpine-flagship-v1",
    );
    expect(() => resolveIsoSelector("/tmp/x.iso")).toThrow(/by name\/id/);
    expect(() => resolveIsoSelector("https://x/y.iso")).toThrow(/by name\/id/);
    expect(attachIsoBody("my-iso")).toEqual({ iso: "my-iso" });
  });

  // Response parsers tolerate the documented Hetzner JSON shape.
  it("parseCreateServerResponse + parseServerStatus read the documented shape", () => {
    const created = parseCreateServerResponse({
      server: { id: 42, public_net: { ipv4: { ip: "203.0.113.9" } } },
    });
    expect(created).toEqual({ id: "42", ip: "203.0.113.9" });
    expect(
      parseServerStatus({ server: { status: "running", public_net: { ipv4: { ip: "1.1.1.1" } } } }),
    ).toEqual({ status: "running", running: true, ip: "1.1.1.1" });
    expect(parseServerStatus({ server: { status: "initializing" } }).running).toBe(
      false,
    );
    expect(() => parseCreateServerResponse({ server: {} })).toThrow(/no server\.id/);
  });
});
