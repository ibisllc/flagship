import { describe, it, expect } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import {
  deriveIRK,
  deriveAccountId,
  deriveHouseholdKey,
  ed,
  verifySetDeadManPolicy,
  serviceInviteSecretHash,
  type Keypair,
} from "@flagship/protocol";

import {
  checkRestrictedMode,
  checkAdminGate,
  checkRevocationReachesBox,
  checkDebugAccessAuthority,
  checkTransferRehomeAuthority,
  runEnforcementChecks,
  type EnforcementContext,
  type EnforcementKeys,
  type EnforcementTarget,
  type WireResponse,
  type HttpFn,
  type RawFn,
  type CheckOutcome,
} from "../src/enforcement/checks.js";
import { rollup, verdictExitCode, renderReport } from "../src/enforcement/report.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const ZERO_SIG = "00".repeat(64);
const NOW = 1_700_000_000_000;
const now = () => NOW;

function rawKey(fill: number): Keypair {
  const seed = new Uint8Array(32).fill(fill);
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

function makeKeys(overrides: Partial<EnforcementKeys> = {}): EnforcementKeys {
  const ownerUmk = { seed: new Uint8Array(32).fill(0x11) };
  const authorUmk = { seed: new Uint8Array(32).fill(0x22) };
  const friendUmk = { seed: new Uint8Array(32).fill(0x33) };
  const acquirerUmk = { seed: new Uint8Array(32).fill(0x44) };
  return {
    ownerIrk: deriveIRK(ownerUmk),
    attacker: rawKey(0x55),
    friendAid: deriveAccountId(friendUmk),
    author: {
      aid: deriveAccountId(authorUmk),
      device: deriveIRK(authorUmk),
      householdKey: deriveHouseholdKey(authorUmk),
    },
    acquirerIrk: deriveIRK(acquirerUmk),
    adminRoot: rawKey(0x66),
    ...overrides,
  };
}

const TARGET: EnforcementTarget = {
  control: "gym.example.com",
  servicesApex: "gym.flagship.services",
  user: "gymdemo",
  fqdn: "home.gymdemo.gym.flagship.services",
  serviceSlug: "gate",
  serviceRef: "gymdemo--gate",
};

function R(status: number, text = "", json: unknown = null): WireResponse {
  return { status, text, json, setCookies: [] };
}

function ctx(http: HttpFn, raw: RawFn, keys = makeKeys()): EnforcementContext {
  return { http, raw, now, target: TARGET, keys };
}

const throwingHttp: HttpFn = async () => {
  throw new Error("ECONNREFUSED (no box)");
};
const throwingRaw: RawFn = async () => {
  throw new Error("ECONNREFUSED (no box)");
};
const gatedRaw: RawFn = async () => R(403, "forbidden");

// ── Control 1: restricted-mode on the real request path ─────────────────────────

describe("control 1 — restricted-mode on the real request path (GAP-1)", () => {
  // An ENFORCING box: every path (tier-1, tier-2, raw absent/spoof Host) knocks
  // or 403s; a non-browser request is a hard 403.
  const enforcingHttp: HttpFn = async (_url, init) => {
    if (init?.headers?.accept === "application/json") return R(403, "forbidden");
    return R(200, "Access is restricted — open flagship://access?page=abc to knock");
  };
  // A BYPASSED box: tier-1 gates, but the tier-2 leader-routed URL serves the app
  // ungated (the exact GAP-1 class).
  const bypassHttp: HttpFn = async (url, init) => {
    const isTier1 = url.includes(`gate.${TARGET.fqdn}`);
    if (isTier1) {
      if (init?.headers?.accept === "application/json") return R(403, "forbidden");
      return R(200, "Access is restricted flagship://access?page=x");
    }
    return R(200, "Hostname: gate-abc\nRemoteAddr: 10.0.0.1\nGET / HTTP/1.1");
  };

  it("ENFORCED when tier-1, tier-2, and raw spoof/absent-Host all gate", async () => {
    const o = await checkRestrictedMode(ctx(enforcingHttp, gatedRaw));
    expect(o.status).toBe("enforced");
    expect(o.assertions).toHaveLength(5);
    expect(o.assertions.every((a) => a.ok)).toBe(true);
  });

  it("BYPASSED when the tier-2 leader-routed URL serves the restricted app ungated", async () => {
    const o = await checkRestrictedMode(ctx(bypassHttp, gatedRaw));
    expect(o.status).toBe("bypassed");
    const tier2 = o.assertions.find((a) => a.label.includes("tier-2"))!;
    expect(tier2.ok).toBe(false);
    expect(tier2.detail).toContain("UNGATED");
  });

  it("BYPASSED when a raw absent-Host request serves the app ungated", async () => {
    const servingRaw: RawFn = async () => R(200, "Hostname: x\nGET / HTTP/1.1");
    const o = await checkRestrictedMode(ctx(enforcingHttp, servingRaw));
    expect(o.status).toBe("bypassed");
    expect(o.assertions.some((a) => a.label.includes("ABSENT Host") && !a.ok)).toBe(true);
  });

  it("SKIPPED (not passed) when the box is unreachable", async () => {
    const o = await checkRestrictedMode(ctx(throwingHttp, throwingRaw));
    expect(o.status).toBe("skipped");
    expect(o.skipReason).toContain("ECONNREFUSED");
    expect(o.assertions).toHaveLength(0);
  });

  it("SKIPPED when tier-1 is neither gated nor serving (service not up) — never a false pass", async () => {
    const notUp: HttpFn = async () => R(502, "bad gateway");
    const o = await checkRestrictedMode(ctx(notUp, gatedRaw));
    expect(o.status).toBe("skipped");
    expect(o.skipReason).toContain("inconclusive");
  });
});

// ── Control 2: admin gate rejects a non-admin ───────────────────────────────────

describe("control 2 — admin gate rejects a non-admin on the real path", () => {
  const keys = makeKeys();
  // ENFORCING box: verifies the dead-man policy signature under the pinned owner.
  const enforcingHttp: HttpFn = async (_url, init) => {
    const body = JSON.parse(init!.body!);
    if (body.signature === ZERO_SIG) return R(401, "bad sig");
    const ok = verifySetDeadManPolicy(body.request, hexToBytes(body.signature), keys.ownerIrk.publicKey);
    return ok ? R(200, JSON.stringify({ enabled: false })) : R(403, "not the owner");
  };
  // BYPASSED box: accepts ANY signature (the gate doesn't verify the signer).
  const bypassHttp: HttpFn = async () => R(200, JSON.stringify({ enabled: false }));

  it("ENFORCED: owner accepted, non-owner + forged rejected, admin-root boundary holds", async () => {
    const o = await checkAdminGate(ctx(enforcingHttp, gatedRaw, keys));
    expect(o.status).toBe("enforced");
    expect(o.assertions.every((a) => a.ok)).toBe(true);
    // The deterministic admin-root boundary is present + carried as a deferred TODO.
    expect(o.deferred?.deterministic).toBe(true);
    expect(o.assertions.some((a) => a.label.includes("membership IRK is NOT master admin"))).toBe(true);
  });

  it("BYPASSED when a non-owner signature is accepted by the box", async () => {
    const o = await checkAdminGate(ctx(bypassHttp, gatedRaw, keys));
    expect(o.status).toBe("bypassed");
    expect(o.assertions.some((a) => a.label.includes("NON-owner") && !a.ok)).toBe(true);
  });

  it("BYPASSED (boundary broken) if a membership IRK equals the pinned admin root", async () => {
    // If the owner IRK IS the admin root, a membership signer would be master
    // admin — the deterministic boundary assertion must flip to red.
    const broken = makeKeys({ adminRoot: makeKeys().ownerIrk });
    const o = await checkAdminGate(ctx(enforcingHttp, gatedRaw, broken));
    expect(o.status).toBe("bypassed");
  });

  it("SKIPPED (not passed) when the box is unreachable", async () => {
    const o = await checkAdminGate(ctx(throwingHttp, throwingRaw, keys));
    expect(o.status).toBe("skipped");
  });
});

// ── Control 3: revocation reaches the box ───────────────────────────────────────

describe("control 3 — revocation reaches the box", () => {
  // A faithful .com + box stub: mint records inviteId→secretHash; revoke marks the
  // hash; redeem (box→.com) denies a revoked hash. `bypass` never denies.
  function inviteFake(mode: "enforce" | "bypass"): HttpFn {
    const idToHash = new Map<string, string>();
    const revoked = new Set<string>();
    return async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (url.endsWith("/service-invites")) {
        idToHash.set(body.request.inviteId, body.request.secretHash);
        return R(200, "{}", {});
      }
      if (url.endsWith("/service-invites/revoke")) {
        const h = idToHash.get(body.request.inviteId);
        if (h) revoked.add(h);
        return R(200, "{}", {});
      }
      if (url.endsWith("/api/service-invites/redeem")) {
        const hash = serviceInviteSecretHash(hexToBytes(body.secret));
        if (mode === "enforce" && revoked.has(hash)) return R(403, "invite revoked");
        return R(200, "{}", { boundAID: body.visitorAID });
      }
      return R(404, "not found");
    };
  }

  it("ENFORCED: an un-revoked invite redeems, a revoked one is denied at the box", async () => {
    const o = await checkRevocationReachesBox(ctx(inviteFake("enforce"), gatedRaw));
    expect(o.status).toBe("enforced");
    expect(o.assertions.find((a) => a.label.includes("baseline"))!.ok).toBe(true);
    expect(o.assertions.find((a) => a.label.includes("REVOKED invite is DENIED"))!.ok).toBe(true);
  });

  it("BYPASSED when a revoked invite still redeems (revocation never reached the box)", async () => {
    const o = await checkRevocationReachesBox(ctx(inviteFake("bypass"), gatedRaw));
    expect(o.status).toBe("bypassed");
    expect(o.assertions.find((a) => a.label.includes("REVOKED invite is DENIED"))!.ok).toBe(false);
  });

  it("SKIPPED (not passed) when the invite mint/revoke setup fails", async () => {
    const failMint: HttpFn = async () => R(500, "control-plane error");
    const o = await checkRevocationReachesBox(ctx(failMint, gatedRaw));
    expect(o.status).toBe("skipped");
    expect(o.skipReason).toContain("mint failed");
  });
});

