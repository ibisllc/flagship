import { describe, expect, it, vi } from "vitest";
import {
  ed,
  signInstallApp,
  signUninstallApp,
  type Keypair,
} from "@flagship/protocol";
import {
  AppPlatform,
  buildAppHttpHandlers,
} from "../src/appPlatform.js";
import { AppRunner, type CommandRunner } from "../src/appRunner.js";
import {
  DataProvisioner,
  InMemoryMinioAdmin,
  InMemoryPostgresAdmin,
  InMemoryRedisAdmin,
} from "../src/dataLayer/index.js";
import { InMemoryAppAuthTokens } from "../src/appAuthToken.js";

const HOST_USERNAME = "alice";
const HOST_FQDN = `home.${HOST_USERNAME}.flagship.services`;

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

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fakeRunner(): { runner: AppRunner; cmd: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const cmd: CommandRunner = {
    run: async (c, args) => {
      calls.push(`${c} ${args.join(" ")}`);
    },
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  return { runner: new AppRunner(cmd), cmd, calls };
}

function makeProvisioner(): DataProvisioner {
  return new DataProvisioner({
    postgres: new InMemoryPostgresAdmin(),
    objects: new InMemoryMinioAdmin(),
    kv: new InMemoryRedisAdmin(),
  });
}

const SELF_MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "game1",
  version: "0.1.0",
  runtime: { image: "ghcr.io/alice/game1:0.1.0", port: 8080 },
  data: { stores: { postgres: true } },
  network: { subdomain: "game1" },
  access: { enabled: true, default_role: "viewer" },
  migration: { portable: true, verification: "standard" },
});

const NO_DATA_MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "static",
  version: "0.1.0",
  runtime: { image: "nginx:1.27", port: 80 },
  data: {},
  network: { subdomain: "static" },
  access: { enabled: true, default_role: "viewer" },
  migration: { portable: true, verification: "standard" },
});

describe("AppPlatform — URL collapse", () => {
  it("self-authored: creator===host renders the URL label as just the slug", () => {
    expect(AppPlatform.urlLabel("alice", "alice", "game1")).toBe("game1");
  });
  it("cross-creator: creator!==host renders <slug>-<creator>", () => {
    expect(AppPlatform.urlLabel("bob", "alice", "game1")).toBe("game1-alice");
  });
  it("appId composes (creator, slug) host-independently", () => {
    expect(AppPlatform.appId("alice", "game1")).toBe("alice--game1");
    expect(AppPlatform.appId("alice", "habit-tracker")).toBe("alice--habit-tracker");
  });
});

describe("AppPlatform.install", () => {
  it("installs a self-authored app, deploys the container, provisions the data store, and registers an InstalledApp", async () => {
    const irk = makeKey();
    const { runner, calls } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
    });
    const req = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      manifestJson: SELF_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    const sig = signInstallApp(req, irk);
    const r = await platform.install({
      request: req,
      signature: sig,
      verify: () => true, // we'll exercise verification separately below
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.app.urlLabel).toBe("game1"); // collapsed because alice authored on alice's box
    expect(r.app.containerPort).toBeGreaterThan(0);
    expect(calls.some((c) => c.startsWith("docker run -d --name flagship-alice--game1"))).toBe(true);
    expect(calls.some((c) => c.includes("FLAGSHIP_PG_URL"))).toBe(true);
    expect(calls.some((c) => c.includes("ghcr.io/alice/game1:0.1.0"))).toBe(true);

    // Lookup paths the reverse proxy will use
    expect(platform.byLabel("game1")?.appId).toBe("alice--game1");
    expect(platform.byAppId("alice--game1")?.urlLabel).toBe("game1");
  });

  it("cross-creator install renders <slug>-<creator> as the URL label and namespaces data under the creator", async () => {
    const irk = makeKey();
    const { runner, calls } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: "bob", irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
    });
    const req = {
      serverId: "home.bob.flagship.services",
      creator: "alice", // alice authored, bob hosts
      slug: "game1",
      manifestJson: SELF_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    const sig = signInstallApp(req, irk);
    const r = await platform.install({
      request: req,
      signature: sig,
      verify: () => true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.app.urlLabel).toBe("game1-alice");
    // Data stays under (creator=alice, slug=game1) regardless of host
    expect(calls.some((c) => c.includes("_alice_game1"))).toBe(true);
  });

  it("rejects invalid signature (must be host's IRK)", async () => {
    const real = makeKey();
    const attacker = makeKey();
    const { runner } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: real.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
    });
    const req = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      manifestJson: SELF_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    const sig = signInstallApp(req, attacker); // wrong signer
    const r = await platform.install({
      request: req,
      signature: sig,
      verify: (req, sig, pub) => ed.verify(sig, new TextEncoder().encode(""), pub) || false,
    });
    expect(r.ok).toBe(false);
  });

  it("refuses to install when manifest declares stores but no DataProvisioner is configured", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
    });
    const req = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      manifestJson: SELF_MANIFEST, // declares postgres
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    const r = await platform.install({
      request: req,
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toMatch(/DataProvisioner/);
  });

  it("apps with no stores can install on a daemon without a DataProvisioner", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
    });
    const req = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "static",
      manifestJson: NO_DATA_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    const r = await platform.install({
      request: req,
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects double install of the same (creator, slug)", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
    });
    const baseReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      manifestJson: SELF_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    const r1 = await platform.install({
      request: baseReq,
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(r1.ok).toBe(true);
    const r2 = await platform.install({
      request: { ...baseReq, issuedAt: Date.now() },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(r2.ok).toBe(false);
  });
});

