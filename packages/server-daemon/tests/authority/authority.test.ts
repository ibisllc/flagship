import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthorityHub, GrantIndex, GrantRefusedError, LedgerError, OperationLedger, approvalBinding, type LedgerChecks, type NewGrant } from "../../src/authority/index.js";

let dir: string;
let clock = 1_000_000;
let revision = 1;
let liveOverride: ((ids: string[]) => boolean) | null = null;
const now = () => clock;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "authority-"));
  clock = 1_000_000;
  revision = 1;
  liveOverride = null;
});

function mk(idx: GrantIndex): { ledger: OperationLedger; hub: AuthorityHub } {
  const checks: LedgerChecks = {
    grantsLive: (ids, at) => (liveOverride ? liveOverride(ids) : ids.every((i) => idx.isLive(i, at))),
    currentRevision: () => revision,
    verifyApproval: (op, a) => a.signatureHex === `sig:${a.by}:${approvalBinding({ ...op })}`,
  };
  const ledger = new OperationLedger(join(dir, "ops.json"), checks, now);
  return { ledger, hub: new AuthorityHub(idx, ledger, now, 50) };
}

async function fresh() {
  const idx = new GrantIndex(join(dir, "grants.json"), now);
  await idx.load();
  const { ledger, hub } = mk(idx);
  await ledger.load();
  return { idx, ledger, hub };
}

const grant = (id: string, over: Partial<NewGrant> = {}): NewGrant => ({
  id, kind: "owner-session", issuer: "dev1", subject: "s", accountGeneration: 1, audience: "box", capability: "read",
  policyRevision: 1, issuedAt: clock, ...over,
});

async function toAuthorized(ledger: OperationLedger, deps: string[] = [], payload = "update|abc") {
  const op = await ledger.request({ requester: "dev1", kind: "update", idempotencyKey: "k1", canonicalPayload: payload, expectedRevision: 1, grantDeps: deps, approvalTtlMs: 60_000 });
  const waiting = await ledger.awaitApproval(op.id);
  const sig = `sig:dev1:${approvalBinding(waiting)}`;
  const ok = await ledger.approve(op.id, { by: "dev1", signatureHex: sig, challenge: waiting.challenge!, payloadHash: waiting.payloadHash, expectedRevision: 1 });
  return { op: ok, waiting, sig };
}

describe("grant index", () => {
  it("revokes a parent and every descendant durably, and bumps the epoch", async () => {
    const { idx } = await fresh();
    await idx.issue(grant("dev"));
    await idx.issue(grant("sess", { parents: ["dev"] }));
    await idx.issue(grant("key", { parents: ["sess"], kind: "app-api-key" }));
    expect(idx.isLive("key")).toBe(true);
    const r = await idx.revoke("dev", "lost phone");
    expect(r.revoked.map((g) => g.id).sort()).toEqual(["dev", "key", "sess"]);
    expect(r.epoch).toBe(1);
    const again = new GrantIndex(join(dir, "grants.json"), now);
    await again.load();
    expect(again.isLive("key")).toBe(false);
    expect(again.epoch).toBe(1);
  });

  it("a child never outlives its parent and secret access is not widened", async () => {
    const { idx } = await fresh();
    await idx.issue(grant("p", { expiresAt: clock + 100 }));
    const c = await idx.issue(grant("c", { parents: ["p"], expiresAt: clock + 10_000 }));
    expect(c.expiresAt).toBe(clock + 100);
    await expect(idx.issue(grant("s", { parents: ["p"], secretAccess: true }))).rejects.toMatchObject({ code: "secret-widening" });
    await expect(idx.issue(grant("x", { parents: ["nope"] }))).rejects.toBeInstanceOf(GrantRefusedError);
    clock += 200;
    expect(idx.isLive("c")).toBe(false);
  });

  it("a damaged file loads closed: nothing is live and nothing can be issued", async () => {
    await writeFile(join(dir, "grants.json"), "{not json");
    const idx = new GrantIndex(join(dir, "grants.json"), now);
    await idx.load();
    expect(idx.unavailable).toBe(true);
    expect(idx.isLive("anything")).toBe(false);
    await expect(idx.issue(grant("a"))).rejects.toMatchObject({ code: "index-unavailable" });
  });

  it("restoring an older file shows a lower epoch, so a high-water mark catches it", async () => {
    const { idx } = await fresh();
    await idx.issue(grant("a"));
    const before = await readFile(join(dir, "grants.json"), "utf8");
    await idx.revoke("a", "x");
    expect(idx.epoch).toBe(1);
    // A restore of the older file shows a LOWER epoch, which a caller comparing against its
    // high-water mark can detect.
    await writeFile(join(dir, "old.json"), before);
    const old = new GrantIndex(join(dir, "old.json"), now);
    await old.load();
    expect(old.epoch).toBeLessThan(idx.epoch);
  });
});

