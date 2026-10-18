import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  acceptSecurityNotice,
  canonicalSecurityNotice,
  clientBelowMinimum,
  parseSecurityNotice,
  securityNoticeOutcome,
  securityNoticeProblem,
  securityNoticeText,
  signSecurityNotice,
  storedSecurityNoticeOutcome,
  verifySecurityNotice,
  SECURITY_NOTICE_MAX_WINDOW_MS,
  type SecurityNotice,
  type SecurityNoticeBody,
  type SecurityNoticeStore,
} from "../src/securityNotice.js";
import { ed } from "../src/edSync.js";
import { buildSecurityNoticeVectors, VECTORS_PATH, T0 } from "./genSecurityNoticeVectors.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as any;
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const DAY = 24 * 3600_000;
const auth = V.keys.authorityPubHex as string;

describe("security-notice vectors", () => {
  it("the file is what the generator writes", () => {
    expect(V).toEqual(JSON.parse(JSON.stringify(buildSecurityNoticeVectors())));
  });

  it("reproduces every canonical string and verifies every positive", () => {
    for (const p of V.positive) {
      const n = parseSecurityNotice(p.notice);
      expect(n, p.name).not.toBeNull();
      expect(text(canonicalSecurityNotice(n!, n!.signedBy)), p.name).toBe(p.canonical);
      expect(verifySecurityNotice(n!, [auth]), p.name).toEqual({ ok: true });
    }
  });

  it("refuses every reject with its reason", () => {
    for (const r of V.reject) {
      const n = parseSecurityNotice(r.notice);
      const got = n ? verifySecurityNotice(n, [auth]) : { ok: false, reason: "malformed" };
      expect(got, r.name).toEqual({ ok: false, reason: r.expect });
    }
  });

  it("will not build bytes for a body that breaks a rule", () => {
    for (const u of V.unsignable) {
      expect(securityNoticeProblem(u.body, auth), u.name).toBe(u.code);
    }
  });

  it("shows what the outcomes table says", () => {
    for (const o of V.outcomes) {
      const n = parseSecurityNotice(o.notice)!;
      const got = securityNoticeOutcome(n, o.client, o.now);
      const flat =
        got.action === "none" ? { action: "none", why: got.why } : got.action === "banner" ? { action: "banner", style: got.style } : { action: "lock" };
      expect(flat, o.name).toEqual(o.expect);
    }
  });

  it("absorbs candidates the way the accept table says", () => {
    for (const a of V.accept) {
      const st: SecurityNoticeStore = { highestSeq: a.store.highestSeq, notice: a.store.notice ? parseSecurityNotice(a.store.notice) : null };
      const r = acceptSecurityNotice(st, a.candidate, a.authorityKeys);
      expect({ highestSeq: r.store.highestSeq, seq: r.store.notice ? r.store.notice.seq : null, refused: r.refused }, a.name).toEqual(a.expect);
    }
  });
});

