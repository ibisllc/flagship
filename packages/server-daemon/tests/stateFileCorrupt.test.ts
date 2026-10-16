/**
 * A security state file that is there but unreadable must load CLOSED, be set
 * aside as `<file>.corrupt-<ms>` and be reported, never load as the permissive
 * default (durableFile.ts keepCorruptAside).
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed, signAdminRootRotation, type Keypair } from "@flagship/protocol";
import { onCorruptState, type CorruptStateReport } from "../src/durableFile.js";
import { ServiceSessionStore, ServiceAccessStore } from "../src/serviceAccess.js";
import { AccessJournal } from "../src/accessJournal.js";
import { buildAccessSync } from "../src/accessSync.js";
import { DeadManController } from "../src/deadMan.js";
import {
  AdminRootPinLostError,
  claimAdminRootRotations,
  fileAdminRootPinStore,
  recoverLostAdminRootPin,
  resolvePinnedAdminRoot,
  type RotationChainEntry,
} from "../src/adminRootRotationConsumer.js";
import { fileUsedNonceStore } from "../src/updateConsumer.js";
import { ShareStore } from "../src/shares/shareStore.js";
import { ShareSessionStore } from "../src/shares/sharesHttp.js";
import { AppAccessStore } from "../src/egress/accessStore.js";
import { AppApiKeyStore } from "../src/appApiKeys.js";
import { SealedInstalledServicesStore } from "../src/installedServicesStore.js";
import { swkOps } from "./helpers/keyCustody.js";

let dir: string;
let reports: CorruptStateReport[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "state-corrupt-"));
  reports = [];
  onCorruptState((r) => reports.push(r));
});
afterEach(async () => {
  onCorruptState(null);
  await rm(dir, { recursive: true, force: true });
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function key(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

/** The file was set aside, and the owner told about that file. */
async function keptAsideAndReported(path: string): Promise<void> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const d = path.slice(0, path.lastIndexOf("/"));
  expect((await readdir(d)).some((f) => f.startsWith(`${name}.corrupt-`))).toBe(true);
  expect(reports.some((r) => r.path === path && r.keptAs !== null)).toBe(true);
}

describe("access state", () => {
  it("app sessions: an unreadable file loads with no session and is set aside", async () => {
    const path = join(dir, "service-sessions.json");
    const a = new ServiceSessionStore(path);
    const token = await a.issue("alice--club", "aa".repeat(32), Date.now(), 60_000);
    await writeFile(path, '{"torn": {"serviceRef": "alice--club", "aid"');
    const b = new ServiceSessionStore(path);
    await b.load();
    expect(b.lookup(token, Date.now())).toBeNull();
    await keptAsideAndReported(path);
  });

  it("app access: an unreadable file is reported to the owner (activity log)", async () => {
    const path = join(dir, "service-access.json");
    await writeFile(path, "[1, 2");
    const s = new ServiceAccessStore(path);
    await s.load();
    expect(s.mode("alice--club")).toBe("restricted");
    await keptAsideAndReported(path);
  });

  it("access journal: an unreadable journal holds every shared app until it has caught up", async () => {
    const accessPath = join(dir, "service-access.json");
    const journalPath = join(dir, "access-journal.json");
    const store = new ServiceAccessStore(accessPath);
    await store.load();
    await writeFile(journalPath, '{"alice--club": {"entries": {');
    const journal = new AccessJournal(journalPath);
    await journal.load();
    expect(journal.wasLost()).toBe(true);
    await keptAsideAndReported(journalPath);
    const sync = buildAccessSync({
      selfFqdn: "home.alice.flagship.services",
      journal,
      store,
      apply: async () => true,
      peers: () => ({ leaderFor: () => null, runners: () => [] }),
      key: new Uint8Array(32).fill(1),
      installed: () => true,
      apps: () => ["alice--club"],
    });
    sync.start();
    try {
      expect(store.isCatchingUp("alice--club")).toBe(true);
    } finally {
      sync.stop();
    }
  });
});

describe("dead-man switch", () => {
  it("an unreadable state file arms the switch as missed, restarts after the grace, and stays armed", async () => {
    const statePath = join(dir, "deadman.json");
    await writeFile(statePath, '{"policy": {"enabled": true, "windowMs": 36');
    let now = 1_000_000;
    const events: string[] = [];
    const mk = () =>
      new DeadManController({
        serverId: "home.alice.flagship.services",
        irkPub: key(50).publicKey,
        suppressor: { suppress: async () => void events.push("suppress") },
        runner: { power: async (m) => void events.push(`power:${m}`) },
        statePath,
        now: () => now,
        setIntervalImpl: () => 0,
        clearIntervalImpl: () => {},
      });
    const a = mk();
    await a.start();
    expect(a.policy()).toMatchObject({ enabled: true, lockoutMode: "restart" });
    await keptAsideAndReported(statePath);
    await a.checkOnce();
    expect(events).toEqual([]);
    now += a.policy().graceMs + 1;
    await a.checkOnce();
    expect(events).toEqual(["suppress", "power:restart"]);
    const b = mk();
    await b.start();
    expect(b.policy().enabled).toBe(true);
  });
});

