import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetProvisionStatus, handlePostServerSeen } from "../src/provisionStatus.js";

const SERIAL = "FS-ABCD-1234";

describe("Studio's report of the key a hosted VM showed", () => {
  it("is kept beside the order's status for the phone to check, a few at most, and nothing for an unknown order", async () => {
    const s = new InMemoryStorage();
    const deps = { storage: s.provisionStatus, now: () => 5 };
    const report = (stk: string, mac: string) => handlePostServerSeen(deps, SERIAL, { stkPubHex: stk, macHex: mac });
    expect((await report("ab".repeat(32), "cd".repeat(32))).status).toBe(404);
    await s.provisionStatus.putProvisionStatus(SERIAL, { phase: "booting", ts: 1 });
    expect((await report("ab".repeat(32), "cd".repeat(32))).status).toBe(200);
    for (let i = 0; i < 6; i++) await report("ab".repeat(32), i.toString(16).padStart(2, "0").repeat(32));
    const r = await handleGetProvisionStatus(deps, SERIAL);
    const seen = (r.body as { serverSeen: Array<{ macHex: string }> }).serverSeen;
    expect(seen).toHaveLength(4);
    expect(seen.at(-1)?.macHex).toBe("05".repeat(32));
    // A later phase report keeps them.
    await s.provisionStatus.putProvisionStatus(SERIAL, { phase: "registering", ts: 2 });
    expect(((await handleGetProvisionStatus(deps, SERIAL)).body as { serverSeen: unknown[] }).serverSeen).toHaveLength(4);
  });

  it("refuses anything but hex key and MAC, and a malformed serial", async () => {
    const s = new InMemoryStorage();
    await s.provisionStatus.putProvisionStatus(SERIAL, { phase: "booting", ts: 1 });
    const deps = { storage: s.provisionStatus };
    expect((await handlePostServerSeen(deps, SERIAL, { stkPubHex: "AB".repeat(32), macHex: "cd".repeat(32) })).status).toBe(400);
    expect((await handlePostServerSeen(deps, SERIAL, { stkPubHex: "ab".repeat(32) })).status).toBe(400);
    expect((await handlePostServerSeen(deps, "../x", { stkPubHex: "ab".repeat(32), macHex: "cd".repeat(32) })).status).toBe(400);
  });
});
