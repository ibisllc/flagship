/**
 * Lineage-break end-to-end test.
 *
 * Covers the four scenarios called out in the task spec:
 *   1. Chain-break detection (the verifier rejects a divergent pack).
 *   2. Pause state persists across daemon restarts (FileAppPullStateStore
 *      round-trip).
 *   3. Accept flow unpauses + rolls the anchor forward.
 *   4. Refusal keeps the old version running indefinitely (re-pulling
 *      while paused is a no-op, working tree never advances).
 *
 * Strategy mirrors the existing updateClient.test.ts: two real git
 * repos in tmpdirs (upstream + subscriber), a real bundle from
 * `git bundle create`, and a mocked fetch().
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed, type Keypair } from "@flagship/protocol";
import {
  UpdateClient,
  FileAppPullStateStore,
  type AppPullState,
  type PhoneUpdateAlert,
} from "../src/updateClient.js";
import { LineageVerifier } from "../src/updatePack/lineageVerifier.js";
import { buildLineageResolverAdapter } from "../src/updatePack/lineageResolverAdapter.js";

const execFileP = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", repo, ...args], { timeout: 10_000 });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "flagship-linbreak-"));
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@flagship.test"]);
  await git(repo, ["config", "user.name", "Test"]);
  return repo;
}

async function commitFile(repo: string, path: string, content: string, msg: string): Promise<string> {
  const abs = join(repo, path);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  if (dir !== repo) await mkdir(dir, { recursive: true });
  await writeFile(abs, content);
  await git(repo, ["add", path]);
  await git(repo, ["commit", "-m", msg]);
  return await git(repo, ["rev-parse", "HEAD"]);
}

async function makeBundle(repo: string, range: string): Promise<Buffer> {
  const tmp = await mkdtemp(join(tmpdir(), "flagship-bundle-"));
  const bundle = join(tmp, "out.bundle");
  await execFileP("git", ["-C", repo, "bundle", "create", bundle, range], { timeout: 10_000 });
  const bytes = await readFile(bundle);
  await rm(tmp, { recursive: true, force: true });
  return bytes;
}

function makeIdentity(seed: number): Keypair {
  const priv = new Uint8Array(32);
  priv.fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const APP_ID = "alice--game1";

describe("LineageVerifier — pure decision tests", () => {
  let repo: string;
  let c1: string;
  let c2: string;

  beforeEach(async () => {
    repo = await initRepo();
    c1 = await commitFile(repo, "README.md", "v1\n", "first");
    c2 = await commitFile(repo, "README.md", "v2\n", "second");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("ok when the new tip extends the anchor", async () => {
    const v = new LineageVerifier();
    const r = await v.verify({
      workDir: repo,
      lineageAnchor: c1,
      previouslyAppliedTip: c1,
      newPackTip: c2,
    });
    expect(r.ok).toBe(true);
  });

  it("ok when the new tip extends both anchor and prior tip", async () => {
    const c3 = await commitFile(repo, "README.md", "v3\n", "third");
    const v = new LineageVerifier();
    const r = await v.verify({
      workDir: repo,
      lineageAnchor: c1,
      previouslyAppliedTip: c2,
      newPackTip: c3,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects anchor-unreachable (force-pushed divergent history)", async () => {
    // Build a totally separate repo with an unrelated commit and bring
    // its tip into our verifier's repo so git can resolve it but the
    // anchor is not on its history.
    const divergent = await initRepo();
    try {
      const d1 = await commitFile(divergent, "README.md", "different\n", "rebuilt");
      // Fetch the divergent commit into our local repo so it's
      // resolvable; this models the puller having `git fetch`'d
      // an attacker's bundle into `incoming-main`.
      await git(repo, ["fetch", divergent, d1]);
      const v = new LineageVerifier();
      const r = await v.verify({
        workDir: repo,
        lineageAnchor: c1,
        previouslyAppliedTip: c1,
        newPackTip: d1,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("anchor-unreachable");
        expect(r.detail).toMatch(/not an ancestor/);
      }
    } finally {
      await rm(divergent, { recursive: true, force: true });
    }
  });

  it("rejects unresolvable new tip (empty / malformed pack)", async () => {
    const v = new LineageVerifier();
    const r = await v.verify({
      workDir: repo,
      lineageAnchor: c1,
      previouslyAppliedTip: c1,
      newPackTip: "0000000000000000000000000000000000000000",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("new-tip-unresolvable");
  });

  it("rejects missing input", async () => {
    const v = new LineageVerifier();
    const r = await v.verify({
      workDir: "",
      lineageAnchor: c1,
      previouslyAppliedTip: c1,
      newPackTip: c2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-input");
  });
});

describe("UpdateClient — lineage-break auto-pause + resolve", () => {
  let upstream: string;
  let subscriber: string;
  let firstCommit: string;
  let secondCommit: string;
  let identity: Keypair;
  let alerts: PhoneUpdateAlert[];
  let restartCount: number;
  let stateDir: string;

  beforeEach(async () => {
    upstream = await initRepo();
    firstCommit = await commitFile(upstream, "README.md", "v1\n", "first");
    secondCommit = await commitFile(upstream, "README.md", "v2\n", "second");

    subscriber = await mkdtemp(join(tmpdir(), "flagship-sub-"));
    await git(subscriber, ["init", "--initial-branch=main"]);
    await git(subscriber, ["config", "user.email", "test@flagship.test"]);
    await git(subscriber, ["config", "user.name", "Test"]);
    await git(subscriber, ["fetch", upstream, firstCommit]);
    await git(subscriber, ["update-ref", "refs/heads/main", firstCommit]);
    await git(subscriber, ["checkout", "main"]);

    identity = makeIdentity(7);
    alerts = [];
    restartCount = 0;
    stateDir = await mkdtemp(join(tmpdir(), "flagship-state-"));
  });
  afterEach(async () => {
    await rm(upstream, { recursive: true, force: true });
    await rm(subscriber, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  function makeClient(store: FileAppPullStateStore, bundleFetcher: () => Promise<Buffer>): UpdateClient {
    return new UpdateClient({
      identity,
      pullerServerId: "home.bob.flagship.services",
      state: store,
      appWorkingDir: () => subscriber,
      fetch: async () => new Response(await bundleFetcher(), { status: 200 }),
      runMigration: async () => {},
      restartContainer: async () => {
        restartCount++;
      },
      emitPhoneAlert: (a) => alerts.push(a),
      now: () => 1_700_000_000_000,
    });
  }

  it("scenario 1 — detects chain break, persists pause, emits enriched alert", async () => {
    // Build a totally divergent upstream with a different first commit.
    const divergent = await initRepo();
    const divergentFirst = await commitFile(divergent, "README.md", "evil\n", "rebuilt");
    const divergentSecond = await commitFile(divergent, "README.md", "evil2\n", "rebuilt2");

    const store = new FileAppPullStateStore(stateDir);
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const client = makeClient(store, () => makeBundle(divergent, "main"));
    const res = await client.pullOne({ appId: APP_ID });
    expect(res.kind).toBe("halted-lineage-break");
    if (res.kind === "halted-lineage-break") {
      expect(res.reason).toBe("anchor-unreachable");
      expect(res.upstreamTip).toBe(divergentSecond);
    }
    expect(restartCount).toBe(0);
    // Working tree did NOT advance.
    const head = await git(subscriber, ["rev-parse", "main"]);
    expect(head).toBe(firstCommit);
    // Persisted pause:
    const persisted = await store.get(APP_ID);
    expect(persisted?.lineagePaused).toBe(true);
    expect(persisted?.lineagePauseInfo?.reason).toBe("anchor-unreachable");
    expect(persisted?.lineagePauseInfo?.creator).toBe("alice");
    expect(persisted?.lineagePauseInfo?.slug).toBe("game1");
    expect(persisted?.lineagePauseInfo?.priorTip).toBe(firstCommit);
    expect(persisted?.lineagePauseInfo?.upstreamTip).toBe(divergentSecond);
    // Alert carries the enriched fields.
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.kind).toBe("lineage-break");
    if (alert.kind === "lineage-break") {
      expect(alert.creator).toBe("alice");
      expect(alert.slug).toBe("game1");
      expect(alert.priorTip).toBe(firstCommit);
      expect(alert.upstreamTip).toBe(divergentSecond);
      expect(alert.reason).toBe("anchor-unreachable");
      expect(alert.detectedAt).toBe(1_700_000_000_000);
      expect(alert.detail).toMatch(/not an ancestor/);
    }
    void divergentFirst;
    await rm(divergent, { recursive: true, force: true });
  });

  it("scenario 2 — pause survives 'daemon restart' (file-backed store)", async () => {
    const divergent = await initRepo();
    await commitFile(divergent, "README.md", "evil\n", "rebuilt");
    await commitFile(divergent, "README.md", "evil2\n", "rebuilt2");

    // First instance detects + persists the break.
    const storeBefore = new FileAppPullStateStore(stateDir);
    await storeBefore.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const client1 = makeClient(storeBefore, () => makeBundle(divergent, "main"));
    await client1.pullOne({ appId: APP_ID });

    // Simulate daemon restart: a fresh store instance reading the same dir.
    const storeAfter = new FileAppPullStateStore(stateDir);
    const reloaded = await storeAfter.get(APP_ID);
    expect(reloaded?.lineagePaused).toBe(true);
    expect(reloaded?.lineagePauseInfo?.reason).toBe("anchor-unreachable");

    // A fresh UpdateClient sharing the reloaded store refuses to pull.
    let postRestartFetchCount = 0;
    const client2 = new UpdateClient({
      identity,
      pullerServerId: "home.bob.flagship.services",
      state: storeAfter,
      appWorkingDir: () => subscriber,
      fetch: async () => {
        postRestartFetchCount++;
        return new Response(await makeBundle(divergent, "main"), { status: 200 });
      },
      runMigration: async () => {},
      restartContainer: async () => {
        restartCount++;
      },
      emitPhoneAlert: (a) => alerts.push(a),
    });
    const res = await client2.pullOne({ appId: APP_ID });
    expect(res).toEqual({ kind: "no-op", reason: "lineage-paused" });
    // Critically — no HTTP fetch was attempted while paused.
    expect(postRestartFetchCount).toBe(0);
    expect(restartCount).toBe(0);
    await rm(divergent, { recursive: true, force: true });
  });

  it("scenario 3 — acceptLineageBreak unpauses + rolls anchor forward", async () => {
    const divergent = await initRepo();
    await commitFile(divergent, "README.md", "evil\n", "rebuilt");
    const divergentSecond = await commitFile(divergent, "README.md", "evil2\n", "rebuilt2");

    const store = new FileAppPullStateStore(stateDir);
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const client = makeClient(store, () => makeBundle(divergent, "main"));
    await client.pullOne({ appId: APP_ID });

    // Sanity: paused.
    expect((await store.get(APP_ID))?.lineagePaused).toBe(true);

    // Phone taps accept.
    const r = await client.acceptLineageBreak({ appId: APP_ID });
    expect(r).toEqual({ ok: true, outcome: "accepted" });

    const after = await store.get(APP_ID);
    expect(after?.lineagePaused).toBeFalsy();
    expect(after?.lineagePauseInfo).toBeUndefined();
    expect(after?.lineageAnchor).toBe(divergentSecond);

    // Accept on an already-clear app is idempotent.
    const r2 = await client.acceptLineageBreak({ appId: APP_ID });
    expect(r2).toEqual({ ok: true, outcome: "already-clear" });
    await rm(divergent, { recursive: true, force: true });
  });

  it("scenario 4 — refusal keeps the old version running indefinitely", async () => {
    // Even with the upstream "healing" (anchor reappears in the chain),
    // a paused app stays paused until the phone resolves — the daemon
    // never silently consents on the user's behalf.
    const divergent = await initRepo();
    await commitFile(divergent, "README.md", "evil\n", "rebuilt");

    const store = new FileAppPullStateStore(stateDir);
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const client = makeClient(store, () => makeBundle(divergent, "main"));

    // Initial pull halts.
    const first = await client.pullOne({ appId: APP_ID });
    expect(first.kind).toBe("halted-lineage-break");
    const alertsAfterFirst = alerts.length;

    // Subsequent ticks: all no-ops, no new alerts, no working-tree
    // movement, no restart.
    for (let i = 0; i < 5; i++) {
      const r = await client.pullOne({ appId: APP_ID });
      expect(r).toEqual({ kind: "no-op", reason: "lineage-paused" });
    }
    expect(alerts.length).toBe(alertsAfterFirst);
    expect(restartCount).toBe(0);
    const head = await git(subscriber, ["rev-parse", "main"]);
    expect(head).toBe(firstCommit);
    // README still v1 — old version still running.
    const readme = await readFile(join(subscriber, "README.md"), "utf8");
    expect(readme).toBe("v1\n");
    await rm(divergent, { recursive: true, force: true });
  });

  it("lineagePauseInfo getter — exposes the snapshot for the BFF view", async () => {
    const divergent = await initRepo();
    await commitFile(divergent, "README.md", "evil\n", "rebuilt");

    const store = new FileAppPullStateStore(stateDir);
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const client = makeClient(store, () => makeBundle(divergent, "main"));
    expect(await client.lineagePauseInfo({ appId: APP_ID })).toBeNull();
    await client.pullOne({ appId: APP_ID });
    const info = await client.lineagePauseInfo({ appId: APP_ID });
    expect(info?.reason).toBe("anchor-unreachable");
    expect(info?.creator).toBe("alice");
    expect(info?.detectedAt).toBe(1_700_000_000_000);
    await rm(divergent, { recursive: true, force: true });
  });
});

describe("LineageResolverAdapter — list + accept + revoke wiring", () => {
  let upstream: string;
  let subscriber: string;
  let firstCommit: string;
  let identity: Keypair;
  let stateDir: string;

  beforeEach(async () => {
    upstream = await initRepo();
    firstCommit = await commitFile(upstream, "README.md", "v1\n", "first");
    await commitFile(upstream, "README.md", "v2\n", "second");
    subscriber = await mkdtemp(join(tmpdir(), "flagship-sub-"));
    await git(subscriber, ["init", "--initial-branch=main"]);
    await git(subscriber, ["config", "user.email", "test@flagship.test"]);
    await git(subscriber, ["config", "user.name", "Test"]);
    await git(subscriber, ["fetch", upstream, firstCommit]);
    await git(subscriber, ["update-ref", "refs/heads/main", firstCommit]);
    await git(subscriber, ["checkout", "main"]);
    identity = makeIdentity(11);
    stateDir = await mkdtemp(join(tmpdir(), "flagship-state-"));
  });
  afterEach(async () => {
    await rm(upstream, { recursive: true, force: true });
    await rm(subscriber, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function seedPausedApp(): Promise<{
    store: FileAppPullStateStore;
    client: UpdateClient;
    upstreamTip: string;
  }> {
    const divergent = await initRepo();
    await commitFile(divergent, "README.md", "evil\n", "rebuilt");
    const upstreamTip = await commitFile(divergent, "README.md", "evil2\n", "rebuilt2");

    const store = new FileAppPullStateStore(stateDir);
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const client = new UpdateClient({
      identity,
      pullerServerId: "home.bob.flagship.services",
      state: store,
      appWorkingDir: () => subscriber,
      fetch: async () =>
        new Response(await makeBundle(divergent, "main"), { status: 200 }),
      runMigration: async () => {},
      restartContainer: async () => {},
      emitPhoneAlert: () => {},
    });
    await client.pullOne({ appId: APP_ID });
    await rm(divergent, { recursive: true, force: true });
    return { store, client, upstreamTip };
  }

  it("list() surfaces every paused app with full context", async () => {
    const { store, client } = await seedPausedApp();
    const adapter = buildLineageResolverAdapter({
      store,
      client,
      uninstall: async () => ({ ok: true }),
    });
    const list = await adapter.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      appId: APP_ID,
      creator: "alice",
      slug: "game1",
      canonicalUrl: "game1.alice.flagship.services",
      reason: "anchor-unreachable",
    });
  });

  it("accept() delegates to the client + returns wire-ready outcome", async () => {
    const { store, client, upstreamTip } = await seedPausedApp();
    const adapter = buildLineageResolverAdapter({
      store,
      client,
      uninstall: async () => ({ ok: true }),
    });
    const r = await adapter.accept(APP_ID);
    expect(r).toEqual({ ok: true, outcome: "accepted" });
    const after = await store.get(APP_ID);
    expect(after?.lineagePaused).toBeFalsy();
    expect(after?.lineageAnchor).toBe(upstreamTip);
  });

  it("revoke() routes through the supplied uninstall thunk", async () => {
    const { store, client } = await seedPausedApp();
    const calls: string[] = [];
    const adapter = buildLineageResolverAdapter({
      store,
      client,
      uninstall: async (appId) => {
        calls.push(appId);
        return { ok: true };
      },
    });
    const r = await adapter.revoke(APP_ID);
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([APP_ID]);
  });

  it("revoke() surfaces uninstall failure cleanly", async () => {
    const { store, client } = await seedPausedApp();
    const adapter = buildLineageResolverAdapter({
      store,
      client,
      uninstall: async () => ({ ok: false, reason: "container still up" }),
    });
    const r = await adapter.revoke(APP_ID);
    expect(r).toEqual({ ok: false, reason: "container still up" });
  });
});
