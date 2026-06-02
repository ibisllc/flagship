import { describe, expect, it } from "vitest";
import { InMemoryMintReservationStorage } from "../src/index.js";

describe("InMemoryMintReservationStorage (dead-lead-safe CAS lease)", () => {
  it("first acquirer wins; a second live acquirer backs off", async () => {
    const s = new InMemoryMintReservationStorage();
    const a = await s.tryAcquire({ username: "dani", holderPubHex: "AA", expiresAt: 1000, now: 0 });
    expect(a.acquired).toBe(true);
    expect(a.holder.holderPubHex).toBe("aa");
    // A DIFFERENT minter while the lease is live → loses, sees the holder.
    const b = await s.tryAcquire({ username: "dani", holderPubHex: "bb", expiresAt: 2000, now: 500 });
    expect(b.acquired).toBe(false);
    expect(b.holder.holderPubHex).toBe("aa");
  });

  it("a dead holder's lapsed lease is reclaimable by the next minter", async () => {
    const s = new InMemoryMintReservationStorage();
    await s.tryAcquire({ username: "dani", holderPubHex: "aa", expiresAt: 1000, now: 0 });
    // now is PAST aa's expiry → bb takes over (aa "died" mid-cycle).
    const b = await s.tryAcquire({ username: "dani", holderPubHex: "bb", expiresAt: 3000, now: 1500 });
    expect(b.acquired).toBe(true);
    expect(b.holder.holderPubHex).toBe("bb");
  });

  it("the holder can re-acquire (extend) its own live lease", async () => {
    const s = new InMemoryMintReservationStorage();
    await s.tryAcquire({ username: "dani", holderPubHex: "aa", expiresAt: 1000, now: 0 });
    const again = await s.tryAcquire({ username: "dani", holderPubHex: "aa", expiresAt: 5000, now: 500 });
    expect(again.acquired).toBe(true);
    expect(again.holder.expiresAt).toBe(5000);
  });

  it("release frees the lease only for the current holder", async () => {
    const s = new InMemoryMintReservationStorage();
    await s.tryAcquire({ username: "dani", holderPubHex: "aa", expiresAt: 1000, now: 0 });
    // A non-holder's release is a no-op.
    await s.release("dani", "bb");
    expect((await s.get("dani"))?.holderPubHex).toBe("aa");
    // The holder's release clears it; a fresh minter can now win immediately.
    await s.release("dani", "aa");
    expect(await s.get("dani")).toBeUndefined();
    const c = await s.tryAcquire({ username: "dani", holderPubHex: "cc", expiresAt: 2000, now: 100 });
    expect(c.acquired).toBe(true);
  });

  it("reservations are per-user (case-insensitive)", async () => {
    const s = new InMemoryMintReservationStorage();
    await s.tryAcquire({ username: "DANI", holderPubHex: "aa", expiresAt: 1000, now: 0 });
    expect((await s.get("dani"))?.holderPubHex).toBe("aa");
    // A different user is independent.
    const other = await s.tryAcquire({ username: "alice", holderPubHex: "bb", expiresAt: 1000, now: 0 });
    expect(other.acquired).toBe(true);
  });
});
