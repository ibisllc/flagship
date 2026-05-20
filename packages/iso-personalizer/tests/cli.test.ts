import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signInstallBlob } from "@flagship/protocol";

import {
  parseArgs,
  validateLabel,
  hexToBytes,
  bytesToHex,
  synthesizeBlob,
  buildTrailerWithSignature,
  verifyPersonalized,
  sha256Hex,
  main,
} from "../src/cli.js";
import { parseTrailer } from "../src/trailer.js";
import { personalizeBytes } from "../src/personalize.js";
import { installBlobToJson } from "../src/trailer.js";

const SEED = new Uint8Array(32).fill(7);

describe("parseArgs", () => {
  it("returns a clean ParsedArgs for the standalone flag set", () => {
    const a = parseArgs([
      "--base-iso",
      "/tmp/x.iso",
      "--output",
      "/tmp/y.iso",
      "--username",
      "alice",
      "--server-name",
      "home",
    ]);
    expect(a.baseIso).toBe("/tmp/x.iso");
    expect(a.output).toBe("/tmp/y.iso");
    expect(a.username).toBe("alice");
    expect(a.serverName).toBe("home");
    expect(a.verify).toBe(false);
  });

  it("parses --verify and --help as booleans", () => {
    const a = parseArgs(["--verify", "--help"]);
    expect(a.verify).toBe(true);
    expect(a.help).toBe(true);
  });

  it("throws on a flag missing its value", () => {
    expect(() => parseArgs(["--base-iso"])).toThrow(/requires a value/);
    expect(() => parseArgs(["bare-arg"])).toThrow(/unexpected argument/);
  });
});

describe("validateLabel", () => {
  it("accepts RFC-1035 labels", () => {
    expect(() => validateLabel("alice", "username")).not.toThrow();
    expect(() => validateLabel("home-1", "server-name")).not.toThrow();
  });
  it("rejects empty, uppercase, leading-dash, dots", () => {
    expect(() => validateLabel("", "x")).toThrow();
    expect(() => validateLabel("Alice", "x")).toThrow();
    expect(() => validateLabel("-alice", "x")).toThrow();
    expect(() => validateLabel("a.b", "x")).toThrow();
  });
});

describe("hexToBytes / bytesToHex", () => {
  it("round-trips", () => {
    const b = new Uint8Array([0, 1, 0x7f, 0xff, 0xa5]);
    expect(hexToBytes(bytesToHex(b))).toEqual(b);
  });
  it("rejects odd-length hex", () => {
    expect(() => hexToBytes("abc")).toThrow(/bad hex/);
  });
});

