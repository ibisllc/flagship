import { describe, expect, it } from "vitest";
import { handleUsernameClaim } from "../src/usernameClaim.js";
import { handleSuggestUsername } from "../src/randomUsername.js";
import { deriveIRK, signClaimUsername } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";

const harryIrk = deriveIRK({ seed: new Uint8Array(32).fill(11) });
const malloryIrk = deriveIRK({ seed: new Uint8Array(32).fill(99) });

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Build a signed claim body for `username` under `irk`. */
function claimBody(username: string, irk = harryIrk, at = Date.now()) {
  const sig = signClaimUsername({ username, irkPub: irk.publicKey, issuedAt: at }, irk);
  return {
    request: { username, irkPub: hex(irk.publicKey), issuedAt: at },
    signature: hex(sig),
  };
}

describe("username claim — roster gate", () => {
  it("REJECTS (403) a name the server never offered", async () => {
    const s = new InMemoryStorage();
    const r = await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers },
      claimBody("brave-fox"),
    );
    expect(r.status).toBe(403);
  });

  it("ALLOWS a recently-offered name, then CONSUMES the offer", async () => {
    const s = new InMemoryStorage();
    await s.usernameOffers.record("happy-otter", "devX", Date.now());
    const r = await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers },
      claimBody("happy-otter"),
    );
    expect(r.status).toBe(200);
    expect(await s.usernameOffers.isOffered("happy-otter", 0)).toBe(false); // consumed
  });

  it("rejects an offer that's past the TTL window", async () => {
    const s = new InMemoryStorage();
    const now = 10_000_000;
    await s.usernameOffers.record("calm-owl", "d", now - 2 * 60 * 60_000); // 2h ago
    const r = await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers, now: () => now },
      claimBody("calm-owl", harryIrk, now),
    );
    expect(r.status).toBe(403);
  });

  it("allows the idempotent re-claim by the SAME owner with no live offer", async () => {
    const s = new InMemoryStorage();
    await s.usernameOffers.record("happy-otter", "d", Date.now());
    expect((await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers }, claimBody("happy-otter"),
    )).status).toBe(200); // claims + consumes the offer
    // Re-claim, no offer left → still ok because harry already owns it.
    const again = await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers }, claimBody("happy-otter"),
    );
    expect(again.status).toBe(200);
  });

  it("a DIFFERENT key can't steal a claimed name even with a (racey) re-offer → 409", async () => {
    const s = new InMemoryStorage();
    await s.usernameOffers.record("happy-otter", "d", Date.now());
    await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers }, claimBody("happy-otter", harryIrk),
    );
    // Name got re-suggested before the queue caught up → an offer exists again,
    // so the gate passes — but `put` still enforces ownership (409, not 200).
    await s.usernameOffers.record("happy-otter", "d2", Date.now());
    const mallory = await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers }, claimBody("happy-otter", malloryIrk),
    );
    expect(mallory.status).toBe(409);
  });

  it("no offers dep (legacy test-setup) skips the gate", async () => {
    const s = new InMemoryStorage();
    const r = await handleUsernameClaim({ storage: s.usernames }, claimBody("brave-fox"));
    expect(r.status).toBe(200);
  });

  it("bypassOfferGate (trusted ops path) skips the gate", async () => {
    const s = new InMemoryStorage();
    const r = await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers, bypassOfferGate: true },
      claimBody("brave-fox"),
    );
    expect(r.status).toBe(200);
  });

  it("end-to-end: a SUGGESTED name is immediately claimable", async () => {
    const s = new InMemoryStorage();
    const now = Date.now();
    const sug = await handleSuggestUsername(
      {
        queue: s.suggestionQueue,
        usernames: s.usernames,
        throttle: s.suggestThrottle,
        offers: s.usernameOffers,
        now,
      },
      { deviceKey: "dev1" },
    );
    expect(sug.status).toBe(200);
    const name = (sug.body as { name: string }).name;
    const r = await handleUsernameClaim(
      { storage: s.usernames, offers: s.usernameOffers, now: () => now },
      claimBody(name, harryIrk, now),
    );
    expect(r.status).toBe(200);
  });
});
