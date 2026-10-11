/**
 * Installed services survive a daemon restart. The registry used to live only
 * in memory, so an update, reboot or crash left the box no longer routing to
 * its apps and without the credentials to their databases. Now every change is
 * saved (sealed under the SWK) and a fresh platform brings each service back:
 * same address, port, data credentials, token and members.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed, signInstallService, signUninstallService, verifyInstallService, verifyUninstallService, type Keypair } from "@flagship/protocol";
import { swkOps } from "./helpers/keyCustody.js";
import { ServicePlatform } from "../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { DataProvisioner, InMemoryMinioAdmin, InMemoryPostgresAdmin, InMemoryRedisAdmin } from "../src/dataLayer/index.js";
import { InMemoryAppAuthTokens } from "../src/serviceAuthToken.js";
import { InMemoryInstalledServicesStore, SealedInstalledServicesStore } from "../src/installedServicesStore.js";

const HOST = "alice";
const FQDN = `home.${HOST}.flagship.services`;

function key(): Keypair {
  const p = new Uint8Array(32);
  crypto.getRandomValues(p);
  return { privateKey: p, publicKey: ed.getPublicKey(p) };
}

const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  runtime: { image: "flagship-vibe-alice--notes:1", port: 8080 },
  data: { stores: { postgres: true } },
  network: {},
  access: { enabled: true, default_role: "viewer" },
  migration: { verification: "standard" },
  browser: { domains: ["example.com"] },
});

function world(registry: InMemoryInstalledServicesStore | SealedInstalledServicesStore, swkBytes: Uint8Array, tokens = new InMemoryAppAuthTokens()) {
  const calls: string[] = [];
  let failing = 0;
  const cmd: CommandRunner = {
    run: async (c, args) => {
      if (args[0] === "run" && failing > 0) {
        failing--;
        throw new Error("Cannot connect to the Docker daemon");
      }
      calls.push(`${c} ${args.join(" ")}`);
    },
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  const irk = key();
  const grants: Record<string, string[]> = {};
  const platform = new ServicePlatform({
    host: { username: HOST, irkPub: irk.publicKey },
    swk: swkOps(swkBytes),
    appRunner: new AppRunner(cmd),
    dataProvisioner: new DataProvisioner({
      postgres: new InMemoryPostgresAdmin(),
      objects: new InMemoryMinioAdmin(),
      kv: new InMemoryRedisAdmin(),
    }),
    appAuthTokens: tokens,
    domainGate: { setGrant: (id: string, d: string[]) => { grants[id] = d; }, revoke: (id: string) => { delete grants[id]; } } as never,
    registry,
  });
  return { platform, calls, irk, grants, failNextRuns: (n: number) => { failing = n; } };
}

async function install(w: ReturnType<typeof world>) {
  const request = { serverId: FQDN, creator: HOST, slug: "notes", manifestJson: MANIFEST, addOwnerToMembership: true, issuedAt: Date.now() };
  const r = await w.platform.install({ request, signature: signInstallService(request, w.irk), verify: verifyInstallService });
  if (!r.ok) throw new Error(r.reason);
  w.platform.addHostAsOwner({ serviceId: "alice--notes", hostIrk: w.irk });
  await w.platform.flush();
}

describe("installed services across a daemon restart", () => {
  it("comes back with the same address, port, credentials, token, members and browser grant", async () => {
    const swk = crypto.getRandomValues(new Uint8Array(32));
    const registry = new InMemoryInstalledServicesStore();
    const tokens = new InMemoryAppAuthTokens();
    const before = world(registry, swk, tokens);
    await install(before);
    const was = before.platform.byServiceId("alice--notes")!;
    expect(registry.saved).toHaveLength(1);

    const after = world(registry, swk, tokens);
    expect(after.platform.byLabel("notes")).toBeUndefined();
    const r = await after.platform.restore({ retryDelayMs: 0 });
    expect(r).toEqual({ restored: ["alice--notes"], failed: [] });

    const now = after.platform.byLabel("notes")!;
    expect(now.serviceId).toBe("alice--notes");
    expect(now.containerPort).toBe(was.containerPort);
    expect(now.data).toEqual(was.data);
    expect(now.membership.members.list().map((m) => m.role)).toEqual(["owner"]);
    expect(after.grants["alice--notes"]).toEqual(["example.com"]);

    const run = after.calls.find((c) => c.startsWith("docker run "))!;
    expect(run).toContain(`127.0.0.1:${was.containerPort}:8080`);
    expect(run).toContain(`FLAGSHIP_APP_TOKEN=${await tokens.tokenForApp("alice--notes")}`);
    expect(run).toContain("flagship-vibe-alice--notes:1");
    expect(run).toContain("FLAGSHIP_PG_URL=");
  });

  it("keeps the service registered and retries while Docker isn't up yet", async () => {
    const swk = crypto.getRandomValues(new Uint8Array(32));
    const registry = new InMemoryInstalledServicesStore();
    await install(world(registry, swk));
    const after = world(registry, swk);
    after.failNextRuns(2);
    const r = await after.platform.restore({ retries: 3, retryDelayMs: 0 });
    expect(r.restored).toEqual(["alice--notes"]);
    expect(after.platform.byLabel("notes")).toBeDefined();
  });

  it("forgets an uninstalled service", async () => {
    const swk = crypto.getRandomValues(new Uint8Array(32));
    const registry = new InMemoryInstalledServicesStore();
    const w = world(registry, swk);
    await install(w);
    const request = { serverId: FQDN, creator: HOST, slug: "notes", issuedAt: Date.now() };
    const u = await w.platform.uninstall({ request, signature: signUninstallService(request, w.irk), verify: verifyUninstallService });
    expect(u.ok).toBe(true);
    await w.platform.flush();
    expect(registry.saved).toEqual([]);
  });

  it("saves an alias change", async () => {
    const swk = crypto.getRandomValues(new Uint8Array(32));
    const registry = new InMemoryInstalledServicesStore();
    const w = world(registry, swk);
    await install(w);
    expect(w.platform.setAlias("alice--notes", "jottings").ok).toBe(true);
    await w.platform.flush();
    const after = world(registry, swk);
    await after.platform.restore({ retryDelayMs: 0 });
    expect(after.platform.byLabel("jottings")?.serviceId).toBe("alice--notes");
  });
});

describe("SealedInstalledServicesStore", () => {
  it("keeps the database passwords sealed on disk and reads them back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "installed-"));
    try {
      const swk = crypto.getRandomValues(new Uint8Array(32));
      const store = new SealedInstalledServicesStore(join(dir, "s.sealed"), swkOps(swk));
      expect(await store.load()).toEqual([]);
      const w = world(store, swk);
      await install(w);
      const onDisk = await readFile(join(dir, "s.sealed"), "utf8");
      const pw = w.platform.byServiceId("alice--notes")!.data!.postgres!.default!.password;
      expect(onDisk).not.toContain(pw);
      expect(onDisk).not.toContain("notes");
      const back = await new SealedInstalledServicesStore(join(dir, "s.sealed"), swkOps(swk)).load();
      expect(back[0]!.data).toEqual(w.platform.byServiceId("alice--notes")!.data);

      const other = new SealedInstalledServicesStore(join(dir, "s.sealed"), swkOps(crypto.getRandomValues(new Uint8Array(32))));
      await expect(other.load()).rejects.toThrow();
      await writeFile(join(dir, "s.sealed"), "zz");
      const restored = await world(store, swk).platform.restore({ retryDelayMs: 0 });
      expect(restored).toEqual({ restored: [], failed: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
