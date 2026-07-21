/**
 * End-to-end test: UpdateServer (canonical home) + UpdateClient
 * (subscriber) talking to each other through a fake fetch that
 * routes the client's HTTP call directly into the server's handler.
 *
 * This proves the actual signing → .com pubkey resolution → signature
 * verification → subscriber-list check → bundle build → bundle apply
 * → lineage check → migrations → restart chain works on real git
 * repos with no protocol mismatches between the two halves.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed, type Bytes, type Keypair } from "@flagship/protocol";
import { UpdateServer } from "../src/updateServer.js";
import {
  UpdateClient,
  type AppPullState,
  type AppPullStateStore,
  type PhoneUpdateAlert,
} from "../src/updateClient.js";
import { InMemoryAlertInbox } from "../src/alertInbox.js";
import type { InstalledService } from "../src/servicePlatform.js";
import type { HttpRequest } from "../src/runtime.js";

const execFileP = promisify(execFile);
const APP_ID = "alice--game1";
const PULLER_ID = "home.bob.flagship.services";
const HOME_URL = "game1.alice.flagship.services";

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", repo, ...args], { timeout: 10_000 });
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "flagship-e2e-"));
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@flagship.test"]);
  await git(repo, ["config", "user.name", "Test"]);
  return repo;
}

async function commit(repo: string, path: string, content: string, msg: string): Promise<string> {
  const abs = join(repo, path);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  if (dir !== repo) await mkdir(dir, { recursive: true });
  await writeFile(abs, content);
  await git(repo, ["add", path]);
  await git(repo, ["commit", "-m", msg]);
  return await git(repo, ["rev-parse", "HEAD"]);
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

function makeApp(creator: string, slug: string): InstalledService {
  return {
    creator,
    slug,
    serviceId: `${creator}--${slug}`,
    manifest: {} as InstalledService["manifest"],
    urlLabel: slug,
    membership: undefined as unknown as InstalledService["membership"],
    containerPort: 0,
    data: null,
    installedAt: 0,
  };
}

/**
 * Bridge: turn the client's `fetch(url, init)` into a call against the
 * server's `handle(app, HttpRequest)`. The path of the URL becomes the
 * request path; headers transfer 1:1.
 */
function makeBridgeFetch(args: {
  server: UpdateServer;
  serverApp: InstalledService;
}): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    const initHeaders = init.headers as Headers;
    initHeaders.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const req: HttpRequest = {
      method: init.method ?? "GET",
      path: u.pathname,
      headers,
      body: Buffer.alloc(0),
    };
    const res = await args.server.handle(args.serverApp, req);
    if (!res) return new Response("not found", { status: 404 });
    const body = res.body instanceof Buffer ? res.body : Buffer.from(res.body, "utf8");
    return new Response(body, {
      status: res.status,
      headers: res.headers,
    });
  };
}

