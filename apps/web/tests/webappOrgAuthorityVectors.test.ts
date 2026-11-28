// The shared org-authority vectors (packages/protocol/test-vectors/org-authority) through the webapp's bundled org
// protocol (vendor/flagship-org) and lib/orgSeat.js's verifyServedChain: chains with .com's observed notice times
// (a backdated notice, a late veto that now counts, two notices opened in parallel) and the pending-approval check
// (an evaded freeze).
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
const V = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const refs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(refs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
};

let org: any, seat: any;
const codeOf = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof org.OrgAuthorityError) return (e as { code: string }).code;
    throw e;
  }
};

describe("org authority vectors through the bundled protocol", () => {
  beforeAll(async () => {
    org = await import("../public/webapp/vendor/flagship-org/org.js");
    seat = await import("../public/webapp/lib/orgSeat.js");
  });

  it("chains, with the notice times .com observed, as the authority read serves them", () => {
    for (const raw of V.chains) {
      const c = refs(raw);
      const served = { entries: c.entries, freezes: c.freezes, overturns: c.overturns, vetoes: c.vetoes, noticeOpenedAt: c.noticeOpenedAt };
      let version = -1;
      const got = codeOf(() => {
        version = seat.verifyServedChain(served, c.genesisHash ?? V.genesisHash, c.now).current.version;
      });
      expect(got, c.name).toBe(c.expect.ok ? "ok" : c.expect.code);
      if (c.expect.ok) expect(version, c.name).toBe(c.currentVersion);
    }
  });

  it("pending approvals count a freeze at their signed time or now", () => {
    const base = refs(V.chains[0]);
    const st = org.verifyOrgAuthorityChain(base.entries.slice(0, 2), { genesisHash: V.genesisHash, now: base.now });
    const g = refs(V.seatBooks[0]);
    for (const raw of V.approvers) {
      const c = refs(raw);
      const book = org.buildOrgSeatBook(st, { grants: g.grants, revokes: g.revokes, freezes: c.freezes, now: c.now });
      let signers: string[] = [];
      const got = codeOf(() => {
        signers = org.verifyOrgApprovers(st, book, new TextEncoder().encode(c.order), c.approvals, c.now);
      });
      expect(got, c.name).toBe(c.expect.ok ? "ok" : c.expect.code);
      if (c.expect.ok) expect(signers).toEqual(c.expect.signers);
    }
  });
});
