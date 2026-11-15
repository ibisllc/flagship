/**
 * Forgery against the org server, key-ring and audit-export envelopes (docs/enterprise-accounts.md
 * "Org servers", §5.4, §8, §11). Each case takes a valid object from test-vectors/org-servers and
 * changes one thing an attacker controls (a field after approval, the signer, a spliced recipient),
 * then checks the verifier refuses it.
 *
 *   AT-ENV-40  org-server-code/v1: domain splice, another org's genesis, outsider, scoped seat
 *   AT-ENV-41  org-server-register/v1: another STK, domain swap, code-hash swap, bit flip
 *   AT-ENV-42  org-seat-kem/v1 and org-box-kem/v1: moved to another seat, KEM key swapped, another STK
 *   AT-ENV-43  org-key-ring/v1: recipient spliced after approval, retired seat dropped, commitment and scope swap
 *   AT-ENV-44  org-audit-export/v1: log head swap, record hash swap, outsider
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../../../packages/protocol/src/index.js";

const VECTORS = join(import.meta.dirname, "../../../packages/protocol/test-vectors");
const A = JSON.parse(readFileSync(join(VECTORS, "org-authority/vectors.json"), "utf8"));
const V = JSON.parse(readFileSync(join(VECTORS, "org-servers/vectors.json"), "utf8"));
const refs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(refs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return A.keys[o.$key].binding;
  if (typeof o.$approval === "number") return A.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
};
const entries = refs(A.chains[0]).entries.slice(0, 2);
const grants = refs(A.seatBooks[0]).grants;
const clone = <T>(x: T): T => structuredClone(x);
const flip = (h: string) => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");

function ctx(now: number, revokes: unknown[] = []) {
  const state = P.verifyOrgAuthorityChain(entries, { genesisHash: A.genesisHash, now });
  const book = P.buildOrgSeatBook(state, { grants, revokes: revokes as never, now });
  const keys: P.OrgKemKey[] = [];
  for (const k of V.kems.seat) {
    try {
      keys.push(P.verifyOrgSeatKem(state, book, k, now));
    } catch {
      /* departed */
    }
  }
  for (const k of V.kems.box) keys.push(P.verifyOrgBoxKem(k, A.orgId, V.register.request.serverIdentityPubKeyHex, now));
  return { state, book, kems: P.newestOrgKems(keys), servers: new Set<string>(V.servers), now };
}

describe("AT-ENV-40 org-server-code/v1", () => {
  const good = V.serverCodes[0];
  const run = (code: P.OrgServerCode, approvals = good.approvals) => {
    const c = ctx(good.now);
    return () => P.verifyOrgServerCode(c.state, c.book, code, approvals, good.now);
  };
  it("AT-ENV-40a the valid code verifies (control)", () => expect(run(good.code)).not.toThrow());
  it("AT-ENV-40b a domain changed after approval is refused (catches: one approval reused for another server)", () => {
    expect(run({ ...good.code, serverDomain: "evil.acme.flagship.services", serverName: "evil" })).toThrow(P.OrgAuthorityError);
  });
  it("AT-ENV-40c another org's genesis is refused (catches: a box pinned to an attacker's org)", () => {
    expect(run({ ...good.code, genesisHash: "ee".repeat(32) })).toThrow(/wrong-org/);
  });
  it("AT-ENV-40d an outsider's approval and a scoped seat without servers-add are refused", () => {
    for (const c of V.serverCodes.slice(1, 3)) {
      const k = ctx(c.now);
      expect(() => P.verifyOrgServerCode(k.state, k.book, c.code, c.approvals, c.now)).toThrow(P.OrgAuthorityError);
    }
  });
  it("AT-ENV-40e a delegated key swapped after approval is refused", () => {
    expect(run({ ...good.code, delegatedPubKeyHex: "aa".repeat(32) })).toThrow(/order-mismatch/);
  });
});

describe("AT-ENV-41 org-server-register/v1", () => {
  const r = V.register.request;
  it("AT-ENV-41a the valid registration verifies (control)", () => expect(P.verifyOrgServerRegister(r, V.register.signature)).toBe(true));
  it("AT-ENV-41b another STK, another domain, another code hash, a flipped bit: each refused", () => {
    expect(P.verifyOrgServerRegister({ ...r, serverIdentityPubKeyHex: "11".repeat(32) }, V.register.signature)).toBe(false);
    expect(P.verifyOrgServerRegister({ ...r, serverDomain: "other.acme.flagship.services" }, V.register.signature)).toBe(false);
    expect(P.verifyOrgServerRegister({ ...r, codeSha256: "00".repeat(32) }, V.register.signature)).toBe(false);
    expect(P.verifyOrgServerRegister(r, flip(V.register.signature))).toBe(false);
  });
});

