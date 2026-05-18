/**
 * Link-4 daemon port (#8), LOCKED Phase-2 v2 model:
 * makeCaTrustChain + verifiedTrackFromFolder.
 *
 * Proves the wire from a real on-disk `.maintainers/` v2 ca-track —
 * verified FORWARD from a baked pinned-Mandate hash — through
 * `@maintainers/protocol`'s authorizedCaKeys into the #30
 * `CaTrustChain`, and that the #30 chokepoint stays fail-closed
 * (`pin-unconfigured`) until a pinned-mandate hash is configured —
 * i.e. the wire is built but correctly inert pre-ceremony.
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
} from "@maintainers/protocol";
import { authorizedCaKeysOrFailClosed } from "@flagship/protocol";
import { verifiedTrackFromFolder } from "../src/releaseVerifier.js";
import { makeCaTrustChain } from "../src/caTrustChain.js";

// ca root mandate valid 2026-05-01 .. 2026-11-01; NOW inside it.
const ISO_MANDATE_FROM = "2026-05-01T00:00:00.000Z";
const ISO_MANDATE_TO = "2026-11-01T00:00:00.000Z";
const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();
// CaEndorsement lease 2026-05-15 .. 2026-07-15; NOW inside, LATER past.
const ISO_LEASE_FROM = "2026-05-15T00:00:00.000Z";
const ISO_LEASE_TO = "2026-07-15T00:00:00.000Z";
const LATER = new Date("2026-08-01T00:00:00.000Z").getTime();
const DAY = 86400;

function kp(seedByte: number) {
  const b = new Uint8Array(32);
  b[0] = seedByte;
  return generateKeypair(b);
}

function makeCaRepo(): {
  rootDir: string;
  cleanup: () => void;
  authority: ReturnType<typeof kp>;
  pin: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-ctc-"));
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
  // No policy.json in v2 — the succession rule is folded into the mandate.
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
  opPubkey: string,
): CaEndorsement {
  return signCaEndorsement(
    {
      kind: "CaEndorsement",
      version: 1,
      endorsementId: "ce000000-0000-4000-8000-000000000001",
      track: "ca",
      caPubkey: opPubkey,
      scope: "flagship/directory-attestation",
      notBefore: ISO_LEASE_FROM,
      notAfter: ISO_LEASE_TO,
      issuedAt: ISO_LEASE_FROM,
      signedBy: authority.pubKey,
    },
    [{ privKey: authority.privKey }],
  );
}

describe("verifiedTrackFromFolder", () => {
  it("verify-forwards the on-disk v2 ca track from the pin", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      );
      expect(vt).not.toBeNull();
      expect(vt!.chain.validMandates.length).toBe(1);
      expect(vt!.chain.root).not.toBeNull();
    } finally {
      repo.cleanup();
    }
  });

  it("returns null for a track with no mandates on disk", () => {
    const repo = makeCaRepo();
    try {
      expect(
        verifiedTrackFromFolder(
          { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
          "release",
        ),
      ).toBeNull();
    } finally {
      repo.cleanup();
    }
  });

  it("an empty/forked pin yields a fail-closed chain (not null) when mandates exist", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: "de".repeat(32) },
        "ca",
      );
      expect(vt).not.toBeNull();
      expect(vt!.chain.validMandates.length).toBe(0);
      expect(vt!.chain.rootError).toBe("pin-not-in-log");
    } finally {
      repo.cleanup();
    }
  });
});

describe("makeCaTrustChain", () => {
  it("authorizes the operational key in-window, nothing out-of-window", () => {
    const repo = makeCaRepo();
    try {
      const op = kp(99);
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, op.pubKey),
      ]);
      expect(chain.authorizedCaKeys(NOW)).toEqual([op.pubKey]);
      // Past the lease window (+ skew) ⇒ no authorized key.
      expect(chain.authorizedCaKeys(LATER)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  it("yields no keys when there are no CaEndorsements (⇒ fail closed)", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, []);
      expect(chain.authorizedCaKeys(NOW)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  it("an endorsement signed by a non-authority key is not authorized", () => {
    const repo = makeCaRepo();
    try {
      const impostor = kp(200);
      const op = kp(99);
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(impostor, op.pubKey),
      ]);
      expect(chain.authorizedCaKeys(NOW)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  it("a forked-pin chain authorizes nothing even with a valid lease", () => {
    const repo = makeCaRepo();
    try {
      const op = kp(99);
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: "de".repeat(32) },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, op.pubKey),
      ]);
      expect(chain.authorizedCaKeys(NOW)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("#30 chokepoint integration (links 1-4)", () => {
  it("stays fail-closed (pin-unconfigured) with the shipped empty pin — chain not consulted", () => {
    const repo = makeCaRepo();
    try {
      const op = kp(99);
      // No pinnedMandateHash override ⇒ the (empty) baked default; the
      // chain is fail-closed AND the chokepoint never consults the port.
      const vt = verifiedTrackFromFolder({ gitRepoPath: repo.rootDir }, "ca")!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, op.pubKey),
      ]);
      const r = authorizedCaKeysOrFailClosed(chain, NOW);
      expect(r).toEqual({ ok: false, reason: "pin-unconfigured" });
    } finally {
      repo.cleanup();
    }
  });

  it("once a pin is configured, the port resolves the operational key", () => {
    const repo = makeCaRepo();
    try {
      const op = kp(99);
      const vt = verifiedTrackFromFolder(
        { gitRepoPath: repo.rootDir, pinnedMandateHash: repo.pin },
        "ca",
      )!;
      const chain = makeCaTrustChain(vt.chain, [
        signedEndorsement(repo.authority, op.pubKey),
      ]);
      // Inject the same non-empty baked pinned-mandate hash (post-Gate-B
      // state): link-1 met ⇒ the chokepoint consults the link-4 port.
      const r = authorizedCaKeysOrFailClosed(chain, NOW, repo.pin);
      expect(r).toEqual({ ok: true, keys: [op.pubKey] });
    } finally {
      repo.cleanup();
    }
  });
});
