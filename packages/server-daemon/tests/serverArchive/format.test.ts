import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARCHIVE_MAGIC, ArchiveError, openToTar, readHeader, sealToFile, type ArchiveHeader } from "../../src/serverArchive/format.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-fmt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = Buffer.alloc(32, 7);
const header = (frameBytes = 4096): ArchiveHeader => ({
  magic: ARCHIVE_MAGIC,
  v: 1,
  archiveId: "00112233445566778899aabbccddeeff",
  createdAt: 1,
  sourceServer: "home.alice.flagship.services",
  frameBytes,
  apps: [{ serviceId: "alice--wiki", name: "Wiki" }],
});

async function collect(path: string, key = KEY): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of openToTar(path, key)) parts.push(c as Buffer);
  return Buffer.concat(parts);
}
const data = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff));

describe("server archive container", () => {
  it.each([0, 1, 4095, 4096, 4097, 20000])("round-trips %i bytes", async (n) => {
    const path = join(dir, "a.fsa");
    const plain = data(n);
    const out = await sealToFile(Readable.from([plain]), KEY, header(), path);
    expect(out.bytes).toBe((await readFile(path)).length);
    expect(await collect(path)).toEqual(plain);
  });

  it("reads the header without the key", async () => {
    const path = join(dir, "a.fsa");
    await sealToFile(Readable.from([data(10)]), KEY, header(), path);
    const { header: h } = await readHeader(path);
    expect(h.archiveId).toBe("00112233445566778899aabbccddeeff");
    expect(h.apps[0]?.name).toBe("Wiki");
  });

  it("refuses a wrong key", async () => {
    const path = join(dir, "a.fsa");
    await sealToFile(Readable.from([data(9000)]), KEY, header(), path);
    await expect(collect(path, Buffer.alloc(32, 8))).rejects.toThrow(ArchiveError);
  });

  it("refuses a flipped byte", async () => {
    const path = join(dir, "a.fsa");
    await sealToFile(Readable.from([data(9000)]), KEY, header(), path);
    const raw = await readFile(path);
    raw[raw.length - 40] ^= 1;
    await writeFile(path, raw);
    await expect(collect(path)).rejects.toThrow(ArchiveError);
  });

  it("refuses a truncated archive (cut at a frame boundary too)", async () => {
    const path = join(dir, "a.fsa");
    await sealToFile(Readable.from([data(9000)]), KEY, header(), path);
    const raw = await readFile(path);
    const nl = raw.indexOf(0x0a) + 1;
    const first = 4 + raw.readUInt32BE(nl);
    await writeFile(path, raw.subarray(0, nl + first));
    await expect(collect(path)).rejects.toThrow(ArchiveError);
    await writeFile(path, raw.subarray(0, raw.length - 5));
    await expect(collect(path)).rejects.toThrow(ArchiveError);
  });

  it("refuses an edited header (names, source server)", async () => {
    const path = join(dir, "a.fsa");
    await sealToFile(Readable.from([data(100)]), KEY, header(), path);
    const raw = (await readFile(path)).toString("latin1").replace("Wiki", "Wikx");
    await writeFile(path, Buffer.from(raw, "latin1"));
    await expect(collect(path)).rejects.toThrow(ArchiveError);
  });

  it("refuses a file that isn't an archive", async () => {
    const path = join(dir, "x");
    await writeFile(path, "hello\n");
    await expect(readHeader(path)).rejects.toThrow(/isn't a Flagship archive/);
  });
});
