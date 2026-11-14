import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OrgAuthorityError,
  authorizeOrgOrder,
  buildOrgSeatBook,
  canonicalOrgApproval,
  deriveOrgSeatMemberSeeds,
  orgSeatSas,
  orgSha256Hex,
  verifyOrgAuthorityChain,
  type OrgAction,
  type OrgAuthorityEntry,
  type OrgAuthorityState,
} from "../src/orgAuthority.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "test-vectors", "org-authority", "vectors.json"), "utf8"));

function resolveRefs(v: unknown): any {
  if (Array.isArray(v)) return v.map(resolveRefs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveRefs(x)]));
}

const code = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof OrgAuthorityError) return e.code;
    throw e;
  }
};

const enc = (s: string) => new TextEncoder().encode(s);

function baseState(): OrgAuthorityState {
  const c = resolveRefs(V.chains[0]);
  return verifyOrgAuthorityChain(c.entries.slice(0, 2) as OrgAuthorityEntry[], { genesisHash: V.genesisHash, now: c.now });
}

describe("org authority vectors", () => {
  it("canonical forms", () => {
    for (const c of V.canonical) expect(orgSha256Hex(enc(c.bytes)), c.name).toBe(c.sha256);
    const a = V.approvals[0];
    expect(new TextDecoder().decode(canonicalOrgApproval(a)).startsWith("flagship/org-approval/v1|")).toBe(true);
  });

  it("SAS and member seeds", () => {
    expect(orgSeatSas(V.sas.inviteSha256, V.sas.memberKeyId, V.sas.adminKeyId)).toBe(V.sas.code);
    const s = deriveOrgSeatMemberSeeds(Uint8Array.from(Buffer.from(V.memberSeeds.umkHex, "hex")), V.memberSeeds.orgId);
    expect(Buffer.from(s.edSeed).toString("hex")).toBe(V.memberSeeds.edSeedHex);
    expect(Buffer.from(s.mldsaSeed).toString("hex")).toBe(V.memberSeeds.mldsaSeedHex);
    expect(Buffer.from(s.publicKey.subarray(0, 32)).toString("hex")).toBe(V.memberSeeds.ed25519PubHex);
  });

  for (const raw of V.chains) {
    it(`chain: ${raw.name}`, () => {
      const c = resolveRefs(raw);
      let state: OrgAuthorityState | null = null;
      const got = code(() => {
        state = verifyOrgAuthorityChain(c.entries, {
          genesisHash: c.genesisHash ?? V.genesisHash,
          now: c.now,
          freezes: c.freezes,
          overturns: c.overturns,
          vetoes: c.vetoes,
        });
      });
      expect(got).toBe(c.expect.ok ? "ok" : c.expect.code);
      if (c.expect.ok) expect(state!.current.version).toBe(c.currentVersion);
    });
  }

  for (const raw of V.seatBooks) {
    it(`seat book: ${raw.name}`, () => {
      const c = resolveRefs(raw);
      const book = buildOrgSeatBook(baseState(), { grants: c.grants, revokes: c.revokes, now: V.chains[0].now });
      expect([...book.seats.keys()].sort()).toEqual([...c.expectSeats].sort());
      expect(book.refused).toEqual(c.expectRefused);
    });
  }

  const book = () => {
    const c = resolveRefs(V.seatBooks[0]);
    return buildOrgSeatBook(baseState(), { grants: c.grants, revokes: c.revokes, now: V.chains[0].now });
  };

  for (const raw of V.authorize) {
    it(`authorize: ${raw.name}`, () => {
      const c = resolveRefs(raw);
      const order = enc(c.order);
      let result: { scopedSeat: string | null } | null = null;
      const got = code(() => {
        result = authorizeOrgOrder({ state: baseState(), book: book(), action: c.action as OrgAction, order, approvals: c.approvals, now: c.now });
      });
      expect(got).toBe(c.expect.ok ? "ok" : c.expect.code);
      if (c.expect.ok) expect(result!.scopedSeat).toBe(c.expect.scopedSeat);
    });
  }
});
