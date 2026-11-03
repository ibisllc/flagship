/**
 * `flagship/journal-read/v2` (review 2026-10-25 #15): the owner's journal read carries a
 * single-use nonce in its signed bytes, so the box can refuse a replay inside the 5-minute window.
 */
import { describe, expect, it } from "vitest";
import { canonicalJournalRequest, ed, signJournalRequest, verifyJournalRequest, type JournalRequest } from "../src/index.js";

const r: JournalRequest = { serverId: "home.harry.flagship.services", unit: "flagship-daemon", lines: 200, nonce: "0123456789abcdef0123456789abcdef", issuedAt: 1735689600000 };
const priv = new Uint8Array(32).fill(7);
const kp = { privateKey: priv, publicKey: ed.getPublicKey(priv) };

describe("flagship/journal-read/v2", () => {
  it("binds the nonce: tag|serverId|unit|lines|nonce|issuedAt", () => {
    expect(new TextDecoder().decode(canonicalJournalRequest(r))).toBe(
      "flagship/journal-read/v2|home.harry.flagship.services|flagship-daemon|200|0123456789abcdef0123456789abcdef|1735689600000",
    );
    const sig = signJournalRequest(r, kp);
    expect(verifyJournalRequest(r, sig, kp.publicKey)).toBe(true);
    expect(verifyJournalRequest({ ...r, nonce: "f".repeat(32) }, sig, kp.publicKey)).toBe(false);
  });

  it("refuses a missing, upper-case or short nonce", () => {
    for (const nonce of [undefined, "", "0123456789ABCDEF0123456789ABCDEF", "abcd", "0123456789abcdef0123456789abcdef|"]) {
      expect(() => canonicalJournalRequest({ ...r, nonce } as JournalRequest)).toThrow(/nonce/);
    }
  });

  it("never verifies a v1 signature (no nonce) as v2", () => {
    const v1 = new TextEncoder().encode(["flagship/journal-read/v1", r.serverId, r.unit, String(r.lines), String(r.issuedAt)].join("|"));
    expect(verifyJournalRequest(r, ed.sign(v1, priv), kp.publicKey)).toBe(false);
  });
});