describe("AT-ENV-42 org-seat-kem/v1 and org-box-kem/v1", () => {
  const now = V.keyRings[0].now;
  it("AT-ENV-42a a seat's statement moved to another seat is refused (catches: sealing a key to an attacker's KEM key under a colleague's name)", () => {
    const c = ctx(now);
    const moved = clone(V.kems.seat[3]);
    moved.statement.seatId = V.kems.seat[0].statement.seatId;
    expect(() => P.verifyOrgSeatKem(c.state, c.book, moved, now)).toThrow(P.OrgAuthorityError);
  });
  it("AT-ENV-42b a KEM key swapped under a valid signature is refused", () => {
    const c = ctx(now);
    const swapped = { ...V.kems.seat[0], kemPubHex: V.kems.seat[1].kemPubHex };
    expect(() => P.verifyOrgSeatKem(c.state, c.book, swapped, now)).toThrow(/binding/);
    const boxSwapped = { ...V.kems.box[0], kemPubHex: V.kems.seat[1].kemPubHex };
    expect(() => P.verifyOrgBoxKem(boxSwapped, A.orgId, V.register.request.serverIdentityPubKeyHex, now)).toThrow(/binding/);
  });
  it("AT-ENV-42c a box statement under another STK, and a departed seat's statement, are refused", () => {
    expect(() => P.verifyOrgBoxKem(V.kems.box[0], A.orgId, "22".repeat(32), now)).toThrow(/bad-signature/);
    const c = ctx(V.rotations[0].now, [V.revokeS]);
    expect(() => P.verifyOrgSeatKem(c.state, c.book, V.kems.seat[2], V.rotations[0].now)).toThrow(/seat-unknown/);
  });
});

describe("AT-ENV-43 org-key-ring/v1", () => {
  const good = V.keyRings[3];
  const check = (b: P.OrgKeyRingBundle, prev = good.prev, fresh = true) => {
    const c = ctx(good.now, good.revokes);
    return () => P.verifyOrgKeyRing(c, b, prev, { fresh });
  };
  it("AT-ENV-43a the rotation after S left verifies (control)", () => expect(check(good.bundle)).not.toThrow());
  it("AT-ENV-43b a recipient spliced in after approval is refused, fresh or stored (catches: .com adding a copy for itself)", () => {
    const spliced = clone(good.bundle);
    spliced.recipients.push({ ...V.opens[2].ring.recipients.find((x: { recipient: string }) => x.recipient.startsWith("seat:51")) });
    expect(check(spliced)).toThrow(P.OrgAuthorityError);
    expect(check(spliced, good.prev, false)).toThrow(P.OrgAuthorityError);
  });
  it("AT-ENV-43c dropping the retired seat, swapping the commitment or the scope after approval is refused", () => {
    for (const mut of [
      (r: P.OrgKeyRing) => (r.retired = []),
      (r: P.OrgKeyRing) => (r.keyCommitment = "00".repeat(32)),
      (r: P.OrgKeyRing) => (r.scope = "other.acme.flagship.services"),
    ]) {
      const b = clone(good.bundle);
      mut(b.ring);
      expect(check(b, good.prev, false)).toThrow(P.OrgAuthorityError);
    }
  });
  it("AT-ENV-43d an outsider's approval is refused", () => {
    const b = clone(good.bundle);
    const x = A.keys["X outsider"];
    b.approvals = [
      P.signOrgApproval(
        { orgId: A.orgId, oarVersion: 1, order: P.canonicalOrgKeyRing(b.ring), seatId: x.seatId, adminKeyId: x.keyId, issuedAt: b.ring.issuedAt, notAfter: b.ring.issuedAt + 3_600_000 },
        Uint8Array.from(Buffer.from(x.edSeedHex + x.mldsaSeedHex, "hex")),
      ),
    ];
    expect(check(b, good.prev, false)).toThrow(/unknown-signer/);
  });
});

describe("AT-ENV-44 org-audit-export/v1", () => {
  const now = V.audit.cases[0].now;
  it("AT-ENV-44a the export verifies (control)", () => {
    expect(P.verifyOrgAuditExport(clone(V.audit.export), { genesisHash: A.genesisHash, now }).signedBy).toBe(A.keys["A founder"].seatId);
  });
  it("AT-ENV-44b a log head or record hash swapped in the signed statement is refused (catches: a truncated log passed off as complete)", () => {
    const head = clone(V.audit.export);
    head.statement.logSeq -= 1;
    head.statement.logHeadHash = head.log[head.log.length - 2].entryHash;
    head.log.pop();
    expect(() => P.verifyOrgAuditExport(head, { genesisHash: A.genesisHash, now })).toThrow(/order-mismatch/);
    const rec = clone(V.audit.export);
    rec.statement.oarHash = "00".repeat(32);
    expect(() => P.verifyOrgAuditExport(rec, { genesisHash: A.genesisHash, now })).toThrow(/order-mismatch/);
  });
  it("AT-ENV-44c an export under another genesis is refused", () => {
    expect(() => P.verifyOrgAuditExport(clone(V.audit.export), { genesisHash: "11".repeat(32), now })).toThrow(/wrong-org/);
  });
});
