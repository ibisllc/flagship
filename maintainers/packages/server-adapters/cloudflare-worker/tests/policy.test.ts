/**
 * Policy enforcement tests for the Cloudflare Worker adapter.
 *
 * These tests build synthetic RepoStates in-process and feed them
 * through `decide()`. They cover every defense-in-depth fence:
 * path-prefix, envelope shape, canonical-bytes mismatch, bad
 * signatures, unauthorized signers, and the genesis-acceptance path.
 *
 * No network — never test against real GitHub.
 */

import { describe, expect, it } from "vitest";
import {
  generateKeypair,
  signMandate,
  signKeyFile,
  signEmailRotation,
  signReleaseEndorsement,
  canonicalMandate,
  canonicalKeyFile,
  canonicalEmailRotation,
  canonicalReleaseEndorsement,
  intermediateMerkleRoot,
  bytesToHex,
  type Mandate,
  type KeyFile,
  type ReleaseEndorsement,
  type TrackPolicy,
  type RootPolicy,
} from "@maintainers/protocol";
import { decide, summarizeState, type RepoState } from "../src/policy.js";

function kp(seed: number): { privKey: string; pubKey: string } {
  const s = new Uint8Array(32);
  s[0] = seed;
  return generateKeypair(s);
}

function rootPolicy(): RootPolicy {
  return {
    schemaVersion: 1,
    project: { name: "test" },
    tracks: ["release"],
  };
}

function releasePolicy(): TrackPolicy {
  return {
    track: "release",
    defaultMandateDuration: "60d",
    approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
  };
}

function emptyState(): RepoState {
  return { rootPolicy: null, tracks: new Map(), keyFiles: new Map() };
}

function stateWithGenesisMandate(holder: { privKey: string; pubKey: string }, successors: string[] = []): { state: RepoState; mandate: Mandate } {
  const m = signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: "g1-00000000-0000-0000-0000-000000000001",
      track: "release",
      holder: holder.pubKey,
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-12-01T00:00:00Z",
      successors,
      signedBy: holder.pubKey,
    },
    [{ privKey: holder.privKey }],
  );
  const state: RepoState = {
    rootPolicy: rootPolicy(),
    tracks: new Map([["release", { policy: releasePolicy(), mandates: [m] }]]),
    keyFiles: new Map(),
  };
  return { state, mandate: m };
}