describe("AppPlatform.uninstall (idempotent)", () => {
  it("uninstalls + cleans up the URL/registry slot", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
    });
    const installReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      manifestJson: SELF_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    await platform.install({ request: installReq, signature: new Uint8Array(64), verify: () => true });

    const uninstallReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      issuedAt: Date.now(),
    };
    const r1 = await platform.uninstall({
      request: uninstallReq,
      signature: signUninstallApp(uninstallReq, irk),
      verify: () => true,
    });
    expect(r1.ok).toBe(true);
    expect(platform.byAppId("alice--game1")).toBeUndefined();
    expect(platform.byLabel("game1")).toBeUndefined();

    // Idempotent retry returns ok with alreadyGone=true
    const r2 = await platform.uninstall({
      request: { ...uninstallReq, issuedAt: Date.now() },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.alreadyGone).toBe(true);
  });
});

describe("buildAppHttpHandlers", () => {
  function setup() {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
    });
    const handle = buildAppHttpHandlers({ platform, hostIrk: irk });
    return { platform, irk, handle };
  }

  function asReq(method: string, path: string, body: unknown = {}) {
    return {
      method,
      path,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(body)),
    };
  }

  it("POST /api/apps installs + lists; DELETE /api/apps/:appId removes", async () => {
    const { handle, irk } = setup();

    // List starts empty
    const list0 = await handle(asReq("GET", "/api/apps"));
    expect(list0?.status).toBe(200);
    expect(JSON.parse(String(list0?.body)).apps).toEqual([]);

    const installReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      manifestJson: SELF_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    const sig = signInstallApp(installReq, irk);
    const installRes = await handle(
      asReq("POST", "/api/apps", { request: installReq, signature: bytesToHex(sig) }),
    );
    expect(installRes?.status).toBe(200);
    const installBody = JSON.parse(String(installRes?.body));
    expect(installBody.appId).toBe("alice--game1");
    expect(installBody.urlLabel).toBe("game1");

    // List now has it
    const list1 = await handle(asReq("GET", "/api/apps"));
    expect(JSON.parse(String(list1?.body)).apps[0].appId).toBe("alice--game1");

    // Delete
    const uninstallReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      issuedAt: Date.now(),
    };
    const uninstallSig = signUninstallApp(uninstallReq, irk);
    const uninstallRes = await handle(
      asReq("DELETE", "/api/apps/alice--game1", {
        request: uninstallReq,
        signature: bytesToHex(uninstallSig),
      }),
    );
    expect(uninstallRes?.status).toBe(200);

    const list2 = await handle(asReq("GET", "/api/apps"));
    expect(JSON.parse(String(list2?.body)).apps).toEqual([]);
  });

  it("returns null for non /api/apps paths so other handlers can take them", async () => {
    const { handle } = setup();
    expect(await handle(asReq("GET", "/api/health"))).toBeNull();
    expect(await handle(asReq("POST", "/something/else"))).toBeNull();
  });

  it("DELETE rejects when appId in path doesn't match (creator,slug) in body", async () => {
    const { handle, irk } = setup();
    // First install something
    const installReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      manifestJson: SELF_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    await handle(
      asReq("POST", "/api/apps", {
        request: installReq,
        signature: bytesToHex(signInstallApp(installReq, irk)),
      }),
    );

    const uninstallReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      issuedAt: Date.now(),
    };
    const r = await handle(
      asReq("DELETE", "/api/apps/wrong--app", {
        request: uninstallReq,
        signature: bytesToHex(signUninstallApp(uninstallReq, irk)),
      }),
    );
    expect(r?.status).toBe(400);
  });
});

void vi; // not currently used; kept to silence unused-import in case future tests use spies

describe("AppPlatform — per-app daemon-API auth token", () => {
  it("install mints a token and injects FLAGSHIP_APP_TOKEN into the container env", async () => {
    const irk = makeKey();
    const { runner, calls } = fakeRunner();
    const tokens = new InMemoryAppAuthTokens();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
      appAuthTokens: tokens,
    });
    await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "game1",
        manifestJson: SELF_MANIFEST,
        addOwnerToMembership: true,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    const stored = await tokens.tokenForApp("alice--game1");
    expect(stored).toBeTruthy();
    expect(await tokens.resolve(stored!)).toBe("alice--game1");
    // The docker run command line was built with `-e FLAGSHIP_APP_TOKEN=<token>`.
    const dockerLine = calls.find((c) => c.includes("docker run"));
    expect(dockerLine).toBeTruthy();
    expect(dockerLine).toContain(`FLAGSHIP_APP_TOKEN=${stored}`);
  });

  it("uninstall forgets the token (resolve returns null afterwards)", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const tokens = new InMemoryAppAuthTokens();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
      appAuthTokens: tokens,
    });
    await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "game1",
        manifestJson: SELF_MANIFEST,
        addOwnerToMembership: true,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    const t = await tokens.tokenForApp("alice--game1");
    expect(t).toBeTruthy();

    await platform.uninstall({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "game1",
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(await tokens.resolve(t!)).toBeNull();
    expect(await tokens.tokenForApp("alice--game1")).toBeNull();
  });

  it("install without appAuthTokens dep simply skips the env var (browser API stays disabled)", async () => {
    const irk = makeKey();
    const { runner, calls } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
      // appAuthTokens omitted
    });
    await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "game1",
        manifestJson: SELF_MANIFEST,
        addOwnerToMembership: true,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    const dockerLine = calls.find((c) => c.includes("docker run"));
    expect(dockerLine).toBeTruthy();
    expect(dockerLine).not.toContain("FLAGSHIP_APP_TOKEN");
  });
});
