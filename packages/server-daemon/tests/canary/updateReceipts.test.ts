import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canaryCohort, parseUpdateReceipt } from "@flagship/protocol";
import { UpdateReceiptReporter, buildUpdateReportsHttp, loadRolloutSalt } from "../../src/canary/updateReceipts.js";
import type { UpdateOutcomeRecord } from "../../src/updateOutcome.js";
import { parseUpdateOutcome } from "../../src/updateOutcome.js";
import type { HttpRequest } from "../../src/runtime.js";

const T = "0123456789abcdef0123456789abcdef01234567";
const P = "fedcba9876543210fedcba9876543210fedcba98";

function setup(o: { share?: boolean; outcome?: UpdateOutcomeRecord | null; status?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "receipts-"));
  let outcome = o.outcome ?? null;
  let now = 1_000_000;
  const posted: { url: string; body: string; headers: Record<string, string> }[] = [];
  let status = o.status ?? 200;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    posted.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  const r = new UpdateReceiptReporter({
    consentPath: join(dir, "update-reports.json"),
    outboxPath: join(dir, "outbox.json"),
    salt: () => "a".repeat(64),
    stack: () => "arch-v2",
    outcome: () => outcome,
    controlBase: "https://com.test/",
    defaultShare: o.share ?? false,
    arch: "arm64",
    fetchImpl,
    now: () => now,
    random: () => 0,
  });
  return {
    dir,
    r,
    posted,
    setOutcome: (x: UpdateOutcomeRecord | null) => (outcome = x),
    advance: (ms: number) => (now += ms),
    setStatus: (s: number) => (status = s),
  };
}

