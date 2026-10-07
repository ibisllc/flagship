import { describe, expect, it } from "vitest";
import {
  mintRecoveryProof,
  verifyRecoveryProof,
  RECOVERY_PROOF_TTL_MS,
} from "../src/recoveryProof.js";

const SECRET = "worker-secret-0123456789abcdef";
const BINDING = { username: "alice", fetchTokenHashHex: "ab".repeat(32) };
const T0 = 1_700_000_000_000;

describe("recovery-session proof", () => {
  it("round-trips a freshly minted proof", async () => {
    const { token, expiresAt } = await mintRecoveryProof(BINDING, SECRET, { now: T0 });
    expect(expiresAt).toBe(T0 + RECOVERY_PROOF_TTL_MS);
    const v = await verifyRecoveryProof(token, BINDING, SECRET, { now: T0 + 1_000 });
    expect(v.ok).toBe(true);
  });

  it("is bound to the username — a token for one account is useless on another", async () => {
    const { token } = await mintRecoveryProof(BINDING, SECRET, { now: T0 });
    const v = await verifyRecoveryProof(
      token,
      { ...BINDING, username: "bob" },
      SECRET,
      { now: T0 },
    );
    expect(v).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("is case-insensitive on the username (handles are lowercased)", async () => {
    const { token } = await mintRecoveryProof(
      { ...BINDING, username: "Alice" },
      SECRET,
      { now: T0 },
    );
    const v = await verifyRecoveryProof(token, BINDING, SECRET, { now: T0 });
    expect(v.ok).toBe(true);
  });

  it("is bound to the record's fetchToken hash — rotating the passphrase kills it", async () => {
    const { token } = await mintRecoveryProof(BINDING, SECRET, { now: T0 });
    const v = await verifyRecoveryProof(
      token,
      { ...BINDING, fetchTokenHashHex: "cd".repeat(32) },
      SECRET,
      { now: T0 },
    );
    expect(v).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token minted under a different secret", async () => {
    const { token } = await mintRecoveryProof(BINDING, "other-secret", { now: T0 });
    const v = await verifyRecoveryProof(token, BINDING, SECRET, { now: T0 });
    expect(v).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("expires", async () => {
    const { token } = await mintRecoveryProof(BINDING, SECRET, { now: T0 });
    const v = await verifyRecoveryProof(token, BINDING, SECRET, {
      now: T0 + RECOVERY_PROOF_TTL_MS + 1,
    });
    expect(v).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses an over-long window even when the MAC is valid", async () => {
    // The ceiling lives with the VERIFIER, so a minter that widens its
    // TTL can't outlive a deploy of the verifying code.
    const { token } = await mintRecoveryProof(BINDING, SECRET, {
      now: T0,
      ttlMs: 365 * 24 * 60 * 60_000,
    });
    const v = await verifyRecoveryProof(token, BINDING, SECRET, { now: T0 });
    expect(v).toEqual({ ok: false, reason: "ttl-too-long" });
  });

  it("cannot be forged by rewriting the expiry on a real token", async () => {
    const { token } = await mintRecoveryProof(BINDING, SECRET, { now: T0 });
    const [prefix, , mac] = token.split(".");
    const extended = [prefix, String(T0 + RECOVERY_PROOF_TTL_MS - 1), mac].join(".");
    const v = await verifyRecoveryProof(extended, BINDING, SECRET, { now: T0 });
    expect(v).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "garbage",
      "rp1.notanumber.aa",
      "rp2." + String(T0 + 1000) + "." + "ab".repeat(32),
      "rp1." + String(T0 + 1000) + ".tooshort",
    ]) {
      const v = await verifyRecoveryProof(bad, BINDING, SECRET, { now: T0 });
      expect(v.ok).toBe(false);
    }
  });
});