// ── Control 4: debug-access requires the admin authority ────────────────────────

describe("control 4 — debug-access requires the admin authority", () => {
  const noop: HttpFn = async () => R(200);

  it("ENFORCED deterministically: membership grant refused under a pinned root, admin root accepted, forged rejected", async () => {
    const o = await checkDebugAccessAuthority(ctx(noop, gatedRaw));
    expect(o.status).toBe("enforced");
    expect(o.assertions.every((a) => a.ok)).toBe(true);
    expect(o.deferred?.deterministic).toBe(true);
    expect(o.deferred?.todo).toContain("LAN SSH");
  });

  it("BYPASSED (boundary broken) if the membership IRK equals the pinned admin root", async () => {
    const broken = makeKeys({ adminRoot: makeKeys().ownerIrk });
    const o = await checkDebugAccessAuthority(ctx(noop, gatedRaw, broken));
    expect(o.status).toBe("bypassed");
    expect(o.assertions.some((a) => a.label.includes("NOT the admin authority") && !a.ok)).toBe(true);
  });
});

// ── Control 5: transfer re-home requires the giver signature ─────────────────────

describe("control 5 — transfer re-home requires the giver signature (GAP-3)", () => {
  const noop: HttpFn = async () => R(200);

  it("ENFORCED deterministically: a valid giver sig accepted; forged/non-giver/tampered refused", async () => {
    const o = await checkTransferRehomeAuthority(ctx(noop, gatedRaw));
    expect(o.status).toBe("enforced");
    expect(o.assertions).toHaveLength(5);
    expect(o.assertions.every((a) => a.ok)).toBe(true);
    expect(o.assertions.some((a) => a.label.includes("ABSENT/forged authorization is REFUSED"))).toBe(true);
    expect(o.deferred?.deterministic).toBe(true);
  });
});

