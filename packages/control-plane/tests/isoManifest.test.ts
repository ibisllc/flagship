import { describe, expect, it } from "vitest";
import { handleIsoManifest, type IsoManifest } from "../src/isoManifest.js";

const BLESSED: IsoManifest = {
  version: "debian-12.7.0-amd64",
  url: "https://r2.example.com/iso/debian-12.7.0-amd64-netinst.iso",
  sha256: "a".repeat(64),
  sizeBytes: 658505728,
  attestation: "https://cdimage.debian.org/debian-cd/12.7.0/amd64/iso-cd/SHA256SUMS",
};

describe("iso manifest handler", () => {
  it("configured + current=null → returns the download block", () => {
    const r = handleIsoManifest(
      { blessedManifest: BLESSED },
      { platform: "mac", burnerVersion: "1.2.3", current: null },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ download: BLESSED });
  });

  it("configured + current.sha256 mismatch → returns the download block", () => {
    const r = handleIsoManifest(
      { blessedManifest: BLESSED },
      {
        platform: "linux",
        burnerVersion: "1.0.0",
        current: { version: "debian-old", sha256: "b".repeat(64) },
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ download: BLESSED });
  });

  it("configured + current.sha256 match (case-insensitive) → { download: null }", () => {
    const r = handleIsoManifest(
      { blessedManifest: BLESSED },
      {
        platform: "windows",
        burnerVersion: "2.0.0",
        current: { version: "whatever", sha256: "A".repeat(64) },
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ download: null });
  });

  it("unconfigured (no blessed manifest) → { download: null }", () => {
    const r = handleIsoManifest(
      { blessedManifest: null },
      { platform: "mac", burnerVersion: "1.2.3", current: null },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ download: null });
  });

  it("unconfigured + current present → still { download: null }", () => {
    const r = handleIsoManifest(
      { blessedManifest: null },
      {
        platform: "mac",
        burnerVersion: "1.2.3",
        current: { version: "x", sha256: "c".repeat(64) },
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ download: null });
  });

  describe("arch selection", () => {
    const BLESSED_ARM64: IsoManifest = {
      version: "debian-13.6.0-arm64",
      url: "https://cdimage.debian.org/cdimage/release/13.6.0/arm64/iso-cd/debian-13.6.0-arm64-netinst.iso",
      sha256: "d".repeat(64),
      sizeBytes: 735358976,
      attestation:
        "https://cdimage.debian.org/cdimage/release/13.6.0/arm64/iso-cd/SHA256SUMS",
    };

    it("absent arch → the amd64 manifest (back-compat with deployed burners)", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED, blessedManifestArm64: BLESSED_ARM64 },
        { platform: "mac", burnerVersion: "1.2.3", current: null },
      );
      expect(r.body).toEqual({ download: BLESSED });
    });

    it('arch:"amd64" → the amd64 manifest', () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED, blessedManifestArm64: BLESSED_ARM64 },
        { platform: "linux", burnerVersion: "1.2.3", current: null, arch: "amd64" },
      );
      expect(r.body).toEqual({ download: BLESSED });
    });

    it('arch:"arm64" → the arm64 manifest', () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED, blessedManifestArm64: BLESSED_ARM64 },
        { platform: "mac", burnerVersion: "1.2.3", current: null, arch: "arm64" },
      );
      expect(r.body).toEqual({ download: BLESSED_ARM64 });
    });

    it('arch:"arm64" with a matching current sha → { download: null }', () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED, blessedManifestArm64: BLESSED_ARM64 },
        {
          platform: "mac",
          burnerVersion: "1.2.3",
          current: { version: "debian-13.6.0-arm64", sha256: "D".repeat(64) },
          arch: "arm64",
        },
      );
      expect(r.body).toEqual({ download: null });
    });

    it('arch:"arm64" unconfigured → { download: null } even though amd64 is blessed', () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED },
        { platform: "mac", burnerVersion: "1.2.3", current: null, arch: "arm64" },
      );
      expect(r.body).toEqual({ download: null });
    });

    it("bad arch → 400", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED, blessedManifestArm64: BLESSED_ARM64 },
        { platform: "mac", burnerVersion: "1.2.3", current: null, arch: "riscv64" },
      );
      expect(r.status).toBe(400);
    });
  });

  describe("bad input → 400", () => {
    it("missing body", () => {
      expect(handleIsoManifest({ blessedManifest: BLESSED }, undefined).status).toBe(400);
    });

    it("unknown platform", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED },
        { platform: "freebsd", burnerVersion: "1.0.0", current: null },
      );
      expect(r.status).toBe(400);
    });

    it("missing platform", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED },
        { burnerVersion: "1.0.0", current: null } as never,
      );
      expect(r.status).toBe(400);
    });

    it("empty burnerVersion", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED },
        { platform: "mac", burnerVersion: "", current: null },
      );
      expect(r.status).toBe(400);
    });

    it("non-string burnerVersion", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED },
        { platform: "mac", burnerVersion: 5 as never, current: null },
      );
      expect(r.status).toBe(400);
    });

    it("current with non-hex sha256", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED },
        {
          platform: "mac",
          burnerVersion: "1.0.0",
          current: { version: "x", sha256: "not-hex" },
        },
      );
      expect(r.status).toBe(400);
    });

    it("current with too-short sha256", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED },
        {
          platform: "mac",
          burnerVersion: "1.0.0",
          current: { version: "x", sha256: "abc" },
        },
      );
      expect(r.status).toBe(400);
    });

    it("current missing version", () => {
      const r = handleIsoManifest(
        { blessedManifest: BLESSED },
        {
          platform: "mac",
          burnerVersion: "1.0.0",
          current: { sha256: "d".repeat(64) } as never,
        },
      );
      expect(r.status).toBe(400);
    });
  });
});
