import { describe, expect, it } from "vitest";
import {
  SESSION_LOCK_MS,
  applyClaim,
  applyPairRead,
  applyUnpair,
  initialSnapshot,
  tick,
} from "../../src/nfcPairing/pairStateMachine.js";

const SID = "deadbeef".repeat(4); // 32-hex sessionId

describe("pair state machine (N-BOX-5)", () => {
  it("starts UNPAIRED", () => {
    const s = initialSnapshot();
    expect(s.state).toBe("UNPAIRED");
    expect(s.sessionId).toBeNull();
    expect(s.lockExpiresAt).toBeNull();
    expect(s.pairedAt).toBeNull();
  });

  it("PAIR read latches SESSION_LOCKED with a 30 s window", () => {
    const r = applyPairRead(initialSnapshot(), SID, 1_000);
    expect(r.ok).toBe(true);
    expect(r.rotateKeys).toBe(false);
    expect(r.newSnapshot.state).toBe("SESSION_LOCKED");
    expect(r.newSnapshot.sessionId).toBe(SID);
    expect(r.newSnapshot.lockExpiresAt).toBe(1_000 + SESSION_LOCK_MS);
  });

  it("ignores a second tap while a lock is active (first-tap-wins)", () => {
    const a = applyPairRead(initialSnapshot(), SID, 1_000);
    const b = applyPairRead(a.newSnapshot, "ffff".repeat(8), 1_500);
    expect(b.ok).toBe(false);
    expect(b.newSnapshot.sessionId).toBe(SID);
  });

  it("re-latches a fresh tap once the lock has expired (caller rotates keys)", () => {
    const a = applyPairRead(initialSnapshot(), SID, 0);
    const b = applyPairRead(a.newSnapshot, "abcd".repeat(8), SESSION_LOCK_MS + 1);
    expect(b.ok).toBe(true);
    expect(b.rotateKeys).toBe(true);
    expect(b.newSnapshot.sessionId).toBe("abcd".repeat(8));
  });

  it("matching claim within window latches PAIRED", () => {
    const after = applyPairRead(initialSnapshot(), SID, 0).newSnapshot;
    const r = applyClaim(after, { sessionId: SID, at: 500 });
    expect(r.verdict.ok).toBe(true);
    expect(r.newSnapshot.state).toBe("PAIRED");
    expect(r.newSnapshot.pairedAt).toBe(500);
  });

  it("rejects claim with wrong sessionId", () => {
    const after = applyPairRead(initialSnapshot(), SID, 0).newSnapshot;
    const r = applyClaim(after, { sessionId: "00".repeat(16), at: 500 });
    expect(r.verdict.ok).toBe(false);
    expect(r.newSnapshot.state).toBe("SESSION_LOCKED");
  });

  it("rejects claim with no session locked", () => {
    const r = applyClaim(initialSnapshot(), { sessionId: SID, at: 0 });
    expect(r.verdict.ok).toBe(false);
    if (!r.verdict.ok) expect(r.verdict.reason).toBe("no-session-locked");
  });

  it("rejects claim after the lock window expired", () => {
    const after = applyPairRead(initialSnapshot(), SID, 0).newSnapshot;
    const r = applyClaim(after, { sessionId: SID, at: SESSION_LOCK_MS + 1 });
    expect(r.verdict.ok).toBe(false);
    if (!r.verdict.ok) expect(r.verdict.reason).toBe("session-expired");
  });

  it("rejects subsequent claims once PAIRED (first-claim-wins)", () => {
    const locked = applyPairRead(initialSnapshot(), SID, 0).newSnapshot;
    const paired = applyClaim(locked, { sessionId: SID, at: 100 }).newSnapshot;
    const second = applyClaim(paired, { sessionId: SID, at: 200 });
    expect(second.verdict.ok).toBe(false);
    if (!second.verdict.ok) expect(second.verdict.reason).toBe("already-paired");
  });

  it("tick fires rotateKeys when lock expires without a claim", () => {
    const locked = applyPairRead(initialSnapshot(), SID, 0).newSnapshot;
    const t = tick(locked, SESSION_LOCK_MS + 1);
    expect(t.rotateKeys).toBe(true);
    expect(t.newSnapshot.state).toBe("UNPAIRED");
  });

  it("tick is a no-op while locked + within window", () => {
    const locked = applyPairRead(initialSnapshot(), SID, 0).newSnapshot;
    const t = tick(locked, 500);
    expect(t.rotateKeys).toBe(false);
    expect(t.newSnapshot.state).toBe("SESSION_LOCKED");
  });

  it("BoxUnpair from PAIRED rebinds to UNPAIRED", () => {
    const locked = applyPairRead(initialSnapshot(), SID, 0).newSnapshot;
    const paired = applyClaim(locked, { sessionId: SID, at: 100 }).newSnapshot;
    const unpaired = applyUnpair(paired);
    expect(unpaired.state).toBe("UNPAIRED");
    expect(unpaired.sessionId).toBeNull();
  });

  it("BoxUnpair from UNPAIRED is a no-op", () => {
    const u = applyUnpair(initialSnapshot());
    expect(u.state).toBe("UNPAIRED");
  });

  it("BoxUnpair from SESSION_LOCKED returns to UNPAIRED (caller rotates next tick)", () => {
    const locked = applyPairRead(initialSnapshot(), SID, 0).newSnapshot;
    const u = applyUnpair(locked);
    expect(u.state).toBe("UNPAIRED");
    expect(u.sessionId).toBeNull();
  });
});
