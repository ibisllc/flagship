import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyBootSuspension,
  canonicalBootSuspension,
  initialSuspension,
  mayReleaseLease,
  signBootSuspension,
  verifyBootSuspension,
  maxLeaseExpiryForDeadMan,
  type BootSuspensionOrder,
  type BootSuspensionState,
} from "../src/bootSuspension.js";
import { ed } from "../src/edSync.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/boot-suspension/vectors.json", import.meta.url), "utf8"));
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("boot suspension vectors (shared with Swift and Kotlin)", () => {
  it("replays every step to the same outcome, canonical bytes and signature", () => {
    let state: BootSuspensionState | null = null;
    for (const s of V.steps) {
      const o: BootSuspensionOrder = s.order;
      expect(new TextDecoder().decode(canonicalBootSuspension(o)), s.name).toBe(s.canonical);
      const pub = unhex(o.signer === "owner" ? V.ownerPubHex : V.boxPubHex);
      expect(verifyBootSuspension(o, unhex(s.signatureHex), pub), s.name).toBe(true);
      expect(verifyBootSuspension(o, unhex(s.signatureHex), unhex(o.signer === "owner" ? V.boxPubHex : V.ownerPubHex)), s.name).toBe(false);
      const r = applyBootSuspension(state, o, s.signatureHex, s.now);
      if (r.ok) state = r.state;
      const got = r.ok ? { ok: true, suspended: r.state.suspended, epoch: r.state.epoch, seq: r.state.seq } : { ok: false, code: r.code };
      expect(got, s.name).toEqual(s.expect);
    }
  });
});

describe("the rules", () => {
  const D = "box.test";
  const T = 1_800_000_000_000;
  const owner = (epoch: number, action: "suspend" | "resume"): BootSuspensionOrder => ({ serverDomain: D, epoch, seq: 0, action, reason: action === "suspend" ? "manual-lock" : "owner-resume", signer: "owner", issuedAt: T });
  const box = (epoch: number, seq: number): BootSuspensionOrder => ({ serverDomain: D, epoch, seq, action: "suspend", reason: "dead-man", signer: "box", issuedAt: T });

  it("a missing or unreadable record never releases a lease", () => {
    expect(mayReleaseLease(undefined)).toBe(false);
    expect(mayReleaseLease(null)).toBe(false);
    expect(mayReleaseLease(initialSuspension(D))).toBe(true);
  });

  it("a thief with the box key cannot clear a lock, lower the epoch or burn the owner's next one", () => {
    let st = (applyBootSuspension(null, owner(1, "suspend"), "aa", T) as { ok: true; state: BootSuspensionState }).state;
    for (const o of [box(1, 1), { ...box(1, 1), action: "resume" as const }, box(2, 1), box(0, 1), box(1, 9)]) {
      const r = applyBootSuspension(st, o, "bb", T + 60_000);
      if (r.ok) expect(r.state.suspended).toBe(true);
      else expect(["box-cannot-resume", "future-epoch", "stale-epoch", "seq-jump"]).toContain(r.code);
    }
    // The owner can still resume at epoch + 1 no matter what the box did.
    const resumed = applyBootSuspension(st, owner(2, "resume"), "cc", T + 1);
    expect(resumed.ok && resumed.state.suspended === false).toBe(true);
  });

  it("box writes are rate-limited and counters cannot overflow", () => {
    const st0 = (applyBootSuspension(null, owner(1, "resume"), "aa", T) as { ok: true; state: BootSuspensionState }).state;
    const a = applyBootSuspension(st0, box(1, 1), "bb", T) as { ok: true; state: BootSuspensionState };
    expect(a.ok && a.state.suspended).toBe(true);
    const re = applyBootSuspension({ ...a.state, suspended: false }, box(1, 2), "bb", T + 1000);
    expect(re.ok).toBe(false);
    expect(!re.ok && re.code).toBe("too-soon");
    const big = applyBootSuspension(null, owner(2 ** 31, "suspend"), "aa", T);
    expect(!big.ok && big.code).toBe("counter-overflow");
  });

  it("rejects fields that would break the canonical form", () => {
    expect(() => canonicalBootSuspension({ ...owner(1, "suspend"), serverDomain: "a|b" })).toThrow();
    expect(() => canonicalBootSuspension({ ...owner(1, "suspend"), epoch: -1 })).toThrow();
    expect(() => canonicalBootSuspension({ ...owner(1, "suspend"), reason: "x\ny" as never })).toThrow();
    const sk = new Uint8Array(32).fill(3);
    const sig = signBootSuspension(owner(1, "suspend"), sk);
    expect(verifyBootSuspension({ ...owner(1, "suspend"), epoch: 2 }, sig, ed.getPublicKey(sk))).toBe(false);
  });

  it("a dead-man lease never outlives its affirmation", () => {
    expect(maxLeaseExpiryForDeadMan(1000, 5000)).toBe(1000);
    expect(maxLeaseExpiryForDeadMan(9000, 5000)).toBe(5000);
  });
});
