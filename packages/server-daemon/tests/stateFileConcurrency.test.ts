/**
 * Overlapping writes to one state file must all land whole (durableFile.ts).
 * Every store here used to write through one fixed `<file>.tmp` (or do an
 * unlocked read-modify-write), so twenty changes at once tore the file, lost
 * changes, or failed the second rename with ENOENT.
 */
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveSWK,
  ed,
  mintDevEntitlements,
  signDeadManAffirmation,
  signSetDeadManPolicy,
  type DeadManAffirmation,
  type Keypair,
  type SetDeadManPolicy,
} from "@flagship/protocol";
import { withFileLock, writeFileDurable } from "../src/durableFile.js";
import { DeadManController, BootUnlockModeSuppressor } from "../src/deadMan.js";
import { FrontPageStore } from "../src/frontPage.js";
import { buildIdentityRotateHandlers } from "../src/identityRotateHttp.js";
import { TokenSetSessionGate } from "../src/alertInboxHttp.js";
import { FileAppAuthTokens } from "../src/serviceAuthToken.js";
import { FileAppEnvStore } from "../src/serviceEnvStore.js";
import { FileBuildCredentialStore } from "../src/llm/buildCredentialStore.js";
import { FileMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import { FileSubscriberRegistry } from "../src/subscriberRegistry.js";
import { FileAppPullStateStore, type AppPullState } from "../src/updateClient.js";
import { FileJournalStore } from "../src/postRecovery/fileJournalStore.js";
import { RePairWatcher } from "../src/postRecovery/rePairWatcher.js";
import { loadEntitlementBundle, writeEntitlementBundle } from "../src/entitlementBundleStore.js";
import { PersistentAcmeStore } from "../src/acme/persistentStore.js";
import { fileUsedNonceStore } from "../src/updateConsumer.js";
import { ShareSessionStore } from "../src/shares/sharesHttp.js";
import { swkOps } from "./helpers/keyCustody.js";

const N = 20;
const range = (n = N) => Array.from({ length: n }, (_, i) => i);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "state-race-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function noTempLeft(d: string): Promise<void> {
  expect((await readdir(d)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
}

function key(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

describe("durableFile", () => {
  it("twenty overlapping writes to one path all land, last one wins, no temp files left", async () => {
    const path = join(dir, "state.json");
    const bodies = range().map((i) => JSON.stringify({ i, pad: "x".repeat(4000 - i * 100) }));
    await Promise.all(bodies.map((b) => writeFileDurable(path, b)));
    expect(await readFile(path, "utf8")).toBe(bodies[N - 1]);
    await noTempLeft(dir);
  });

  it("read-modify-writes under the lock never lose an update", async () => {
    const path = join(dir, "counter.json");
    await writeFileDurable(path, "0");
    await Promise.all(
      range().map(() =>
        withFileLock(path, async (write) => {
          const n = Number(await readFile(path, "utf8"));
          await new Promise((r) => setTimeout(r, 1));
          await write(String(n + 1));
        }),
      ),
    );
    expect(await readFile(path, "utf8")).toBe(String(N));
  });

  it("a failed write is its caller's alone; the next one still runs", async () => {
    const path = join(dir, "blocked", "state.json");
    await writeFile(join(dir, "blocked"), "a file where the folder should be");
    await expect(writeFileDurable(path, "a")).rejects.toThrow();
    await rm(join(dir, "blocked"));
    await writeFileDurable(path, "b");
    expect(await readFile(path, "utf8")).toBe("b");
  });
});

describe("stores survive twenty overlapping writes", () => {
  it("dead-man: every affirmation's nonce is on disk after a reload", async () => {
    const irk = key(50);
    const SERVER = "home.alice.flagship.services";
    const statePath = join(dir, "deadman.json");
    const now = 1_000_000;
    const mk = () =>
      new DeadManController({
        serverId: SERVER,
        irkPub: irk.publicKey,
        suppressor: { suppress: async () => {} },
        runner: { power: async () => {} },
        statePath,
        now: () => now,
        setIntervalImpl: () => 0,
        clearIntervalImpl: () => {},
      });
    const a = mk();
    await a.start();
    const policy: SetDeadManPolicy = {
      serverId: SERVER,
      enabled: true,
      windowMs: 24 * 3600_000,
      graceMs: 6 * 3600_000,
      lockoutMode: "off",
      issuedAt: now,
    };
    expect(await a.applyPolicy(policy, signSetDeadManPolicy(policy, irk))).toBe(true);
    const results = await Promise.all(
      range().map((i) => {
        const affirm: DeadManAffirmation = { serverId: SERVER, nonce: new Uint8Array(16).fill(i + 1), issuedAt: now };
        return a.affirm(affirm, signDeadManAffirmation(affirm, irk));
      }),
    );
    expect(results.every(Boolean)).toBe(true);
    const saved = JSON.parse(await readFile(statePath, "utf8")) as { usedNonces: string[] };
    expect(saved.usedNonces).toHaveLength(N);
    await noTempLeft(dir);
  });

  it("dead-man suppressor: overlapping locks leave one whole marker", async () => {
    const path = join(dir, "flagship-lock-once");
    const s = new BootUnlockModeSuppressor(path);
    await Promise.all(range().map(() => s.suppress()));
    expect(await readFile(path, "utf8")).toBe("approve-once\n");
    await noTempLeft(dir);
  });

  it("front page: the last label set is the one reloaded", async () => {
    const path = join(dir, "front-page.json");
    const s = new FrontPageStore(path);
    await Promise.all(range().map((i) => s.set(`app-${i}`)));
    const b = new FrontPageStore(path);
    await b.load();
    expect(b.get()).toBe(`app-${N - 1}`);
  });

  it("pending identity: every request succeeds and the file holds one of the keys handed out", async () => {
    const pendingPath = join(dir, "identity", "identity.pending.priv.hex");
    const handle = buildIdentityRotateHandlers({ gate: new TokenSetSessionGate(new Set(["s"])), pendingPath });
    const res = await Promise.all(
      range().map(() =>
        handle({
          method: "POST",
          path: "/api/identity/pending",
          headers: { authorization: "Flagship-Session s" },
          body: Buffer.alloc(0),
        }),
      ),
    );
    expect(res.map((r) => r?.status)).toEqual(range().map(() => 200));
    const pubs = res.map((r) => (JSON.parse(String(r!.body)) as { pubKeyHex: string }).pubKeyHex);
    const priv = (await readFile(pendingPath, "utf8")).trim();
    expect(priv).toMatch(/^[0-9a-f]{64}$/);
    expect(pubs).toContain(Buffer.from(ed.getPublicKey(Buffer.from(priv, "hex"))).toString("hex"));
  });

  it("app auth tokens: only the last token minted resolves, before and after a reload", async () => {
    const tokensDir = join(dir, "tokens");
    const a = new FileAppAuthTokens(tokensDir);
    const minted = await Promise.all(range().map(() => a.mint("svc")));
    const last = await a.tokenForApp("svc");
    for (const t of minted) expect(await a.resolve(t)).toBe(t === last ? "svc" : null);
    const b = new FileAppAuthTokens(tokensDir);
    await b.load();
    expect(await b.tokenForApp("svc")).toBe(last);
    await noTempLeft(tokensDir);
  });

  it("app env: the last put is the one reloaded; a forget after puts sticks", async () => {
    const swk = swkOps(new Uint8Array(32).fill(3));
    const envDir = join(dir, "env");
    const a = new FileAppEnvStore(envDir, swk);
    await Promise.all(range().map((i) => a.put("svc", { N: String(i) })));
    const b = new FileAppEnvStore(envDir, swk);
    await b.load();
    expect(await b.get("svc")).toEqual({ N: String(N - 1) });
    await Promise.all([...range().map((i) => a.put("gone", { N: String(i) })), a.forget("gone")]);
    const c = new FileAppEnvStore(envDir, swk);
    await c.load();
    expect(await c.get("gone")).toBeNull();
    expect(await a.get("gone")).toBeNull();
  });

  it("build credentials: the last put is the one reloaded; a forget after puts sticks", async () => {
    const swk = swkOps(deriveSWK({ seed: new Uint8Array(32).fill(9) }, "srv-cred"));
    const credDir = join(dir, "creds");
    const ID = "0123456789abcdef";
    const a = new FileBuildCredentialStore(credDir, swk);
    await Promise.all(range().map((i) => a.put(ID, { provider: "openai", apiKey: `sk-${i}` })));
    const b = new FileBuildCredentialStore(credDir, swk);
    await b.load();
    expect((await b.get(ID))?.apiKey).toBe(`sk-${N - 1}`);
    const ID2 = "fedcba9876543210";
    await Promise.all([...range().map((i) => a.put(ID2, { provider: "openai", apiKey: `sk-${i}` })), a.forget(ID2)]);
    const c = new FileBuildCredentialStore(credDir, swk);
    await c.load();
    expect(await c.get(ID2)).toBeNull();
  });

  it("MCP keys: only the last key minted for a build resolves; a revoke after mints sticks", async () => {
    const keysDir = join(dir, "mcp");
    const SWK = new Uint8Array(32).fill(7);
    let seed = 0;
    const rand = () => new Uint8Array(24).fill(++seed % 251);
    const a = new FileMcpKeyStore(keysDir, SWK, () => 1, rand);
    const minted = await Promise.all(range().map(() => a.mint("b1")));
    const last = await a.get("b1");
    for (const k of minted) expect(await a.resolve(k.key)).toBe(k.key === last!.key ? "b1" : null);
    const b = new FileMcpKeyStore(keysDir, SWK, () => 1, rand);
    await b.load();
    expect((await b.get("b1"))?.key).toBe(last!.key);
    await Promise.all([...range().map(() => a.mint("b2")), a.revoke("b2")]);
    const c = new FileMcpKeyStore(keysDir, SWK, () => 1, rand);
    await c.load();
    expect(await c.get("b2")).toBeNull();
  });

  it("subscribers: every overlapping add is kept", async () => {
    const r = new FileSubscriberRegistry(join(dir, "subs"));
    await Promise.all(range().map((i) => r.add("svc", `home.user${i}.flagship.services`)));
    expect(await new FileSubscriberRegistry(join(dir, "subs")).list("svc")).toHaveLength(N);
  });

  it("app pull state: the last put is the one read back", async () => {
    const s = new FileAppPullStateStore(join(dir, "pull"));
    const state = (i: number): AppPullState => ({
      canonicalUrl: "https://x",
      lineageAnchor: "a".repeat(40),
      currentTip: String(i).padStart(40, "0"),
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    await Promise.all(range().map((i) => s.put("svc", state(i))));
    expect((await s.get("svc"))?.currentTip).toBe(state(N - 1).currentTip);
    await noTempLeft(join(dir, "pull"));
  });

  it("post-recovery journal: rows appended while a prune rewrites the file are kept", async () => {
    const path = join(dir, "j.jsonl");
    const s = new FileJournalStore(path);
    const row = (serviceId: string, rewrittenAt: number) => ({
      serviceId,
      ivHex: "00".repeat(12),
      ciphertextHex: "ab".repeat(32),
      tagHex: "00".repeat(16),
      rewrittenAt,
    });
    for (const i of range()) await s.append(row(`old-${i}`, 1));
    await Promise.all([
      ...range().map((i) => s.deleteOlderThan(10 + i)),
      ...range().map((i) => s.append(row(`new-${i}`, 1_000))),
    ]);
    const all = await s.listAll();
    expect(all.map((r) => r.serviceId).sort()).toEqual(range().map((i) => `new-${i}`).sort());
  });

  it("re-pair watcher: overlapping polls leave a readable state file", async () => {
    const statePath = join(dir, "repair-watcher.json");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ pending: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const w = new RePairWatcher({
      rotationAppliedSince: async () => true,
      username: "alice",
      currentIrkPubHex: "aa".repeat(32),
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl,
      statePath,
      now: () => 5,
      pollIntervalMs: 60_000,
      clearPairedSessions: async () => 0,
      reissuerDeps: null,
    });
    await Promise.all(range().map(() => w.pollOnce()));
    expect((JSON.parse(await readFile(statePath, "utf8")) as { lastPolledAt: number }).lastPolledAt).toBe(5);
    await noTempLeft(dir);
  });

  it("entitlement bundle: overlapping writes leave one whole, verifiable bundle", async () => {
    const irk = key(0x11);
    const path = join(dir, "entitlements.json");
    const bundles = range().map((i) =>
      mintDevEntitlements({ irk, podPubKey: key(0x30 + i).publicKey, username: "alice", podCanonical: "home.alice.flagship.services" }),
    );
    await Promise.all(bundles.map((b) => writeEntitlementBundle(path, b)));
    const loaded = await loadEntitlementBundle(path);
    expect(loaded).not.toBeNull();
    expect(Buffer.from(loaded!.rootEntitlement.podPubKey).equals(Buffer.from(bundles[N - 1]!.rootEntitlement.podPubKey))).toBe(true);
    await noTempLeft(dir);
  });

  it("ACME certs: overlapping saves for one name never pair one cert with another's key", async () => {
    const s = new PersistentAcmeStore(dir);
    const fqdn = "home.alice.flagship.services";
    await Promise.all(
      range().map((i) =>
        s.saveCert(fqdn, { certPem: `CERT-${i}`, privateKeyPem: `KEY-${i}`, names: [fqdn], notAfter: 1_000 + i }),
      ),
    );
    const c = await s.loadCert(fqdn);
    expect(c?.certPem).toBe(`CERT-${N - 1}`);
    expect(c?.privateKeyPem).toBe(`KEY-${N - 1}`);
    expect(c?.notAfter).toBe(1_000 + N - 1);
  });

  it("update nonces: every overlapping mark is remembered (two stores, one file)", async () => {
    const path = join(dir, "update-used-nonces.json");
    const a = fileUsedNonceStore(path);
    const b = fileUsedNonceStore(path);
    await Promise.all(range().map((i) => (i % 2 ? a : b).mark(`nonce-${i}`)));
    for (const i of range()) expect(await a.has(`nonce-${i}`)).toBe(true);
  });

  it("share sessions: one failed write doesn't stop every later one", async () => {
    await mkdir(join(dir, "s"));
    const blocker = join(dir, "s", "x");
    await writeFile(blocker, "a file where the folder should be");
    const s = new ShareSessionStore(join(blocker, "share-sessions.json"), () => 1);
    await expect(s.mint("share-1")).rejects.toThrow();
    await rm(blocker);
    const { token } = await s.mint("share-2");
    const b = new ShareSessionStore(join(blocker, "share-sessions.json"), () => 1);
    await b.load();
    expect(b.lookup(token)).toBe("share-2");
  });
});
