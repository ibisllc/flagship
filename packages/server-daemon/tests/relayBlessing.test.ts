/**
 * shouldRelayThroughHub — the box's pure pre-connect relay-blessing gate
 * (docs/maintainer-trust-enforcement.md). Exercised end-to-end through the
 * daemon's REAL chain builder (makeCaTrustChain over a verify-forward
 * on-disk ca track), so a pass here proves the same chain the directory
 * attestation uses also accepts a hub blessing.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateKeypair,
  mandatePinHash,
  signCaEndorsement,
  signMandate,
  type CaEndorsement,
  type Mandate,
} from "@ibisllc/maintainers";
import { signServiceBlessing, type Keypair } from "@flagship/protocol";
import { verifiedTrackFromFolder } from "../src/releaseVerifier.js";
import { makeCaTrustChain } from "../src/caTrustChain.js";
import { shouldRelayThroughHub } from "../src/relayBlessing.js";

const ISO_MANDATE_FROM = "2026-05-01T00:00:00.000Z";
const ISO_MANDATE_TO = "2026-11-01T00:00:00.000Z";
const ISO_LEASE_FROM = "2026-05-15T00:00:00.000Z";
const ISO_LEASE_TO = "2026-07-15T00:00:00.000Z";
const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();
const LATER = new Date("2026-08-01T00:00:00.000Z").getTime(); // past the lease
const DAY = 86400;

function kp(seedByte: number) {
  const b = new Uint8Array(32);
  b[0] = seedByte;
  return generateKeypair(b);
}
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
/** A protocol Keypair from a maintainers hex keypair (for signServiceBlessing). */
function protocolKeypair(m: { privKey: string; pubKey: string }): Keypair {
  return { privateKey: hexToBytes(m.privKey), publicKey: hexToBytes(m.pubKey) };
}

function makeCaRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-relay-"));
  const dotM = path.join(tmp, ".maintainers");
  fs.mkdirSync(path.join(dotM, "tracks", "ca", "mandates"), { recursive: true });
  const authority = kp(7);
  const unsigned: Omit<Mandate, "signatures"> = {
    kind: "Mandate",
    version: 1,
    mandateId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a",
    track: "ca",
    holder: authority.pubKey,
    issuedAt: ISO_MANDATE_FROM,
    expiresAt: ISO_MANDATE_TO,
    successors: [authority.pubKey],
    approvalRule: { kind: "threshold", threshold: 1 },
    minSuccessors: 1,
    maxDurationSeconds: 365 * DAY,
    defaultDurationSeconds: 180 * DAY,
    signedBy: authority.pubKey,
  };
  const genesis: Mandate = signMandate(unsigned, [{ privKey: authority.privKey }]);
  fs.writeFileSync(
    path.join(dotM, "tracks", "ca", "mandates", "2026-05-01-genesis.json"),
    JSON.stringify(genesis),
    "utf8",
  );
  return {
    rootDir: tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    authority,
    pin: mandatePinHash(genesis),
  };
}
function signedEndorsement(
  authority: ReturnType<typeof kp>,
  caPubkey: string,
): CaEndorsement {
  return signCaEndorsement(
    {
      kind: "CaEndorsement",
      version: 1,
      endorsementId: "ce000000-0000-4000-8000-000000000001",
      track: "ca",
      caPubkey,
      scope: "flagship/directory-attestation",
      notBefore: ISO_LEASE_FROM,
      notAfter: ISO_LEASE_TO,
      issuedAt: ISO_LEASE_FROM,
      signedBy: authority.pubKey,
    },
    [{ privKey: authority.privKey }],
  );
}

const hotCaKey = kp(0xca);
const HUB_PUB = "ab".repeat(32);

function blessing(issuedAt: number, ttlMs: number) {
  return signServiceBlessing(
    {
      hubKeyPub: HUB_PUB,
      hubHost: "flagship.services",
      nonce: "n1",
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    },
    protocolKeypair(hotCaKey),
  );
}

describe("shouldRelayThroughHub", () => {
  it("relays when the hub blessing verifies through the real chain", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, hotCaKey.pubKey),
      ]);
      const b = blessing(NOW - 1000, 26 * 60 * 60_000);
      expect(shouldRelayThroughHub(b, chain, repo.pin, NOW)).toEqual({
        ok: true,
        reason: "ok",
      });
    } finally {
      repo.cleanup();
    }
  });

  it("locks down when the hot CA key's lease has lapsed (NOW past notAfter)", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, hotCaKey.pubKey),
      ]);
      const b = blessing(LATER - 1000, 26 * 60 * 60_000);
      expect(shouldRelayThroughHub(b, chain, repo.pin, LATER)).toEqual({
        ok: false,
        reason: "no-authorized-ca-keys",
      });
    } finally {
      repo.cleanup();
    }
  });

  it("locks down when the blessing itself is expired", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, hotCaKey.pubKey),
      ]);
      const b = blessing(NOW - 60 * 60_000, 30 * 60_000); // expired 30m ago
      expect(shouldRelayThroughHub(b, chain, repo.pin, NOW)).toEqual({
        ok: false,
        reason: "artifact-expired",
      });
    } finally {
      repo.cleanup();
    }
  });

  it("fails closed when the pin is unconfigured (empty)", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, hotCaKey.pubKey),
      ]);
      const b = blessing(NOW - 1000, 26 * 60 * 60_000);
      expect(shouldRelayThroughHub(b, chain, "", NOW)).toEqual({
        ok: false,
        reason: "pin-unconfigured",
      });
    } finally {
      repo.cleanup();
    }
  });

  it("locks down when the blessing is signed by a key the chain does not authorize", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      // endorse a DIFFERENT hot key than the one that signed the blessing
      const otherHot = kp(0xee);
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, otherHot.pubKey),
      ]);
      const b = blessing(NOW - 1000, 26 * 60 * 60_000);
      expect(shouldRelayThroughHub(b, chain, repo.pin, NOW)).toEqual({
        ok: false,
        reason: "signature-unverified",
      });
    } finally {
      repo.cleanup();
    }
  });

  it("fails closed when the chain is null", () => {
    const b = blessing(NOW - 1000, 26 * 60 * 60_000);
    expect(
      shouldRelayThroughHub(b, null, "deadbeef".repeat(8), NOW),
    ).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
  });
});
