import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthorityHub, GrantIndex, OperationLedger, runOrderOperation, type OrderOperationInput } from "../../src/authority/index.js";
import { applyEndorsedUpdate, type PendingVerifyMarker, type PendingVerifyStore } from "../../src/updateConsumer.js";
import type { ReleaseSwapper } from "../../src/artifactUpdate.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "order-op-"));
});

async function hub() {
  const idx = new GrantIndex(join(dir, "grants.json"));
  await idx.load();
  await idx.issue({ id: "root", kind: "owner-session", issuer: "account", subject: "account", accountGeneration: 1, audience: "box", capability: "owner", policyRevision: 1, issuedAt: Date.now() });
  const ledger = new OperationLedger(join(dir, "ops.json"), {
    grantsLive: (ids, at) => ids.every((i) => idx.isLive(i, at)),
    currentRevision: () => 0,
    verifyApproval: () => false,
  });
  await ledger.load();
  return new AuthorityHub(idx, ledger);
}

const input = (over: Partial<OrderOperationInput> = {}): OrderOperationInput => ({
  kind: "server-update", requester: "owner", idempotencyKey: "k", canonicalPayload: "p", grantDeps: ["root"],
  approvedBy: "admin", orderSignatureHex: "ab", label: "test", ...over,
});

describe("runOrderOperation", () => {
  it("records a successful run as applied and refuses to run the same order twice", async () => {
    const h = await hub();
    let runs = 0;
    const exec = async () => { runs += 1; return { value: "ok", resultDigest: "d" }; };
    const first = await runOrderOperation(h, input(), exec);
    expect(first).toMatchObject({ ran: true, value: "ok" });
    expect(h.ops.list({ kind: "server-update" })[0]?.state).toBe("applied");
    const again = await runOrderOperation(h, input(), exec);
    expect(again).toMatchObject({ ran: false, reason: "already-applied" });
    expect(runs).toBe(1);
  });

  it("records a failure and lets a fresh attempt of the same order run", async () => {
    const h = await hub();
    await expect(runOrderOperation(h, input(), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(h.ops.list()[0]?.state).toBe("failed");
    const retry = await runOrderOperation(h, input(), async () => ({ value: 1, resultDigest: "d" }));
    expect(retry.ran).toBe(true);
  });

  it("refuses to cross the point of no return once its grant is revoked, and stops the work", async () => {
    const h = await hub();
    let reached = false;
    const res = await runOrderOperation(h, input(), async (ctx) => {
      await h.revoke("root", "owner signed out");
      expect(ctx.cancelled).toBe(true);
      await ctx.crossPointOfNoReturn();
      reached = true;
      return { value: 1, resultDigest: "d" };
    });
    expect(reached).toBe(false);
    expect(res).toMatchObject({ ran: false, reason: "refused" });
  });
});

describe("applyEndorsedUpdate as an operation", () => {
  function pending(): PendingVerifyStore & { marker: PendingVerifyMarker | null } {
    const s = { marker: null as PendingVerifyMarker | null, read: async () => s.marker, write: async (m: PendingVerifyMarker) => { s.marker = m; }, clear: async () => { s.marker = null; } };
    return s;
  }
  const swapper = (calls: string[]): ReleaseSwapper => ({
    install: async (c: string) => { calls.push(`install ${c}`); },
    restore: async (c: string) => { calls.push(`restore ${c}`); },
  } as unknown as ReleaseSwapper);

  it("swaps the release and records the operation as applied", async () => {
    const h = await hub();
    const calls: string[] = [];
    let exits = 0;
    const out = await applyEndorsedUpdate(
      { swapper: swapper(calls), pendingStore: pending(), requestExit: () => { exits += 1; }, operations: { hub: h, grantDeps: ["root"] } },
      "aaaa1111", "bbbb2222", "test", { requester: "owner", by: "admin", signatureHex: "cd" },
    );
    expect(out.applied).toBe(true);
    expect(calls).toEqual(["install bbbb2222"]);
    expect(exits).toBe(1);
    expect(h.ops.list({ kind: "server-update" })[0]?.state).toBe("applied");
  });

  it("does not swap when the grant was revoked before the swap", async () => {
    const h = await hub();
    await h.revoke("root", "signed out");
    const calls: string[] = [];
    const out = await applyEndorsedUpdate(
      { swapper: swapper(calls), pendingStore: pending(), requestExit: () => {}, operations: { hub: h, grantDeps: ["root"] } },
      "aaaa1111", "bbbb2222", "test", { requester: "owner", by: "admin", signatureHex: "cd" },
    );
    expect(out.applied).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("evidence of authority events", () => {
  it("is told of each operation state and each revocation, with no bodies in it", async () => {
    const h = await hub();
    const ops: string[] = [];
    const revs: Array<{ grants: number; kinds: string[]; reason: string }> = [];
    h.ops.onTransition = (op) => ops.push(`${op.kind}:${op.state}`);
    h.onRevocation = (e) => revs.push(e);
    await runOrderOperation(h, input({ canonicalPayload: "secret-bearing payload" }), async () => ({ value: 1, resultDigest: "d" }));
    expect(ops).toEqual(["server-update:requested", "server-update:authorized", "server-update:executing", "server-update:applied"]);
    await h.revoke("root", "owner signed out");
    expect(revs).toEqual([expect.objectContaining({ grants: 1, kinds: ["owner-session"], reason: "owner signed out" })]);
    expect(JSON.stringify([ops, revs])).not.toContain("secret-bearing");
  });

  it("a sink that throws does not stop the operation or the revocation", async () => {
    const h = await hub();
    h.ops.onTransition = () => { throw new Error("log full"); };
    h.onRevocation = () => { throw new Error("log full"); };
    expect((await runOrderOperation(h, input(), async () => ({ value: 1, resultDigest: "d" }))).ran).toBe(true);
    await expect(h.revoke("root", "x")).resolves.toBeDefined();
  });
});
