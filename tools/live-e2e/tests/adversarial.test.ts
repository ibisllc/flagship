import { describe, expect, it } from "vitest";
import { classifyEgressProbe, flipSig, isRefusal, sansConfined, signatureVariants, statusOf, ZERO_SIG } from "../lib/adversarial.js";

const VALID = "a1".repeat(64);

describe("live adversarial helpers", () => {
  it("flips exactly one bit of the first byte and refuses non-hex", () => {
    expect(flipSig(VALID)).toBe("a0" + "a1".repeat(63));
    expect(flipSig(flipSig(VALID))).toBe(VALID);
    expect(() => flipSig("xyz")).toThrow();
  });

  it("builds every refusal shape around a valid signature, never the valid one itself", () => {
    const v = signatureVariants(VALID, { "B's admin root": "bb".repeat(64) });
    expect(v.map((x) => x.label)).toEqual(["all-zero signature", "one bit flipped", "signature left out", "truncated signature", "not hex", "signed by B's admin root"]);
    expect(v.find((x) => x.label === "signature left out")!.signature).toBeUndefined();
    expect(v.some((x) => x.signature === VALID)).toBe(false);
    expect(v[0]!.signature).toBe(ZERO_SIG);
    expect(v[3]!.signature).toHaveLength(64);
  });

  it("counts only a 4xx as a refusal", () => {
    expect([400, 401, 403, 404, 409, 499].every(isRefusal)).toBe(true);
    expect([0, 200, 204, 302, 500, 503].some(isRefusal)).toBe(false);
  });

  it("reads an egress probe: a TLS error means a TCP connection was made", () => {
    expect(classifyEgressProbe({ reached: true, status: 200 })).toBe("reached");
    expect(classifyEgressProbe({ reached: false, error: "<urlopen error [SSL: WRONG_VERSION_NUMBER] wrong version number (_ssl.c:1000)>" })).toBe("connected");
    expect(classifyEgressProbe({ reached: false, error: "<urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed>" })).toBe("connected");
    expect(classifyEgressProbe({ reached: false, error: "<urlopen error Tunnel connection failed: 403 Forbidden>" })).toBe("fenced");
    expect(classifyEgressProbe({ reached: false, error: "<urlopen error [Errno 111] Connection refused>" })).toBe("fenced");
    expect(classifyEgressProbe({ reached: false, error: "<urlopen error timed out>" })).toBe("fenced");
    expect(classifyEgressProbe({ reached: false, error: "<urlopen error [Errno -2] Name or service not known>" })).toBe("fenced");
    expect(classifyEgressProbe({ reached: false, error: "something new" })).toBe("unclear");
    expect(classifyEgressProbe(null)).toBe("unclear");
  });

  it("keeps a certificate inside one account's names", () => {
    const apex = "gym.flagship.services";
    expect(sansConfined(["home.alice.gym.flagship.services", "*.home.alice.gym.flagship.services", "*.alice.gym.flagship.services"], "alice", apex)).toBe(true);
    expect(sansConfined(["home.alice.gym.flagship.services", "home.bob.gym.flagship.services"], "alice", apex)).toBe(false);
    expect(sansConfined(["evilalice.gym.flagship.services"], "alice", apex)).toBe(false);
    expect(sansConfined(["*.gym.flagship.services"], "alice", apex)).toBe(false);
    expect(sansConfined([], "alice", apex)).toBe(false);
  });

  it("reads the status line of a raw answer", () => {
    expect(statusOf("HTTP/1.1 403 Forbidden\r\nx: y\r\n\r\n{}")).toBe(403);
    expect(statusOf("garbage")).toBe(0);
  });
});
