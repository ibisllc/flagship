// The org box's Business plan backstop (orgPlanCheck.ts): a CA-signed org plan attestation, "unknown" never blocks,
// a lapsed org's new seats and new directory people wait, existing seats stay.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { signOrgPlanAttestation, type OrgPlanAttestationBody } from "@flagship/protocol";
import { ed } from "../../protocol/src/edSync.js";
import { mergeOrgServed, type OrgServed } from "../src/orgAuthorityPin.js";
import { OrgPlanCheck } from "../src/orgPlanCheck.js";

const ORG = "0f".repeat(16);
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const PIN = "ab".repeat(32);
const caSeed = new Uint8Array(32).fill(0x61);
const ca = { privateKey: caSeed, publicKey: ed.getPublicKey(caSeed) };
const caHex = Buffer.from(ca.publicKey).toString("hex");

const attest = (over: Partial<OrgPlanAttestationBody> = {}, signer = ca) =>
  signOrgPlanAttestation({ orgId: ORG, status: "paid", seatLimit: 3, paidSeats: 3, trialEndsAt: NOW - 40 * DAY, paidUntil: NOW + 5 * DAY, issuedAt: NOW, expiresAt: NOW + DAY, ...over }, signer as never);

function check(served: () => unknown, clock: { t: number }) {
  return new OrgPlanCheck({
    path: join(mkdtempSync(join(tmpdir(), "org-plan-")), "org-plan.json"),
    orgId: ORG,
    chain: () => ({ authorizedCaKeys: () => [caHex] }),
    fetchAttestation: async () => served(),
    pinnedMandateHash: PIN,
    now: () => clock.t,
  });
}

describe("OrgPlanCheck", () => {
  it("is unknown (and blocks nothing) until it holds a CA-signed attestation for this org", async () => {
    const clock = { t: NOW };
    let served: unknown = null;
    const c = check(() => served, clock);
    await c.load();
    expect(c.state()).toBe("unknown");
    expect(c.admitsNewSeat(NOW, 1000)).toBe(true);
    expect(c.allowsNewPeople()).toBe(true);
    served = attest({ orgId: "1f".repeat(16) });
    expect(await c.refresh()).toBe("unknown");
    const other = ed.getPublicKey(new Uint8Array(32).fill(2));
    served = attest({}, { privateKey: new Uint8Array(32).fill(2), publicKey: other });
    expect(await c.refresh()).toBe("unknown");
    served = attest();
    expect(await c.refresh()).toBe("paid");
    clock.t = NOW + 2 * DAY;
    expect(c.state()).toBe("unknown");
  });

  it("paid: new seats up to the limit; lapsed: no new seat granted after the lapse, no new people", async () => {
    const clock = { t: NOW };
    let served: unknown = attest();
    const c = check(() => served, clock);
    await c.refresh();
    expect(c.admitsNewSeat(NOW, 2)).toBe(true);
    expect(c.admitsNewSeat(NOW, 3)).toBe(false);
    served = attest({ status: "lapsed", paidUntil: NOW - 10 * DAY, issuedAt: NOW + 1 });
    clock.t = NOW + 2;
    expect(await c.refresh()).toBe("lapsed");
    expect(c.allowsNewPeople()).toBe(false);
    expect(c.admitsNewSeat(NOW - 10 * DAY, 0)).toBe(true);
    expect(c.admitsNewSeat(NOW, 0)).toBe(false);
  });

  it("survives a restart from disk", async () => {
    const clock = { t: NOW };
    const dir = mkdtempSync(join(tmpdir(), "org-plan-"));
    const mk = (served: unknown) =>
      new OrgPlanCheck({ path: join(dir, "p.json"), orgId: ORG, chain: () => ({ authorizedCaKeys: () => [caHex] }), fetchAttestation: async () => served, pinnedMandateHash: PIN, now: () => clock.t });
    await mk(attest({ status: "trial" })).refresh();
    const again = mk(null);
    await again.load();
    expect(again.state()).toBe("trial");
  });
});

describe("the seat backstop in the org sync", () => {
  const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../protocol/test-vectors/org-authority/vectors.json"), "utf8"));
  const R = (v: unknown): any => {
    if (Array.isArray(v)) return v.map(R);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$key === "string") return V.keys[o.$key].binding;
    if (typeof o.$approval === "number") return V.approvals[o.$approval];
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, R(x)]));
  };
  const chain = R(V.chains[0]);
  const books = V.seatBooks.map(R);
  const expected = { orgId: V.orgId as string, genesisHash: V.genesisHash as string };
  const served = (grants: unknown[]): OrgServed => ({ entries: chain.entries.slice(0, 2), freezes: [], overturns: [], vetoes: [], grants: grants as never, revokes: [] });

  it("holds a new seat while the plan can't take it, keeps the existing ones, admits it once allowed", () => {
    const [g1, g2] = books[0].grants;
    const first = mergeOrgServed(null, served([g1]), expected, chain.now).pinned;
    const held = mergeOrgServed(first, served([g1, g2]), expected, chain.now, () => false).pinned;
    expect([...held.book.seats.keys()]).toEqual([...first.book.seats.keys()]);
    const admitted = mergeOrgServed(held, served([g1, g2]), expected, chain.now, (_t, live) => live < 10).pinned;
    expect(admitted.book.seats.size).toBe(first.book.seats.size + 1);
  });
});
