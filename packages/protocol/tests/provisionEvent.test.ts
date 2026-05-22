import { describe, expect, it } from "vitest";
import {
  DAEMON_PROVISION_PHASES,
  PROVISION_PHASES,
  isProvisionPhase,
  signProvisionEvent,
  verifyProvisionEvent,
  type ProvisionEvent,
} from "../src/auth.js";
import { ed } from "../src/edSync.js";

function freshKeypair() {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = Math.floor(Math.random() * 256);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

const baseEvent = (): ProvisionEvent => ({
  serverDomain: "home.demoalice.flagship.services",
  phase: "ready",
  error: "",
  issuedAt: 1_700_000_000_000,
});

describe("ProvisionEvent — sign + verify", () => {
  it("round-trips a signed daemon phase under the server identity", () => {
    const id = freshKeypair();
    const e = baseEvent();
    const sig = signProvisionEvent(e, id);
    expect(verifyProvisionEvent(e, sig, id.publicKey)).toBe(true);
  });

  it("rejects a signature from a different key", () => {
    const id = freshKeypair();
    const mallory = freshKeypair();
    const e = baseEvent();
    const sig = signProvisionEvent(e, id);
    expect(verifyProvisionEvent(e, sig, mallory.publicKey)).toBe(false);
  });

  it("rejects a tampered phase (canonical bytes bind every field)", () => {
    const id = freshKeypair();
    const e = baseEvent();
    const sig = signProvisionEvent(e, id);
    const tampered: ProvisionEvent = { ...e, phase: "failed" };
    expect(verifyProvisionEvent(tampered, sig, id.publicKey)).toBe(false);
  });

  it("rejects a tampered error string", () => {
    const id = freshKeypair();
    const e: ProvisionEvent = { ...baseEvent(), phase: "failed", error: "acme timeout" };
    const sig = signProvisionEvent(e, id);
    const tampered: ProvisionEvent = { ...e, error: "tunnel down" };
    expect(verifyProvisionEvent(tampered, sig, id.publicKey)).toBe(false);
  });

  it("rejects a tampered serverDomain (a pod can't forge another's phase)", () => {
    const id = freshKeypair();
    const e = baseEvent();
    const sig = signProvisionEvent(e, id);
    const tampered: ProvisionEvent = { ...e, serverDomain: "home.bob.flagship.services" };
    expect(verifyProvisionEvent(tampered, sig, id.publicKey)).toBe(false);
  });

  it("rejects a tampered issuedAt", () => {
    const id = freshKeypair();
    const e = baseEvent();
    const sig = signProvisionEvent(e, id);
    const tampered: ProvisionEvent = { ...e, issuedAt: e.issuedAt + 1 };
    expect(verifyProvisionEvent(tampered, sig, id.publicKey)).toBe(false);
  });

  it("does not throw on a malformed signature — returns false", () => {
    const id = freshKeypair();
    const e = baseEvent();
    expect(verifyProvisionEvent(e, new Uint8Array(10), id.publicKey)).toBe(false);
  });
});

describe("provision-phase vocabulary", () => {
  it("models the full bootstrap → daemon → terminal sequence", () => {
    expect(PROVISION_PHASES).toEqual([
      "boot",
      "cloned",
      "deps",
      "built",
      "identity",
      "registered",
      "tunnel-online",
      "cert-issued",
      "ready",
      "failed",
    ]);
  });

  it("isProvisionPhase narrows known phases and rejects unknown ones", () => {
    expect(isProvisionPhase("cloned")).toBe(true);
    expect(isProvisionPhase("ready")).toBe(true);
    expect(isProvisionPhase("failed")).toBe(true);
    expect(isProvisionPhase("nope")).toBe(false);
    expect(isProvisionPhase("")).toBe(false);
  });

  it("daemon phases are the signed subset", () => {
    expect(DAEMON_PROVISION_PHASES).toEqual([
      "tunnel-online",
      "cert-issued",
      "ready",
      "failed",
    ]);
    for (const p of DAEMON_PROVISION_PHASES) {
      expect(isProvisionPhase(p)).toBe(true);
    }
  });
});