describe("security notice rules", () => {
  const seed = new Uint8Array(32).fill(0x77);
  const authority = { publicKey: ed.getPublicKey(seed), privateKey: seed };
  const body = (over: Partial<SecurityNoticeBody> = {}): SecurityNoticeBody => ({
    seq: 7,
    kind: "update-required",
    validFrom: T0,
    validUntil: T0 + 10 * DAY,
    eventAt: 0,
    lockFrom: T0 + DAY,
    platforms: { ios: { minBuild: 20, minProtocol: 0 } },
    advisoryId: "FSA-1",
    deprecatesProtocol: 0,
    reason: "A signing flaw.",
    message: "Update now.",
    ...over,
  });
  const client = { platform: "ios" as const, build: 19, protocol: 1 };

  it("refuses a window over 30 days at exactly one millisecond past the cap", () => {
    expect(securityNoticeProblem(body({ validUntil: T0 + SECURITY_NOTICE_MAX_WINDOW_MS }), auth)).toBeNull();
    expect(securityNoticeProblem(body({ validUntil: T0 + SECURITY_NOTICE_MAX_WINDOW_MS + 1 }), auth)).toBe("window-too-long");
  });

  it("will not sign update-required without a named security reason", () => {
    expect(() => signSecurityNotice(body({ advisoryId: "" }), authority)).toThrow(/advisory-required/);
    expect(() => signSecurityNotice(body({ reason: "" }), authority)).toThrow(/reason-required/);
  });

  it("only update-required locks, and never outside its window", () => {
    for (const kind of ["maintenance", "update-advisory"] as const) {
      const n = signSecurityNotice(
        body({ kind, lockFrom: 0, advisoryId: "", reason: "", platforms: kind === "maintenance" ? {} : { ios: { minBuild: 20, minProtocol: 0 } } }),
        authority,
      );
      for (const t of [T0, T0 + DAY, T0 + 5 * DAY]) expect(securityNoticeOutcome(n, client, t).action).not.toBe("lock");
    }
    const n = signSecurityNotice(body(), authority);
    expect(securityNoticeOutcome(n, client, T0 - 1).action).toBe("none");
    expect(securityNoticeOutcome(n, client, T0 + DAY - 1).action).toBe("banner");
    expect(securityNoticeOutcome(n, client, T0 + DAY).action).toBe("lock");
    expect(securityNoticeOutcome(n, client, T0 + 10 * DAY - 1).action).toBe("lock");
    expect(securityNoticeOutcome(n, client, T0 + 10 * DAY).action).toBe("none");
    expect(securityNoticeOutcome(n, client, T0 + 10 * DAY + 400 * DAY).action).toBe("none");
  });

  it("does not lock another platform, a newer build or a matching protocol", () => {
    const n = signSecurityNotice(body(), authority);
    const at = T0 + 2 * DAY;
    expect(securityNoticeOutcome(n, { ...client, platform: "android" }, at).action).toBe("none");
    expect(securityNoticeOutcome(n, { ...client, build: 20 }, at).action).toBe("none");
    const p = signSecurityNotice(body({ platforms: { ios: { minBuild: 0, minProtocol: 2 } } }), authority);
    expect(securityNoticeOutcome(p, { ...client, protocol: 2 }, at).action).toBe("none");
    expect(securityNoticeOutcome(p, { ...client, build: 999, protocol: 1 }, at).action).toBe("lock");
    expect(clientBelowMinimum(p, { ...client, protocol: 1 })).toBe(true);
  });

  it("a signed all clear ends a lock, and a lower seq cannot bring it back", () => {
    const lock = signSecurityNotice(body({ seq: 7 }), authority);
    const clear = signSecurityNotice(
      body({ seq: 8, kind: "none", lockFrom: 0, advisoryId: "", reason: "", message: "", platforms: {} }),
      authority,
    );
    let st: SecurityNoticeStore = { highestSeq: 0, notice: null };
    st = acceptSecurityNotice(st, lock, [auth]).store;
    expect(storedSecurityNoticeOutcome(st, [auth], client, T0 + 2 * DAY).action).toBe("lock");
    st = acceptSecurityNotice(st, clear, [auth]).store;
    expect(storedSecurityNoticeOutcome(st, [auth], client, T0 + 2 * DAY).action).toBe("none");
    const again = acceptSecurityNotice(st, lock, [auth]);
    expect(again.refused).toBe("stale");
    expect(storedSecurityNoticeOutcome(again.store, [auth], client, T0 + 2 * DAY).action).toBe("none");
  });

  it("a stored lock shows nothing when the authority cannot be established", () => {
    const lock = signSecurityNotice(body(), authority);
    const st: SecurityNoticeStore = { highestSeq: lock.seq, notice: lock };
    expect(storedSecurityNoticeOutcome(st, [auth], client, T0 + 2 * DAY).action).toBe("lock");
    expect(storedSecurityNoticeOutcome(st, [], client, T0 + 2 * DAY).action).toBe("none");
    expect(storedSecurityNoticeOutcome(st, ["00".repeat(32)], client, T0 + 2 * DAY).action).toBe("none");
  });

  it("a fetch that fails or returns junk never changes the store", () => {
    const lock = signSecurityNotice(body(), authority);
    const st: SecurityNoticeStore = { highestSeq: lock.seq, notice: lock };
    for (const junk of [null, undefined, 5, "x", [], {}, { type: "SecurityNotice", version: 1 }] as unknown[]) {
      expect(acceptSecurityNotice(st, junk, [auth]).store).toBe(st);
    }
  });

  it("rejects a notice whose signature is flipped by one bit", () => {
    const n = signSecurityNotice(body(), authority);
    const flipped: SecurityNotice = { ...n, signature: (n.signature[0] === "0" ? "1" : "0") + n.signature.slice(1) };
    expect(verifySecurityNotice(flipped, [auth])).toEqual({ ok: false, reason: "signature-invalid" });
  });

  it("renders {date} through the caller's formatter", () => {
    const n = signSecurityNotice(
      body({ kind: "maintenance", lockFrom: 0, advisoryId: "", reason: "", platforms: {}, eventAt: T0 + DAY, message: "We update on {date}, {date}." }),
      authority,
    );
    expect(securityNoticeText(n, () => "Tue 21 Oct")).toBe("We update on Tue 21 Oct, Tue 21 Oct.");
  });
});
