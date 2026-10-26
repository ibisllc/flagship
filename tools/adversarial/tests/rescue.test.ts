/**
 * V01 adversarial suite: the rescue session and offline control (docs/data-sovereignty.md). The
 * attacker is on the owner's LAN or reaches the box through the relay, holds no owner key, and may
 * replay, relabel or lift anything it has seen; or it is a compromised daemon asking keyd to sign.
 * The end-to-end refusals (stranger, replay, stale, other server or session, IRK on a pinned box,
 * strict without the hybrid half, a machine in the middle, flooded hellos starving revocations) live
 * in packages/server-daemon/tests/rescue.test.ts against real TLS; these are the protocol-level ones.
 *
 *   AT-RSC-01  a signature lifted to another rescue message type            -> refused
 *   AT-RSC-02  an order's signature moved to another session, server or action -> refused
 *   AT-RSC-03  keyd signs only well-formed hellos, and never an owner message  -> refused
 *   AT-RSC-04  the discovery id names no server and differs per server         -> nothing to read off the LAN
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  offlineControlCanonicalBytes,
  rescueDiscoveryId,
  rescueHelloCanonicalBytes,
  rescueSessionCanonicalBytes,
  signOfflineControl,
  signRescueSession,
  verifyOfflineControl,
  type OfflineControlOrder,
  type RescueExchange,
} from "../../../packages/protocol/src/index.js";
import { BOX_SIGN_PURPOSES, checkSign } from "../../../packages/keyd/src/policy.js";

const key = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const owner = key(1);
const box = key(2);
const hex32 = (c: string) => c.repeat(32);
const ex: RescueExchange = { serverDomain: "home.alice.flagship.services", clientNonce: hex32("a"), boxNonce: hex32("b"), certSha256: "c".repeat(64), issuedAt: 1_800_000_000_000 };
const order: OfflineControlOrder = { serverDomain: ex.serverDomain, sessionNonce: ex.boxNonce, action: "app-stop", target: "alice--notes", nonce: hex32("d"), issuedAt: ex.issuedAt };
const refusal = (f: () => unknown): string => {
  try {
    f();
    return "allowed";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("AT-RSC-01 a signature lifted to another rescue message type", () => {
  it("the owner's session signature is not a hello, and not an offline order", () => {
    const sig = signRescueSession(ex, owner);
    expect(ed.verify(sig, rescueSessionCanonicalBytes(ex), owner.publicKey)).toBe(true);
    expect(ed.verify(sig, rescueHelloCanonicalBytes(ex), owner.publicKey)).toBe(false);
    expect(ed.verify(sig, offlineControlCanonicalBytes(order), owner.publicKey)).toBe(false);
  });

  it("an offline order's signature opens no session and is no hello", () => {
    const sig = signOfflineControl(order, owner);
    expect(verifyOfflineControl(order, sig, owner.publicKey)).toBe(true);
    expect(ed.verify(sig, rescueSessionCanonicalBytes(ex), owner.publicKey)).toBe(false);
    expect(ed.verify(sig, rescueHelloCanonicalBytes(ex), owner.publicKey)).toBe(false);
  });

  it("the box's hello signature is not an owner order", () => {
    const sig = ed.sign(rescueHelloCanonicalBytes(ex), box.privateKey);
    expect(ed.verify(sig, rescueSessionCanonicalBytes(ex), box.publicKey)).toBe(false);
    expect(ed.verify(sig, offlineControlCanonicalBytes(order), box.publicKey)).toBe(false);
  });
});

describe("AT-RSC-02 an order's signature moved to another session, server or action", () => {
  const sig = signOfflineControl(order, owner);
  for (const [what, moved] of [
    ["another session", { ...order, sessionNonce: hex32("e") }],
    ["another server", { ...order, serverDomain: "home.mallory.flagship.services", target: order.target }],
    ["another action", { ...order, action: "app-start" as const }],
    ["another app", { ...order, target: "alice--wiki" }],
    ["another nonce", { ...order, nonce: hex32("f") }],
    ["another time", { ...order, issuedAt: order.issuedAt + 1 }],
    ["a shutdown instead", { ...order, action: "server-shutdown" as const, target: order.serverDomain }],
  ] as const) {
    it(`refuses it for ${what}`, () => expect(verifyOfflineControl(moved, sig, owner.publicKey)).toBe(false));
  }
  it("a separator smuggled into a field never makes a different order", () => {
    expect(refusal(() => offlineControlCanonicalBytes({ ...order, target: "alice--notes|app-start" }))).toContain("bad target");
    expect(refusal(() => offlineControlCanonicalBytes({ ...order, serverDomain: "home.alice.flagship.services|x" }))).not.toBe("allowed");
  });
});

describe("AT-RSC-03 keyd signs only well-formed hellos, and never an owner message", () => {
  const msg = (s: string) => new TextEncoder().encode(s);
  const pub = "00".repeat(32);
  it("signs a real hello", () => {
    expect(refusal(() => checkSign(rescueHelloCanonicalBytes(ex), pub))).toBe("allowed");
  });
  it("refuses a hello-tagged message that is anything else", () => {
    for (const bad of [
      "flagship/rescue-hello/v1|anything at all",
      `flagship/rescue-hello/v1|${ex.serverDomain}|${hex32("a")}|${hex32("b")}|${"c".repeat(64)}|1|extra`,
      `flagship/rescue-hello/v1|${ex.serverDomain}|zz|${hex32("b")}|${"c".repeat(64)}|1`,
      `flagship/rescue-hello/v1|${ex.serverDomain}|${hex32("a")}|${hex32("b")}|${"c".repeat(63)}|1`,
      `flagship/rescue-hello/v1|${ex.serverDomain}|${hex32("a")}|${hex32("b")}|${"c".repeat(64)}|-1`,
    ]) expect(refusal(() => checkSign(msg(bad), pub)), bad).toContain("rescue hello");
  });
  it("the owner's rescue messages are not box purposes", () => {
    expect(BOX_SIGN_PURPOSES.has("flagship/rescue-session/v1")).toBe(false);
    expect(BOX_SIGN_PURPOSES.has("flagship/offline-control/v1")).toBe(false);
    expect(refusal(() => checkSign(rescueSessionCanonicalBytes(ex), pub))).toContain("does not sign");
    expect(refusal(() => checkSign(offlineControlCanonicalBytes(order), pub))).toContain("does not sign");
  });
});

describe("AT-RSC-04 what the box announces on the LAN", () => {
  it("the discovery id differs per server and per key, and contains neither the name nor the key", () => {
    const a = rescueDiscoveryId(box.publicKey, "home.alice.flagship.services");
    const b = rescueDiscoveryId(box.publicKey, "nas.alice.flagship.services");
    const c = rescueDiscoveryId(owner.publicKey, "home.alice.flagship.services");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(box.publicKey).toString("hex")).not.toContain(a);
  });
});
