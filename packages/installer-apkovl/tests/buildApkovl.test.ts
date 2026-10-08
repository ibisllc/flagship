import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { buildApkovl, buildFlagshipApkovl } from "../src/buildApkovl.js";

function untar(buf: Uint8Array): Array<{ name: string; mode: number; content: Uint8Array }> {
  const entries: Array<{ name: string; mode: number; content: Uint8Array }> = [];
  for (let off = 0; off < buf.length; off += 512) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    let name = "";
    for (let i = 0; i < 100 && block[i] !== 0; i++) name += String.fromCharCode(block[i]!);
    const mode = parseInt(decodeOctal(block, 100, 8), 8);
    const size = parseInt(decodeOctal(block, 124, 12), 8);
    off += 512;
    const content = buf.subarray(off, off + size).slice();
    const padded = Math.ceil(size / 512) * 512;
    off += padded - 512;
    entries.push({ name, mode, content });
  }
  return entries;
}

function decodeOctal(block: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = off; i < off + len && block[i] !== 0 && block[i] !== 0x20; i++) {
    s += String.fromCharCode(block[i]!);
  }
  return s || "0";
}

describe("buildApkovl", () => {
  it("produces a gzipped tar with the expected files and modes", () => {
    const enc = new TextEncoder();
    const bytes = buildApkovl({
      files: [
        { name: "etc/local.d/01-test.start", content: enc.encode("hello"), mode: 0o755 },
        { name: "var/flagship/marker", content: enc.encode("x"), mode: 0o644 },
      ],
    });
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    const tar = new Uint8Array(gunzipSync(bytes));
    const entries = untar(tar);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe("etc/local.d/01-test.start");
    expect(entries[0]!.mode & 0o777).toBe(0o755);
    expect(new TextDecoder().decode(entries[0]!.content)).toBe("hello");
    expect(entries[1]!.name).toBe("var/flagship/marker");
    expect(entries[1]!.mode & 0o777).toBe(0o644);
  });

  it("buildFlagshipApkovl drops scripts at the right paths with executable bits", () => {
    const bytes = buildFlagshipApkovl({
      bootstrap: "#!/bin/sh\nbootstrap\n",
      trailerProbe: "#!/usr/bin/env node\nprobe\n",
      trailerValidate: "#!/usr/bin/env node\nvalidate\n",
    });
    const tar = new Uint8Array(gunzipSync(bytes));
    const entries = untar(tar);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["etc/local.d/01-flagship-bootstrap.start"]!.mode & 0o777).toBe(0o755);
    expect(byName["usr/local/bin/flagship-trailer-probe"]!.mode & 0o777).toBe(0o755);
    expect(byName["usr/local/bin/flagship-trailer-validate"]!.mode & 0o777).toBe(0o755);
    expect(byName["etc/runlevels/default/local"]).toBeDefined();
    expect(byName["usr/local/bin/flagship-install.sh"]).toBeUndefined();
    expect(byName["usr/local/bin/flagship-boot-stage.sh"]).toBeUndefined();
  });

  it("rejects filenames longer than 100 bytes (USTAR limit)", () => {
    expect(() =>
      buildApkovl({
        files: [{ name: "a/".repeat(60) + "x", content: new Uint8Array(0) }],
      }),
    ).toThrow(/longer than 100/);
  });

  it("ends in two zero blocks (proper tar EOF)", () => {
    const bytes = buildApkovl({
      files: [{ name: "x", content: new Uint8Array(10) }],
    });
    const tar = new Uint8Array(gunzipSync(bytes));
    const last1024 = tar.subarray(tar.length - 1024);
    expect(last1024.every((b) => b === 0)).toBe(true);
  });

  it("produces byte-identical output across two builds with the same input (reproducibility)", () => {
    // The single most important property the reproducible-ISO build
    // depends on: same inputs → same bytes. If gzip ever embeds a
    // timestamp, or tar mtimes drift, the GHA build-twice-and-compare
    // step catches it — but we'd rather catch the regression here in
    // the unit suite where the failure mode is obvious.
    const inputs = {
      mtime: 1700000000,
      files: [
        { name: "etc/local.d/01-a.start", content: new Uint8Array([0x01, 0x02, 0x03]), mode: 0o755 },
        { name: "usr/local/bin/helper", content: new Uint8Array(64).fill(0xab), mode: 0o755 },
        { name: "etc/runlevels/default/local", content: new Uint8Array([0x10]), mode: 0o644 },
      ],
    };
    const a = buildApkovl(inputs);
    const b = buildApkovl(inputs);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        throw new Error(`apkovl bytes diverge at offset ${i}: ${a[i]} vs ${b[i]}`);
      }
    }
  });

  it("respects an explicit mtime (no Date.now() leakage into the tar mtime field)", () => {
    // Regression: prior code used Math.floor(Date.now() / 1000) for the
    // tar mtime field. Two builds in the same wall-second produced the
    // same bytes, but a build before and after a second boundary did
    // not — silently breaking the GHA "build twice and compare" check.
    const inputs = {
      files: [
        { name: "etc/local.d/01-mtime.start", content: new Uint8Array([0x42]), mode: 0o755 },
      ],
    };
    const a = buildApkovl({ ...inputs, mtime: 1700000000 });
    const b = buildApkovl({ ...inputs, mtime: 1700000000 });
    const c = buildApkovl({ ...inputs, mtime: 1800000000 });

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);

    const tarA = new Uint8Array(gunzipSync(a));
    const entryA = untar(tarA)[0]!;
    // tar mtime field is at offset 136 length 12 (octal). Decode and
    // confirm it matches what we passed in, not Date.now().
    const mtimeStr = decodeOctal(tarA.subarray(0, 512), 136, 12);
    expect(parseInt(mtimeStr, 8)).toBe(1700000000);
    void entryA; // suppress lint
  });

  it("falls back to SOURCE_DATE_EPOCH when no explicit mtime is given", () => {
    const prior = process.env.SOURCE_DATE_EPOCH;
    try {
      process.env.SOURCE_DATE_EPOCH = "1700000000";
      const a = buildApkovl({
        files: [{ name: "x", content: new Uint8Array([0x01]), mode: 0o644 }],
      });
      process.env.SOURCE_DATE_EPOCH = "1800000000";
      const b = buildApkovl({
        files: [{ name: "x", content: new Uint8Array([0x01]), mode: 0o644 }],
      });
      expect(a).not.toEqual(b);
    } finally {
      if (prior === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = prior;
    }
  });

  it("buildFlagshipApkovl threads mtime through to the tar header", () => {
    const a = buildFlagshipApkovl(
      { bootstrap: "#!/bin/sh\n", trailerProbe: "p\n", trailerValidate: "v\n" },
      { mtime: 1700000000 },
    );
    const b = buildFlagshipApkovl(
      { bootstrap: "#!/bin/sh\n", trailerProbe: "p\n", trailerValidate: "v\n" },
      { mtime: 1700000000 },
    );
    const c = buildFlagshipApkovl(
      { bootstrap: "#!/bin/sh\n", trailerProbe: "p\n", trailerValidate: "v\n" },
      { mtime: 1800000000 },
    );
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
