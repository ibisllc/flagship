import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleNfcRendezvousConsume,
  handleNfcRendezvousDeposit,
} from "../src/nfcRendezvous.js";

const RID = "abcd1234efgh5678";
const SEALED = "deadbeef".repeat(8); // 64 hex chars — well under cap
const NONCE = "00".repeat(12); // 24 hex chars — AES-GCM 12-byte nonce

describe("C3: NFC rendezvous deposit + consume (one-shot)", () => {
  let storage: InMemoryStorage;
  let now = 1_700_000_000_000;

  beforeEach(() => {
    storage = new InMemoryStorage();
    now = 1_700_000_000_000;
  });

  const deps = () => ({
    rendezvous: storage.nfcRendezvous,
    now: () => now,
  });

  it("happy path: deposit then consume returns the same blob", async () => {
    const dep = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: SEALED,
      nonceHex: NONCE,
    });
    expect(dep.status).toBe(200);
    const depBody = dep.body as { ok: boolean; expiresAt: number };
    expect(depBody.ok).toBe(true);
    expect(depBody.expiresAt).toBe(now + 15 * 60_000);

    const got = await handleNfcRendezvousConsume(deps(), RID);
    expect(got.status).toBe(200);
    const body = got.body as {
      rendezvousId: string;
      sealedHex: string;
      nonceHex: string;
      depositedAt: number;
    };
    expect(body.rendezvousId).toBe(RID);
    expect(body.sealedHex).toBe(SEALED.toLowerCase());
    expect(body.nonceHex).toBe(NONCE);
    expect(body.depositedAt).toBe(now);
  });

  it("consume is one-shot: a second consume returns 404", async () => {
    await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: SEALED,
      nonceHex: NONCE,
    });
    const first = await handleNfcRendezvousConsume(deps(), RID);
    expect(first.status).toBe(200);
    const second = await handleNfcRendezvousConsume(deps(), RID);
    expect(second.status).toBe(404);
  });

  it("consume after TTL expiry returns 404", async () => {
    await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: SEALED,
      nonceHex: NONCE,
    });
    now += 16 * 60_000; // past the 15-min default TTL
    const got = await handleNfcRendezvousConsume(deps(), RID);
    expect(got.status).toBe(404);
  });

  it("custom ttlMs is honored end-to-end", async () => {
    const customDeps = {
      rendezvous: storage.nfcRendezvous,
      now: () => now,
      ttlMs: 60_000,
    };
    const dep = await handleNfcRendezvousDeposit(customDeps, RID, {
      sealedHex: SEALED,
      nonceHex: NONCE,
    });
    expect((dep.body as { expiresAt: number }).expiresAt).toBe(now + 60_000);
    now += 61_000;
    const got = await handleNfcRendezvousConsume(customDeps, RID);
    expect(got.status).toBe(404);
  });

  it("purgeExpired drops only expired rows", async () => {
    await storage.nfcRendezvous.put({
      rendezvousId: "fresh-slot-1",
      sealedHex: SEALED,
      nonceHex: NONCE,
      depositedAt: now,
      expiresAt: now + 10_000,
    });
    await storage.nfcRendezvous.put({
      rendezvousId: "stale-slot-1",
      sealedHex: SEALED,
      nonceHex: NONCE,
      depositedAt: now - 60_000,
      expiresAt: now - 30_000,
    });
    await storage.nfcRendezvous.put({
      rendezvousId: "stale-slot-2",
      sealedHex: SEALED,
      nonceHex: NONCE,
      depositedAt: now - 90_000,
      expiresAt: now - 60_000,
    });
    const purged = await storage.nfcRendezvous.purgeExpired(now);
    expect(purged).toBe(2);
    // Fresh slot still consumable.
    const got = await handleNfcRendezvousConsume(deps(), "fresh-slot-1");
    expect(got.status).toBe(200);
  });

  it("idempotent overwrite: a re-deposit replaces the prior blob", async () => {
    const sealed1 = "11".repeat(32);
    const sealed2 = "22".repeat(32);
    await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: sealed1,
      nonceHex: NONCE,
    });
    now += 1000;
    await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: sealed2,
      nonceHex: NONCE,
    });
    const got = await handleNfcRendezvousConsume(deps(), RID);
    expect(got.status).toBe(200);
    const body = got.body as { sealedHex: string; depositedAt: number };
    expect(body.sealedHex).toBe(sealed2);
    expect(body.depositedAt).toBe(now);
  });
});

describe("C3: NFC rendezvous input validation", () => {
  let storage: InMemoryStorage;
  const now = 1_700_000_000_000;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  const deps = () => ({
    rendezvous: storage.nfcRendezvous,
    now: () => now,
  });

  it("rejects rendezvousId that's too short (deposit)", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), "short", {
      sealedHex: SEALED,
      nonceHex: NONCE,
    });
    expect(r.status).toBe(400);
  });

  it("rejects rendezvousId that's too long (consume)", async () => {
    const r = await handleNfcRendezvousConsume(deps(), "a".repeat(65));
    expect(r.status).toBe(400);
  });

  it("rejects rendezvousId with disallowed characters", async () => {
    const r = await handleNfcRendezvousConsume(deps(), "abcd1234/../etc");
    expect(r.status).toBe(400);
  });

  it("accepts unicode-safe url-safe slot identifiers", async () => {
    const id = "ABCDefgh-_1234567890";
    await handleNfcRendezvousDeposit(deps(), id, {
      sealedHex: SEALED,
      nonceHex: NONCE,
    });
    const got = await handleNfcRendezvousConsume(deps(), id);
    expect(got.status).toBe(200);
  });

  it("rejects missing body", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), RID, undefined);
    expect(r.status).toBe(400);
  });

  it("rejects missing sealedHex", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      nonceHex: NONCE,
    } as never);
    expect(r.status).toBe(400);
  });

  it("rejects missing nonceHex", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: SEALED,
    } as never);
    expect(r.status).toBe(400);
  });

  it("rejects non-hex sealedHex", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: "not-actually-hex!",
      nonceHex: NONCE,
    });
    expect(r.status).toBe(400);
  });

  it("rejects odd-length sealedHex (not byte-aligned)", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: "abc",
      nonceHex: NONCE,
    });
    expect(r.status).toBe(400);
  });

  it("rejects empty sealedHex", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: "",
      nonceHex: NONCE,
    });
    expect(r.status).toBe(400);
  });

  it("rejects oversize sealedHex (>8 KB binary)", async () => {
    const oversize = "ab".repeat(8 * 1024 + 1); // > 8 KB binary
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: oversize,
      nonceHex: NONCE,
    });
    expect(r.status).toBe(400);
  });

  it("accepts sealedHex at exactly the 8 KB binary cap", async () => {
    const atCap = "ab".repeat(8 * 1024); // exactly 8 KB binary
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: atCap,
      nonceHex: NONCE,
    });
    expect(r.status).toBe(200);
  });

  it("rejects nonceHex of wrong length (not 24 chars)", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: SEALED,
      nonceHex: "00".repeat(10), // 20 chars
    });
    expect(r.status).toBe(400);
  });

  it("rejects non-hex nonceHex", async () => {
    const r = await handleNfcRendezvousDeposit(deps(), RID, {
      sealedHex: SEALED,
      nonceHex: "zz".repeat(12),
    });
    expect(r.status).toBe(400);
  });
});
