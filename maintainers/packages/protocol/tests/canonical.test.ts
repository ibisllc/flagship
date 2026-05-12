import { describe, expect, it } from "vitest";
import {
  canonicalMandate,
  canonicalReleaseEndorsement,
  canonicalKeyFile,
  CanonicalBytesError,
} from "../src/canonical.js";
import type { Mandate, ReleaseEndorsement, KeyFile } from "../src/types.js";

const FORTY_HEX = "0".repeat(40);
const SIXTY_FOUR_HEX = "0".repeat(64);

function baseMandate(overrides: Partial<Mandate> = {}): Omit<Mandate, "signatures"> {
  return {
    kind: "Mandate",
    version: 1,
    mandateId: "550e8400-e29b-41d4-a716-446655440000",
    track: "release",
    holder: SIXTY_FOUR_HEX.slice(0, 63) + "1",
    issuedAt: "2026-05-15T12:00:00Z",
    expiresAt: "2026-07-14T12:00:00Z",
    successors: [SIXTY_FOUR_HEX.slice(0, 63) + "2"],
    signedBy: SIXTY_FOUR_HEX.slice(0, 63) + "1",
    ...overrides,
  };
}

describe("canonicalMandate", () => {
  it("produces deterministic bytes", () => {
    const m = baseMandate();
    const bytes1 = canonicalMandate(m);
    const bytes2 = canonicalMandate({ ...m });
    expect(bytes1).toEqual(bytes2);
  });

  it("uses the maintainers/mandate/v1 tag", () => {
    const bytes = canonicalMandate(baseMandate());
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded.startsWith("maintainers/mandate/v1|")).toBe(true);
  });

  it("rejects a track name containing '|'", () => {
    expect(() => canonicalMandate(baseMandate({ track: "bad|track" }))).toThrow(
      CanonicalBytesError,
    );
  });

  it("rejects a track name containing a control character", () => {
    expect(() => canonicalMandate(baseMandate({ track: "badtrack" }))).toThrow(
      CanonicalBytesError,
    );
  });

  it("rejects malformed holder pubkey", () => {
    expect(() => canonicalMandate(baseMandate({ holder: "tooshort" }))).toThrow(
      CanonicalBytesError,
    );
  });

  it("rejects uppercase hex in holder", () => {
    expect(() =>
      canonicalMandate(baseMandate({ holder: SIXTY_FOUR_HEX.slice(0, 63) + "A" })),
    ).toThrow(CanonicalBytesError);
  });

  it("changing successors changes the bytes", () => {
    const a = canonicalMandate(baseMandate());
    const b = canonicalMandate(baseMandate({ successors: [SIXTY_FOUR_HEX.slice(0, 63) + "3"] }));
    expect(a).not.toEqual(b);
  });
});

describe("canonicalReleaseEndorsement", () => {
  function baseEnd(
    overrides: Partial<ReleaseEndorsement> = {},
  ): Omit<ReleaseEndorsement, "signatures"> {
    return {
      kind: "ReleaseEndorsement",
      version: 1,
      releaseId: "release-uuid-here",
      semverTag: "v0.1.0",
      commitHash: FORTY_HEX,
      previousReleaseId: null,
      previousCommitHash: null,
      intermediateCommits: [],
      intermediateMerkleRoot: SIXTY_FOUR_HEX,
      endorsedNotes: null,
      issuedAt: "2026-05-15T12:00:00Z",
      signedBy: SIXTY_FOUR_HEX.slice(0, 63) + "1",
      ...overrides,
    };
  }

  it("produces deterministic bytes", () => {
    const e = baseEnd();
    const a = canonicalReleaseEndorsement(e);
    const b = canonicalReleaseEndorsement({ ...e });
    expect(a).toEqual(b);
  });

  it("uses the maintainers/release/v1 tag", () => {
    const bytes = canonicalReleaseEndorsement(baseEnd());
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded.startsWith("maintainers/release/v1|")).toBe(true);
  });

  it("rejects '|' in semverTag", () => {
    expect(() => canonicalReleaseEndorsement(baseEnd({ semverTag: "v|0.1.0" }))).toThrow(
      CanonicalBytesError,
    );
  });

  it("rejects commitHash with wrong length", () => {
    expect(() =>
      canonicalReleaseEndorsement(baseEnd({ commitHash: "0".repeat(38) })),
    ).toThrow(CanonicalBytesError);
  });

  it("allows null previous fields for genesis", () => {
    expect(() => canonicalReleaseEndorsement(baseEnd())).not.toThrow();
  });

  it("accepts non-null previous fields for non-genesis", () => {
    const e = baseEnd({
      previousReleaseId: "prev-release",
      previousCommitHash: FORTY_HEX,
    });
    expect(() => canonicalReleaseEndorsement(e)).not.toThrow();
  });
});

describe("canonicalKeyFile", () => {
  function baseKey(overrides: Partial<KeyFile> = {}): Omit<KeyFile, "signature"> {
    return {
      kind: "KeyFile",
      version: 1,
      pubkey: SIXTY_FOUR_HEX.slice(0, 63) + "1",
      displayName: "Harry Winner",
      currentEmail: "harry@flagship.services",
      emailHistory: [],
      metadata: { photo: null, github: "harrywinner2", role: "founder" },
      introductionMandate: "intro-mandate-uuid",
      ...overrides,
    };
  }

  it("rejects display name with '|'", () => {
    expect(() => canonicalKeyFile(baseKey({ displayName: "Bad|Name" }))).toThrow(
      CanonicalBytesError,
    );
  });

  it("rejects email containing newline", () => {
    expect(() =>
      canonicalKeyFile(baseKey({ currentEmail: "harry@flagship.services\n" })),
    ).toThrow(CanonicalBytesError);
  });

  it("metadata changes affect canonical bytes (different role)", () => {
    const a = canonicalKeyFile(baseKey());
    const b = canonicalKeyFile(
      baseKey({ metadata: { photo: null, github: "harrywinner2", role: "co-founder" } }),
    );
    expect(a).not.toEqual(b);
  });
});
