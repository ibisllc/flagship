/**
 * The archive extraction check against the shared vectors (plan G6/R6): the TS twin, and the Rust
 * checker (`flagship-broker check-tar`) when it has been built, give the same verdict per case.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkTarBytes, checkTarFile, resetTarCheckerProbe, tarCheckSink, type TarLimits, type TarProfile } from "../../src/serverArchive/tarCheck.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const V = JSON.parse(readFileSync(join(ROOT, "packages/protocol/test-vectors/archive-extraction/vectors.json"), "utf8")) as {
  defaults: TarLimits;
  codes: string[];
  cases: Array<{ name: string; profile: TarProfile; limits?: Partial<TarLimits>; expect: { ok: boolean; code?: string; entries?: number; bytes?: number }; tarB64: string }>;
};
const RUST = process.env.FLAGSHIP_TARCHECK_RUST_BIN ?? join(ROOT, "rust/target/debug/flagship-broker");
const dir = mkdtempSync(join(tmpdir(), "tarcheck-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const shape = (v: { ok: boolean; code?: string; entries?: number; bytes?: number }) => (v.ok ? { ok: true, entries: v.entries, bytes: v.bytes } : { ok: false, code: v.code });

describe("archive extraction vectors: the TS twin", () => {
  it("covers every refusal code", () => {
    const used = new Set(V.cases.filter((c) => !c.expect.ok).map((c) => c.expect.code));
    expect([...used].sort()).toEqual([...V.codes].sort());
  });
  for (const c of V.cases) {
    it(c.name, async () => {
      const v = await checkTarBytes(Buffer.from(c.tarB64, "base64"), c.profile, { ...V.defaults, ...c.limits });
      expect(shape(v)).toEqual(shape(c.expect));
    });
  }
  it("gives the same verdict when the stream arrives a byte at a time", async () => {
    for (const c of V.cases.slice(0, 12)) {
      const bytes = Buffer.from(c.tarB64, "base64");
      const sink = await withoutRust(() => tarCheckSink(c.profile, { ...V.defaults, ...c.limits }));
      for (let i = 0; i < bytes.length; i += 97) sink.write(bytes.subarray(i, i + 97));
      expect(shape(await sink.end())).toEqual(shape(c.expect));
    }
  });
});

async function withoutRust<T>(f: () => Promise<T>): Promise<T> {
  const was = process.env.FLAGSHIP_TARCHECK_BIN;
  process.env.FLAGSHIP_TARCHECK_BIN = join(dir, "no-such-binary");
  resetTarCheckerProbe();
  try {
    return await f();
  } finally {
    if (was === undefined) delete process.env.FLAGSHIP_TARCHECK_BIN;
    else process.env.FLAGSHIP_TARCHECK_BIN = was;
    resetTarCheckerProbe();
  }
}

describe.skipIf(!existsSync(RUST))("archive extraction vectors: the Rust checker through checkTarFile", () => {
  for (const c of V.cases) {
    it(c.name, async () => {
      process.env.FLAGSHIP_TARCHECK_BIN = RUST;
      resetTarCheckerProbe();
      const p = join(dir, `${V.cases.indexOf(c)}.tar`);
      writeFileSync(p, Buffer.from(c.tarB64, "base64"));
      const v = await checkTarFile(p, c.profile, c.limits ?? {});
      delete process.env.FLAGSHIP_TARCHECK_BIN;
      expect(v.checker).toBe("rust");
      expect(shape(v)).toEqual(shape(c.expect));
    });
  }
});
