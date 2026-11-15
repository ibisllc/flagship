import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OrgAuthorityError,
  buildOrgKeyRings,
  buildOrgSeatBook,
  canonicalOrgAuditExport,
  canonicalOrgBoxKem,
  canonicalOrgKeyRing,
  canonicalOrgSeatKem,
  canonicalOrgServerCode,
  canonicalOrgServerRegister,
  deriveOrgSeatKemSeed,
  newestOrgKems,
  openOrgKeyRing,
  orgKemKeyPair,
  orgRotationDone,
  orgSha256Hex,
  verifyOrgAuditExport,
  verifyOrgAuthorityChain,
  verifyOrgBoxKem,
  verifyOrgKeyRing,
  verifyOrgSeatKem,
  verifyOrgServerCode,
  verifyOrgServerRegister,
  type OrgKeyKind,
} from "../src/index.js";

const dir = resolve(import.meta.dirname, "../test-vectors");
const A = JSON.parse(readFileSync(resolve(dir, "org-authority/vectors.json"), "utf8"));
const V = JSON.parse(readFileSync(resolve(dir, "org-servers/vectors.json"), "utf8"));
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
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const codeOf = (e: unknown) => (e instanceof OrgAuthorityError ? e.code : String(e));

function ctxAt(now: number, revokes: unknown[] = []) {
  const state = verifyOrgAuthorityChain(entries, { genesisHash: A.genesisHash, now });
  const book = buildOrgSeatBook(state, { grants, revokes: revokes as never, now });
  const live = (f: () => ReturnType<typeof verifyOrgSeatKem>) => {
    try {
      return [f()];
    } catch {
      return [];
    }
  };
  // A departed seat's KEM statement no longer verifies, so it can be no recipient.
  const kems = newestOrgKems([
    ...V.kems.seat.flatMap((k: never) => live(() => verifyOrgSeatKem(state, book, k, now))),
    ...V.kems.box.map((k: never) => verifyOrgBoxKem(k, V.orgId, V.register.request.serverIdentityPubKeyHex, now)),
  ]);
  return { state, book, kems, servers: new Set<string>(V.servers), now };
}

