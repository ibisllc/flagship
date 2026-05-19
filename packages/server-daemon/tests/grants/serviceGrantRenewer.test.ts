/**
 * #91 — ServiceGrant background renewer tests.
 *
 * Walks the matrix: grants within window get renewed, grants far from
 * expiry are skipped, revoked grants are skipped, explicit-renewal
 * grants are skipped, signature self-verifies on every renewal.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_RENEW_WINDOW_MS,
  isInRenewalWindow,
  renewOne,
  runRenewal,
  type GrantWithMeta,
  type RenewerDeps,
} from "../../src/grants/serviceGrantRenewer.js";
import {
  deriveIRK,
  deriveSTK,
  deriveSWK,
  signServiceGrant,
  verifyServiceGrant,
  type ServiceGrant,
} from "@flagship/protocol";

const umk = { seed: new Uint8Array(32).fill(7) };
const irk = deriveIRK(umk);
const stk = deriveSTK(deriveSWK(umk, "home"));

function fixture(opts: { expiresInMs: number; requiresExplicit?: boolean }): GrantWithMeta {
  const now = 1_780_000_000_000;
  const g: ServiceGrant = {
    grantId: `g-${Math.random().toString(36).slice(2, 10)}`,
    username: "harry",
    serviceCanonical: "notes@abc123def456",
    serverDomains: ["home.harry.flagship.services"],
    serverIdentities: [stk.publicKey],
    routes: [{ url: "home.harry.flagship.services", scope: "canonical" }],
    issuedAt: now - 24 * 60 * 60_000,
    expiresAt: now + opts.expiresInMs,
  };
  return {
    grant: g,
    signature: signServiceGrant(g, irk),
    requiresExplicitRenewal: opts.requiresExplicit ?? false,
  };
}

interface Harness {
  saved: GrantWithMeta[];
  distributed: GrantWithMeta[];
  deps: RenewerDeps;
}

function harness(input: GrantWithMeta[], now: number, revoked: Set<string> = new Set()): Harness {
  const saved: GrantWithMeta[] = [];
  const distributed: GrantWithMeta[] = [];
  return {
    saved,
    distributed,
    deps: {
      listGrants: async () => input,
      saveGrant: async (g) => {
        saved.push(g);
      },
      distribute: async (g) => {
        distributed.push(g);
      },
      isRevoked: async (id) => revoked.has(id),
      irk,
      now: () => now,
    },
  };
}

describe("ServiceGrant renewer (#91)", () => {
  const NOW = 1_780_000_000_000;

  it("renews a grant within the renewal window", async () => {
    const cur = fixture({ expiresInMs: 12 * 60 * 60_000 }); // 12h from expiry
    const h = harness([cur], NOW);
    const run = await runRenewal(h.deps);
    expect(run.renewed).toBe(1);
    expect(run.skippedFarFromExpiry).toBe(0);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.grant.grantId).not.toBe(cur.grant.grantId);
    expect(h.distributed).toHaveLength(1);
  });

  it("skips a grant far from expiry", async () => {
    const cur = fixture({ expiresInMs: 6 * 24 * 60 * 60_000 }); // 6d remaining
    const h = harness([cur], NOW);
    const run = await runRenewal(h.deps);
    expect(run.renewed).toBe(0);
    expect(run.skippedFarFromExpiry).toBe(1);
    expect(h.saved).toHaveLength(0);
  });

  it("skips an explicit-renewal grant even when in window", async () => {
    const cur = fixture({ expiresInMs: 12 * 60 * 60_000, requiresExplicit: true });
    const h = harness([cur], NOW);
    const run = await runRenewal(h.deps);
    expect(run.renewed).toBe(0);
    expect(run.skippedExplicit).toBe(1);
    expect(h.saved).toHaveLength(0);
  });

  it("skips a revoked grant", async () => {
    const cur = fixture({ expiresInMs: 12 * 60 * 60_000 });
    const h = harness([cur], NOW, new Set([cur.grant.grantId]));
    const run = await runRenewal(h.deps);
    expect(run.renewed).toBe(0);
    expect(run.skippedRevoked).toBe(1);
  });

  it("a renewed grant carries over content unchanged but rolls grantId + dates", async () => {
    const cur = fixture({ expiresInMs: 12 * 60 * 60_000 });
    const h = harness([cur], NOW);
    await runRenewal(h.deps);
    const next = h.saved[0]!.grant;
    expect(next.serviceCanonical).toBe(cur.grant.serviceCanonical);
    expect(next.username).toBe(cur.grant.username);
    expect(next.serverDomains).toEqual(cur.grant.serverDomains);
    expect(next.routes).toEqual(cur.grant.routes);
    expect(next.issuedAt).toBe(NOW);
    expect(next.expiresAt).toBe(NOW + DEFAULT_GRANT_TTL_MS);
    expect(next.grantId).not.toBe(cur.grant.grantId);
  });

  it("renewed signature verifies under the user's IRK", async () => {
    const cur = fixture({ expiresInMs: 12 * 60 * 60_000 });
    const h = harness([cur], NOW);
    await runRenewal(h.deps);
    const saved = h.saved[0]!;
    expect(verifyServiceGrant(saved.grant, saved.signature, irk.publicKey)).toBe(true);
  });

  it("a distribute failure does not roll back the save", async () => {
    const cur = fixture({ expiresInMs: 12 * 60 * 60_000 });
    const h = harness([cur], NOW);
    h.deps.distribute = async () => {
      throw new Error("sibling-WS unreachable");
    };
    const run = await runRenewal(h.deps);
    expect(run.renewed).toBe(1);
    expect(run.failed).toHaveLength(1);
    expect(run.failed[0]!.reason).toMatch(/sibling-WS unreachable/);
    expect(h.saved).toHaveLength(1);
  });

  it("mixed list — some renewed, some skipped — returns the right counts", async () => {
    const grants = [
      fixture({ expiresInMs: 12 * 60 * 60_000 }), // renew
      fixture({ expiresInMs: 5 * 24 * 60 * 60_000 }), // skip far
      fixture({ expiresInMs: 12 * 60 * 60_000, requiresExplicit: true }), // skip explicit
      fixture({ expiresInMs: 12 * 60 * 60_000 }), // renew
    ];
    const h = harness(grants, NOW);
    const run = await runRenewal(h.deps);
    expect(run.considered).toBe(4);
    expect(run.renewed).toBe(2);
    expect(run.skippedFarFromExpiry).toBe(1);
    expect(run.skippedExplicit).toBe(1);
  });

  it("renewOne is callable directly with a custom idgen", () => {
    const cur = fixture({ expiresInMs: 12 * 60 * 60_000 });
    const next = renewOne(cur, irk, NOW, DEFAULT_GRANT_TTL_MS, () => "deterministic-id");
    expect(next.grant.grantId).toBe("deterministic-id");
  });

  it("isInRenewalWindow returns true for grants close to expiry", () => {
    const cur = fixture({ expiresInMs: 12 * 60 * 60_000 });
    expect(isInRenewalWindow(cur.grant, NOW)).toBe(true);
  });

  it("isInRenewalWindow returns false for grants comfortably in their active window", () => {
    const cur = fixture({ expiresInMs: 5 * 24 * 60 * 60_000 });
    expect(isInRenewalWindow(cur.grant, NOW, DEFAULT_RENEW_WINDOW_MS)).toBe(false);
  });
});