describe("synthesizeBlob", () => {
  it("produces a self-consistent install blob whose trailer round-trips", () => {
    const { blob, signer } = synthesizeBlob({
      username: "alice",
      serverName: "home",
      seedBytes: SEED,
      now: 1_700_000_000_000,
    });
    expect(blob.username).toBe("alice");
    expect(blob.serverName).toBe("home");
    expect(blob.serverDomain).toBe("home.alice.flagship.services");
    // Sign it the same way buildTrailer would and confirm parseTrailer
    // verifies (same path the live installer takes on first boot).
    const sig = signInstallBlob(blob, signer);
    const trailer = buildTrailerWithSignature(blob, sig);
    const parsed = parseTrailer(trailer);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(true);
    expect(parsed!.blob.username).toBe("alice");
    expect(parsed!.blob.serverName).toBe("home");
  });

  it("is deterministic given the same seed", () => {
    const a = synthesizeBlob({
      username: "alice",
      serverName: "home",
      seedBytes: SEED,
      now: 1_700_000_000_000,
    });
    const b = synthesizeBlob({
      username: "alice",
      serverName: "home",
      seedBytes: SEED,
      now: 1_700_000_000_000,
    });
    expect(bytesToHex(a.blob.authCode.userPubKey)).toBe(
      bytesToHex(b.blob.authCode.userPubKey),
    );
    expect(a.blob.authCode.serial).toBe(b.blob.authCode.serial);
  });

  it("rejects non-32-byte seeds", () => {
    expect(() =>
      synthesizeBlob({
        username: "alice",
        serverName: "home",
        seedBytes: new Uint8Array(31),
        now: 0,
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("buildTrailerWithSignature", () => {
  it("produces bytes that parseTrailer accepts when the signature was over the live blob", () => {
    const { blob, signer } = synthesizeBlob({
      username: "harry",
      serverName: "home",
      seedBytes: SEED,
      now: 1_700_000_000_000,
    });
    const sig = signInstallBlob(blob, signer);
    const bytes = buildTrailerWithSignature(blob, sig);
    const parsed = parseTrailer(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(true);
  });

  it("rejects wrong-length signatures", () => {
    const { blob } = synthesizeBlob({
      username: "harry",
      serverName: "home",
      seedBytes: SEED,
      now: 1_700_000_000_000,
    });
    expect(() => buildTrailerWithSignature(blob, new Uint8Array(63))).toThrow(/64 bytes/);
  });
});

describe("verifyPersonalized", () => {
  it("returns ok for a freshly-personalized trailer + base", () => {
    const { blob, signer } = synthesizeBlob({
      username: "alice",
      serverName: "home",
      seedBytes: SEED,
      now: 1_700_000_000_000,
    });
    const sig = signInstallBlob(blob, signer);
    const trailer = buildTrailerWithSignature(blob, sig);
    const fakeBase = new Uint8Array(8192);
    crypto.getRandomValues(fakeBase);
    const personalized = personalizeBytes(fakeBase, trailer);
    expect(verifyPersonalized(personalized, "alice", "home")).toEqual({ ok: true });
  });
  it("reports a mismatch when asked for a different username", () => {
    const { blob, signer } = synthesizeBlob({
      username: "alice",
      serverName: "home",
      seedBytes: SEED,
      now: 1_700_000_000_000,
    });
    const sig = signInstallBlob(blob, signer);
    const trailer = buildTrailerWithSignature(blob, sig);
    const personalized = personalizeBytes(new Uint8Array(8192), trailer);
    const v = verifyPersonalized(personalized, "bob", "home");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/username mismatch/);
  });
});

describe("main (file I/O)", () => {
  // The CLI sets process.exit / writes to stdout; we just assert the
  // exit code + the artifact ends up on disk with a parseable trailer.
  it("end-to-end standalone mode writes a personalized ISO with a parseable trailer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fp-iso-test-"));
    try {
      const base = join(dir, "base.iso");
      const out = join(dir, "out.iso");
      // 8 KiB of nonsense as a stand-in for the real Alpine ISO. The
      // personalize-iso CLI doesn't care about ISO9660 layout — it just
      // appends the trailer.
      const fakeBase = new Uint8Array(8192);
      crypto.getRandomValues(fakeBase);
      await writeFile(base, fakeBase);
      const code = await main([
        "--base-iso",
        base,
        "--output",
        out,
        "--username",
        "e2etest",
        "--server-name",
        "home",
        "--seed-hex",
        bytesToHex(new Uint8Array(32).fill(42)),
        "--verify",
      ]);
      expect(code).toBe(0);
      const bytes = new Uint8Array(await readFile(out));
      const parsed = parseTrailer(bytes);
      expect(parsed).not.toBeNull();
      expect(parsed!.blob.username).toBe("e2etest");
      expect(parsed!.blob.serverName).toBe("home");
      expect(parsed!.signatureValid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blob-json mode round-trips the supplied blob byte-for-byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fp-iso-test-"));
    try {
      const base = join(dir, "base.iso");
      const out = join(dir, "out.iso");
      const blobJsonPath = join(dir, "blob.json");
      const fakeBase = new Uint8Array(8192);
      crypto.getRandomValues(fakeBase);
      await writeFile(base, fakeBase);
      // Build a blob ourselves using the same helper, sign it, write the
      // envelope shape the live `.com` build-relay returns.
      const { blob, signer } = synthesizeBlob({
        username: "envelope",
        serverName: "home",
        seedBytes: SEED,
        now: 1_700_000_000_000,
      });
      const sig = signInstallBlob(blob, signer);
      const envelope = {
        blob: installBlobToJson(blob),
        blobSignature: bytesToHex(sig),
      };
      await writeFile(blobJsonPath, JSON.stringify(envelope));
      const code = await main([
        "--base-iso",
        base,
        "--output",
        out,
        "--blob-json",
        blobJsonPath,
        "--verify",
      ]);
      expect(code).toBe(0);
      const bytes = new Uint8Array(await readFile(out));
      const parsed = parseTrailer(bytes);
      expect(parsed).not.toBeNull();
      expect(parsed!.blob.username).toBe("envelope");
      expect(parsed!.signatureValid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("missing --base-iso / --output => exit 2", async () => {
    const code = await main([]);
    expect(code).toBe(2);
  });

  it("invalid username label => exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fp-iso-test-"));
    try {
      const base = join(dir, "base.iso");
      const out = join(dir, "out.iso");
      await writeFile(base, new Uint8Array(8192));
      const code = await main([
        "--base-iso",
        base,
        "--output",
        out,
        "--username",
        "Bad.Label",
        "--server-name",
        "home",
      ]);
      expect(code).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sha256Hex", () => {
  it("matches a known constant for empty input", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
