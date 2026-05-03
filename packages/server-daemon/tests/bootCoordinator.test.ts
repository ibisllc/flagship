import { describe, expect, it } from "vitest";
import { deriveBAK, signBootApproval } from "@flagship/protocol";
import { BootCoordinator } from "../src/bootCoordinator.js";

const umk = { seed: new Uint8Array(32).fill(13) };

describe("BootCoordinator", () => {
  it("creates a challenge bound to the server id", () => {
    const bak = deriveBAK(umk, "srv-X");
    const coord = new BootCoordinator("srv-X", bak.publicKey);
    const { challenge, nonceId } = coord.createChallenge();
    expect(challenge.serverId).toBe("srv-X");
    expect(challenge.nonce.length).toBe(32);
    expect(nonceId.length).toBe(16);
  });

  it("accepts a valid signed approval and consumes the challenge", () => {
    const bak = deriveBAK(umk, "srv-1");
    const coord = new BootCoordinator("srv-1", bak.publicKey);
    const { challenge, nonceId } = coord.createChallenge();
    const sig = signBootApproval(challenge, bak);
    expect(coord.submitApproval(nonceId, sig)).toEqual({ ok: true });
    expect(coord.pendingCount()).toBe(0);
  });

  it("rejects an unknown nonceId", () => {
    const bak = deriveBAK(umk, "srv-1");
    const coord = new BootCoordinator("srv-1", bak.publicKey);
    const result = coord.submitApproval("deadbeef00000000", new Uint8Array(64));
    expect(result).toEqual({ ok: false, reason: "challenge-not-found" });
  });

  it("rejects an expired challenge", () => {
    const bak = deriveBAK(umk, "srv-1");
    let now = 1000;
    const coord = new BootCoordinator("srv-1", bak.publicKey, {
      challengeTtlMs: 100,
      now: () => now,
    });
    const { challenge, nonceId } = coord.createChallenge();
    const sig = signBootApproval(challenge, bak);
    now += 200;
    expect(coord.submitApproval(nonceId, sig)).toEqual({
      ok: false,
      reason: "challenge-expired",
    });
  });

  it("rejects a signature from a different server's BAK", () => {
    const bakSelf = deriveBAK(umk, "srv-1");
    const bakOther = deriveBAK(umk, "srv-2");
    const coord = new BootCoordinator("srv-1", bakSelf.publicKey);
    const { challenge, nonceId } = coord.createChallenge();
    const sig = signBootApproval(challenge, bakOther);
    expect(coord.submitApproval(nonceId, sig)).toEqual({
      ok: false,
      reason: "invalid-signature",
    });
  });

  it("does not consume a challenge on failure (allows retry until TTL)", () => {
    const bak = deriveBAK(umk, "srv-1");
    const coord = new BootCoordinator("srv-1", bak.publicKey);
    const { challenge, nonceId } = coord.createChallenge();
    const bogus = new Uint8Array(64);
    coord.submitApproval(nonceId, bogus);
    expect(coord.pendingCount()).toBe(1);
    const sig = signBootApproval(challenge, bak);
    expect(coord.submitApproval(nonceId, sig)).toEqual({ ok: true });
  });
});