describe("rollout salt", () => {
  it("is made once, kept private and secret-sized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "salt-"));
    const p = join(dir, "rollout-salt");
    const a = await loadRolloutSalt(p);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadRolloutSalt(p)).toBe(a);
    expect(statSync(p).mode & 0o077).toBe(0);
  });

  it("replaces a damaged file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "salt-"));
    const p = join(dir, "rollout-salt");
    writeFileSync(p, "home.alice.flagship.services\n");
    expect(await loadRolloutSalt(p)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("update receipts on the box", () => {
  it("sends nothing while the owner has not agreed", async () => {
    const s = setup({ outcome: { outcome: "applied", at: 5, targetCommit: T, previousCommit: P, bootAttempts: 1 } });
    expect(await s.r.sync()).toBe("not-shared");
    expect(await s.r.flush()).toEqual({ sent: 0, kept: 0 });
    expect(s.posted).toHaveLength(0);
    // agreeing later does not send the verdict reached while sharing was off
    await s.r.setConsent(true);
    expect(await s.r.sync()).toBe("seen");
    await s.r.flush();
    expect(s.posted).toHaveLength(0);
  });

  it("sends one content-free receipt for an applied update, with no session or name", async () => {
    const s = setup({ share: true, outcome: { outcome: "applied", at: 5, targetCommit: T, previousCommit: P, bootAttempts: 1 } });
    expect(await s.r.sync()).toBe("queued");
    expect(await s.r.flush()).toEqual({ sent: 1, kept: 0 });
    expect(s.posted).toHaveLength(1);
    expect(s.posted[0]!.url).toBe("https://com.test/api/update-receipts");
    expect(Object.keys(s.posted[0]!.headers)).toEqual(["content-type"]);
    const body = JSON.parse(s.posted[0]!.body);
    expect(parseUpdateReceipt(body)).not.toBeNull();
    expect(body).toMatchObject({ release: T, healthGate: "pass", rolledBack: false, arch: "arm64", stack: "arch-v2", cohort: canaryCohort("a".repeat(64), T) });
    expect(s.posted[0]!.body).not.toContain(P);
    // the same verdict is never sent twice
    expect(await s.r.sync()).toBe("seen");
    await s.r.flush();
    expect(s.posted).toHaveLength(1);
  });

  it("reports a rollback, and a refused rollback (below the floor) as failed without rollback", async () => {
    const s = setup({ share: true, outcome: { outcome: "rolled-back", at: 5, targetCommit: T, previousCommit: P, bootAttempts: 3 } });
    await s.r.sync();
    await s.r.flush();
    expect(JSON.parse(s.posted[0]!.body)).toMatchObject({ healthGate: "fail", rolledBack: true });
    s.setOutcome({ outcome: "rolled-back", at: 9, targetCommit: T, previousCommit: P, bootAttempts: 3, rollbackRefused: true });
    await s.r.sync();
    await s.r.flush();
    expect(JSON.parse(s.posted[1]!.body)).toMatchObject({ healthGate: "fail", rolledBack: false });
  });

  it("ignores a refused order: nothing changed, so it says nothing about the release", async () => {
    const s = setup({ share: true, outcome: { outcome: "refused", at: 5, reason: "unendorsed" } });
    expect(await s.r.sync()).toBe("none");
    await s.r.flush();
    expect(s.posted).toHaveLength(0);
  });

  it("waits out the random delay, keeps a receipt through server errors, drops one refused as malformed", async () => {
    const s = setup({ share: true, outcome: { outcome: "applied", at: 5, targetCommit: T } });
    const delayed = new UpdateReceiptReporter({
      consentPath: join(s.dir, "update-reports.json"),
      outboxPath: join(s.dir, "outbox2.json"),
      salt: () => "b".repeat(64),
      stack: () => "classic",
      outcome: () => ({ outcome: "applied", at: 5, targetCommit: T }),
      controlBase: "https://com.test",
      defaultShare: true,
      fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      now: () => 0,
      random: () => 0.5,
    });
    await delayed.sync();
    expect(await delayed.flush()).toEqual({ sent: 0, kept: 1 }); // not due yet
    s.setStatus(503);
    await s.r.sync();
    expect(await s.r.flush()).toEqual({ sent: 0, kept: 1 });
    s.setStatus(400);
    expect(await s.r.flush()).toEqual({ sent: 0, kept: 0 });
  });

  it("drops the queue when the owner turns sharing off", async () => {
    const s = setup({ share: true, outcome: { outcome: "applied", at: 5, targetCommit: T } });
    s.setStatus(503);
    await s.r.sync();
    await s.r.flush();
    await s.r.setConsent(false);
    s.setStatus(200);
    expect(await s.r.flush()).toEqual({ sent: 0, kept: 0 });
    expect(s.posted).toHaveLength(1); // only the failed first try
  });
});

describe("GET/POST /api/update-reports", () => {
  const req = (method: string, body = ""): HttpRequest => ({ method, path: "/api/update-reports", headers: {}, body: Buffer.from(body) });
  it("is behind the owner gate and stores the choice", async () => {
    const s = setup();
    const open = buildUpdateReportsHttp({ reporter: s.r, gate: { check: () => null } });
    const closed = buildUpdateReportsHttp({ reporter: s.r, gate: { check: () => ({ status: 403, body: "no" }) } });
    expect((await closed(req("POST", JSON.stringify({ share: true }))))!.status).toBe(403);
    expect(JSON.parse(String((await open(req("GET")))!.body))).toMatchObject({ share: false, source: "default" });
    expect((await open(req("POST", JSON.stringify({ share: "yes" }))))!.status).toBe(400);
    expect((await open(req("POST", JSON.stringify({ share: true }))))!.status).toBe(200);
    expect(JSON.parse(String((await open(req("GET")))!.body))).toMatchObject({ share: true, source: "owner" });
    expect(JSON.parse(readFileSync(join(s.dir, "update-reports.json"), "utf8")).share).toBe(true);
    expect(await open({ ...req("GET"), path: "/api/other" })).toBeNull();
  });
});

describe("update outcome record", () => {
  it("keeps the rollback-refused flag only on a rolled-back verdict", () => {
    expect(parseUpdateOutcome({ outcome: "rolled-back", at: 1, rollbackRefused: true })).toMatchObject({ rollbackRefused: true });
    expect(parseUpdateOutcome({ outcome: "applied", at: 1, rollbackRefused: true })).not.toHaveProperty("rollbackRefused");
  });
});
