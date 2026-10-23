import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed, type Keypair } from "@flagship/protocol";
import { UpdateClient, type AppPullState, type AppPullStateStore, type PhoneUpdateAlert, type UpdatePolicy } from "../src/updateClient.js";

const run = promisify(execFile);
const git = async (repo: string, args: string[]) => (await run("git", args, { cwd: repo })).stdout.trim();

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 1, name: "game1", version: "0.1.0", runtime: { image: "ghcr.io/alice/game1:0.1.0", port: 8080 },
    data: {}, network: { subdomain: "game1" }, access: { enabled: true, default_role: "viewer" },
    migration: { portable: true, verification: "standard" }, ...over,
  });

async function commit(repo: string, files: Record<string, string>, msg: string): Promise<string> {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(repo, p)), { recursive: true });
    await writeFile(join(repo, p), c);
  }
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", msg]);
  return git(repo, ["rev-parse", "HEAD"]);
}

class MemStore implements AppPullStateStore {
  m = new Map<string, AppPullState>();
  async get(id: string) { return this.m.get(id) ?? null; }
  async put(id: string, s: AppPullState) { this.m.set(id, { ...s }); }
}

const APP = "alice--game1";
let upstream: string;
let sub: string;
let first: string;
let now: number;
let alerts: PhoneUpdateAlert[];
let restarts: number;

beforeEach(async () => {
  upstream = await mkdtemp(join(tmpdir(), "um-up-"));
  await git(upstream, ["init", "--initial-branch=main"]);
  await git(upstream, ["config", "user.email", "t@t"]);
  await git(upstream, ["config", "user.name", "T"]);
  first = await commit(upstream, { "flagship.app.json": manifest() }, "first");
  sub = await mkdtemp(join(tmpdir(), "um-sub-"));
  await git(sub, ["init", "--initial-branch=main"]);
  await git(sub, ["config", "user.email", "t@t"]);
  await git(sub, ["config", "user.name", "T"]);
  await git(sub, ["fetch", upstream, first]);
  await git(sub, ["update-ref", "refs/heads/main", first]);
  await git(sub, ["checkout", "main"]);
  now = 1_000_000;
  alerts = [];
  restarts = 0;
});
afterEach(async () => {
  await rm(upstream, { recursive: true, force: true });
  await rm(sub, { recursive: true, force: true });
});

async function bundle(range: string): Promise<Buffer> {
  const p = join(upstream, "..", `um-${Math.random().toString(36).slice(2)}.bundle`);
  await git(upstream, ["bundle", "create", p, range]);
  const { readFile } = await import("node:fs/promises");
  const b = await readFile(p);
  await rm(p, { force: true });
  return b;
}

function client(store: MemStore, bundleBytes: () => Promise<Buffer>): UpdateClient {
  const priv = new Uint8Array(32).fill(7);
  const identity: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
  return new UpdateClient({
    identity, pullerServerId: "home.bob.flagship.services", state: store, appWorkingDir: () => sub,
    fetch: async () => new Response(await bundleBytes(), { status: 200 }),
    runMigration: async () => {},
    restartContainer: async () => { restarts++; },
    emitPhoneAlert: (a) => alerts.push(a),
    now: () => now,
    stagedHoldMs: 10_000,
  } as never);
}

async function seed(policy: UpdatePolicy): Promise<MemStore> {
  const s = new MemStore();
  await s.put(APP, { canonicalUrl: "game1.alice.flagship.services", lineageAnchor: first, currentTip: first, lastAppliedMigration: "", updatePolicy: policy });
  return s;
}