describe("decide() — path-prefix fence", () => {
  it("rejects a path outside .maintainers/", () => {
    const alice = kp(1);
    const m = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "id-00000000-0000-0000-0000-000000000010",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-04-01T00:00:00Z",
        successors: [],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const r = decide({
      path: "src/whatever.json",
      envelope: m,
      envelopeBytesHex: bytesToHex(canonicalMandate(m)),
      state: emptyState(),
      now: new Date("2026-02-01T01:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("path-outside-maintainers");
      expect(r.status).toBe(403);
    }
  });

  it("rejects path traversal segments", () => {
    const alice = kp(1);
    const m = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "id-00000000-0000-0000-0000-000000000011",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-04-01T00:00:00Z",
        successors: [],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const r = decide({
      path: ".maintainers/../etc/passwd",
      envelope: m,
      envelopeBytesHex: bytesToHex(canonicalMandate(m)),
      state: emptyState(),
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path-traversal");
  });

  it("rejects directory-like paths", () => {
    const alice = kp(1);
    const m = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "id-00000000-0000-0000-0000-000000000012",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-04-01T00:00:00Z",
        successors: [],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const r = decide({
      path: ".maintainers/keys/",
      envelope: m,
      envelopeBytesHex: bytesToHex(canonicalMandate(m)),
      state: emptyState(),
      now: new Date(),
    });
    expect(r.ok).toBe(false);
  });
});

describe("decide() — envelope-shape fence", () => {
  it("rejects non-object envelopes", () => {
    const r = decide({
      path: ".maintainers/x.json",
      envelope: "not-an-object",
      envelopeBytesHex: "00",
      state: emptyState(),
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("envelope-not-object");
  });

  it("rejects unknown envelope kinds", () => {
    const r = decide({
      path: ".maintainers/x.json",
      envelope: { kind: "MaliciousKind", version: 1 },
      envelopeBytesHex: "00",
      state: emptyState(),
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("envelope-kind-unknown");
  });

  it("rejects future version numbers", () => {
    const r = decide({
      path: ".maintainers/x.json",
      envelope: { kind: "Mandate", version: 2 },
      envelopeBytesHex: "00",
      state: emptyState(),
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("envelope-version-unsupported");
  });
});

describe("decide() — canonical-bytes fence", () => {
  it("rejects envelopes whose bytes don't match", () => {
    const alice = kp(1);
    const m = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "id-00000000-0000-0000-0000-000000000020",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-04-01T00:00:00Z",
        successors: [],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/release/mandates/m.json",
      envelope: m,
      envelopeBytesHex: "deadbeef",
      state: emptyState(),
      now: new Date("2026-02-01T01:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("canonical-bytes-mismatch");
  });
});

describe("decide() — signature fence", () => {
  it("rejects a Mandate whose signature was forged", () => {
    const alice = kp(1);
    const eve = kp(99);
    const m: Mandate = {
      kind: "Mandate",
      version: 1,
      mandateId: "id-00000000-0000-0000-0000-000000000030",
      track: "release",
      holder: alice.pubKey,
      issuedAt: "2026-02-01T00:00:00Z",
      expiresAt: "2026-04-01T00:00:00Z",
      successors: [],
      signedBy: alice.pubKey,
      // Sign with eve, but claim it's alice
      signatures: [{ pubkey: alice.pubKey, sig: "00".repeat(64) }],
    };
    const r = decide({
      path: ".maintainers/tracks/release/mandates/m.json",
      envelope: m,
      envelopeBytesHex: bytesToHex(canonicalMandate(m)),
      state: emptyState(),
      now: new Date("2026-02-01T01:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("signature-invalid");
  });

  it("rejects when signedBy is not present in signatures", () => {
    const alice = kp(1);
    const bob = kp(2);
    const m = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "id-00000000-0000-0000-0000-000000000031",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-04-01T00:00:00Z",
        successors: [],
        signedBy: alice.pubKey,
      },
      [{ privKey: bob.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/release/mandates/m.json",
      envelope: m,
      envelopeBytesHex: bytesToHex(canonicalMandate(m)),
      state: emptyState(),
      now: new Date("2026-02-01T01:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("signedBy-not-in-signatures");
  });
});

describe("decide() — genesis acceptance", () => {
  it("accepts a well-formed self-signed genesis Mandate when state is empty", () => {
    const alice = kp(1);
    const m = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "g1-00000000-0000-0000-0000-000000000040",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-07-01T00:00:00Z",
        successors: [],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/release/mandates/2026-01-01-genesis.json",
      envelope: m,
      envelopeBytesHex: bytesToHex(canonicalMandate(m)),
      state: emptyState(),
      now: new Date("2026-01-01T01:00:00Z"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commitMessage).toMatch(/^maintainers: Mandate by /);
  });

  it("rejects genesis not self-signed", () => {
    const alice = kp(1);
    const bob = kp(2);
    const m = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "g1-00000000-0000-0000-0000-000000000041",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-07-01T00:00:00Z",
        successors: [],
        signedBy: bob.pubKey,
      },
      [{ privKey: bob.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/release/mandates/2026-01-01-genesis.json",
      envelope: m,
      envelopeBytesHex: bytesToHex(canonicalMandate(m)),
      state: emptyState(),
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("genesis-rejected");
  });
});

describe("decide() — authority fence for non-genesis Mandates", () => {
  it("accepts a renewal signed by the current holder during their active window", () => {
    const alice = kp(1);
    const { state } = stateWithGenesisMandate(alice, [alice.pubKey]);
    const renewal = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "r1-00000000-0000-0000-0000-000000000050",
        track: "release",
        holder: alice.pubKey,
        issuedAt: "2026-06-01T00:00:00Z",
        expiresAt: "2027-01-01T00:00:00Z",
        successors: [alice.pubKey],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/release/mandates/2026-06-01-renewal.json",
      envelope: renewal,
      envelopeBytesHex: bytesToHex(canonicalMandate(renewal)),
      state,
      now: new Date("2026-06-01T01:00:00Z"),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a renewal by someone other than the holder during the active window", () => {
    const alice = kp(1);
    const eve = kp(99);
    const { state } = stateWithGenesisMandate(alice, [alice.pubKey]);
    const hostile = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "h1-00000000-0000-0000-0000-000000000051",
        track: "release",
        holder: eve.pubKey,
        issuedAt: "2026-06-01T00:00:00Z",
        expiresAt: "2027-01-01T00:00:00Z",
        successors: [],
        signedBy: eve.pubKey,
      },
      [{ privKey: eve.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/release/mandates/2026-06-01-hostile.json",
      envelope: hostile,
      envelopeBytesHex: bytesToHex(canonicalMandate(hostile)),
      state,
      now: new Date("2026-06-01T01:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mandate-rejected");
  });

  it("accepts a named-successor takeover after expiry", () => {
    const alice = kp(1);
    const bob = kp(2);
    const { state } = stateWithGenesisMandate(alice, [bob.pubKey]);
    const takeover = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "t1-00000000-0000-0000-0000-000000000052",
        track: "release",
        holder: bob.pubKey,
        issuedAt: "2027-01-01T00:00:00Z",
        expiresAt: "2027-06-01T00:00:00Z",
        successors: [bob.pubKey],
        signedBy: bob.pubKey,
      },
      [{ privKey: bob.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/release/mandates/2027-01-01-takeover.json",
      envelope: takeover,
      envelopeBytesHex: bytesToHex(canonicalMandate(takeover)),
      state,
      now: new Date("2027-01-01T01:00:00Z"),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-successor's takeover attempt after expiry", () => {
    const alice = kp(1);
    const bob = kp(2);
    const eve = kp(99);
    const { state } = stateWithGenesisMandate(alice, [bob.pubKey]);
    const fakeTakeover = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "h2-00000000-0000-0000-0000-000000000053",
        track: "release",
        holder: eve.pubKey,
        issuedAt: "2027-01-01T00:00:00Z",
        expiresAt: "2027-06-01T00:00:00Z",
        successors: [],
        signedBy: eve.pubKey,
      },
      [{ privKey: eve.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/release/mandates/2027-01-01-attack.json",
      envelope: fakeTakeover,
      envelopeBytesHex: bytesToHex(canonicalMandate(fakeTakeover)),
      state,
      now: new Date("2027-01-01T01:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mandate-rejected");
  });

  it("rejects a Mandate for a track not declared in policy when state is non-empty", () => {
    const alice = kp(1);
    const { state } = stateWithGenesisMandate(alice);
    const wrongTrack = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "x1-00000000-0000-0000-0000-000000000054",
        track: "ops",
        holder: alice.pubKey,
        issuedAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-04-01T00:00:00Z",
        successors: [],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const r = decide({
      path: ".maintainers/tracks/ops/mandates/m.json",
      envelope: wrongTrack,
      envelopeBytesHex: bytesToHex(canonicalMandate(wrongTrack)),
      state,
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-track");
  });
});

describe("decide() — ReleaseEndorsement authority", () => {
  it("accepts an endorsement signed by the current release-track holder", () => {
    const alice = kp(1);
    const { state } = stateWithGenesisMandate(alice, [alice.pubKey]);
    const commits = ["aa".repeat(20), "bb".repeat(20), "cc".repeat(20)];
    const root = intermediateMerkleRoot(commits);
    const endo = signReleaseEndorsement(
      {
        kind: "ReleaseEndorsement",
        version: 1,
        releaseId: "e1-00000000-0000-0000-0000-000000000060",
        semverTag: "v0.1.0",
        commitHash: "cc".repeat(20),
        previousReleaseId: null,
        previousCommitHash: null,
        intermediateCommits: commits,
        intermediateMerkleRoot: root,
        endorsedNotes: null,
        issuedAt: "2026-02-15T00:00:00Z",
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    );
    const r = decide({
      path: ".maintainers/endorsements/v0.1.0.json",
      envelope: endo,
      envelopeBytesHex: bytesToHex(canonicalReleaseEndorsement(endo)),
      state,
      now: new Date("2026-02-15T01:00:00Z"),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an endorsement signed by a non-holder", () => {
    const alice = kp(1);
    const eve = kp(99);
    const { state } = stateWithGenesisMandate(alice, []);
    const commits = ["aa".repeat(20)];
    const endo = signReleaseEndorsement(
      {
        kind: "ReleaseEndorsement",
        version: 1,
        releaseId: "e2-00000000-0000-0000-0000-000000000061",
        semverTag: "v0.2.0",
        commitHash: "aa".repeat(20),
        previousReleaseId: null,
        previousCommitHash: null,
        intermediateCommits: commits,
        intermediateMerkleRoot: intermediateMerkleRoot(commits),
        endorsedNotes: null,
        issuedAt: "2026-02-15T00:00:00Z",
        signedBy: eve.pubKey,
      },
      [{ privKey: eve.privKey }],
    );
    const r = decide({
      path: ".maintainers/endorsements/v0.2.0.json",
      envelope: endo,
      envelopeBytesHex: bytesToHex(canonicalReleaseEndorsement(endo)),
      state,
      now: new Date("2026-02-15T01:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("endorsement-signer-not-holder");
  });
});

describe("decide() — KeyFile / EmailRotation", () => {
  it("accepts a self-signed KeyFile", () => {
    const alice = kp(1);
    const kf: KeyFile = signKeyFile(
      {
        kind: "KeyFile",
        version: 1,
        pubkey: alice.pubKey,
        displayName: "Alice",
        currentEmail: "alice@example.com",
        emailHistory: [{ email: "alice@example.com", from: "2026-01-01T00:00:00Z", to: null }],
        metadata: { photo: null, github: "alice", role: "maintainer" },
        introductionMandate: "g1-00000000-0000-0000-0000-000000000001",
      },
      alice.privKey,
    );
    const r = decide({
      path: ".maintainers/keys/alice@example.com.json",
      envelope: kf,
      envelopeBytesHex: bytesToHex(canonicalKeyFile(kf)),
      state: emptyState(),
      now: new Date(),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an EmailRotation whose pubkey is unknown", () => {
    const alice = kp(1);
    const rot = signEmailRotation(
      {
        kind: "EmailRotation",
        version: 1,
        pubkey: alice.pubKey,
        fromEmail: "old@example.com",
        toEmail: "new@example.com",
        rotatedAt: "2026-03-01T00:00:00Z",
      },
      alice.privKey,
    );
    const r = decide({
      path: ".maintainers/keys/old@example.com.json",
      envelope: rot,
      envelopeBytesHex: bytesToHex(canonicalEmailRotation(rot)),
      state: emptyState(),
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-pubkey");
  });
});

describe("summarizeState()", () => {
  it("reports current holder and successors", () => {
    const alice = kp(1);
    const bob = kp(2);
    const { state } = stateWithGenesisMandate(alice, [bob.pubKey]);
    const s = summarizeState(state, new Date("2026-06-01T00:00:00Z"));
    expect(s.tracks).toHaveLength(1);
    expect(s.tracks[0]?.name).toBe("release");
    expect(s.tracks[0]?.currentHolder).toBe(alice.pubKey);
    expect(s.tracks[0]?.successors).toEqual([bob.pubKey]);
  });

  it("emits a takeover alarm when a successor signs", () => {
    const alice = kp(1);
    const bob = kp(2);
    const { state, mandate: m1 } = stateWithGenesisMandate(alice, [bob.pubKey]);
    const m2 = signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "t1-00000000-0000-0000-0000-000000000070",
        track: "release",
        holder: bob.pubKey,
        issuedAt: "2027-01-01T00:00:00Z",
        expiresAt: "2027-06-01T00:00:00Z",
        successors: [],
        signedBy: bob.pubKey,
      },
      [{ privKey: bob.privKey }],
    );
    state.tracks.get("release")!.mandates.push(m2);
    const s = summarizeState(state, new Date("2027-02-01T00:00:00Z"));
    expect(s.takeoverAlarms).toHaveLength(1);
    expect(s.takeoverAlarms[0]?.previousMandate).toBe(m1.mandateId);
    expect(s.takeoverAlarms[0]?.newMandate).toBe(m2.mandateId);
    expect(s.takeoverAlarms[0]?.previousHolder).toBe(alice.pubKey);
    expect(s.takeoverAlarms[0]?.newHolder).toBe(bob.pubKey);
  });
});
