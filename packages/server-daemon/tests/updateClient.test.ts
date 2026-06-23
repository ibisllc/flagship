/**
 * Tests for UpdateClient — the subscriber side that pulls bundles from
 * the canonical home, verifies lineage, applies migrations, and
 * restarts the container.
 *
 * Strategy: spin up two real git repos in tmpdirs — an "upstream" (the
 * canonical home) and a "subscriber" (this box's working clone) —
 * generate a real bundle with `git bundle create`, and have a mocked
 * fetch() return its bytes. This exercises the actual git operations
 * in the client, including incremental fetch + lineage check.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed, type Keypair } from "@flagship/protocol";
import {
  UpdateClient,
  type AppPullState,
  type AppPullStateStore,
  type PhoneUpdateAlert,
  FileAppPullStateStore,
} from "../src/updateClient.js";

const execFileP = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", repo, ...args], { timeout: 10_000 });
  return stdout.trim();
}

async function makeBareRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "flagship-upstream-"));
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

class MemStore implements AppPullStateStore {
  private state = new Map<string, AppPullState>();
  async get(serviceId: string): Promise<AppPullState | null> {
    return this.state.get(serviceId) ?? null;
  }
  async put(serviceId: string, state: AppPullState): Promise<void> {
    this.state.set(serviceId, { ...state });
  }
}

function makeIdentity(seed: number): Keypair {
  const priv = new Uint8Array(32);
  priv.fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const APP_ID = "alice--game1";

describe("UpdateClient", () => {
  let upstream: string;
  let subscriber: string;
  let firstCommit: string;
  let secondCommit: string;
  let identity: Keypair;
  let alerts: PhoneUpdateAlert[];
  let restartCount: number;
  let migrationsRun: string[];

  beforeEach(async () => {
    upstream = await makeBareRepo();
    firstCommit = await commitFile(upstream, "README.md", "v1\n", "first");
    secondCommit = await commitFile(upstream, "README.md", "v2\n", "second");

    // Subscriber starts at firstCommit.
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
    migrationsRun = [];
  });
  afterEach(async () => {
    await rm(upstream, { recursive: true, force: true });
    await rm(subscriber, { recursive: true, force: true });
  });

  function makeClient(args: {
    store: AppPullStateStore;
    fetcher: (url: string, init: RequestInit) => Promise<Response>;
    runMigration?: (a: { serviceId: string; absPath: string; filename: string }) => Promise<void>;
  }): UpdateClient {
    return new UpdateClient({
      identity,
      pullerServerId: "home.bob.flagship.services",
      state: args.store,
      appWorkingDir: () => subscriber,
      fetch: args.fetcher,
      runMigration:
        args.runMigration ??
        (async ({ filename }) => {
          migrationsRun.push(filename);
        }),
      restartContainer: async () => {
        restartCount++;
      },
      emitPhoneAlert: (a) => alerts.push(a),
    });
  }

  it("returns no-op when policy is frozen — no fetch attempted", async () => {
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "frozen",
    });
    let fetched = false;
    const client = makeClient({
      store,
      fetcher: async () => {
        fetched = true;
        return new Response(null, { status: 500 });
      },
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({ kind: "no-op", reason: "frozen-policy" });
    expect(fetched).toBe(false);
  });

  it("auto policy: applies new commits, runs no migrations when none exist, restarts container", async () => {
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const bundle = await makeBundle(upstream, `${firstCommit}..main`);
    const client = makeClient({
      store,
      fetcher: async () =>
        new Response(bundle, {
          status: 200,
          headers: { "content-type": "application/x-git-bundle" },
        }),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({ kind: "applied", from: firstCommit, to: secondCommit });
    expect(restartCount).toBe(1);
    expect(migrationsRun).toEqual([]);
    const after = await store.get(APP_ID);
    expect(after?.currentTip).toBe(secondCommit);
    // Working tree was reset to main; README should now read "v2".
    const readme = await readFile(join(subscriber, "README.md"), "utf8");
    expect(readme).toBe("v2\n");
  });

  it("auto policy: runs new migrations in lex order then restarts", async () => {
    // Add migrations to upstream and commit them.
    const m1 = "0001_init.sql";
    const m2 = "0002_add_levels.sql";
    await commitFile(upstream, `migrations/${m1}`, "-- init\n", "add migration 1");
    const tipAfterM1 = await git(upstream, ["rev-parse", "HEAD"]);
    await commitFile(upstream, `migrations/${m2}`, "-- levels\n", "add migration 2");
    const tipAfterM2 = await git(upstream, ["rev-parse", "HEAD"]);

    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const bundle = await makeBundle(upstream, `${firstCommit}..main`);
    const client = makeClient({
      store,
      fetcher: async () => new Response(bundle, { status: 200 }),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({ kind: "applied", to: tipAfterM2, migrationsApplied: [m1, m2] });
    expect(migrationsRun).toEqual([m1, m2]);
    expect(restartCount).toBe(1);
    const after = await store.get(APP_ID);
    expect(after?.lastAppliedMigration).toBe(m2);
    void tipAfterM1;
  });

  it("manual policy: stages incoming-main but doesn't advance — emits manual-pending alert", async () => {
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "manual",
    });
    const bundle = await makeBundle(upstream, `${firstCommit}..main`);
    const client = makeClient({
      store,
      fetcher: async () => new Response(bundle, { status: 200 }),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({ kind: "halted-manual-pending", from: firstCommit, to: secondCommit });
    expect(restartCount).toBe(0);
    // Working tree was NOT advanced — main still on firstCommit.
    const head = await git(subscriber, ["rev-parse", "main"]);
    expect(head).toBe(firstCommit);
    expect(alerts).toEqual([
      expect.objectContaining({
        kind: "manual-pending",
        serviceId: APP_ID,
        fromCommit: firstCommit,
        toCommit: secondCommit,
      }),
    ]);
    const after = await store.get(APP_ID);
    expect(after?.pendingPullCommit).toBe(secondCommit);
  });

  it("applyPending: phone-approved manual pull advances and runs migrations", async () => {
    const m1 = "0001_init.sql";
    await commitFile(upstream, `migrations/${m1}`, "-- init\n", "add migration");
    const tipWithMigration = await git(upstream, ["rev-parse", "HEAD"]);

    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "manual",
    });
    const bundle = await makeBundle(upstream, `${firstCommit}..main`);
    const client = makeClient({
      store,
      fetcher: async () => new Response(bundle, { status: 200 }),
    });
    // First call halts pending.
    await client.pullOne({ serviceId: APP_ID });
    // Phone approves.
    const res = await client.applyPending({ serviceId: APP_ID });
    expect(res).toMatchObject({ kind: "applied", to: tipWithMigration, migrationsApplied: [m1] });
    expect(restartCount).toBe(1);
    const after = await store.get(APP_ID);
    expect(after?.pendingPullCommit).toBeUndefined();
  });

  it("lineage break: anchor not in upstream's history → halts, emits lineage-break alert", async () => {
    // Build a divergent upstream with a different first commit.
    const divergent = await makeBareRepo();
    const divergentFirst = await commitFile(divergent, "README.md", "different\n", "rebuilt");
    const divergentSecond = await commitFile(divergent, "README.md", "different2\n", "rebuilt2");

    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit, // from the original lineage
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const bundle = await makeBundle(divergent, "main");
    const client = makeClient({
      store,
      fetcher: async () => new Response(bundle, { status: 200 }),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({
      kind: "halted-lineage-break",
      lineageAnchor: firstCommit,
      upstreamTip: divergentSecond,
    });
    expect(restartCount).toBe(0);
    // main was NOT advanced
    const head = await git(subscriber, ["rev-parse", "main"]);
    expect(head).toBe(firstCommit);
    expect(alerts).toEqual([
      expect.objectContaining({
        kind: "lineage-break",
        serviceId: APP_ID,
        upstreamTip: divergentSecond,
      }),
    ]);
    void divergentFirst;
    await rm(divergent, { recursive: true, force: true });
  });

  it("migration failure: halts, doesn't restart, emits migration-failed alert", async () => {
    const m1 = "0001_broken.sql";
    await commitFile(upstream, `migrations/${m1}`, "-- broken\n", "add broken migration");

    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const bundle = await makeBundle(upstream, `${firstCommit}..main`);
    const client = makeClient({
      store,
      fetcher: async () => new Response(bundle, { status: 200 }),
      runMigration: async ({ filename }) => {
        if (filename === m1) throw new Error("syntax error in DDL");
        migrationsRun.push(filename);
      },
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({
      kind: "halted-migration-failed",
      failingFile: m1,
      reason: "syntax error in DDL",
    });
    expect(restartCount).toBe(0);
    expect(alerts).toEqual([
      expect.objectContaining({
        kind: "migration-failed",
        serviceId: APP_ID,
        migrationFile: m1,
      }),
    ]);
  });

  it("no-op when home returns empty bundle (rare but possible)", async () => {
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const client = makeClient({
      store,
      fetcher: async () => new Response(new Uint8Array(0), { status: 200 }),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({ kind: "no-op", reason: "already-current" });
    expect(restartCount).toBe(0);
  });

  it("error path: home returns 500 — surfaced as kind:error, no restart", async () => {
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const client = makeClient({
      store,
      fetcher: async () => new Response("nope", { status: 500 }),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({ kind: "error" });
    expect(restartCount).toBe(0);
  });

  it("releaseGate: halts the pull when the upstream tip is not endorsed", async () => {
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    const bundle = await makeBundle(upstream, `${firstCommit}..main`);
    const client = new UpdateClient({
      identity,
      pullerServerId: "home.bob.flagship.services",
      state: store,
      appWorkingDir: () => subscriber,
      fetch: async () =>
        new Response(bundle, {
          status: 200,
          headers: { "content-type": "application/x-git-bundle" },
        }),
      runMigration: async () => {},
      restartContainer: async () => {
        restartCount++;
      },
      emitPhoneAlert: (a) => alerts.push(a),
      releaseGate: {
        assertCommitEndorsed: (commitHash) => {
          throw new Error(`no endorsement for ${commitHash}`);
        },
      },
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res.kind).toBe("halted-unendorsed");
    if (res.kind === "halted-unendorsed") {
      expect(res.upstreamTip).toBe(secondCommit);
      expect(res.reason).toMatch(/no endorsement/);
    }
    expect(restartCount).toBe(0);
    // The working tree must not have advanced.
    const readme = await readFile(join(subscriber, "README.md"), "utf8");
    expect(readme).toBe("v1\n");
  });
});

describe("FileAppPullStateStore", () => {
  it("round-trips state through atomic file replace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flagship-state-"));
    try {
      const store = new FileAppPullStateStore(dir);
      expect(await store.get("alice--game1")).toBeNull();
      const s: AppPullState = {
        canonicalUrl: "game1.alice.flagship.services",
        lineageAnchor: "deadbeef",
        currentTip: "cafef00d",
        lastAppliedMigration: "0002_x.sql",
        updatePolicy: "manual",
      };
      await store.put("alice--game1", s);
      expect(await store.get("alice--game1")).toEqual(s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
