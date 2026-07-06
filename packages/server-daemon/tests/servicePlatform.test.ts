import { describe, expect, it, vi } from "vitest";
import { swkOps } from "./helpers/keyCustody.js";
import type { SwkOps } from "../src/keyCustodian.js";
import {
  ed,
  signInstallService,
  verifyInstallService,
  signUninstallService,
  type Keypair,
} from "@flagship/protocol";
import {
  ServicePlatform,
  buildServiceHttpHandlers,
} from "../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import {
  DataProvisioner,
  InMemoryMinioAdmin,
  InMemoryPostgresAdmin,
  InMemoryRedisAdmin,
} from "../src/dataLayer/index.js";
import { InMemoryAppAuthTokens } from "../src/serviceAuthToken.js";
import { DomainGate } from "../src/browser/domainGate.js";

const HOST_USERNAME = "alice";
const HOST_FQDN = `home.${HOST_USERNAME}.flagship.services`;

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

describe("ServicePlatform — URL collapse", () => {
  it("self-authored: creator===host renders the URL label as just the slug", () => {
    expect(ServicePlatform.urlLabel("alice", "alice", "game1")).toBe("game1");
  });
  it("cross-creator: creator!==host renders <slug>--<creator>", () => {
    expect(ServicePlatform.urlLabel("bob", "alice", "game1")).toBe("game1--alice");
  });
  it("serviceId composes (creator, slug) host-independently — double dash", () => {
    expect(ServicePlatform.serviceId("alice", "game1")).toBe("alice--game1");
    // Slug with hyphens still composes; the FIRST dash is the
    // creator/slug boundary (usernames are hyphen-free).
    expect(ServicePlatform.serviceId("alice", "habit-tracker")).toBe("alice--habit-tracker");
  });

  it("parseServiceId is the exact inverse of serviceId, even for hyphenated slugs", () => {
    expect(ServicePlatform.parseServiceId("alice--game1")).toEqual({ creator: "alice", slug: "game1" });
    expect(ServicePlatform.parseServiceId("alice--habit-tracker")).toEqual({
      creator: "alice",
      slug: "habit-tracker",
    });
    // No hyphen → not a valid composite.
    expect(ServicePlatform.parseServiceId("nodash")).toBeNull();
    // Round-trip property over a hyphenated slug.
    const id = ServicePlatform.serviceId("bob", "multi-word-slug");
    expect(ServicePlatform.parseServiceId(id)).toEqual({ creator: "bob", slug: "multi-word-slug" });
  });
});