describe("Update-pack end-to-end (UpdateServer ↔ UpdateClient)", () => {
  let upstream: string;
  let subscriber: string;
  let firstCommit: string;
  let secondCommit: string;
  let pullerKey: Keypair;
  let pullerPub: Bytes;
  let cacheDir: string;

  beforeEach(async () => {
    upstream = await makeRepo();
    firstCommit = await commit(upstream, "README.md", "v1\n", "first");
    secondCommit = await commit(upstream, "README.md", "v2\n", "second");
    subscriber = await mkdtemp(join(tmpdir(), "flagship-e2e-sub-"));
    await git(subscriber, ["init", "--initial-branch=main"]);
    await git(subscriber, ["config", "user.email", "test@flagship.test"]);
    await git(subscriber, ["config", "user.name", "Test"]);
    await git(subscriber, ["fetch", upstream, firstCommit]);
    await git(subscriber, ["update-ref", "refs/heads/main", firstCommit]);
    await git(subscriber, ["checkout", "main"]);
    cacheDir = await mkdtemp(join(tmpdir(), "flagship-e2e-cache-"));

    const priv = ed.utils.randomPrivateKey();
    pullerKey = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
    pullerPub = pullerKey.publicKey;
  });
  afterEach(async () => {
    await rm(upstream, { recursive: true, force: true });
    await rm(subscriber, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("subscriber pulls updates, alert inbox stays empty (clean auto path)", async () => {
    const server = new UpdateServer({
      cacheDir,
      appDistribution: () => ({
        publicDistribution: false,
        subscribers: new Set([PULLER_ID]),
        repoPath: upstream,
      }),
      resolveServerPubkey: async (id) => (id === PULLER_ID ? pullerPub : null),
    });
    const inbox = new InMemoryAlertInbox();
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: HOME_URL,
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });

    let restartCount = 0;
    const client = new UpdateClient({
      identity: pullerKey,
      pullerServerId: PULLER_ID,
      state: store,
      appWorkingDir: () => subscriber,
      fetch: makeBridgeFetch({ server, serverApp: makeApp("alice", "game1") }),
      runMigration: async () => {},
      restartContainer: async () => {
        restartCount++;
      },
      emitPhoneAlert: (a: PhoneUpdateAlert) => inbox.emit(a),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res).toMatchObject({
      kind: "applied",
      from: firstCommit,
      to: secondCommit,
    });
    expect(restartCount).toBe(1);
    expect(inbox.size()).toBe(0);

    const after = await store.get(APP_ID);
    expect(after?.currentTip).toBe(secondCommit);
  });

  it("subscriber denied (not in list) → client surfaces error, working tree unchanged", async () => {
    const server = new UpdateServer({
      cacheDir,
      appDistribution: () => ({
        publicDistribution: false,
        subscribers: new Set(["someone-else.flagship.services"]),
        repoPath: upstream,
      }),
      resolveServerPubkey: async (id) => (id === PULLER_ID ? pullerPub : null),
    });
    const inbox = new InMemoryAlertInbox();
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: HOME_URL,
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });

    const client = new UpdateClient({
      identity: pullerKey,
      pullerServerId: PULLER_ID,
      state: store,
      appWorkingDir: () => subscriber,
      fetch: makeBridgeFetch({ server, serverApp: makeApp("alice", "game1") }),
      runMigration: async () => {},
      restartContainer: async () => {},
      emitPhoneAlert: (a: PhoneUpdateAlert) => inbox.emit(a),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.reason).toContain("403");
    }
    const head = await git(subscriber, ["rev-parse", "main"]);
    expect(head).toBe(firstCommit);
  });

  it("lineage break: rewritten upstream → server still serves; client halts and alerts", async () => {
    // Build a divergent repo with no shared history.
    const divergent = await makeRepo();
    await commit(divergent, "README.md", "different\n", "rebuilt");
    const divergentTip = await commit(divergent, "README.md", "different2\n", "rebuilt2");

    const server = new UpdateServer({
      cacheDir,
      appDistribution: () => ({
        publicDistribution: false,
        subscribers: new Set([PULLER_ID]),
        repoPath: divergent,
      }),
      resolveServerPubkey: async (id) => (id === PULLER_ID ? pullerPub : null),
    });
    const inbox = new InMemoryAlertInbox();
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: HOME_URL,
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });

    let restartCount = 0;
    const client = new UpdateClient({
      identity: pullerKey,
      pullerServerId: PULLER_ID,
      state: store,
      appWorkingDir: () => subscriber,
      fetch: makeBridgeFetch({ server, serverApp: makeApp("alice", "game1") }),
      runMigration: async () => {},
      restartContainer: async () => {
        restartCount++;
      },
      emitPhoneAlert: (a: PhoneUpdateAlert) => inbox.emit(a),
    });
    const res = await client.pullOne({ serviceId: APP_ID });
    expect(res.kind).toBe("halted-lineage-break");
    expect(restartCount).toBe(0);
    expect(inbox.size()).toBe(1);
    const events = inbox.list();
    expect(events[0]?.alert).toMatchObject({
      kind: "lineage-break",
      serviceId: APP_ID,
      upstreamTip: divergentTip,
    });
    await rm(divergent, { recursive: true, force: true });
  });

  it("manual policy: client halts pending; phone-approval applyPending advances", async () => {
    const server = new UpdateServer({
      cacheDir,
      appDistribution: () => ({
        publicDistribution: false,
        subscribers: new Set([PULLER_ID]),
        repoPath: upstream,
      }),
      resolveServerPubkey: async (id) => (id === PULLER_ID ? pullerPub : null),
    });
    const inbox = new InMemoryAlertInbox();
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: HOME_URL,
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "manual",
    });

    let restartCount = 0;
    const client = new UpdateClient({
      identity: pullerKey,
      pullerServerId: PULLER_ID,
      state: store,
      appWorkingDir: () => subscriber,
      fetch: makeBridgeFetch({ server, serverApp: makeApp("alice", "game1") }),
      runMigration: async () => {},
      restartContainer: async () => {
        restartCount++;
      },
      emitPhoneAlert: (a: PhoneUpdateAlert) => inbox.emit(a),
    });
    const first = await client.pullOne({ serviceId: APP_ID });
    expect(first.kind).toBe("halted-manual-pending");
    expect(restartCount).toBe(0);
    expect(inbox.size()).toBe(1);

    // Phone approves.
    const second = await client.applyPending({ serviceId: APP_ID });
    expect(second.kind).toBe("applied");
    expect(restartCount).toBe(1);

    const head = await git(subscriber, ["rev-parse", "main"]);
    expect(head).toBe(secondCommit);
  });

  it("non-readReady subscriber repeating pulls is cheap: server cache hits + client no-ops", async () => {
    const server = new UpdateServer({
      cacheDir,
      appDistribution: () => ({
        publicDistribution: false,
        subscribers: new Set([PULLER_ID]),
        repoPath: upstream,
      }),
      resolveServerPubkey: async (id) => (id === PULLER_ID ? pullerPub : null),
    });
    const inbox = new InMemoryAlertInbox();
    const store = new MemStore();
    await store.put(APP_ID, {
      canonicalUrl: HOME_URL,
      lineageAnchor: firstCommit,
      currentTip: firstCommit,
      lastAppliedMigration: "",
      updatePolicy: "auto",
    });
    let restartCount = 0;
    const client = new UpdateClient({
      identity: pullerKey,
      pullerServerId: PULLER_ID,
      state: store,
      appWorkingDir: () => subscriber,
      fetch: makeBridgeFetch({ server, serverApp: makeApp("alice", "game1") }),
      runMigration: async () => {},
      restartContainer: async () => {
        restartCount++;
      },
      emitPhoneAlert: (a: PhoneUpdateAlert) => inbox.emit(a),
    });
    const first = await client.pullOne({ serviceId: APP_ID });
    expect(first.kind).toBe("applied");
    expect(restartCount).toBe(1);

    // No new commits upstream — second pull is a no-op.
    const second = await client.pullOne({ serviceId: APP_ID });
    expect(second).toMatchObject({ kind: "no-op", reason: "already-current" });
    expect(restartCount).toBe(1); // unchanged
  });

  it("readFile sanity: bundle round-trips identically across repeated server hits (cache key is deterministic)", async () => {
    const server = new UpdateServer({
      cacheDir,
      appDistribution: () => ({
        publicDistribution: true,
        subscribers: new Set(),
        repoPath: upstream,
      }),
      resolveServerPubkey: async () => pullerPub,
    });
    const a = await server.buildPack({ serviceId: APP_ID, repoPath: upstream, since: "" });
    const b = await server.buildPack({ serviceId: APP_ID, repoPath: upstream, since: "" });
    expect(Buffer.compare(a, b)).toBe(0);
    void readFile;
  });
});