// ── The rollup: skip-is-not-pass (the meta-invariant) ───────────────────────────

describe("enforcement rollup — a SKIP is never a pass (the standing-gate lesson)", () => {
  const enforced = (id: string): CheckOutcome => ({
    id,
    control: id,
    title: id,
    status: "enforced",
    assertions: [{ label: "x", ok: true, detail: "" }],
  });
  const bypassed = (id: string): CheckOutcome => ({
    id,
    control: id,
    title: id,
    status: "bypassed",
    assertions: [{ label: "x", ok: false, detail: "" }],
  });
  const skipped = (id: string): CheckOutcome => ({
    id,
    control: id,
    title: id,
    status: "skipped",
    assertions: [],
    skipReason: "no box / no secret",
  });

  it("all enforced → fullyEnforced, exit 0", () => {
    const r = rollup([enforced("a"), enforced("b")]);
    expect(r.fullyEnforced).toBe(true);
    expect(r.anyBypass).toBe(false);
    expect(verdictExitCode(r)).toBe(0);
  });

  it("a BYPASS → RED (exit 1), never green, even alongside enforced checks", () => {
    const r = rollup([enforced("a"), bypassed("b"), enforced("c")]);
    expect(r.anyBypass).toBe(true);
    expect(r.fullyEnforced).toBe(false);
    expect(verdictExitCode(r)).toBe(1);
  });

  it("a SKIPPED enforcement check is reported SKIPPED-not-passed: NOT counted as enforced, blocks green (exit 3)", () => {
    const r = rollup([enforced("a"), enforced("b"), skipped("c")]);
    // The skip is tallied as a skip, never rolled into the enforced (pass) count.
    expect(r.skipped).toBe(1);
    expect(r.enforced).toBe(2);
    expect(r.considered).toBe(2); // a skip is not "considered" a verdict
    // …and the whole phase can NOT read as fully enforced with a skip present.
    expect(r.fullyEnforced).toBe(false);
    expect(verdictExitCode(r)).toBe(3); // inconclusive — weekly treats as failure
  });

  it("a bypass dominates a skip (a real bypass is RED regardless of skips)", () => {
    const r = rollup([bypassed("a"), skipped("b")]);
    expect(verdictExitCode(r)).toBe(1);
  });

  it("an empty run (nothing ran) is NOT green (proves nothing)", () => {
    const r = rollup([]);
    expect(r.fullyEnforced).toBe(false);
    expect(verdictExitCode(r)).toBe(3);
  });

  it("renderReport marks each status and never labels a skip as passed", () => {
    const txt = renderReport(rollup([enforced("a"), skipped("c")]));
    expect(txt).toContain("[ENFORCED] a");
    expect(txt).toContain("[SKIPPED] c");
    expect(txt).toContain("INCONCLUSIVE");
    expect(txt).not.toContain("[ENFORCED] c");
  });

  it("a live check that SKIPS (unreachable box) folds into the rollup as a skip, blocking green", async () => {
    // Ties the driver to the rollup: a real check whose transport throws is a
    // skip, and mixing it with enforced checks still can't read green.
    const skip = await checkRestrictedMode(ctx(throwingHttp, throwingRaw));
    const r = rollup([enforced("admin"), skip]);
    expect(skip.status).toBe("skipped");
    expect(r.fullyEnforced).toBe(false);
    expect(verdictExitCode(r)).toBe(3);
  });
});