describe("update modes", () => {
  it("manual (the default) never takes an update on its own", async () => {
    const tip = await commit(upstream, { "flagship.app.json": manifest({ version: "0.2.0" }) }, "v2");
    const store = await seed("manual");
    const r = await client(store, () => bundle(`${first}..main`)).pullOne({ serviceId: APP });
    expect(r).toMatchObject({ kind: "halted-manual-pending", to: tip });
    expect(restarts).toBe(0);
    expect(await git(sub, ["rev-parse", "main"])).toBe(first);
  });

  it("automatic takes a same-key update that adds no authority, at once", async () => {
    const tip = await commit(upstream, { "flagship.app.json": manifest({ version: "0.2.0" }) }, "v2");
    const store = await seed("auto");
    const r = await client(store, () => bundle(`${first}..main`)).pullOne({ serviceId: APP });
    expect(r.kind).toBe("applied");
    expect(await git(sub, ["rev-parse", "main"])).toBe(tip);
    expect(restarts).toBe(1);
  });

  it("automatic stops for the owner when the update asks for more authority", async () => {
    const tip = await commit(upstream, { "flagship.app.json": manifest({ version: "0.2.0", network: { subdomain: "game1", egress: [{ host: "api.example.com", why: "weather" }] } }) }, "v2 wants the internet");
    const store = await seed("auto");
    const r = await client(store, () => bundle(`${first}..main`)).pullOne({ serviceId: APP });
    expect(r).toMatchObject({ kind: "halted-manual-pending", to: tip });
    expect(restarts).toBe(0);
    expect(await git(sub, ["rev-parse", "main"])).toBe(first);
    expect(alerts[0]).toMatchObject({ kind: "manual-pending", capabilityChanges: { needsApproval: true } });
  });

  it("automatic never takes an update whose authority it cannot read", async () => {
    await commit(upstream, { "flagship.app.json": "not json" }, "broken manifest");
    const store = await seed("auto");
    const r = await client(store, () => bundle(`${first}..main`)).pullOne({ serviceId: APP });
    expect(r.kind).toBe("halted-manual-pending");
    expect(restarts).toBe(0);
  });

  it("staged holds a clean update, then takes it; a newer commit restarts the hold", async () => {
    await commit(upstream, { "flagship.app.json": manifest({ version: "0.2.0" }) }, "v2");
    const store = await seed("staged");
    const c = client(store, () => bundle(`${first}..main`));
    expect((await c.pullOne({ serviceId: APP })).kind).toBe("halted-manual-pending");
    expect((await store.get(APP))?.stagedAt).toBe(now);
    now += 5_000;
    expect((await c.pullOne({ serviceId: APP })).kind).toBe("halted-manual-pending");
    expect(alerts).toHaveLength(1);
    // a newer release arrives mid-hold: the hold starts over
    const tip2 = await commit(upstream, { "flagship.app.json": manifest({ version: "0.3.0" }) }, "v3");
    expect((await c.pullOne({ serviceId: APP })).kind).toBe("halted-manual-pending");
    expect((await store.get(APP))?.pendingPullCommit).toBe(tip2);
    expect((await store.get(APP))?.stagedAt).toBe(now);
    now += 10_000;
    expect((await c.pullOne({ serviceId: APP })).kind).toBe("applied");
    expect(await git(sub, ["rev-parse", "main"])).toBe(tip2);
  });

  it("staged never takes a held update that grows authority", async () => {
    await commit(upstream, { "flagship.app.json": manifest({ version: "0.2.0", network: { subdomain: "game1", egress: [{ host: "api.example.com", why: "weather" }] } }) }, "v2");
    const store = await seed("staged");
    const c = client(store, () => bundle(`${first}..main`));
    await c.pullOne({ serviceId: APP });
    expect((await store.get(APP))?.stagedAt).toBeUndefined();
    now += 100_000;
    expect((await c.pullOne({ serviceId: APP })).kind).toBe("halted-manual-pending");
    expect(restarts).toBe(0);
  });

  it("the owner changes the mode, leaving the hold only for staged", async () => {
    const store = await seed("manual");
    const c = client(store, () => bundle(`${first}..main`));
    expect(await c.setPolicy({ serviceId: APP, policy: "staged" })).toEqual({ ok: true });
    expect(await c.policyOf(APP)).toBe("staged");
    expect(await c.setPolicy({ serviceId: APP, policy: "weekly" as never })).toMatchObject({ ok: false });
    expect(await c.setPolicy({ serviceId: "nobody--x", policy: "auto" })).toMatchObject({ ok: false });
  });
});
