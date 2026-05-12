/**
 * Signing helpers — verify that each sign* function produces an
 * envelope whose canonical bytes verify against the produced signature.
 */
import { describe, expect, it } from "vitest";
import { generateKeypair, verify } from "../src/crypto.js";
import {
  signEmailRotation,
  signKeyFile,
  signKeyIntroductionRequest,
  signKeyRedirect,
  signMandate,
  signReleaseEndorsement,
} from "../src/signing.js";
import {
  canonicalEmailRotation,
  canonicalKeyFile,
  canonicalKeyIntroductionRequest,
  canonicalKeyRedirect,
  canonicalMandate,
  canonicalReleaseEndorsement,
} from "../src/canonical.js";

function keypair(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

describe("sign* roundtrips", () => {
  it("signMandate signature verifies against canonicalMandate", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const m = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "g1",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-03-01T00:00:00Z",
        successors: [bob.pubKey],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const bytes = canonicalMandate(m);
    expect(verify(m.signatures[0]!.sig, bytes, m.signatures[0]!.pubkey)).toBe(true);
  });

  it("signKeyFile self-signs against canonicalKeyFile", () => {
    const alice = keypair(1);
    const k = signKeyFile(
      {
        kind: "KeyFile",
        version: 1,
        pubkey: alice.pubKey,
        displayName: "Alice",
        currentEmail: "alice@example.com",
        emailHistory: [],
        metadata: { photo: null, github: null, role: null },
        introductionMandate: "intro-1",
      },
      alice.privKey,
    );
    const bytes = canonicalKeyFile(k);
    expect(verify(k.signature, bytes, alice.pubKey)).toBe(true);
  });

  it("signKeyFile rejects mismatched priv/pub", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    expect(() =>
      signKeyFile(
        {
          kind: "KeyFile",
          version: 1,
          pubkey: alice.pubKey,
          displayName: "Alice",
          currentEmail: "alice@example.com",
          emailHistory: [],
          metadata: { photo: null, github: null, role: null },
          introductionMandate: "intro-1",
        },
        bob.privKey, // wrong key
      ),
    ).toThrow(/does not correspond/);
  });

  it("signKeyRedirect signs against canonical bytes", () => {
    const alice = keypair(1);
    const r = signKeyRedirect(
      {
        kind: "KeyRedirect",
        version: 1,
        fromEmail: "old@example.com",
        renamedTo: "new@example.com",
        renamedAt: "2026-05-01T00:00:00Z",
        pubkey: alice.pubKey,
      },
      alice.privKey,
    );
    const bytes = canonicalKeyRedirect(r);
    expect(verify(r.signature, bytes, alice.pubKey)).toBe(true);
  });

  it("signEmailRotation signs against canonical bytes", () => {
    const alice = keypair(1);
    const r = signEmailRotation(
      {
        kind: "EmailRotation",
        version: 1,
        pubkey: alice.pubKey,
        fromEmail: "old@example.com",
        toEmail: "new@example.com",
        rotatedAt: "2026-05-01T00:00:00Z",
      },
      alice.privKey,
    );
    const bytes = canonicalEmailRotation(r);
    expect(verify(r.signature, bytes, alice.pubKey)).toBe(true);
  });

  it("signKeyIntroductionRequest signs against canonical bytes", () => {
    const alice = keypair(1);
    const r = signKeyIntroductionRequest(
      {
        kind: "KeyIntroductionRequest",
        version: 1,
        pubkey: alice.pubKey,
        displayName: "Alice",
        currentEmail: "alice@example.com",
        metadata: { photo: null, github: null, role: null },
        requestedAt: "2026-05-01T00:00:00Z",
      },
      alice.privKey,
    );
    const bytes = canonicalKeyIntroductionRequest(r);
    expect(verify(r.signature, bytes, alice.pubKey)).toBe(true);
  });

  it("signReleaseEndorsement signs against canonical bytes", () => {
    const alice = keypair(1);
    const e = signReleaseEndorsement(
      {
        kind: "ReleaseEndorsement",
        version: 1,
        releaseId: "r1",
        semverTag: "v0.1.0",
        commitHash: "0".repeat(40),
        previousReleaseId: null,
        previousCommitHash: null,
        intermediateCommits: [],
        intermediateMerkleRoot: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        endorsedNotes: null,
        issuedAt: "2026-02-01T00:00:00Z",
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const bytes = canonicalReleaseEndorsement(e);
    expect(verify(e.signatures[0]!.sig, bytes, alice.pubKey)).toBe(true);
  });
});
