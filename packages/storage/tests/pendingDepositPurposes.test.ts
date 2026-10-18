import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import { D1Storage, type D1Database } from "../src/d1.js";
import type { PairingDepositRecord, Storage } from "../src/types.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

const NOW = 1_800_000_000_000;
const HOST = "home.alice.flagship.services";
const rec = (host: string, nonce: string, over: Partial<PairingDepositRecord> = {}): PairingDepositRecord => ({
  serverDomain: host, username: "alice", requestNonceHex: nonce, stkPubHex: "11".repeat(32),
  sealedHex: "cd".repeat(8), issuedAt: NOW - 1, expiresAt: NOW + 1000, ...over,
});

async function scenario(s: Storage) {
  const m = s.secretMailbox;
  const out: string[][] = [];
  out.push(await m.pendingDepositPurposes(HOST, NOW));
  await m.putSwkDeposit(rec(HOST, "01".repeat(32)));
  await m.putCgkDeposit(rec(HOST, "02".repeat(32)));
  await m.putPairingDeposit(rec(HOST, "03".repeat(32)));
  await m.putEntitlementDeposit(rec(HOST, "04".repeat(32)));
  await m.putUpdateDeposit(rec(HOST, "05".repeat(32), { expiresAt: NOW - 5 })); // expired
  await m.putSelfDeleteDeposit(rec(HOST, "06".repeat(32)));
  await m.putSwkDeposit(rec("other.alice.flagship.services", "07".repeat(32)));
  out.push(await m.pendingDepositPurposes(HOST, NOW));
  await m.consumeSwkDeposit(HOST, NOW);
  await m.consumeSelfDeleteDeposit(HOST, NOW);
  out.push(await m.pendingDepositPurposes(HOST, NOW));
  return out;
}

describe("pendingDepositPurposes", () => {
  it("answers the same on the in-memory and the D1 adapter, and does not consume", async () => {
    const mem = await scenario(new InMemoryStorage());
    const d1 = await scenario(new D1Storage(createSqliteD1() as unknown as D1Database));
    expect(d1).toEqual(mem);
    expect(mem[0]).toEqual([]);
    expect(mem[1]).toEqual(["cgk", "entitlement-deposit", "pairing", "self-delete", "swk"]);
    // swk was collected; the self-delete order is read without being consumed, so it stays.
    expect(mem[2]).toEqual(["cgk", "entitlement-deposit", "pairing", "self-delete"]);
  });

  it("asking twice changes nothing", async () => {
    const s = new InMemoryStorage();
    await s.secretMailbox.putSwkDeposit(rec(HOST, "01".repeat(32)));
    await s.secretMailbox.pendingDepositPurposes(HOST, NOW);
    expect(await s.secretMailbox.pendingDepositPurposes(HOST, NOW)).toEqual(["swk"]);
    expect((await s.secretMailbox.consumeSwkDeposit(HOST, NOW))?.requestNonceHex).toBe("01".repeat(32));
  });
});
