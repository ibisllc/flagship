/**
 * The file a "Backup/clone server" makes: one JSON header line, then the tar
 * of the server (apps, databases, files folders, images) sealed in AES-256-GCM
 * frames.
 *
 *   {"magic":"flagship-archive","v":1,"archiveId":"<32 hex>",...}\n
 *   [u32 BE n][n bytes: ciphertext + 16-byte tag]  × frames
 *
 * Every frame is bound to the header (its SHA-256 is the AAD) and to its place
 * in the file (the nonce is the frame index), and the AAD carries a "last
 * frame" flag, so a reordered, edited, or truncated archive fails to open
 * instead of restoring half a server. The header is readable without the key
 * (the importing app needs `archiveId` to derive the key and shows the names);
 * it carries no secrets.
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ARCHIVE_MAGIC = "flagship-archive";
export const ARCHIVE_FRAME_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;

export interface ArchiveHeader {
  magic: typeof ARCHIVE_MAGIC;
  v: 1;
  /** 16 random bytes, hex: the public half of the key derivation. */
  archiveId: string;
  createdAt: number;
  /** The server it was made on (for the importer's "from ..." line). */
  sourceServer: string;
  frameBytes: number;
  apps: Array<{ serviceId: string; name: string }>;
}

export class ArchiveError extends Error {}

export function headerLine(h: ArchiveHeader): Buffer {
  return Buffer.from(`${JSON.stringify(h)}\n`, "utf8");
}

function nonceFor(index: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(index), 4);
  return n;
}

function aadFor(headerBytes: Buffer, last: boolean): Buffer {
  return Buffer.concat([createHash("sha256").update(headerBytes).digest(), Buffer.from([last ? 1 : 0])]);
}

function sealFrame(key: Buffer, headerBytes: Buffer, index: number, last: boolean, plain: Buffer): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonceFor(index));
  c.setAAD(aadFor(headerBytes, last));
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function openFrame(key: Buffer, headerBytes: Buffer, index: number, last: boolean, body: Buffer): Buffer {
  if (body.length < TAG_BYTES) throw new ArchiveError("the archive is damaged");
  const d = createDecipheriv("aes-256-gcm", key, nonceFor(index));
  d.setAAD(aadFor(headerBytes, last));
  d.setAuthTag(body.subarray(body.length - TAG_BYTES));
  try {
    return Buffer.concat([d.update(body.subarray(0, body.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new ArchiveError("the archive can't be opened: wrong key, or it was changed or cut short");
  }
}

/**
 * Seal `plain` (the tar stream) into `outPath`. Returns the file's size and
 * SHA-256 (the downloader checks it).
 */
export async function sealToFile(
  plain: Readable,
  key: Buffer,
  header: ArchiveHeader,
  outPath: string,
): Promise<{ bytes: number; sha256: string }> {
  if (key.length !== 32) throw new ArchiveError("the archive key must be 32 bytes");
  const hb = headerLine(header);
  const frameBytes = header.frameBytes;
  const hash = createHash("sha256");
  let bytes = 0;
  async function* frames(): AsyncGenerator<Buffer> {
    hash.update(hb);
    bytes += hb.length;
    yield hb;
    let pending: Buffer = Buffer.alloc(0);
    let held: Buffer | null = null;
    let index = 0;
    const emit = (plainFrame: Buffer, last: boolean): Buffer => {
      const out = sealFrame(key, hb, index++, last, plainFrame);
      hash.update(out);
      bytes += out.length;
      return out;
    };
    for await (const chunk of plain) {
      pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
      while (pending.length >= frameBytes) {
        // One frame is held back so the last one can be sealed as the last.
        if (held) yield emit(held, false);
        held = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
      }
    }
    if (pending.length > 0) {
      if (held) yield emit(held, false);
      held = pending;
    }
    yield emit(held ?? Buffer.alloc(0), true);
  }
  await pipeline(Readable.from(frames(), { objectMode: false }), createWriteStream(outPath, { mode: 0o600 }));
  return { bytes, sha256: hash.digest("hex") };
}

/** The header of an archive on disk, with the byte length of its line. */
export async function readHeader(path: string): Promise<{ header: ArchiveHeader; bytes: Buffer }> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_HEADER_BYTES, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (nl < 0) throw new ArchiveError("that isn't a Flagship archive");
    return parseHeader(buf.subarray(0, nl + 1));
  } finally {
    await fh.close();
  }
}

export function parseHeader(line: Buffer): { header: ArchiveHeader; bytes: Buffer } {
  let h: Partial<ArchiveHeader>;
  try {
    h = JSON.parse(line.toString("utf8")) as Partial<ArchiveHeader>;
  } catch {
    throw new ArchiveError("that isn't a Flagship archive");
  }
  if (h.magic !== ARCHIVE_MAGIC) throw new ArchiveError("that isn't a Flagship archive");
  if (h.v !== 1) throw new ArchiveError("this archive is from a newer version of Flagship");
  if (typeof h.archiveId !== "string" || !/^[0-9a-f]{32}$/.test(h.archiveId)) throw new ArchiveError("the archive header is damaged");
  if (!Number.isSafeInteger(h.frameBytes) || h.frameBytes! < 1024 || h.frameBytes! > 16 * 1024 * 1024) {
    throw new ArchiveError("the archive header is damaged");
  }
  return { header: h as ArchiveHeader, bytes: line };
}

/** Open `path` into its tar stream, verifying every frame (and that the last one is last). */
export function openToTar(path: string, key: Buffer): Readable {
  if (key.length !== 32) throw new ArchiveError("the archive key must be 32 bytes");
  async function* plain(): AsyncGenerator<Buffer> {
    const { header, bytes: hb } = await readHeader(path);
    const total = (await stat(path)).size;
    const fh = await open(path, "r");
    try {
      let pos = hb.length;
      let index = 0;
      const lenBuf = Buffer.alloc(4);
      for (;;) {
        if (pos + 4 > total) throw new ArchiveError("the archive was cut short");
        await fh.read(lenBuf, 0, 4, pos);
        const n = lenBuf.readUInt32BE(0);
        if (n < TAG_BYTES || n > header.frameBytes + TAG_BYTES) throw new ArchiveError("the archive is damaged");
        if (pos + 4 + n > total) throw new ArchiveError("the archive was cut short");
        const body = Buffer.alloc(n);
        await fh.read(body, 0, n, pos + 4);
        pos += 4 + n;
        const last = pos === total;
        yield openFrame(key, hb, index++, last, body);
        if (last) return;
      }
    } finally {
      await fh.close();
    }
  }
  return Readable.from(plain(), { objectMode: false });
}

/** Stream a sealed archive's bytes (for tests and local copies). */
export function rawStream(path: string): Readable {
  return createReadStream(path);
}