describe("ServicePlatform.install", () => {
  it("installs a self-authored app, deploys the container, provisions the data store, and registers an InstalledService", async () => {
    const irk = makeKey();
    const { runner, calls } = fakeRunner();
    const platform = new ServicePlatform({
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
    const sig = signInstallService(req, irk);
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
    expect(platform.byLabel("game1")?.serviceId).toBe("alice--game1");
    expect(platform.byServiceId("alice--game1")?.urlLabel).toBe("game1");
  });

  it("cross-creator install renders <slug>--<creator> as the URL label and namespaces data under the creator", async () => {
    const irk = makeKey();
    const { runner, calls } = fakeRunner();
    const platform = new ServicePlatform({
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
    const sig = signInstallService(req, irk);
    const r = await platform.install({
      request: req,
      signature: sig,
      verify: () => true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.app.urlLabel).toBe("game1--alice");
    // Data stays under (creator=alice, slug=game1) regardless of host
    expect(calls.some((c) => c.includes("_alice_game1"))).toBe(true);
  });

  it("rejects invalid signature (must be host's IRK)", async () => {
    const real = makeKey();
    const attacker = makeKey();
    const { runner } = fakeRunner();
    const platform = new ServicePlatform({
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
    const sig = signInstallService(req, attacker); // wrong signer
    const r = await platform.install({
      request: req,
      signature: sig,
      verify: (req, sig, pub) => ed.verify(sig, new TextEncoder().encode(""), pub) || false,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts the box's own daemon identity key as a host-authority signer (box-originated deploy)", async () => {
    // The owner IRK private half is phone-held, so a build-modes deploy on
    // the box signs with the DAEMON IDENTITY key. With `hostIdentityPub` set
    // to that key, the install is accepted; the owner IRK still verifies too.
    const ownerIrk = makeKey();
    const daemonIdentity = makeKey();
    const { runner } = fakeRunner();
    const platform = new ServicePlatform({
      host: { username: HOST_USERNAME, irkPub: ownerIrk.publicKey },
      hostIdentityPub: daemonIdentity.publicKey,
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
    });
    const baseReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "static",
      manifestJson: NO_DATA_MANIFEST,
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    // Signed with the DAEMON identity (what the box-originated deployer uses):
    const sigDaemon = signInstallService(baseReq, daemonIdentity);
    const rDaemon = await platform.install({ request: baseReq, signature: sigDaemon, verify: verifyInstallService });
    expect(rDaemon.ok).toBe(true);

    // Signed with the OWNER IRK (phone path) still works.
    const ownerReq = { ...baseReq, slug: "static2", manifestJson: NO_DATA_MANIFEST, issuedAt: Date.now() };
    const sigOwner = signInstallService(ownerReq, ownerIrk);
    const rOwner = await platform.install({ request: ownerReq, signature: sigOwner, verify: verifyInstallService });
    expect(rOwner.ok).toBe(true);

    // A FOREIGN key (neither owner IRK nor daemon identity) is still rejected.
    const attacker = makeKey();
    const badReq = { ...baseReq, slug: "static3", issuedAt: Date.now() };
    const sigBad = signInstallService(badReq, attacker);
    const rBad = await platform.install({ request: badReq, signature: sigBad, verify: verifyInstallService });
    expect(rBad.ok).toBe(false);
  });

  it("with NO hostIdentityPub, only the owner IRK is accepted (unchanged default)", async () => {
    const ownerIrk = makeKey();
    const daemonIdentity = makeKey();
    const { runner } = fakeRunner();
    const platform = new ServicePlatform({
      host: { username: HOST_USERNAME, irkPub: ownerIrk.publicKey },
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
    // Daemon identity is NOT accepted when hostIdentityPub is unset.
    const r = await platform.install({ request: req, signature: signInstallService(req, daemonIdentity), verify: verifyInstallService });
    expect(r.ok).toBe(false);
  });

  it("refuses to install when manifest declares stores but no DataProvisioner is configured", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new ServicePlatform({
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
    const platform = new ServicePlatform({
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
    const platform = new ServicePlatform({
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

describe("ServicePlatform.uninstall (idempotent)", () => {
  it("uninstalls + cleans up the URL/registry slot", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new ServicePlatform({
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
      signature: signUninstallService(uninstallReq, irk),
      verify: () => true,
    });
    expect(r1.ok).toBe(true);
    expect(platform.byServiceId("alice--game1")).toBeUndefined();
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

  it("fires onServiceRemoved(slug) on a real uninstall — the per-service route teardown", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const removed: string[] = [];
    const platform = new ServicePlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
      onServiceRemoved: async (slug) => {
        removed.push(slug);
      },
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

    const uninstallReq = { serverId: HOST_FQDN, creator: HOST_USERNAME, slug: "game1", issuedAt: Date.now() };
    await platform.uninstall({
      request: uninstallReq,
      signature: signUninstallService(uninstallReq, irk),
      verify: () => true,
    });
    expect(removed).toEqual(["game1"]);

    // The idempotent already-gone path does NOT re-fire the hook.
    await platform.uninstall({
      request: { ...uninstallReq, issuedAt: Date.now() },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(removed).toEqual(["game1"]);
  });

  it("a throwing onServiceRemoved never fails the uninstall (best-effort)", async () => {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new ServicePlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
      onServiceRemoved: async () => {
        throw new Error("gossip release exploded");
      },
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
    const uninstallReq = { serverId: HOST_FQDN, creator: HOST_USERNAME, slug: "game1", issuedAt: Date.now() };
    const r = await platform.uninstall({
      request: uninstallReq,
      signature: signUninstallService(uninstallReq, irk),
      verify: () => true,
    });
    expect(r.ok).toBe(true);
    expect(platform.byServiceId("alice--game1")).toBeUndefined();
  });
});

describe("buildServiceHttpHandlers", () => {
  function setup() {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const platform = new ServicePlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
    });
    const handle = buildServiceHttpHandlers({ platform, hostIrk: irk });
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

  it("POST /api/services installs + lists; DELETE /api/services/:serviceId removes", async () => {
    const { handle, irk } = setup();

    // List starts empty
    const list0 = await handle(asReq("GET", "/api/services"));
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
    const sig = signInstallService(installReq, irk);
    const installRes = await handle(
      asReq("POST", "/api/services", { request: installReq, signature: bytesToHex(sig) }),
    );
    expect(installRes?.status).toBe(200);
    const installBody = JSON.parse(String(installRes?.body));
    expect(installBody.serviceId).toBe("alice--game1");
    expect(installBody.urlLabel).toBe("game1");

    // List now has it
    const list1 = await handle(asReq("GET", "/api/services"));
    expect(JSON.parse(String(list1?.body)).apps[0].serviceId).toBe("alice--game1");

    // Delete
    const uninstallReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      issuedAt: Date.now(),
    };
    const uninstallSig = signUninstallService(uninstallReq, irk);
    const uninstallRes = await handle(
      asReq("DELETE", "/api/services/alice--game1", {
        request: uninstallReq,
        signature: bytesToHex(uninstallSig),
      }),
    );
    expect(uninstallRes?.status).toBe(200);

    const list2 = await handle(asReq("GET", "/api/services"));
    expect(JSON.parse(String(list2?.body)).apps).toEqual([]);
  });

  it("returns null for non /api/services paths so other handlers can take them", async () => {
    const { handle } = setup();
    expect(await handle(asReq("GET", "/api/health"))).toBeNull();
    expect(await handle(asReq("POST", "/something/else"))).toBeNull();
  });

  it("DELETE rejects when serviceId in path doesn't match (creator,slug) in body", async () => {
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
      asReq("POST", "/api/services", {
        request: installReq,
        signature: bytesToHex(signInstallService(installReq, irk)),
      }),
    );

    const uninstallReq = {
      serverId: HOST_FQDN,
      creator: HOST_USERNAME,
      slug: "game1",
      issuedAt: Date.now(),
    };
    const r = await handle(
      asReq("DELETE", "/api/services/wrong-app", {
        request: uninstallReq,
        signature: bytesToHex(signUninstallService(uninstallReq, irk)),
      }),
    );
    expect(r?.status).toBe(400);
  });
});

void vi; // not currently used; kept to silence unused-import in case future tests use spies

describe("ServicePlatform — per-app daemon-API auth token", () => {
  it("install mints a token and injects FLAGSHIP_APP_TOKEN into the container env", async () => {
    const irk = makeKey();
    const { runner, calls } = fakeRunner();
    const tokens = new InMemoryAppAuthTokens();
    const platform = new ServicePlatform({
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
    const platform = new ServicePlatform({
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
    const platform = new ServicePlatform({
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

describe("ServicePlatform — browser-feature integration", () => {
  const SHOPPER_MANIFEST = JSON.stringify({
    schema_version: 1,
    name: "shopper",
    version: "0.1.0",
    runtime: { image: "ghcr.io/alice/shopper:0.1.0", port: 8080 },
    data: {},
    network: { subdomain: "shopper" },
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
    browser: { domains: ["amazon.com", "*.amazon.com"], login_required: true },
  });

  function setup(options?: { withDomainGate?: boolean; withTabRegistry?: boolean }) {
    const irk = makeKey();
    const { runner } = fakeRunner();
    const gate = options?.withDomainGate !== false ? new DomainGate() : null;
    const closedTabs: { serviceId: string; count: number }[] = [];
    const fakeRegistry =
      options?.withTabRegistry !== false
        ? ({
            closeAllForApp: async (serviceId: string) => {
              closedTabs.push({ serviceId, count: 1 });
              return { closed: 1 };
            },
          } as unknown as Parameters<typeof ServicePlatform>[0]["tabRegistry"])
        : null;
    const platform = new ServicePlatform({
      host: { username: HOST_USERNAME, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: makeProvisioner(),
      domainGate: gate ?? undefined,
      tabRegistry: fakeRegistry ?? undefined,
    });
    return { platform, irk, gate, closedTabs };
  }

  it("install with browser.domains in the manifest registers the DomainGate grant", async () => {
    const { platform, gate } = setup();
    await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "shopper",
        manifestJson: SHOPPER_MANIFEST,
        addOwnerToMembership: true,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(gate?.hasGrant("alice--shopper")).toBe(true);
    expect(gate?.check("alice--shopper", "https://www.amazon.com/")).toBe("allow");
    expect(gate?.check("alice--shopper", "https://walmart.com/")).toBe("deny");
  });

  it("install of a manifest WITHOUT browser.domains does not touch the gate", async () => {
    const { platform, gate } = setup();
    const noBrowserManifest = JSON.stringify({
      ...JSON.parse(SHOPPER_MANIFEST),
      browser: undefined,
    });
    await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "shopper",
        manifestJson: noBrowserManifest,
        addOwnerToMembership: true,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(gate?.hasGrant("alice--shopper")).toBe(false);
  });

  it("uninstall closes app's tabs and revokes the grant", async () => {
    const { platform, gate, closedTabs } = setup();
    await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "shopper",
        manifestJson: SHOPPER_MANIFEST,
        addOwnerToMembership: true,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(gate?.hasGrant("alice--shopper")).toBe(true);

    await platform.uninstall({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "shopper",
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(gate?.hasGrant("alice--shopper")).toBe(false);
    expect(closedTabs).toEqual([{ serviceId: "alice--shopper", count: 1 }]);
  });

  it("install with no domainGate dep doesn't blow up on browser-declaring manifests", async () => {
    const { platform } = setup({ withDomainGate: false });
    const r = await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug: "shopper",
        manifestJson: SHOPPER_MANIFEST,
        addOwnerToMembership: true,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    expect(r.ok).toBe(true);
    // App is installed but has no daemon-side gate, so its browser API
    // calls would 403 at the apiHandler layer.
  });
});
