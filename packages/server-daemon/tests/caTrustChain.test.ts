/**
 * Link-4 daemon port (#8): makeCaTrustChain + verifiedTrackFromFolder.
 *
 * Proves the wire from a real on-disk `.maintainers/` ca-track through
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
  signCaEndorsement,
  signMandate,
  type CaEndorsement,
  type Mandate,
  type TrackPolicy,
} from "@maintainers/protocol";
import { authorizedCaKeysOrFailClosed } from "@flagship/protocol";
import { verifiedTrackFromFolder } from "../src/releaseVerifier.js";
import { makeCaTrustChain } from "../src/caTrustChain.js";

// ca genesis valid 2026-05-01 .. 2026-11-01; NOW inside it.
const ISO_MANDATE_FROM = "2026-05-01T00:00:00.000Z";
const ISO_MANDATE_TO = "2026-11-01T00:00:00.000Z";
const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();
// CaEndorsement lease 2026-05-15 .. 2026-07-15; NOW inside, LATER past.
const ISO_LEASE_FROM = "2026-05-15T00:00:00.000Z";
const ISO_LEASE_TO = "2026-07-15T00:00:00.000Z";
const LATER = new Date("2026-08-01T00:00:00.000Z").getTime();

const CA_POLICY: TrackPolicy = {
  track: "ca",
  defaultMandateDuration: "180d",
  approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
};

function kp(seedByte: number) {
  const b = new Uint8Array(32);
  b[0] = seedByte;
  return generateKeypair(b);
}

function makeCaRepo(): {
  rootDir: string;
  cleanup: () => void;
  authority: ReturnType<typeof kp>;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-ctc-"));
  const dotM = path.join(tmp, ".maintainers");
  fs.mkdirSync(path.join(dotM, "tracks", "ca", "mandates"), { recursive: true });
  fs.writeFileSync(
    path.join(dotM, "policy.json"),
    JSON.stringify({ schemaVersion: 1, project: { name: "Flagship-test" }, tracks: ["ca"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dotM, "tracks", "ca", "policy.json"),
    JSON.stringify(CA_POLICY),
    "utf8",
  );
  const authority = kp(7);
  const genesis: Mandate = signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a",
      track: "ca",
      holder: authority.pubKey,
      issuedAt: ISO_MANDATE_FROM,
      expiresAt: ISO_MANDATE_TO,
      successors: [authority.pubKey],
      signedBy: authority.pubKey,
    },
    [{ privKey: authority.privKey }],
  );
  fs.writeFileSync(
    path.join(dotM, "tracks", "ca", "mandates", "2026-05-01-genesis.json"),
    JSON.stringify(genesis),
    "utf8",
  );
  return { rootDir: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }), authority };
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
  it("verifies the on-disk ca track + returns its approval rule", () => {
    const repo = makeCaRepo();
    try {
      const vt = verifiedTrackFromFolder({ gitRepoPath: repo.rootDir }, "ca");
      expect(vt).not.toBeNull();
      expect(vt!.track.validMandates.length).toBe(1);
      expect(vt!.policy.approvalRule).toEqual(CA_POLICY.approvalRule);
    } finally {
      repo.cleanup();
    }
  });

  it("returns null for a track with no policy/mandates on disk", () => {
    const repo = makeCaRepo();
    try {
      expect(verifiedTrackFromFolder({ gitRepoPath: repo.rootDir }, "release")).toBeNull();
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
      const vt = verifiedTrackFromFolder({ gitRepoPath: repo.rootDir }, "ca")!;
      const chain = makeCaTrustChain(
        vt.track,
        vt.policy.approvalRule,
        [signedEndorsement(repo.authority, op.pubKey)],
      );
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
      const vt = verifiedTrackFromFolder({ gitRepoPath: repo.rootDir }, "ca")!;
      const chain = makeCaTrustChain(vt.track, vt.policy.approvalRule, []);
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
      const vt = verifiedTrackFromFolder({ gitRepoPath: repo.rootDir }, "ca")!;
      const chain = makeCaTrustChain(
        vt.track,
        vt.policy.approvalRule,
        [signedEndorsement(impostor, op.pubKey)],
      );
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
      const vt = verifiedTrackFromFolder({ gitRepoPath: repo.rootDir }, "ca")!;
      const chain = makeCaTrustChain(
        vt.track,
        vt.policy.approvalRule,
        [signedEndorsement(repo.authority, op.pubKey)],
      );
      // Default MAINTAINER_PINNED_MANDATE_HASH is empty ⇒ link-1 unmet ⇒
      // reject before the port is ever called.
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
      const vt = verifiedTrackFromFolder({ gitRepoPath: repo.rootDir }, "ca")!;
      const chain = makeCaTrustChain(
        vt.track,
        vt.policy.approvalRule,
        [signedEndorsement(repo.authority, op.pubKey)],
      );
      // Inject a non-empty baked pinned-mandate hash (the post-Gate-B
      // state): link-1 met ⇒ the chokepoint consults the link-4 port.
      const r = authorizedCaKeysOrFailClosed(chain, NOW, "deadbeef".repeat(8));
      expect(r).toEqual({ ok: true, keys: [op.pubKey] });
    } finally {
      repo.cleanup();
    }
  });
});