// ── runEnforcementChecks wires all five, in task order ──────────────────────────

describe("runEnforcementChecks — the five controls in task order", () => {
  it("returns all five controls (1..5) and rolls up to a single verdict", async () => {
    // Deterministic controls (2 det. part, 4, 5) always produce a verdict; the
    // wire controls skip cleanly with no box. The point: five outcomes, one roll.
    const outcomes = await runEnforcementChecks(ctx(throwingHttp, throwingRaw));
    expect(outcomes).toHaveLength(5);
    expect(outcomes.map((o) => o.id)).toEqual([
      "restricted-mode-real-path",
      "admin-gate-nonadmin-rejected",
      "revocation-reaches-box",
      "debug-access-admin-authority",
      "transfer-rehome-giver-signature",
    ]);
    // Controls 4 & 5 are deterministic — they enforce even with no box.
    expect(outcomes[3]!.status).toBe("enforced");
    expect(outcomes[4]!.status).toBe("enforced");
    // Controls 1 & 3 need the wire — they SKIP (not pass) with no box.
    expect(outcomes[0]!.status).toBe("skipped");
    expect(outcomes[2]!.status).toBe("skipped");
    // So the phase is inconclusive (a skip present) — never a silent green.
    expect(verdictExitCode(rollup(outcomes))).toBe(3);
  });
});
