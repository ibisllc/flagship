import { describe, expect, it } from "vitest";
import { boxSigner, swkOps } from "./helpers/keyCustody.js";
import type { SwkOps } from "../src/keyCustodian.js";
import { ed, signInstallService, type Keypair } from "@flagship/protocol";
import {
  decideAccess,
  handleAppRequest,
  stripIdentityHeaders,
  type SessionInfo,
} from "../src/serviceProxy.js";
import { ServicePlatform, type InstalledService } from "../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { DataProvisioner, InMemoryPostgresAdmin } from "../src/dataLayer/index.js";

const HOST = "alice";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function fakeSwk(): SwkOps {
  const swk = new Uint8Array(32);
  crypto.getRandomValues(swk);
  return swkOps(swk);
}

const NOOP_CMD: CommandRunner = {
  run: async () => undefined,
  capture: async () => ({ stdout: "", stderr: "" }),
};

async function makeApp(opts: {
  publicRoutes?: string[];
}): Promise<{ app: InstalledService; platform: ServicePlatform; hostIrk: Keypair }> {
  const hostIrk = makeKey();
  const platform = new ServicePlatform({
    host: { username: HOST, irkPub: hostIrk.publicKey },
    swk: fakeSwk(),
    appRunner: new AppRunner(NOOP_CMD),
    dataProvisioner: new DataProvisioner({ postgres: new InMemoryPostgresAdmin(), nameKey: "n".repeat(40) }),
  });
  const manifestJson = JSON.stringify({
    schema_version: 1,
    name: "game1",
    version: "0.1.0",
    runtime: { image: "ghcr.io/alice/game1:0.1.0", port: 8080 },
    data: { stores: { postgres: true } },
    network: { subdomain: "game1" },
    access: {
      enabled: true,
      default_role: "viewer",
      public_routes: opts.publicRoutes ?? [],
    },
    migration: { portable: true, verification: "standard" },
  });
  const installReq = {
    serverId: `home.${HOST}.flagship.services`,
    creator: HOST,
    slug: "game1",
    manifestJson,
    addOwnerToMembership: false,
    issuedAt: Date.now(),
  };
  const r = await platform.install({
    request: installReq,
    signature: signInstallService(installReq, hostIrk),
    verify: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  return { app: r.app, platform, hostIrk };
}

function fakeReq(path: string, headers: Record<string, string> = {}) {
  return {
    method: "GET",
    path,
    headers,
    body: Buffer.alloc(0),
  };
}

describe("decideAccess — public_routes vs membership", () => {
  it("anonymous request to a non-public route → deny", async () => {
    const { app } = await makeApp({ publicRoutes: [] });
    expect(decideAccess(app, fakeReq("/private"), null)).toBe("deny");
  });

  it("anonymous request to a path explicitly listed in public_routes → allow", async () => {
    const { app } = await makeApp({ publicRoutes: ["/", "/about"] });
    expect(decideAccess(app, fakeReq("/"), null)).toBe("allow");
    expect(decideAccess(app, fakeReq("/about"), null)).toBe("allow");
    expect(decideAccess(app, fakeReq("/aboutMe"), null)).toBe("deny"); // exact match only
  });

  it("a member session reaches non-public routes", async () => {
    const { app, hostIrk } = await makeApp({ publicRoutes: [] });
    const session: SessionInfo = {
      memberPub: hostIrk.publicKey,
      stableId: app.membership.stableIdFor(hostIrk.publicKey),
      role: "owner",
    };
    expect(decideAccess(app, fakeReq("/private"), session)).toBe("allow");
    // Who counts as a member is the resolver's call (appMemberSession.test.ts).
    expect(decideAccess(app, fakeReq("/private"), null)).toBe("deny");
  });
});

describe("decideAccess — open vs members-only (owner decision 2026-10-14)", () => {
  const req = (method: string, path: string) => ({ ...fakeReq(path), method });

  it("open: an anonymous visitor reaches every path and method; public_routes don't matter", async () => {
    const { app } = await makeApp({ publicRoutes: ["/pub"] });
    for (const m of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const p of ["/", "/pub", "/private", "/admin/x?y=1", "/pub/../admin"]) {
        expect(decideAccess(app, req(m, p), null, null, "open"), `${m} ${p}`).toBe("allow");
      }
    }
  });

  it("members-only: an anonymous visitor reaches only the declared public routes, any method", async () => {
    const { app } = await makeApp({ publicRoutes: ["/", "/hooks/*"] });
    for (const m of ["GET", "POST", "DELETE"]) {
      expect(decideAccess(app, req(m, "/"), null, null, "members-only")).toBe("allow");
      expect(decideAccess(app, req(m, "/hooks/stripe"), null, null, "members-only")).toBe("allow");
      expect(decideAccess(app, req(m, "/admin"), null, null, "members-only")).toBe("deny");
      expect(decideAccess(app, req(m, "/hooks/../admin"), null, null, "members-only")).toBe("deny");
      expect(decideAccess(app, req(m, "/hooks/%2e%2e/admin"), null, null, "members-only")).toBe("deny");
    }
  });

  it("an unknown mode is members-only", async () => {
    const { app } = await makeApp({ publicRoutes: ["/pub"] });
    expect(decideAccess(app, fakeReq("/private"), null, null, null)).toBe("deny");
    expect(decideAccess(app, fakeReq("/private"), null)).toBe("deny");
    expect(decideAccess(app, fakeReq("/pub"), null, null, null)).toBe("allow");
  });

  it("members and API keys reach every path in both modes", async () => {
    const { app, hostIrk } = await makeApp({ publicRoutes: [] });
    const session: SessionInfo = { memberPub: hostIrk.publicKey, stableId: "m", role: "member" };
    for (const mode of ["open", "members-only", null] as const) {
      expect(decideAccess(app, fakeReq("/private"), session, null, mode)).toBe("allow");
      expect(decideAccess(app, fakeReq("/private"), null, { keyId: "00000000000000aa" }, mode)).toBe("allow");
    }
  });

  it("handleAppRequest: open forwards anonymous anywhere with the marker; no accessMode is members-only", async () => {
    const { app } = await makeApp({ publicRoutes: [] });
    let seen: Record<string, string> | null = null;
    const deps = {
      injector: boxSigner(makeKey()),
      forward: async (_h: string, _p: number, r: { headers: Record<string, string> }) => {
        seen = r.headers;
        return { status: 200, body: "ok" };
      },
    };
    const forged = { "x-flagship-user": "owner-id", "x-flagship-role": "owner", "X-Flagship-Visitor": "member", x_flagship_user: "x" };
    const r = await handleAppRequest(app, { ...req("DELETE", "/admin"), headers: forged }, { ...deps, accessMode: () => "open" });
    expect(r.status).toBe(200);
    expect(seen!["x-flagship-visitor"]).toBe("anonymous");
    expect(seen!["x-flagship-user"]).toBeUndefined();
    expect(seen!["x-flagship-role"]).toBeUndefined();
    expect(seen!["X-Flagship-Visitor"]).toBeUndefined();
    expect(seen!["x_flagship_user"]).toBeUndefined();
    seen = null;
    expect((await handleAppRequest(app, req("GET", "/admin"), { ...deps, accessMode: () => null })).status).toBe(403);
    expect((await handleAppRequest(app, req("GET", "/admin"), deps)).status).toBe(403);
    expect((await handleAppRequest(app, req("GET", "/admin"), { ...deps, accessMode: () => "members-only" })).status).toBe(403);
    expect(seen).toBeNull();
  });
});

describe("stripIdentityHeaders", () => {
  it("removes any header whose name starts with x-flagship-", () => {
    const out = stripIdentityHeaders({
      "x-flagship-user": "trying-to-impersonate",
      "X-Flagship-Role": "owner",
      "x-flagship-anything": "weird",
      "user-agent": "ok",
      "content-type": "application/json",
    });
    expect(Object.keys(out).sort()).toEqual(["content-type", "user-agent"]);
    expect(out["user-agent"]).toBe("ok");
  });
});

describe("handleAppRequest — full flow", () => {
  it("denied → returns the 'request access' page (HTML 403); container is never called", async () => {
    const { app } = await makeApp({ publicRoutes: [] });
    let forwardCalled = false;
    const r = await handleAppRequest(app, fakeReq("/secret"), {
      injector: boxSigner(makeKey()),
      forward: async () => {
        forwardCalled = true;
        return { status: 200, body: "leaked" };
      },
    });
    expect(r.status).toBe(403);
    expect(String(r.body)).toContain("is private");
    expect(forwardCalled).toBe(false);
  });

  it("allowed → strips x-flagship-* from inbound, injects signed identity, forwards to container", async () => {
    const { app } = await makeApp({ publicRoutes: ["/"] });
    let captured: { headers: Record<string, string>; path: string } | null = null;
    const r = await handleAppRequest(
      app,
      fakeReq("/", {
        "x-flagship-user": "evil-injection",
        "x-flagship-role": "owner",
        "X-Flagship-Visitor": "member",
        x_flagship_role: "owner",
        cookie: "session=abc",
      }),
      {
        injector: boxSigner(makeKey()),
        forward: async (host, port, req) => {
          captured = { headers: req.headers, path: req.path };
          expect(host).toBe("127.0.0.1");
          expect(port).toBe(app.containerPort);
          return { status: 200, headers: { "content-type": "text/plain" }, body: "ok" };
        },
        now: () => 12345,
      },
    );
    expect(r.status).toBe(200);
    expect(captured).not.toBeNull();
    // Client-supplied X-Flagship-* (any case, or with underscores) are
    // stripped; an anonymous visitor gets the marker and no id or rank.
    expect(captured!.headers["x-flagship-visitor"]).toBe("anonymous");
    expect(captured!.headers["x-flagship-user"]).toBeUndefined();
    expect(captured!.headers["x-flagship-role"]).toBeUndefined();
    expect(captured!.headers["X-Flagship-Visitor"]).toBeUndefined();
    expect(captured!.headers["x_flagship_role"]).toBeUndefined();
    expect(captured!.headers["x-flagship-app-id"]).toBe(app.serviceId);
    expect(captured!.headers["x-flagship-timestamp"]).toBe("12345");
    expect(captured!.headers["x-flagship-signature"]).toMatch(/^[0-9a-f]{128}$/);
    // Cookies + other headers pass through
    expect(captured!.headers["cookie"]).toBe("session=abc");
  });

  it("/.flagship/runtime-pubkey is served by the proxy itself (apps can verify the signature)", async () => {
    const { app } = await makeApp({ publicRoutes: ["/.flagship/runtime-pubkey"] });
    const key = makeKey();
    const r = await handleAppRequest(app, fakeReq("/.flagship/runtime-pubkey"), {
      injector: boxSigner(key),
      forward: async () => {
        throw new Error("forward should not be called");
      },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(String(r.body));
    expect(body.injectorPubKeyHex).toMatch(/^[0-9a-f]{64}$/);
    // Matches our key
    let expected = "";
    for (const x of key.publicKey) expected += x.toString(16).padStart(2, "0");
    expect(body.injectorPubKeyHex).toBe(expected);
  });

  it("signature is verifiable by the app using the injector pubkey", async () => {
    const { app } = await makeApp({ publicRoutes: ["/"] });
    const injector = makeKey();
    let captured: Record<string, string> = {};
    await handleAppRequest(app, fakeReq("/"), {
      injector: boxSigner(injector),
      forward: async (_h, _p, req) => {
        captured = req.headers;
        return { status: 200, body: "" };
      },
      now: () => 999,
    });
    const canonical = `flagship/inject/v1|${app.serviceId}|anonymous|anonymous|999`;
    const sigHex = captured["x-flagship-signature"];
    expect(sigHex).toBeDefined();
    const sig = new Uint8Array(sigHex.length / 2);
    for (let i = 0; i < sig.length; i++) sig[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
    expect(ed.verify(sig, new TextEncoder().encode(canonical), injector.publicKey)).toBe(true);
  });

  it("/.flagship/update is delegated to the UpdateServer when configured (container is never reached)", async () => {
    const { app } = await makeApp({ publicRoutes: ["/.flagship/update"] });
    const injector = makeKey();
    let updateServerCalled = false;
    let containerForwarded = false;
    const fakeUpdateServer = {
      handle: async () => {
        updateServerCalled = true;
        return {
          status: 200,
          headers: { "content-type": "application/x-git-bundle" },
          body: Buffer.from("BUNDLE"),
        };
      },
    } as Pick<import("../src/updateServer.js").UpdateServer, "handle">;
    const r = await handleAppRequest(app, fakeReq("/.flagship/update"), {
      injector: boxSigner(injector),
      forward: async () => {
        containerForwarded = true;
        return { status: 500, body: "should not happen" };
      },
      updateServer: fakeUpdateServer as import("../src/updateServer.js").UpdateServer,
    });
    expect(updateServerCalled).toBe(true);
    expect(containerForwarded).toBe(false);
    expect(r.status).toBe(200);
    expect(r.headers?.["content-type"]).toBe("application/x-git-bundle");
  });

  it("/.flagship/update falls through to the container when no UpdateServer is configured", async () => {
    const { app } = await makeApp({ publicRoutes: ["/.flagship/update"] });
    const injector = makeKey();
    let containerForwarded = false;
    const r = await handleAppRequest(app, fakeReq("/.flagship/update"), {
      injector: boxSigner(injector),
      forward: async () => {
        containerForwarded = true;
        return { status: 200, body: "container said hi" };
      },
      // updateServer omitted
    });
    expect(containerForwarded).toBe(true);
    expect(String(r.body)).toBe("container said hi");
  });
});

describe("defaultForward — hop-by-hop header stripping", () => {
  it("drops the container's content-length (the runtime writes its own; a duplicate makes fetch clients reject every proxied response)", async () => {
    const { createServer } = await import("node:http");
    const { defaultForward } = await import("../src/serviceProxy.js");
    const srv = createServer((_req, res) => {
      res.setHeader("Content-Length", "2");
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Connection", "close");
      res.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await defaultForward("127.0.0.1", port, {
        method: "GET",
        path: "/",
        headers: {},
        body: Buffer.alloc(0),
      });
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe("ok");
      expect(res.headers["content-length"]).toBeUndefined();
      expect(res.headers["transfer-encoding"]).toBeUndefined();
      expect(res.headers["connection"]).toBeUndefined();
      expect(res.headers["content-type"]).toContain("text/plain");
    } finally {
      srv.close();
    }
  });
});

describe("public routes — exact paths and /* prefixes (docs/app-apis.md §2)", () => {
  it("matches exact paths, ignoring the query", async () => {
    const { matchesPublicRoute } = await import("../src/serviceProxy.js");
    expect(matchesPublicRoute("/about", ["/about"])).toBe(true);
    expect(matchesPublicRoute("/about?x=1", ["/about"])).toBe(true);
    expect(matchesPublicRoute("/about#top", ["/about"])).toBe(true);
    expect(matchesPublicRoute("/aboutMe", ["/about"])).toBe(false);
    expect(matchesPublicRoute("/About", ["/about"])).toBe(false);
  });

  it("treats a trailing slash and doubled slashes the same on both sides", async () => {
    const { matchesPublicRoute } = await import("../src/serviceProxy.js");
    expect(matchesPublicRoute("/about/", ["/about"])).toBe(true);
    expect(matchesPublicRoute("/about", ["/about/"])).toBe(true);
    expect(matchesPublicRoute("//about", ["/about"])).toBe(true);
    expect(matchesPublicRoute("/hooks//stripe", ["/hooks/stripe"])).toBe(true);
    expect(matchesPublicRoute("/", ["/"])).toBe(true);
    expect(matchesPublicRoute("//", ["/"])).toBe(true);
    expect(matchesPublicRoute("/x", ["/"])).toBe(false);
  });

  it("decodes percent-encoding once before comparing", async () => {
    const { matchesPublicRoute } = await import("../src/serviceProxy.js");
    expect(matchesPublicRoute("/%77ebhook", ["/webhook"])).toBe(true);
    expect(matchesPublicRoute("/caf%C3%A9", ["/café"])).toBe(true);
    // A double-encoded path is refused: the app might decode it again.
    expect(matchesPublicRoute("/%2577ebhook", ["/webhook"])).toBe(false);
    expect(matchesPublicRoute("/webhook%2fx", ["/webhook/*"])).toBe(false);
  });

  it("a /* prefix is segment-aware", async () => {
    const { matchesPublicRoute } = await import("../src/serviceProxy.js");
    const routes = ["/api/public/*"];
    expect(matchesPublicRoute("/api/public/", routes)).toBe(true);
    expect(matchesPublicRoute("/api/public/x/y?z=1", routes)).toBe(true);
    expect(matchesPublicRoute("/api/public", routes)).toBe(true);
    expect(matchesPublicRoute("/api//public/x", routes)).toBe(true);
    expect(matchesPublicRoute("/api/publicity", routes)).toBe(false);
    expect(matchesPublicRoute("/api/private/x", routes)).toBe(false);
  });

  it("never matches a path that could resolve outside a route (exact, prefix or /*)", async () => {
    const { matchesPublicRoute } = await import("../src/serviceProxy.js");
    const routes = ["/api/public/*", "/webhook", "/*"];
    for (const p of [
      "/webhook/../admin",
      "/%2e%2e/admin",
      "/%2E%2E/webhook",
      "/./webhook",
      "/%2e/webhook",
      "/admin/../webhook",
      "/webhook/..",
      "/webhook/..%3B/admin",
      "/webhook/%2e%2e%2fadmin",
      "/webhook%00",
      "/webhook%0a",
      "/webhook\\",
      "/webhook%5c..%5cadmin",
      "/%252e%252e/admin",
      "webhook",
      "",
      "/api/public/../admin",
      "/api/public/%2e%2e/admin",
      "/api/public/%2E%2E/admin",
      "/api/public/..;/admin",
      "/api/public/.",
      "/api/public/x%2f..%2fadmin",
      "/api/public/x\\..\\admin",
      "/api/public/%zz",
    ]) {
      expect(matchesPublicRoute(p, routes), p).toBe(false);
    }
  });

  it("ignores a declared route that doesn't normalise", async () => {
    const { matchesPublicRoute } = await import("../src/serviceProxy.js");
    expect(matchesPublicRoute("/admin", ["/pub/../admin"])).toBe(false);
    expect(matchesPublicRoute("/admin/x", ["/pub/../admin/*"])).toBe(false);
  });

  it("/* makes the whole app public", async () => {
    const { matchesPublicRoute } = await import("../src/serviceProxy.js");
    expect(matchesPublicRoute("/", ["/*"])).toBe(true);
    expect(matchesPublicRoute("/deep/x?y", ["/*"])).toBe(true);
  });

  it("decideAccess uses prefixes and admits a checked API key anywhere", async () => {
    const { app } = await makeApp({ publicRoutes: ["/api/public/*"] });
    expect(decideAccess(app, fakeReq("/api/public/feed"), null)).toBe("allow");
    expect(decideAccess(app, fakeReq("/api/publicity"), null)).toBe("deny");
    expect(decideAccess(app, fakeReq("/admin"), null, { keyId: "00000000000000aa" })).toBe("allow");
    expect(decideAccess(app, fakeReq("/admin"), null, { keyId: "00000000000000aa" }, "members-only")).toBe("allow");
  });
});

describe("sibling-app guard (docs/app-apis.md §4)", () => {
  const HOSTNAME = "game1.home.alice.flagship.services";
  const req = (method: string, headers: Record<string, string>) => ({
    method,
    path: "/x",
    headers: { host: HOSTNAME, ...headers },
    body: Buffer.alloc(0),
  });

  it("only unsafe methods and upgrades from another origin are anonymous", async () => {
    const { isCrossOriginUnsafe } = await import("../src/serviceProxy.js");
    const other = "https://notes.home.alice.flagship.services";
    expect(isCrossOriginUnsafe(req("GET", { origin: other }), false)).toBe(false);
    expect(isCrossOriginUnsafe(req("POST", { origin: other }), false)).toBe(true);
    expect(isCrossOriginUnsafe(req("DELETE", { origin: "null" }), false)).toBe(true);
    expect(isCrossOriginUnsafe(req("GET", { origin: other }), true)).toBe(true);
    expect(isCrossOriginUnsafe(req("POST", { origin: `https://${HOSTNAME}` }), false)).toBe(false);
    expect(isCrossOriginUnsafe(req("POST", { origin: `https://${HOSTNAME}:443` }), false)).toBe(false);
    expect(isCrossOriginUnsafe(req("POST", { origin: `http://${HOSTNAME}` }), false)).toBe(true);
  });

  it("falls back to Sec-Fetch-Site, then Referer; nothing at all counts as same-origin", async () => {
    const { isCrossOriginUnsafe } = await import("../src/serviceProxy.js");
    expect(isCrossOriginUnsafe(req("POST", { "sec-fetch-site": "same-site" }), false)).toBe(true);
    expect(isCrossOriginUnsafe(req("POST", { "sec-fetch-site": "cross-site" }), false)).toBe(true);
    expect(isCrossOriginUnsafe(req("POST", { "sec-fetch-site": "same-origin" }), false)).toBe(false);
    expect(isCrossOriginUnsafe(req("POST", { "sec-fetch-site": "none" }), false)).toBe(false);
    expect(isCrossOriginUnsafe(req("POST", { referer: "https://notes.home.alice.flagship.services/page" }), false)).toBe(true);
    expect(isCrossOriginUnsafe(req("POST", { referer: `https://${HOSTNAME}/page` }), false)).toBe(false);
    expect(isCrossOriginUnsafe(req("POST", {}), false)).toBe(false);
  });

  it("a cross-origin POST reaches the app, but without the member identity", async () => {
    const { app } = await makeApp({ publicRoutes: ["/x"] });
    const session: SessionInfo = { memberPub: new Uint8Array(32).fill(1), stableId: "member-1", role: "member" };
    let seen: Record<string, string> = {};
    const deps = {
      injector: boxSigner(makeKey()),
      resolveSession: () => session,
      forward: async (_h: string, _p: number, r: { headers: Record<string, string> }) => {
        seen = r.headers;
        return { status: 200, body: "" };
      },
    };
    const r = await handleAppRequest(app, req("POST", { origin: "https://notes.home.alice.flagship.services", cookie: "s=1" }), deps);
    expect(r.status).toBe(200);
    expect(seen["x-flagship-visitor"]).toBe("anonymous");
    expect(seen["x-flagship-user"]).toBeUndefined();
    expect(seen["x-flagship-role"]).toBeUndefined();
    expect(seen["cookie"]).toBe("s=1");
    await handleAppRequest(app, req("POST", { origin: `https://${HOSTNAME}` }), deps);
    expect(seen["x-flagship-visitor"]).toBe("member");
    expect(seen["x-flagship-user"]).toBe("member-1");
  });
});
