/**
 * Envelope-construction tests for each command's `build*` function.
 *
 * The build* functions are pure: they take parsed options + an in-memory key
 * source + a clock + a uuid factory, and return a fully signed envelope. We
 * cross-check the output against the protocol library's verifier so the CLI
 * is guaranteed to emit envelopes that verify back-to-back (the same property
 * the web UI must hold).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalMandate,
  canonicalReleaseEndorsement,
  currentAuthority,
  generateKeypair,
  intermediateMerkleRoot,
  verify,
  verifyChainOfEndorsements,
  verifyTrack,
  type TrackPolicy,
} from "@maintainers/protocol";
import { buildGenesis } from "../src/commands/genesis.js";
import { buildRenewal } from "../src/commands/mandate.js";
import { buildTakeover } from "../src/commands/takeover.js";
import { buildEndorsement } from "../src/commands/endorsement.js";
import { writeMandate, writeTrackPolicyIfMissing } from "../src/lib/store.js";

function keypair(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

function fakeFs(files: Record<string, string>) {
  return {
    readFileSync(p: string): string {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
  };
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("buildGenesis", () => {
  it("produces a self-signed genesis mandate that verifies against the protocol verifier", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const io = fakeFs({
      "./alice.pub": alice.pubKey,
      "./alice.priv": alice.privKey,
      "./bob.pub": bob.pubKey,
    });
    const m = buildGenesis({
      track: "release",
      duration: "60d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: "file:./bob.pub",
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io,
      uuid: () => "11111111-1111-1111-1111-111111111111",
    });
    expect(m.kind).toBe("Mandate");
    expect(m.track).toBe("release");
    expect(m.holder).toBe(alice.pubKey);
    expect(m.signedBy).toBe(alice.pubKey);
    expect(m.successors).toEqual([bob.pubKey]);
    expect(m.issuedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(m.expiresAt).toBe("2026-03-02T00:00:00.000Z");
    expect(m.signatures.length).toBe(1);

    const policy: TrackPolicy = {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    };
    const verified = verifyTrack("release", policy, [m]);
    expect(verified.validMandates).toHaveLength(1);
    expect(verified.rejections).toHaveLength(0);
  });

  it("rejects a signing key that does not match --holder-key", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const io = fakeFs({
      "./alice.pub": alice.pubKey,
      "./bob.priv": bob.privKey,
    });
    expect(() =>
      buildGenesis({
        track: "release",
        duration: "60d",
        holderKeySource: "file:./alice.pub",
        signingKeySource: "file:./bob.priv",
        successorsSource: undefined,
        outputDir: undefined,
        now: () => new Date("2026-01-01T00:00:00Z"),
        io,
        uuid: () => "x",
      }),
    ).toThrow(/genesis must be self-signed/);
  });

  it("defaults successors to [holder] when --successors not provided", () => {
    const alice = keypair(7);
    const io = fakeFs({
      "./alice.pub": alice.pubKey,
      "./alice.priv": alice.privKey,
    });
    const m = buildGenesis({
      track: "release",
      duration: "30d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: undefined,
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io,
      uuid: () => "u",
    });
    expect(m.successors).toEqual([alice.pubKey]);
  });
});

describe("buildRenewal", () => {
  it("produces a holder-signed renewal that the verifier accepts as a continuation", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const tmp = mkTmp("maintainers-cli-renewal-");
    writeTrackPolicyIfMissing(tmp, {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
    const genesis = buildGenesis({
      track: "release",
      duration: "60d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: "file:./bob.pub",
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io: fakeFs({
        "./alice.pub": alice.pubKey,
        "./alice.priv": alice.privKey,
        "./bob.pub": bob.pubKey,
      }),
      uuid: () => "g1g1g1g1-g1g1-g1g1-g1g1-g1g1g1g1g1g1",
    });
    writeMandate(tmp, genesis);

    const renewal = buildRenewal({
      track: "release",
      duration: "60d",
      signingKeySource: "file:./alice.priv",
      successorsSource: undefined,
      rootDir: tmp,
      now: () => new Date("2026-02-01T00:00:00Z"),
      io: fakeFs({ "./alice.priv": alice.privKey }),
      uuid: () => "r1r1r1r1-r1r1-r1r1-r1r1-r1r1r1r1r1r1",
    });

    expect(renewal.holder).toBe(alice.pubKey);
    expect(renewal.signedBy).toBe(alice.pubKey);
    expect(renewal.successors).toEqual([bob.pubKey]);
    const policy: TrackPolicy = {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    };
    const verified = verifyTrack("release", policy, [genesis, renewal]);
    expect(verified.validMandates).toHaveLength(2);
    expect(verified.rejections).toHaveLength(0);
  });

  it("rejects a renewal signed by someone who is not the current holder", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const tmp = mkTmp("maintainers-cli-renewal-bad-");
    writeTrackPolicyIfMissing(tmp, {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
    const genesis = buildGenesis({
      track: "release",
      duration: "60d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: "file:./bob.pub",
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io: fakeFs({
        "./alice.pub": alice.pubKey,
        "./alice.priv": alice.privKey,
        "./bob.pub": bob.pubKey,
      }),
      uuid: () => "gx",
    });
    writeMandate(tmp, genesis);
    expect(() =>
      buildRenewal({
        track: "release",
        duration: "60d",
        signingKeySource: "file:./bob.priv",
        successorsSource: undefined,
        rootDir: tmp,
        now: () => new Date("2026-02-01T00:00:00Z"),
        io: fakeFs({ "./bob.priv": bob.privKey }),
        uuid: () => "rx",
      }),
    ).toThrow(/not the current holder/);
  });
});

describe("buildTakeover", () => {
  it("named successor produces a takeover after expiry that verifies", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const tmp = mkTmp("maintainers-cli-takeover-");
    writeTrackPolicyIfMissing(tmp, {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
    const genesis = buildGenesis({
      track: "release",
      duration: "30d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: "file:./bob.pub",
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io: fakeFs({
        "./alice.pub": alice.pubKey,
        "./alice.priv": alice.privKey,
        "./bob.pub": bob.pubKey,
      }),
      uuid: () => "g",
    });
    writeMandate(tmp, genesis);

    const takeover = buildTakeover({
      track: "release",
      duration: "60d",
      successorKeySource: "file:./bob.priv",
      newHolderSource: "file:./bob.pub",
      successorsSource: undefined,
      rootDir: tmp,
      now: () => new Date("2026-02-15T00:00:00Z"), // after the 30-day expiry
      io: fakeFs({
        "./bob.priv": bob.privKey,
        "./bob.pub": bob.pubKey,
      }),
      uuid: () => "t",
    });

    expect(takeover.holder).toBe(bob.pubKey);
    expect(takeover.signedBy).toBe(bob.pubKey);
    expect(takeover.successors).toEqual([bob.pubKey]);
    const policy: TrackPolicy = {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    };
    const verified = verifyTrack("release", policy, [genesis, takeover]);
    expect(verified.validMandates).toHaveLength(2);
    expect(verified.rejections).toHaveLength(0);
  });

  it("rejects a takeover before the predecessor expires", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const tmp = mkTmp("maintainers-cli-takeover-early-");
    writeTrackPolicyIfMissing(tmp, {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
    const genesis = buildGenesis({
      track: "release",
      duration: "30d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: "file:./bob.pub",
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io: fakeFs({
        "./alice.pub": alice.pubKey,
        "./alice.priv": alice.privKey,
        "./bob.pub": bob.pubKey,
      }),
      uuid: () => "g",
    });
    writeMandate(tmp, genesis);
    expect(() =>
      buildTakeover({
        track: "release",
        duration: "60d",
        successorKeySource: "file:./bob.priv",
        newHolderSource: "file:./bob.pub",
        successorsSource: undefined,
        rootDir: tmp,
        now: () => new Date("2026-01-15T00:00:00Z"),
        io: fakeFs({
          "./bob.priv": bob.privKey,
          "./bob.pub": bob.pubKey,
        }),
        uuid: () => "t",
      }),
    ).toThrow(/has not yet expired/);
  });

  it("rejects a takeover signed by a non-successor", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const eve = keypair(3);
    const tmp = mkTmp("maintainers-cli-takeover-eve-");
    writeTrackPolicyIfMissing(tmp, {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
    const genesis = buildGenesis({
      track: "release",
      duration: "30d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: "file:./bob.pub",
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io: fakeFs({
        "./alice.pub": alice.pubKey,
        "./alice.priv": alice.privKey,
        "./bob.pub": bob.pubKey,
      }),
      uuid: () => "g",
    });
    writeMandate(tmp, genesis);
    expect(() =>
      buildTakeover({
        track: "release",
        duration: "60d",
        successorKeySource: "file:./eve.priv",
        newHolderSource: "file:./eve.pub",
        successorsSource: undefined,
        rootDir: tmp,
        now: () => new Date("2026-02-15T00:00:00Z"),
        io: fakeFs({
          "./eve.priv": eve.privKey,
          "./eve.pub": eve.pubKey,
        }),
        uuid: () => "t",
      }),
    ).toThrow(/not a named successor/);
  });
});

describe("buildEndorsement", () => {
  it("produces a genesis release endorsement with correct merkle root", () => {
    const alice = keypair(1);
    const tmp = mkTmp("maintainers-cli-endorsement-");
    writeTrackPolicyIfMissing(tmp, {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
    const genesis = buildGenesis({
      track: "release",
      duration: "60d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: undefined,
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io: fakeFs({
        "./alice.pub": alice.pubKey,
        "./alice.priv": alice.privKey,
      }),
      uuid: () => "g",
    });
    writeMandate(tmp, genesis);

    const commit = "a".repeat(40);
    const e = buildEndorsement({
      commit,
      tag: "v0.1.0",
      previousId: null,
      previousCommit: null,
      intermediatesSpec: commit,
      signingKeySource: "file:./alice.priv",
      track: "release",
      rootDir: tmp,
      now: () => new Date("2026-01-15T00:00:00Z"),
      io: fakeFs({ "./alice.priv": alice.privKey }),
      uuid: () => "e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1",
    });

    expect(e.semverTag).toBe("v0.1.0");
    expect(e.commitHash).toBe(commit);
    expect(e.previousReleaseId).toBeNull();
    expect(e.previousCommitHash).toBeNull();
    expect(e.intermediateCommits).toEqual([commit]);
    expect(e.intermediateMerkleRoot).toBe(intermediateMerkleRoot([commit]));
    const bytes = canonicalReleaseEndorsement(e);
    expect(verify(e.signatures[0]!.sig, bytes, alice.pubKey)).toBe(true);
  });

  it("verifies inline csv intermediates produce a correct merkle root", () => {
    const alice = keypair(1);
    const tmp = mkTmp("maintainers-cli-endorsement-csv-");
    writeTrackPolicyIfMissing(tmp, {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
    const genesis = buildGenesis({
      track: "release",
      duration: "60d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: undefined,
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io: fakeFs({
        "./alice.pub": alice.pubKey,
        "./alice.priv": alice.privKey,
      }),
      uuid: () => "g",
    });
    writeMandate(tmp, genesis);

    const c1 = "1".repeat(40);
    const c2 = "2".repeat(40);
    const c3 = "3".repeat(40);
    const e = buildEndorsement({
      commit: c3,
      tag: "v0.2.0",
      previousId: "e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1",
      previousCommit: c1,
      intermediatesSpec: `${c2},${c3}`,
      signingKeySource: "file:./alice.priv",
      track: "release",
      rootDir: tmp,
      now: () => new Date("2026-02-01T00:00:00Z"),
      io: fakeFs({ "./alice.priv": alice.privKey }),
      uuid: () => "e2",
    });
    expect(e.intermediateCommits).toEqual([c2, c3]);
    expect(e.intermediateMerkleRoot).toBe(intermediateMerkleRoot([c2, c3]));
  });

  it("rejects a non-hex commit hash", () => {
    const alice = keypair(1);
    const tmp = mkTmp("maintainers-cli-endorsement-bad-");
    writeTrackPolicyIfMissing(tmp, {
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
    const genesis = buildGenesis({
      track: "release",
      duration: "60d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: undefined,
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io: fakeFs({
        "./alice.pub": alice.pubKey,
        "./alice.priv": alice.privKey,
      }),
      uuid: () => "g",
    });
    writeMandate(tmp, genesis);

    expect(() =>
      buildEndorsement({
        commit: "zzz",
        tag: "v0.0.1",
        previousId: null,
        previousCommit: null,
        intermediatesSpec: "auto",
        signingKeySource: "file:./alice.priv",
        track: "release",
        rootDir: tmp,
        now: () => new Date("2026-01-15T00:00:00Z"),
        io: fakeFs({ "./alice.priv": alice.privKey }),
        uuid: () => "e",
      }),
    ).toThrow(/commit must be a 40-character commit hash/);
  });
});

describe("canonical-bytes parity with the protocol library", () => {
  it("canonicalMandate over a CLI-built mandate matches what signMandate signed", () => {
    const alice = keypair(11);
    const io = fakeFs({
      "./alice.pub": alice.pubKey,
      "./alice.priv": alice.privKey,
    });
    const m = buildGenesis({
      track: "release",
      duration: "60d",
      holderKeySource: "file:./alice.pub",
      signingKeySource: "file:./alice.priv",
      successorsSource: undefined,
      outputDir: undefined,
      now: () => new Date("2026-01-01T00:00:00Z"),
      io,
      uuid: () => "deadbeef-dead-beef-dead-beefdeadbeef",
    });
    const bytes = canonicalMandate(m);
    expect(verify(m.signatures[0]!.sig, bytes, alice.pubKey)).toBe(true);
  });
});
