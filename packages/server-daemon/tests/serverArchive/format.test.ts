import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { BACKUP_DATA_MAGIC, openBackupWithPasscode, parseBackupFile, sealBackupFile, serializeBackupFile, wrapPasscodeSlot } from "@flagship/protocol";
import { ArchiveError, checkBackupFile, checkDataFile, openDataFile, sealDataFile, writeBackupFile } from "../../src/serverArchive/format.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-fmt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = Buffer.alloc(32, 7);
const ID = "00112233445566778899aabbccddeeff";
const FRAME = 4096;

async function collect(path: string, key = KEY, id = ID): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of openDataFile(path, key, id)) parts.push(c as Buffer);
  return Buffer.concat(parts);
}
const data = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff));

describe("the backup's data file", () => {
  it.each([0, 1, 4095, 4096, 4097, 20000])("round-trips %i bytes", async (n) => {
    const path = join(dir, "a.flagship-data");
    const plain = data(n);
    const out = await sealDataFile(Readable.from([plain]), KEY, ID, path, FRAME);
    const raw = await readFile(path);
    expect(out.bytes).toBe(raw.length);
    expect(out.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(raw.subarray(0, BACKUP_DATA_MAGIC.length).toString()).toBe(BACKUP_DATA_MAGIC);
    expect(await collect(path)).toEqual(plain);
  });

  it("refuses a wrong key, and another backup's id", async () => {
    const path = join(dir, "a.flagship-data");
    await sealDataFile(Readable.from([data(9000)]), KEY, ID, path, FRAME);
    await expect(collect(path, Buffer.alloc(32, 8))).rejects.toThrow(ArchiveError);
    await expect(collect(path, KEY, "ff".repeat(16))).rejects.toThrow(ArchiveError);
  });

  it("refuses a flipped byte", async () => {
    const path = join(dir, "a.flagship-data");
    await sealDataFile(Readable.from([data(9000)]), KEY, ID, path, FRAME);
    const raw = await readFile(path);
    raw[raw.length - 40] ^= 1;
    await writeFile(path, raw);
    await expect(collect(path)).rejects.toThrow(ArchiveError);
  });

  it("refuses a truncated file (cut at a frame boundary too)", async () => {
    const path = join(dir, "a.flagship-data");
    await sealDataFile(Readable.from([data(9000)]), KEY, ID, path, FRAME);
    const raw = await readFile(path);
    const start = BACKUP_DATA_MAGIC.length;
    const first = 4 + raw.readUInt32BE(start);
    await writeFile(path, raw.subarray(0, start + first));
    await expect(collect(path)).rejects.toThrow(ArchiveError);
    await writeFile(path, raw.subarray(0, raw.length - 5));
    await expect(collect(path)).rejects.toThrow(ArchiveError);
  });

  it("refuses frames in another order", async () => {
    const path = join(dir, "a.flagship-data");
    await sealDataFile(Readable.from([data(3 * FRAME)]), KEY, ID, path, FRAME);
    const raw = await readFile(path);
    const start = BACKUP_DATA_MAGIC.length;
    const len = 4 + raw.readUInt32BE(start);
    const swapped = Buffer.concat([raw.subarray(0, start), raw.subarray(start + len, start + 2 * len), raw.subarray(start, start + len), raw.subarray(start + 2 * len)]);
    await writeFile(path, swapped);
    await expect(collect(path)).rejects.toThrow(ArchiveError);
  });

  it("refuses a file that isn't a data file", async () => {
    const path = join(dir, "x");
    await writeFile(path, "hello\n" + "x".repeat(64));
    await expect(collect(path)).rejects.toThrow(/isn't a Flagship backup's data file/);
  });
});

describe("the backup file the box writes", () => {
  it("seals the body under the content key next to the app's slots", async () => {
    const path = join(dir, "a.flagship-backup");
    const slot = wrapPasscodeSlot(ID, KEY, "correct horse battery staple", new Uint8Array(16), new Uint8Array(12), { m: 64, t: 1, p: 1 });
    const body = {
      createdAt: 1,
      server: { name: "home", domain: "home.alice.flagship.services", bootUnlockMode: "auto" as const, diskEncryption: "luks" as const },
      apps: [{ serviceId: "alice--wiki", name: "Wiki" }],
      left: [],
      includes: [],
      excludes: [],
      data: { fileName: "home-1970-01-01.flagship-data", bytes: 100, sha256: "ab".repeat(32), frameBytes: FRAME },
    };
    const out = await writeBackupFile(path, { archiveId: ID, key: KEY, slots: [slot], body, nonce: Buffer.alloc(12, 1) });
    const text = await readFile(path, "utf8");
    expect(out.text).toBe(text);
    expect(text).not.toContain("Wiki");
    expect(openBackupWithPasscode(parseBackupFile(text), "correct horse battery staple").body).toEqual(body);
  });
});

describe("checking a backup that was just written", () => {
  it("passes a good file, and says what is wrong with a changed, cut or wrongly keyed one", async () => {
    const path = join(dir, "c.flagship-data");
    const out = await sealDataFile(Readable.from([data(9000)]), KEY, ID, path, FRAME);
    expect(await checkDataFile(path, KEY, ID, out)).toEqual({ plainBytes: 9000 });
    // Not the file that was written: a different size, then the same size with one byte changed.
    await expect(checkDataFile(path, KEY, ID, { ...out, bytes: out.bytes + 1 })).rejects.toThrow(/not the .* written/);
    await expect(checkDataFile(path, KEY, ID, { ...out, sha256: "0".repeat(64) })).rejects.toThrow(/does not match the hash/);
    const raw = await readFile(path);
    raw[raw.length - 20] ^= 0xff;
    await writeFile(path, raw);
    const damaged = { bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
    await expect(checkDataFile(path, KEY, ID, damaged)).rejects.toBeInstanceOf(Error);
    // The right bytes but the wrong key never opens.
    const fresh = join(dir, "d.flagship-data");
    const o2 = await sealDataFile(Readable.from([data(100)]), KEY, ID, fresh, FRAME);
    await expect(checkDataFile(fresh, Buffer.alloc(32, 9), ID, o2)).rejects.toBeInstanceOf(Error);
    // A backup of nothing is not a backup.
    const empty = join(dir, "e.flagship-data");
    const o3 = await sealDataFile(Readable.from([Buffer.alloc(0)]), KEY, ID, empty, FRAME);
    await expect(checkDataFile(empty, KEY, ID, o3)).rejects.toThrow(/opens to nothing/);
  });
});

describe("checking the small backup file that was just written", () => {
  const slot = () => wrapPasscodeSlot(ID, KEY, "correct horse battery staple", new Uint8Array(16), new Uint8Array(12), { m: 64, t: 1, p: 1 });
  const body = (over: Record<string, unknown> = {}) => ({
    createdAt: 1,
    server: { name: "home", domain: "home.alice.flagship.services", bootUnlockMode: "auto" as const, diskEncryption: "luks" as const },
    apps: [{ serviceId: "alice--wiki", name: "Wiki" }],
    left: [],
    includes: [],
    excludes: [],
    data: { fileName: "d.flagship-data", bytes: 100, sha256: "ab".repeat(32), frameBytes: FRAME },
    ...over,
  });
  const expected = { dataBytes: 100, dataSha256: "ab".repeat(32), apps: 1 };

  it("passes a good file and names what is wrong with a bad one", async () => {
    const path = join(dir, "b.flagship-backup");
    await writeBackupFile(path, { archiveId: ID, key: KEY, slots: [slot()], body: body(), nonce: Buffer.alloc(12, 1) });
    await expect(checkBackupFile(path, KEY, ID, expected)).resolves.toBeUndefined();

    await expect(checkBackupFile(path, Buffer.alloc(32, 8), ID, expected)).rejects.toThrow(/sealed part does not open/);
    await expect(checkBackupFile(path, KEY, "ff".repeat(16), expected)).rejects.toThrow(/another backup/);
    await expect(checkBackupFile(path, KEY, ID, { ...expected, dataBytes: 101 })).rejects.toThrow(/different data file/);
    await expect(checkBackupFile(path, KEY, ID, { ...expected, dataSha256: "cd".repeat(32) })).rejects.toThrow(/different data file/);
    await expect(checkBackupFile(path, KEY, ID, { ...expected, apps: 2 })).rejects.toThrow(/number of apps/);

    const text = await readFile(path, "utf8");
    await writeFile(path, text.slice(0, text.length - 40));
    await expect(checkBackupFile(path, KEY, ID, expected)).rejects.toThrow(/does not read back/);

    const slotless = join(dir, "n.flagship-backup");
    await writeFile(slotless, serializeBackupFile({ ...sealBackupFile(ID, KEY, [slot()], body(), Buffer.alloc(12, 1)), slots: [] }));
    await expect(checkBackupFile(slotless, KEY, ID, expected)).rejects.toThrow();
  });
});
