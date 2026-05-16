/**
 * Pure-logic tests for scripts/demo-account.mjs (#83). The interactive
 * shell + the real wrangler/flyctl/R2 mutations are NOT exercised
 * (real-infra + irreversible — operator steps). The security-critical
 * parts ARE: the registered-operator Ed25519 gate (fail-closed,
 * replay-bounded, challenge-bound) and the provision/decommission
 * manifests (the HARD-delete plan must cover every user-linked table).
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs sibling, no types
import {
  parseArgs,
  operatorChallenge,
  genEd25519,
  signEd25519,
  verifyEd25519,
  readAuthorizedOperators,
  verifyOperatorAuthorization,
  planProvision,
  planDecommission,
  USER_LINKED_TABLES,
} from "./demo-account.mjs";

describe("parseArgs", () => {
  it("splits command / --flag value / --flag=value / bare --flag", () => {
    const a = parseArgs(["decommission", "--user", "demo", "--execute", "--op-at=5"]);
    expect(a.command).toBe("decommission");
    expect(a.flags.user).toBe("demo");
    expect(a.flags.execute).toBe(true);
    expect(a.flags["op-at"]).toBe("5");
  });
  it("defaults the command to help", () => {
    expect(parseArgs([]).command).toBe("help");
  });
});

describe("operatorChallenge", () => {
  it("is the exact pipe-joined canonical form", () => {
    expect(operatorChallenge("provision", "demo", 17).toString("utf8"))
      .toBe("flagship/demo-operator/v1|provision|demo|17");
  });
  it("rejects separator / control chars in fields", () => {
    expect(() => operatorChallenge("provision", "a|b", 1)).toThrow();
    expect(() => operatorChallenge("prov\nision", "demo", 1)).toThrow();
  });
});

describe("Ed25519 operator gate", () => {
  it("genEd25519 → sign → verify round-trips; a tampered msg/key fails", () => {
    const { seedHex, pubHex } = genEd25519();
    expect(seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(pubHex).toMatch(/^[0-9a-f]{64}$/);
    const msg = operatorChallenge("decommission", "demo", 100);
    const sig = signEd25519(seedHex, msg);
    expect(verifyEd25519(pubHex, msg, sig)).toBe(true);
    expect(verifyEd25519(pubHex, Buffer.from("other"), sig)).toBe(false);
    const other = genEd25519();
    expect(verifyEd25519(other.pubHex, msg, sig)).toBe(false);
  });
});

describe("readAuthorizedOperators", () => {
  it("reads $DEMO_OPERATOR_PUBS (comma-sep, lowercased)", () => {
    const ops = readAuthorizedOperators({ env: { DEMO_OPERATOR_PUBS: "AABB, ccdd " }, file: "/nope" });
    expect(ops).toEqual(["aabb", "ccdd"]);
  });
  it("empty when neither env nor file present (fail closed)", () => {
    expect(readAuthorizedOperators({ env: {}, file: "/definitely/not/here.json" })).toEqual([]);
  });
});

describe("verifyOperatorAuthorization (fail-closed)", () => {
  const { seedHex, pubHex } = genEd25519();
  const fresh = (op: string, user: string, at: number) => ({
    pubHex, sigHex: signEd25519(seedHex, operatorChallenge(op, user, at)), issuedAt: at,
  });

  it("ok with a pinned signer + fresh, challenge-bound signature", () => {
    const r = verifyOperatorAuthorization({
      op: "provision", username: "demo",
      assertion: fresh("provision", "demo", 1_000), authorized: [pubHex], nowMs: 1_000,
    });
    expect(r.ok).toBe(true);
  });
  it("refuses when no operators are pinned", () => {
    const r = verifyOperatorAuthorization({
      op: "provision", username: "demo",
      assertion: fresh("provision", "demo", 1_000), authorized: [], nowMs: 1_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no registered operators/);
  });
  it("refuses an unpinned signer", () => {
    const evil = genEd25519();
    const r = verifyOperatorAuthorization({
      op: "provision", username: "demo",
      assertion: { pubHex: evil.pubHex, sigHex: signEd25519(evil.seedHex, operatorChallenge("provision", "demo", 1)), issuedAt: 1 },
      authorized: [pubHex], nowMs: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a pinned/);
  });
  it("refuses a stale assertion (>5min)", () => {
    const r = verifyOperatorAuthorization({
      op: "provision", username: "demo",
      assertion: fresh("provision", "demo", 0), authorized: [pubHex], nowMs: 6 * 60_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/stale/);
  });
  it("refuses a signature bound to a DIFFERENT op/user (no cross-use)", () => {
    const r = verifyOperatorAuthorization({
      op: "decommission", username: "demo",            // verifying decommission…
      assertion: fresh("provision", "demo", 1_000),    // …with a provision signature
      authorized: [pubHex], nowMs: 1_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not verify/);
  });
});

describe("planProvision", () => {
  it("marks is_demo, seeds a tier row, provisions a VPS, notes the LLM cap", () => {
    const ops = planProvision("Demo");
    const kinds = ops.map((o: { kind: string }) => o.kind);
    expect(kinds).toEqual(["d1", "d1", "vps", "llm-cap", "creds"]);
    expect(ops[0].sql).toMatch(/is_demo=1/);
    expect(ops[0].sql).toMatch(/'demo'/); // lowercased
  });
});

describe("planDecommission (HARD-delete manifest)", () => {
  const ops = planDecommission("Demo");
  it("clears routing + destroys the VM BEFORE any D1 delete", () => {
    const firstD1 = ops.findIndex((o: { kind: string }) => o.kind === "d1");
    const routingIdx = ops.findIndex((o: { kind: string }) => o.kind === "routing");
    const vpsIdx = ops.findIndex((o: { kind: string }) => o.kind === "vps");
    expect(routingIdx).toBeGreaterThanOrEqual(0);
    expect(vpsIdx).toBeGreaterThanOrEqual(0);
    expect(routingIdx).toBeLessThan(firstD1);
    expect(vpsIdx).toBeLessThan(firstD1);
  });
  it("DELETEs every user-linked table (no row left behind), lowercased", () => {
    for (const { table, col } of USER_LINKED_TABLES) {
      const op = ops.find((o: { sql?: string }) => o.sql === `DELETE FROM ${table} WHERE ${col} = 'demo'`);
      expect(op, `missing DELETE for ${table}`).toBeTruthy();
    }
    // custom_domain_orders is keyed by user_id, not username.
    expect(USER_LINKED_TABLES.find((t: { table: string }) => t.table === "custom_domain_orders")!.col).toBe("user_id");
    // and an R2 prune is included.
    expect(ops.some((o: { kind: string }) => o.kind === "r2")).toBe(true);
  });
});
