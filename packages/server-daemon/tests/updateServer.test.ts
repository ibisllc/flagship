/**
 * Tests for UpdateServer — the canonical-home side that serves
 * `/.flagship/update` to subscriber pods. Each test sets up a real
 * temporary git repo with a couple of commits, then exercises the
 * server's request handling.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ed,
  signUpdatePull,
  type Bytes,
  type Keypair,
  type UpdatePullRequest,
} from "@flagship/protocol";
import { UpdateServer, type AppDistributionInfo } from "../src/updateServer.js";
import type { InstalledApp } from "../src/appPlatform.js";
import type { HttpRequest } from "../src/runtime.js";

const execFileP = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", repo, ...args], { timeout: 10_000 });
  return stdout.trim();
}

async function makeRepo(): Promise<{ repo: string; firstCommit: string; secondCommit: string }> {
  const repo = await mkdtemp(join(tmpdir(), "flagship-test-repo-"));
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@flagship.test"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "# v1\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "first"]);
  const firstCommit = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(join(repo, "README.md"), "# v2\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "second"]);
  const secondCommit = await git(repo, ["rev-parse", "HEAD"]);
  return { repo, firstCommit, secondCommit };
}

function makeApp(creator: string, slug: string): InstalledApp {
  const appId = `${creator}--${slug}`;
  return {
    creator,
    slug,
    appId,
    manifest: {
      schemaVersion: 1,
      name: slug,
      version: "0.0.1",
      runtime: { image: "test", port: 80 },
      data: {},
      network: { subdomain: slug },
      access: { enabled: true, defaultRole: "viewer", publicRoutes: ["/"] },
      migration: { portable: true, verification: "standard" },
    } as InstalledApp["manifest"],
    urlLabel: slug,
    membership: undefined as unknown as InstalledApp["membership"],
    containerPort: 0,
    data: null,
    installedAt: 0,
  };
}

function pullEnvelope(p: UpdatePullRequest): string {
  return JSON.stringify(p);
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeRequest(args: {
  pull: UpdatePullRequest;
  pubkey: Bytes;
  sig: Bytes;
}): HttpRequest {
  return {
    method: "GET",
    path: "/.flagship/update",
    headers: {
      "x-flagship-update-pull": pullEnvelope(args.pull),
      authorization: `Flagship-Identity ${bytesToHex(args.pubkey)} ${bytesToHex(args.sig)}`,
    },
    body: Buffer.alloc(0),
  };
}

describe("UpdateServer", () => {
  let repo: string;
  let cacheDir: string;
  let firstCommit: string;
  let secondCommit: string;
  let pullerKey: Keypair;
  let pullerPub: Bytes;

  beforeEach(async () => {
    const r = await makeRepo();
    repo = r.repo;
    firstCommit = r.firstCommit;
    secondCommit = r.secondCommit;
    cacheDir = await mkdtemp(join(tmpdir(), "flagship-cache-"));
    const priv = ed.utils.randomPrivateKey();
    pullerKey = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
    pullerPub = pullerKey.publicKey;
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  function makeServer(opts?: {
    publicDistribution?: boolean;
    subscribers?: Set<string>;
    pubkeyResolver?: (id: string) => Promise<Bytes | null>;
    now?: () => number;
  }): UpdateServer {
    const dist: AppDistributionInfo = {
      publicDistribution: opts?.publicDistribution ?? false,
      subscribers: opts?.subscribers ?? new Set(["home.bob.flagship.services"]),
      repoPath: repo,
    };
    return new UpdateServer({
      cacheDir,
      appDistribution: () => dist,
      resolveServerPubkey:
        opts?.pubkeyResolver ?? (async (id: string) =>
          id === "home.bob.flagship.services" ? pullerPub : null),
      now: opts?.now,
    });
  }

  it("returns null for paths that aren't /.flagship/update — proxy continues", async () => {
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const res = await s.handle(app, {
      method: "GET",
      path: "/anything",
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(res).toBeNull();
  });

  it("rejects non-GET methods", async () => {
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const res = await s.handle(app, {
      method: "POST",
      path: "/.flagship/update",
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(res?.status).toBe(405);
  });

  it("rejects when X-Flagship-Update-Pull header is missing", async () => {
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const res = await s.handle(app, {
      method: "GET",
      path: "/.flagship/update",
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(res?.status).toBe(400);
  });

  it("rejects when (creator,slug) in envelope doesn't match URL app", async () => {
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game2", // doesn't match
      since: "",
      issuedAt: Date.now(),
    };
    const sig = signUpdatePull(pull, pullerKey);
    const res = await s.handle(app, makeRequest({ pull, pubkey: pullerPub, sig }));
    expect(res?.status).toBe(400);
    expect(String(res?.body)).toContain("does not match");
  });

  it("rejects stale requests (issuedAt > 5 min skew)", async () => {
    const now = Date.now();
    const s = makeServer({ now: () => now });
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: now - 10 * 60_000,
    };
    const sig = signUpdatePull(pull, pullerKey);
    const res = await s.handle(app, makeRequest({ pull, pubkey: pullerPub, sig }));
    expect(res?.status).toBe(401);
  });

  it("rejects when authorization header is missing", async () => {
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: Date.now(),
    };
    const res = await s.handle(app, {
      method: "GET",
      path: "/.flagship/update",
      headers: { "x-flagship-update-pull": pullEnvelope(pull) },
      body: Buffer.alloc(0),
    });
    expect(res?.status).toBe(401);
  });

  it("rejects when the claimed pubkey doesn't match the .com-resolved pubkey", async () => {
    const otherPriv = ed.utils.randomPrivateKey();
    const otherPub = ed.getPublicKey(otherPriv);
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: Date.now(),
    };
    const sig = signUpdatePull(pull, pullerKey);
    // Claim "otherPub" while signing with pullerKey. The .com lookup
    // returns pullerPub, so the equality check fails.
    const res = await s.handle(app, makeRequest({ pull, pubkey: otherPub, sig }));
    expect(res?.status).toBe(401);
    expect(String(res?.body)).toContain("does not match the .com-registered identity");
  });

  it("rejects when the puller is not in the subscriber list", async () => {
    const s = makeServer({ subscribers: new Set([]) });
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: Date.now(),
    };
    const sig = signUpdatePull(pull, pullerKey);
    const res = await s.handle(app, makeRequest({ pull, pubkey: pullerPub, sig }));
    expect(res?.status).toBe(403);
  });

  it("allows non-subscribers when the app is public-distribution", async () => {
    const s = makeServer({
      publicDistribution: true,
      subscribers: new Set([]),
    });
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: Date.now(),
    };
    const sig = signUpdatePull(pull, pullerKey);
    const res = await s.handle(app, makeRequest({ pull, pubkey: pullerPub, sig }));
    expect(res?.status).toBe(200);
    expect(res?.headers["content-type"]).toBe("application/x-git-bundle");
  });

  it("returns a valid git bundle for a full-history pull (since=empty)", async () => {
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: Date.now(),
    };
    const sig = signUpdatePull(pull, pullerKey);
    const res = await s.handle(app, makeRequest({ pull, pubkey: pullerPub, sig }));
    expect(res?.status).toBe(200);
    expect(Buffer.isBuffer(res?.body)).toBe(true);

    // Write the bundle to disk and verify it.
    const tmpBundle = join(cacheDir, "from-test.bundle");
    await writeFile(tmpBundle, res!.body as Buffer);
    const verify = await execFileP("git", ["bundle", "verify", tmpBundle], { timeout: 5_000 });
    expect(verify.stderr + verify.stdout).toMatch(/main|ok/);
  });

  it("returns an incremental bundle when since=<firstCommit> — contains second but not first", async () => {
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: firstCommit,
      issuedAt: Date.now(),
    };
    const sig = signUpdatePull(pull, pullerKey);
    const res = await s.handle(app, makeRequest({ pull, pubkey: pullerPub, sig }));
    expect(res?.status).toBe(200);

    // Apply to a fresh clone of the repo at firstCommit and check it advances.
    const subscriber = await mkdtemp(join(tmpdir(), "flagship-sub-"));
    await execFileP("git", ["init", "--initial-branch=main", subscriber]);
    await execFileP("git", ["-C", subscriber, "fetch", repo, firstCommit]);
    await execFileP("git", ["-C", subscriber, "reset", "--hard", firstCommit]);
    const bundlePath = join(subscriber, "from-home.bundle");
    await writeFile(bundlePath, res!.body as Buffer);
    await execFileP("git", ["-C", subscriber, "fetch", bundlePath, "main:remote-main"]);
    const tip = (await execFileP("git", ["-C", subscriber, "rev-parse", "remote-main"])).stdout.trim();
    expect(tip).toBe(secondCommit);
    await rm(subscriber, { recursive: true, force: true });
  });

  it("caches packs by (appId, since, tip) — second hit reuses the cached bundle", async () => {
    const s = makeServer();
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: Date.now(),
    };
    const sig = signUpdatePull(pull, pullerKey);

    const firstRes = await s.handle(app, makeRequest({ pull, pubkey: pullerPub, sig }));
    expect(firstRes?.status).toBe(200);
    const firstBytes = firstRes!.body as Buffer;

    const secondPull = { ...pull, issuedAt: Date.now() + 1 };
    const secondSig = signUpdatePull(secondPull, pullerKey);
    const secondRes = await s.handle(
      app,
      makeRequest({ pull: secondPull, pubkey: pullerPub, sig: secondSig }),
    );
    expect(secondRes?.status).toBe(200);
    const secondBytes = secondRes!.body as Buffer;
    expect(Buffer.compare(firstBytes, secondBytes)).toBe(0);
  });

  it("returns 401 when the puller's identity isn't registered with .com", async () => {
    const s = makeServer({
      pubkeyResolver: async () => null,
    });
    const app = makeApp("alice", "game1");
    const pull: UpdatePullRequest = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: Date.now(),
    };
    const sig = signUpdatePull(pull, pullerKey);
    const res = await s.handle(app, makeRequest({ pull, pubkey: pullerPub, sig }));
    expect(res?.status).toBe(401);
    expect(String(res?.body)).toContain("not registered");
  });
});
