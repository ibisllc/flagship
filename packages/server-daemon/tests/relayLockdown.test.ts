/**
 * RelayLockdownController — the ENFORCE-gated lockdown + SOS state machine
 * (docs/maintainer-trust-enforcement.md, task #5).
 *
 * Deploy-safety contract: with enforce OFF (the default) it NEVER locks
 * down, regardless of verdict. With enforce ON it locks down + SOSes only
 * on a concrete verified=false with no covering owner TrustException.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ed,
  relayCertHash,
  signTrustException,
  type Keypair,
} from "@flagship/protocol";
import {
  RelayLockdownController,
  relayTrustEnforceFromEnv,
  type RelaySosEvent,
} from "../src/relayLockdown.js";
import type { RelayTrustVerdict } from "../src/relayTrustVerifier.js";

const HUB_PUB = "ab".repeat(32);
const CERT_HASH = relayCertHash(HUB_PUB);

function deviceKey(seed: number): Keypair {
  const b = new Uint8Array(32).fill(seed);
  return { privateKey: b, publicKey: ed.getPublicKey(b) };
}

const fail: RelayTrustVerdict = {
  verified: false,
  reason: "signature-unverified",
  hubKeyPub: HUB_PUB,
};
const ok: RelayTrustVerdict = { verified: true, reason: "ok", hubKeyPub: HUB_PUB };
const noVerdict: RelayTrustVerdict = { verified: undefined, reason: "no-blessing" };

describe("RelayLockdownController — enforce OFF (default)", () => {
  it("NEVER locks down on a failed verdict (deploy safety)", async () => {
    const c = new RelayLockdownController({ log: () => {} });
    expect(c.isEnforcing()).toBe(false);
    await c.onVerdict(fail);
    expect(c.isRelayAllowed()).toBe(true);
    expect(c.current().lockedDown).toBe(false);
  });

  it("does not SOS when enforce is off", async () => {
    const sos = vi.fn();
    const c = new RelayLockdownController({ sos, log: () => {} });
    await c.onVerdict(fail);
    expect(sos).not.toHaveBeenCalled();
  });

  it("default constructor (no opts) is OBSERVE", async () => {
    const c = new RelayLockdownController();
    await c.onVerdict(fail);
    expect(c.isRelayAllowed()).toBe(true);
  });
});

describe("RelayLockdownController — enforce ON", () => {
  it("locks down + SOS on a failed verdict with no exception", async () => {
    const sosEvents: RelaySosEvent[] = [];
    const c = new RelayLockdownController({
      enforce: true,
      sos: (e) => sosEvents.push(e),
      now: () => 12345,
      log: () => {},
    });
    const state = await c.onVerdict(fail);
    expect(state.lockedDown).toBe(true);
    expect(state.certHash).toBe(CERT_HASH);
    expect(state.reason).toBe("signature-unverified");
    expect(state.since).toBe(12345);
    expect(c.isRelayAllowed()).toBe(false);
    expect(sosEvents).toHaveLength(1);
    expect(sosEvents[0]).toMatchObject({
      certClass: "relay",
      certHash: CERT_HASH,
      hubKeyPub: HUB_PUB,
      reason: "signature-unverified",
      at: 12345,
    });
  });

  it("does NOT lock down on verified=undefined (no verdict)", async () => {
    const sos = vi.fn();
    const c = new RelayLockdownController({ enforce: true, sos, log: () => {} });
    await c.onVerdict(noVerdict);
    expect(c.isRelayAllowed()).toBe(true);
    expect(sos).not.toHaveBeenCalled();
  });

  it("does NOT re-SOS while already locked down", async () => {
    const sos = vi.fn();
    const c = new RelayLockdownController({ enforce: true, sos, log: () => {} });
    await c.onVerdict(fail);
    await c.onVerdict(fail);
    expect(sos).toHaveBeenCalledTimes(1);
  });

  it("a fresh valid blessing lifts lockdown (recovery without an exception)", async () => {
    const c = new RelayLockdownController({ enforce: true, log: () => {} });
    await c.onVerdict(fail);
    expect(c.isRelayAllowed()).toBe(false);
    await c.onVerdict(ok);
    expect(c.isRelayAllowed()).toBe(true);
    expect(c.current().lockedDown).toBe(false);
  });

  it("honors a valid owner TrustException for the relay cert-hash (no lockdown)", async () => {
    const owner = deviceKey(3);
    const exc = signTrustException(
      { certClass: "relay", certHash: CERT_HASH, grantedAt: 1000 },
      owner,
    );
    const sos = vi.fn();
    const c = new RelayLockdownController({
      enforce: true,
      sos,
      resolveTrustExceptions: async (certHash) => ({
        exceptions: certHash === CERT_HASH ? [exc] : [],
        allowedDevicePubs: [Buffer.from(owner.publicKey).toString("hex")],
      }),
      log: () => {},
    });
    await c.onVerdict(fail);
    expect(c.isRelayAllowed()).toBe(true);
    expect(sos).not.toHaveBeenCalled();
  });

  it("ignores an exception for a DIFFERENT cert-hash (still locks down)", async () => {
    const owner = deviceKey(3);
    const otherExc = signTrustException(
      { certClass: "relay", certHash: relayCertHash("ee".repeat(32)), grantedAt: 1000 },
      owner,
    );
    const c = new RelayLockdownController({
      enforce: true,
      resolveTrustExceptions: async () => ({
        exceptions: [otherExc],
        allowedDevicePubs: [Buffer.from(owner.publicKey).toString("hex")],
      }),
      log: () => {},
    });
    await c.onVerdict(fail);
    expect(c.isRelayAllowed()).toBe(false);
  });

  it("ignores an exception whose signer is not in the device roster", async () => {
    const stranger = deviceKey(9);
    const exc = signTrustException(
      { certClass: "relay", certHash: CERT_HASH, grantedAt: 1000 },
      stranger,
    );
    const c = new RelayLockdownController({
      enforce: true,
      resolveTrustExceptions: async () => ({
        exceptions: [exc],
        allowedDevicePubs: [Buffer.from(deviceKey(3).publicKey).toString("hex")], // not the stranger
      }),
      log: () => {},
    });
    await c.onVerdict(fail);
    expect(c.isRelayAllowed()).toBe(false);
  });

  it("locks down (fail-closed) when the exception lookup throws", async () => {
    const c = new RelayLockdownController({
      enforce: true,
      resolveTrustExceptions: async () => {
        throw new Error("directory down");
      },
      log: () => {},
    });
    await c.onVerdict(fail);
    expect(c.isRelayAllowed()).toBe(false);
  });

  it("clear() manually lifts lockdown", async () => {
    const c = new RelayLockdownController({ enforce: true, log: () => {} });
    await c.onVerdict(fail);
    expect(c.isRelayAllowed()).toBe(false);
    c.clear();
    expect(c.isRelayAllowed()).toBe(true);
  });
});

describe("relayTrustEnforceFromEnv", () => {
  it("defaults OFF", () => {
    expect(relayTrustEnforceFromEnv({})).toBe(false);
    expect(relayTrustEnforceFromEnv({ FLAGSHIP_RELAY_TRUST_ENFORCE: "1" })).toBe(false);
    expect(relayTrustEnforceFromEnv({ FLAGSHIP_RELAY_TRUST_ENFORCE: "false" })).toBe(false);
  });
  it("ON only for the exact string 'true'", () => {
    expect(relayTrustEnforceFromEnv({ FLAGSHIP_RELAY_TRUST_ENFORCE: "true" })).toBe(true);
  });
});
