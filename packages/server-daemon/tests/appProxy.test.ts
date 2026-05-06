import { describe, expect, it } from "vitest";
import { ed, signInstallApp, type Keypair } from "@flagship/protocol";
import {
  decideAccess,
  handleAppRequest,
  stripIdentityHeaders,
  type SessionInfo,
} from "../src/appProxy.js";
import { AppPlatform, type InstalledApp } from "../src/appPlatform.js";
import { AppRunner, type CommandRunner } from "../src/appRunner.js";
import { DataProvisioner, InMemoryPostgresAdmin } from "../src/dataLayer/index.js";

const HOST = "alice";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function fakeSwk(): Uint8Array {
  const swk = new Uint8Array(32);
  crypto.getRandomValues(swk);
  return swk;
}

const NOOP_CMD: CommandRunner = {
  run: async () => undefined,
  capture: async () => ({ stdout: "", stderr: "" }),
};

async function makeApp(opts: {
  publicRoutes?: string[];
}): Promise<{ app: InstalledApp; platform: AppPlatform; hostIrk: Keypair }> {
  const hostIrk = makeKey();
  const platform = new AppPlatform({
    host: { username: HOST, irkPub: hostIrk.publicKey },
    swk: fakeSwk(),
    appRunner: new AppRunner(NOOP_CMD),
    dataProvisioner: new DataProvisioner({ postgres: new InMemoryPostgresAdmin() }),
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
    signature: signInstallApp(installReq, hostIrk),
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

  it("paired-session for a member → allow even on non-public routes", async () => {
    const { app, hostIrk } = await makeApp({ publicRoutes: [] });
    // Add a member directly through the membership store so we don't have
    // to drive the full invite flow in this test.
    app.membership.members.internalAdd(hostIrk.publicKey, "owner");
    const session: SessionInfo = {
      irkPub: hostIrk.publicKey,
      stableId: app.membership.stableIdFor(hostIrk.publicKey),
      role: "owner",
    };
    expect(decideAccess(app, fakeReq("/private"), session)).toBe("allow");
  });

  it("paired-session for a non-member → deny", async () => {
    const { app } = await makeApp({ publicRoutes: [] });
    const stranger = makeKey();
    const session: SessionInfo = {
      irkPub: stranger.publicKey,
      stableId: "stranger",
      role: "viewer",
    };
    expect(decideAccess(app, fakeReq("/private"), session)).toBe("deny");
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
      injectorKey: makeKey(),
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
        cookie: "session=abc",
      }),
      {
        injectorKey: makeKey(),
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
    // Client-supplied X-Flagship-* are stripped
    expect(captured!.headers["x-flagship-user"]).toBe("anonymous");
    expect(captured!.headers["x-flagship-role"]).toBe("anonymous");
    expect(captured!.headers["x-flagship-app-id"]).toBe(app.appId);
    expect(captured!.headers["x-flagship-timestamp"]).toBe("12345");
    expect(captured!.headers["x-flagship-signature"]).toMatch(/^[0-9a-f]{128}$/);
    // Cookies + other headers pass through
    expect(captured!.headers["cookie"]).toBe("session=abc");
  });

  it("/.flagship/runtime-pubkey is served by the proxy itself (apps can verify the signature)", async () => {
    const { app } = await makeApp({ publicRoutes: ["/.flagship/runtime-pubkey"] });
    const key = makeKey();
    const r = await handleAppRequest(app, fakeReq("/.flagship/runtime-pubkey"), {
      injectorKey: key,
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
      injectorKey: injector,
      forward: async (_h, _p, req) => {
        captured = req.headers;
        return { status: 200, body: "" };
      },
      now: () => 999,
    });
    const canonical = `flagship/inject/v1|${app.appId}|anonymous|anonymous|999`;
    const sigHex = captured["x-flagship-signature"];
    expect(sigHex).toBeDefined();
    const sig = new Uint8Array(sigHex.length / 2);
    for (let i = 0; i < sig.length; i++) sig[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
    expect(ed.verify(sig, new TextEncoder().encode(canonical), injector.publicKey)).toBe(true);
  });
});