describe("admin-root pin", () => {
  const USER = "alice";
  const seed = key(0x10);
  const rotated = key(0x20);
  const chain: RotationChainEntry[] = [
    {
      seq: 1,
      oldAdminRootPub: hex(seed.publicKey),
      newAdminRootPub: hex(rotated.publicKey),
      issuedAt: 5,
      signatureHex: hex(
        signAdminRootRotation({ username: USER, oldAdminRootPub: seed.publicKey, newAdminRootPub: rotated.publicKey, issuedAt: 5 }, seed),
      ),
    },
  ];
  const served = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("an unreadable pin never falls back to the seed, even after a restart", async () => {
    const pinPath = join(dir, "admin-root-pin.json");
    await writeFile(pinPath, '{"adminRootPubHex": "' + hex(rotated.publicKey).slice(0, 20));
    await expect(resolvePinnedAdminRoot(hex(seed.publicKey), fileAdminRootPinStore(pinPath))).rejects.toBeInstanceOf(
      AdminRootPinLostError,
    );
    await keptAsideAndReported(pinPath);
    // The next boot still refuses: the lost marker is on disk, not a missing file.
    await expect(resolvePinnedAdminRoot(hex(seed.publicKey), fileAdminRootPinStore(pinPath))).rejects.toBeInstanceOf(
      AdminRootPinLostError,
    );
  });

  it("a lost pin is rebuilt by replaying the chain from the seed, and only then", async () => {
    const pinPath = join(dir, "admin-root-pin.json");
    await writeFile(pinPath, "garbage");
    const store = fileAdminRootPinStore(pinPath);
    await expect(store.read()).rejects.toBeInstanceOf(AdminRootPinLostError);
    const args = { seedAdminRootHex: hex(seed.publicKey), username: USER, controlPlaneBaseUrl: "https://flagshipserver.com", pinStore: store };
    expect(await recoverLostAdminRootPin({ ...args, fetchImpl: served({}, 503) })).toBeNull();
    await expect(store.read()).rejects.toBeInstanceOf(AdminRootPinLostError);
    expect(await recoverLostAdminRootPin({ ...args, fetchImpl: served({ rotations: chain }) })).toBe(hex(rotated.publicKey));
    expect(await resolvePinnedAdminRoot(hex(seed.publicKey), store)).toBe(hex(rotated.publicKey));
  });

  it("the poller rebuilds a pin lost while running and restarts", async () => {
    const pinPath = join(dir, "admin-root-pin.json");
    await writeFile(pinPath, "{}");
    let restarted = 0;
    const out = await claimAdminRootRotations({
      username: USER,
      seedAdminRootHex: hex(rotated.publicKey),
      recoverySeedHex: hex(seed.publicKey),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      pinStore: fileAdminRootPinStore(pinPath),
      restart: () => void restarted++,
      fetchImpl: served({ rotations: chain }),
    });
    expect(out.rotated).toBe(true);
    expect(restarted).toBe(1);
    expect(JSON.parse(await readFile(pinPath, "utf8")).adminRootPubHex).toBe(hex(rotated.publicKey));
  });
});

describe("update order nonces", () => {
  it("an unreadable list refuses every order issued before it was found, and keeps doing so", async () => {
    const path = join(dir, "update-used-nonces.json");
    await writeFile(path, '{"nonces": ["ab');
    let now = 10_000;
    const s = fileUsedNonceStore(path, () => now);
    expect(await s.has("cd", 9_000)).toBe(true);
    await keptAsideAndReported(path);
    now = 20_000;
    const again = fileUsedNonceStore(path, () => now);
    expect(await again.has("cd", 9_000)).toBe(true);
    expect(await again.has("cd", 15_000)).toBe(false);
    await again.mark("cd");
    expect(await again.has("cd", 15_000)).toBe(true);
    expect(await again.has("ef", 9_500)).toBe(true);
  });
});

describe("shares", () => {
  it("an unreadable share list loads with no share instead of stopping the daemon", async () => {
    const path = join(dir, "shares.json");
    await writeFile(path, '{"active": [{"grant"');
    const s = new ShareStore(path, {
      serverDomain: "home.alice.flagship.services",
      verifyOwnerGrant: () => true,
      verifyAcceptAdmin: () => ({ ok: true, keyKind: "admin-root", keyPubHex: "00".repeat(32) }),
    });
    await expect(s.load()).resolves.toEqual({ dropped: 0 });
    expect(s.list()).toEqual([]);
    await keptAsideAndReported(path);
  });

  it("an unreadable share-session list loads with no session instead of stopping the daemon", async () => {
    const path = join(dir, "share-sessions.json");
    await writeFile(path, "not json");
    const s = new ShareSessionStore(path, () => 1);
    await expect(s.load()).resolves.toBeUndefined();
    await keptAsideAndReported(path);
  });
});

describe("sealed stores keep an unreadable file instead of overwriting it", () => {
  const swk = swkOps(new Uint8Array(32).fill(4));

  it("app internet access lists", async () => {
    const path = join(dir, "app-access.sealed");
    await writeFile(path, "00ff".repeat(20));
    const s = new AppAccessStore(path, swk);
    await expect(s.load(() => true, "home.alice.flagship.services")).rejects.toThrow();
    await keptAsideAndReported(path);
  });

  it("app API keys", async () => {
    const path = join(dir, "app-api-keys.sealed");
    await writeFile(path, "00ff".repeat(20));
    const s = new AppApiKeyStore(path, swk);
    await expect(s.load(() => true, "home.alice.flagship.services")).rejects.toThrow();
    await keptAsideAndReported(path);
  });

  it("installed services", async () => {
    const path = join(dir, "installed-services.sealed");
    await writeFile(path, "00ff".repeat(20));
    const s = new SealedInstalledServicesStore(path, swk);
    await expect(s.load()).rejects.toThrow();
    await keptAsideAndReported(path);
  });
});