describe("org servers, key ring and audit vectors", () => {
  it("canonical forms", () => {
    const sha = (s: string) => orgSha256Hex(new TextEncoder().encode(s));
    for (const c of V.canonical) expect(sha(c.bytes), c.name).toBe(c.sha256);
    const byName = Object.fromEntries(V.canonical.map((c: { name: string; bytes: string }) => [c.name, c.bytes]));
    expect(new TextDecoder().decode(canonicalOrgServerCode(V.serverCodes[0].code))).toBe(byName["server code"]);
    expect(new TextDecoder().decode(canonicalOrgServerRegister(V.register.request))).toBe(byName["server register"]);
    expect(new TextDecoder().decode(canonicalOrgSeatKem(V.kems.seat[0].statement))).toBe(byName["seat kem"]);
    expect(new TextDecoder().decode(canonicalOrgBoxKem(V.kems.box[0].statement))).toBe(byName["box kem"]);
    expect(new TextDecoder().decode(canonicalOrgKeyRing(V.opens[0].ring.ring))).toBe(byName["key ring v2"]);
    expect(new TextDecoder().decode(canonicalOrgAuditExport(V.audit.export.statement))).toBe(byName["audit export"]);
  });

  it("server codes", () => {
    for (const c of V.serverCodes) {
      const { state, book } = ctxAt(c.now);
      let got: unknown;
      try {
        const r = verifyOrgServerCode(state, book, c.code, c.approvals, c.now);
        got = { ok: true, scopedSeat: r.scopedSeat };
      } catch (e) {
        got = { ok: false, code: codeOf(e) };
      }
      expect(got, c.name).toEqual(c.expect);
    }
  });

  it("registration is signed by the box's identity key", () => {
    expect(verifyOrgServerRegister(V.register.request, V.register.signature)).toBe(true);
    expect(verifyOrgServerRegister(V.register.request, V.register.flipped)).toBe(false);
    expect(verifyOrgServerRegister({ ...V.register.request, serverDomain: "other.acme.flagship.services" }, V.register.signature)).toBe(false);
  });

  it("the seat's X-Wing seed derives from the UMK per org", () => {
    const seed = deriveOrgSeatKemSeed(hexBytes(V.seatKemSeed.umkHex), V.orgId);
    expect(Buffer.from(seed).toString("hex")).toBe(V.seatKemSeed.seedHex);
    expect(orgKemKeyPair(seed).kemKeyId).toBe(V.seatKemSeed.kemKeyId);
  });

  it("KEM statements: a seat signs with its member key; a statement under another seat's name fails", () => {
    const { state, book } = ctxAt(V.keyRings[0].now);
    const forged = { ...V.kems.seat[3], statement: { ...V.kems.seat[3].statement, seatId: V.kems.seat[2].statement.seatId } };
    expect(() => verifyOrgSeatKem(state, book, forged, V.keyRings[0].now)).toThrow(OrgAuthorityError);
    expect(() => verifyOrgBoxKem(V.kems.box[0], V.orgId, "00".repeat(32), V.keyRings[0].now)).toThrow(OrgAuthorityError);
  });

  it("key rings", () => {
    for (const c of V.keyRings) {
      const ctx = ctxAt(c.now, c.revokes);
      let got: unknown;
      try {
        verifyOrgKeyRing(ctx, c.bundle, c.prev, { fresh: c.fresh });
        got = { ok: true };
      } catch (e) {
        got = { ok: false, code: codeOf(e) };
      }
      expect(got, c.name).toEqual(c.expect);
    }
  });

  it("rotations", () => {
    for (const c of V.rotations) {
      const ctx = ctxAt(c.now, [V.revokeS]);
      const rings = buildOrgKeyRings(ctx, c.rings);
      expect(rings.refused, c.name).toEqual([]);
      expect(orgRotationDone(rings, c.kind as OrgKeyKind, c.scope, c.seatId, c.leftAt), c.name).toBe(c.expect);
    }
  });

  it("opening a copy checks the commitment", () => {
    for (const o of V.opens) {
      const { kemSecret } = orgKemKeyPair(hexBytes(o.kemSeedHex));
      if (o.error) {
        expect(() => openOrgKeyRing(o.ring, o.recipient, kemSecret), o.name).toThrow(o.error);
      } else {
        expect(Buffer.from(openOrgKeyRing(o.ring, o.recipient, kemSecret)).toString("hex"), o.name).toBe(o.keyHex);
      }
    }
    const bad = { ...V.opens[0].ring, ring: { ...V.opens[0].ring.ring, keyCommitment: "00".repeat(32) } };
    expect(() => openOrgKeyRing(bad, V.opens[0].recipient, orgKemKeyPair(hexBytes(V.opens[0].kemSeedHex)).kemSecret)).toThrow("key commitment");
  });

  it("audit export", () => {
    for (const c of V.audit.cases) {
      const x = structuredClone(V.audit.export);
      if (c.patch?.log) x.log[c.patch.log.index].at += c.patch.log.atDelta;
      if (c.patch?.extraGrant) {
        const g = structuredClone(x.grants[c.patch.extraGrant.from]);
        g.grant.issuedAt += c.patch.extraGrant.issuedAtDelta;
        x.grants.push(g);
      }
      if (c.patch?.approval) x.approval = c.patch.approval;
      let got: unknown;
      try {
        const r = verifyOrgAuditExport(x, { genesisHash: V.genesisHash, now: c.now });
        got = { ok: true, signedBy: r.signedBy, logEntries: r.logEntries, unlogged: r.unlogged.length };
      } catch (e) {
        got = { ok: false, code: codeOf(e) };
      }
      expect(got, c.name).toEqual(c.expect);
    }
  });
});
