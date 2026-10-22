import { describe, expect, it } from "vitest";
import { ed, verifyCaSignedPlanAttestation, type PlanAttestation } from "@flagship/protocol";
import type { TierStorage, TierSubscriptionRecord } from "@flagship/storage";
import { handlePlanAttestation } from "../src/planAttestation.js";
import { grantTier } from "../src/tierGrant.js";

const sk = new Uint8Array(32).fill(0x42);
const ca = { keypair: { privateKey: sk, publicKey: ed.getPublicKey(sk) }, issuer: "test-ca" };
const caHex = Buffer.from(ca.keypair.publicKey).toString("hex");
const chain = { authorizedCaKeys: () => [caHex] };
const PIN = "cd".repeat(32);
const DAY = 86_400_000;

async function setup() {
  const recs = new Map<string, TierSubscriptionRecord>();
  const tiers: TierStorage = {
    async get(u) {
      return recs.get(u);
    },
    async put(r) {
      recs.set(r.username, r);
    },
  };
  const usernames = { async get(u: string) { return u === "alice" ? ({ username: "alice" } as never) : undefined; } };
  return { tiers, usernames };
}

describe("handlePlanAttestation", () => {
  it("signs free for an account with no plan", async () => {
    const s = await setup();
    const now = 1_760_000_000_000;
    const r = await handlePlanAttestation({ ca, tiers: s.tiers, usernames: s.usernames, now: () => now }, "Alice");
    expect(r.status).toBe(200);
    const a = r.body as PlanAttestation;
    expect(a).toMatchObject({ username: "alice", tier: "free", paidUntil: 0, issuedAt: now });
    expect(a.expiresAt - a.issuedAt).toBe(26 * 3_600_000);
    expect(verifyCaSignedPlanAttestation(a, chain, now + 1, PIN)).toEqual({ ok: true });
    expect(r.headers?.["cache-control"]).toBe("private, no-store");
  });

  it("signs Pro with the end of the paid period, and free once it lapses", async () => {
    const s = await setup();
    let now = 1_760_000_000_000;
    await grantTier({ tiers: s.tiers, now: () => now }, { username: "alice", tier: "hobby", durationDays: 30 });
    const deps = { ca, tiers: s.tiers, usernames: s.usernames, now: () => now };
    const pro = (await handlePlanAttestation(deps, "alice")).body as PlanAttestation;
    expect(pro).toMatchObject({ tier: "hobby", paidUntil: now + 30 * DAY });
    now += 31 * DAY;
    const lapsed = (await handlePlanAttestation(deps, "alice")).body as PlanAttestation;
    expect(lapsed).toMatchObject({ tier: "free", paidUntil: 0 });
    expect(verifyCaSignedPlanAttestation(lapsed, chain, now, PIN).ok).toBe(true);
  });

  it("refuses an unknown account", async () => {
    const s = await setup();
    const r = await handlePlanAttestation({ ca, tiers: s.tiers, usernames: s.usernames }, "bob");
    expect(r.status).toBe(404);
  });
});