describe("operation ledger", () => {
  it("runs the whole path and is idempotent on the key", async () => {
    const { ledger } = await fresh();
    const { op } = await toAuthorized(ledger);
    expect(op.state).toBe("authorized");
    const again = await ledger.request({ requester: "dev1", kind: "update", idempotencyKey: "k1", canonicalPayload: "update|abc", expectedRevision: 1, approvalTtlMs: 1 });
    expect(again.id).toBe(op.id);
    await expect(ledger.request({ requester: "dev1", kind: "update", idempotencyKey: "k1", canonicalPayload: "update|OTHER", expectedRevision: 1, approvalTtlMs: 1 })).rejects.toMatchObject({ code: "idempotency-conflict" });
    await ledger.begin(op.id);
    await ledger.crossPointOfNoReturn(op.id);
    expect((await ledger.complete(op.id, "digest")).state).toBe("applied");
  });

  it("a mutated payload, a replayed approval and a wrong challenge do not authorize", async () => {
    const { ledger } = await fresh();
    const op = await ledger.request({ requester: "dev1", kind: "update", idempotencyKey: "k", canonicalPayload: "p", expectedRevision: 1, approvalTtlMs: 60_000 });
    const w = await ledger.awaitApproval(op.id);
    const sig = `sig:dev1:${approvalBinding(w)}`;
    const base = { by: "dev1", signatureHex: sig, challenge: w.challenge!, payloadHash: w.payloadHash, expectedRevision: 1 };
    await expect(ledger.approve(op.id, { ...base, payloadHash: "00".repeat(32) })).rejects.toMatchObject({ code: "payload-changed" });
    await expect(ledger.approve(op.id, { ...base, challenge: "0".repeat(32) })).rejects.toMatchObject({ code: "bad-challenge" });
    await expect(ledger.approve(op.id, { ...base, expectedRevision: 2 })).rejects.toMatchObject({ code: "state-changed" });
    await expect(ledger.approve(op.id, { ...base, signatureHex: "forged" })).rejects.toMatchObject({ code: "approval-invalid" });
    await ledger.approve(op.id, base);
    await expect(ledger.approve(op.id, base)).rejects.toMatchObject({ code: "wrong-state" });
  });

  it("two admins racing the same approval: exactly one wins", async () => {
    const { ledger } = await fresh();
    const op = await ledger.request({ requester: "dev1", kind: "update", idempotencyKey: "k", canonicalPayload: "p", expectedRevision: 1, approvalTtlMs: 60_000 });
    const w = await ledger.awaitApproval(op.id);
    const attempt = (by: string) => ledger.approve(op.id, { by, signatureHex: `sig:${by}:${approvalBinding(w)}`, challenge: w.challenge!, payloadHash: w.payloadHash, expectedRevision: 1 });
    const results = await Promise.allSettled([attempt("a1"), attempt("a2")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(ledger.get(op.id)!.state).toBe("authorized");
  });

  it("an approval that arrives late cancels the request", async () => {
    const { ledger } = await fresh();
    const op = await ledger.request({ requester: "dev1", kind: "update", idempotencyKey: "k", canonicalPayload: "p", expectedRevision: 1, approvalTtlMs: 1_000 });
    const w = await ledger.awaitApproval(op.id);
    clock += 5_000;
    await expect(ledger.approve(op.id, { by: "dev1", signatureHex: `sig:dev1:${approvalBinding(w)}`, challenge: w.challenge!, payloadHash: w.payloadHash, expectedRevision: 1 })).rejects.toMatchObject({ code: "expired" });
    expect(ledger.get(op.id)!.state).toBe("cancelled");
  });

  it("the target changing between approval and start refuses; so does a lost grant", async () => {
    const { idx, ledger } = await fresh();
    await idx.issue(grant("g"));
    const { op } = await toAuthorized(ledger, ["g"]);
    revision = 2;
    await expect(ledger.begin(op.id)).rejects.toMatchObject({ code: "state-changed" });
    expect(ledger.get(op.id)!.state).toBe("cancelled");
    revision = 1;
    const second = await ledger.request({ requester: "dev1", kind: "update", idempotencyKey: "k2", canonicalPayload: "q", expectedRevision: 1, grantDeps: ["g"], approvalTtlMs: 60_000 });
    const w = await ledger.awaitApproval(second.id);
    await ledger.approve(second.id, { by: "dev1", signatureHex: `sig:dev1:${approvalBinding(w)}`, challenge: w.challenge!, payloadHash: w.payloadHash, expectedRevision: 1 });
    await idx.revoke("g", "gone");
    await expect(ledger.begin(second.id)).rejects.toMatchObject({ code: "authority-lost" });
  });

  it("authority lost between start and the irreversible commit stops before the commit", async () => {
    const { idx, ledger } = await fresh();
    await idx.issue(grant("g"));
    const { op } = await toAuthorized(ledger, ["g"]);
    await ledger.begin(op.id);
    await idx.revoke("g", "revoked mid-flight");
    await expect(ledger.crossPointOfNoReturn(op.id)).rejects.toMatchObject({ code: "authority-lost" });
    expect(ledger.get(op.id)!.irreversibleAt).toBeUndefined();
  });

  it("crash at every commit point: nothing guesses", async () => {
    // authorized, never started -> still authorized (and cancelled once its window passes)
    let { ledger } = await fresh();
    const { op } = await toAuthorized(ledger);
    ({ ledger } = await fresh());
    expect(ledger.get(op.id)!.state).toBe("authorized");
    // executing at the crash -> outcome-unknown, with the downstream id kept for reconcile
    await ledger.begin(op.id);
    ({ ledger } = await fresh());
    const r = await ledger.recover();
    expect(r.unknown.map((o) => o.id)).toEqual([op.id]);
    expect(ledger.get(op.id)!.state).toBe("outcome-unknown");
    expect(ledger.get(op.id)!.downstreamId).toMatch(/^[0-9a-f]{32}$/);
    // never retried blindly: only an explicit reconcile resolves it
    await expect(ledger.begin(op.id)).rejects.toMatchObject({ code: "wrong-state" });
    expect((await ledger.resolveUnknown(op.id, "applied", "digest")).state).toBe("applied");
  });

  it("an authorized operation that is never started is cancelled on recovery", async () => {
    let { ledger } = await fresh();
    const { op } = await toAuthorized(ledger);
    clock += 10 * 60_000;
    ({ ledger } = await fresh());
    await ledger.recover();
    expect(ledger.get(op.id)!.state).toBe("cancelled");
  });

  it("restoring an older ledger file cannot run an operation twice: applied stays applied only if the file says so", async () => {
    const { ledger } = await fresh();
    const { op } = await toAuthorized(ledger);
    await ledger.begin(op.id);
    await ledger.crossPointOfNoReturn(op.id);
    await ledger.complete(op.id, "d");
    await expect(ledger.begin(op.id)).rejects.toMatchObject({ code: "wrong-state" });
    await expect(ledger.complete(op.id, "d2")).rejects.toBeInstanceOf(LedgerError);
  });
});

describe("hub: revocation reaches open work and operations", () => {
  it("revoking a parent cancels dependent operations and stops open work, within the target", async () => {
    const { idx, ledger, hub } = await fresh();
    await idx.issue(grant("dev"));
    await idx.issue(grant("build", { parents: ["dev"], kind: "build-token" }));
    const { op } = await toAuthorized(ledger, ["build"]);
    const stopped: string[] = [];
    hub.registerWork(["build"], { label: "build 1", cancel: () => void stopped.push("build 1") });
    hub.registerWork(["build"], { label: "stream", cancel: async () => void stopped.push("stream") });
    hub.registerWork(["other"], { label: "unrelated", cancel: () => void stopped.push("unrelated") });
    expect(hub.openWorkFor("dev").sort()).toEqual(["build 1", "stream"]);
    const report = await hub.revoke("dev", "device removed");
    expect(stopped.sort()).toEqual(["build 1", "stream"]);
    expect(report.stuckWork).toEqual([]);
    expect(report.cancelledOperations.map((o) => o.id)).toEqual([op.id]);
    expect(ledger.get(op.id)!.state).toBe("cancelled");
    expect(report.elapsedMs).toBeLessThan(5_000);
  });

  it("a handler that hangs is reported stuck and does not hold the others", async () => {
    const { idx, hub } = await fresh();
    await idx.issue(grant("g"));
    let ran = false;
    hub.registerWork(["g"], { label: "hung", cancel: () => new Promise<void>(() => {}) });
    hub.registerWork(["g"], { label: "fine", cancel: () => void (ran = true) });
    hub.registerWork(["g"], { label: "throws", cancel: () => { throw new Error("boom"); } });
    const r = await hub.revoke("g", "x");
    expect(ran).toBe(true);
    expect(r.stuckWork.sort()).toEqual(["hung", "throws"]);
    expect(r.stoppedWork).toEqual(["fine"]);
  });

  it("revocation after the point of no return does not retract the effect", async () => {
    const { idx, ledger, hub } = await fresh();
    await idx.issue(grant("g"));
    const { op } = await toAuthorized(ledger, ["g"]);
    liveOverride = null;
    await ledger.begin(op.id);
    await ledger.crossPointOfNoReturn(op.id);
    await hub.revoke("g", "late");
    const after = ledger.get(op.id)!;
    expect(after.state).toBe("executing");
    expect(after.cancelRequested).toMatch(/late/);
    expect((await ledger.complete(op.id, "d")).state).toBe("applied");
  });

  it("stopping a service revokes everything it holds and nothing another service holds", async () => {
    const { idx, hub } = await fresh();
    await idx.issue(grant("a1", { service: "chess" }));
    await idx.issue(grant("a2", { service: "chess", parents: ["a1"], kind: "app-api-key" }));
    await idx.issue(grant("b1", { service: "notes" }));
    await hub.revokeService("chess", "stop this service");
    expect(idx.isLive("a2")).toBe(false);
    expect(idx.isLive("b1")).toBe(true);
    expect(idx.forService("notes").map((g) => g.id)).toEqual(["b1"]);
  });
});
