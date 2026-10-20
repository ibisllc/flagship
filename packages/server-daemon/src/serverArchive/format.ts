/**
 * The two files a "Backup/clone server" makes (docs/server-backup-and-clone.md):
 *
 *   the data file   "flagship-backup-data/v2\n", then the tar of the apps sealed
 *                   in AES-256-GCM frames: [u32 BE n][n bytes: ciphertext + tag]
 *   the backup file small JSON (@flagship/protocol serverBackup.ts): the key
 *                   slots, and sealed under the content key the server's
 *                   settings, the apps, and the data file's size and SHA-256
 *
 * Every frame is bound to the backup (its id is in the AAD) and to its place
 * (the nonce is the frame index), and the AAD says whether it is the last
 * frame, so a reordered, edited, or cut-short data file fails to open instead
 * of restoring half a server. The box never reads the slots: the owner's app
 * hands it the content key to seal, and again to open.
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BACKUP_DATA_MAGIC,
  BACKUP_FRAME_BYTES,
  backupFrameAad,
  backupFrameNonce,
  sealBackupFile,
  serializeBackupFile,
  type BackupBody,
  type BackupSlot,
} from "@flagship/protocol";

export const ARCHIVE_FRAME_BYTES = BACKUP_FRAME_BYTES;
const TAG_BYTES = 16;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAGIC = Buffer.from(BACKUP_DATA_MAGIC, "utf8");

export class ArchiveError extends Error {}

function sealFrame(key: Buffer, archiveId: string, index: number, last: boolean, plain: Buffer): Buffer {
  const c = createCipheriv("aes-256-gcm", key, backupFrameNonce(index));
  c.setAAD(backupFrameAad(archiveId, last));
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function openFrame(key: Buffer, archiveId: string, index: number, last: boolean, body: Buffer): Buffer {
  if (body.length < TAG_BYTES) throw new ArchiveError("the backup's data file is damaged");
  const d = createDecipheriv("aes-256-gcm", key, backupFrameNonce(index));
  d.setAAD(backupFrameAad(archiveId, last));
  d.setAuthTag(body.subarray(body.length - TAG_BYTES));
  try {
    return Buffer.concat([d.update(body.subarray(0, body.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new ArchiveError("the backup's data file can't be opened: wrong key, or it was changed or cut short");
  }
}

/**
 * Seal `plain` (the tar stream) into the data file at `outPath`. Returns its
 * size and SHA-256 (they go into the backup file and the restore order).
 */
export async function sealDataFile(
  plain: Readable,
  key: Buffer,
  archiveId: string,
  outPath: string,
  frameBytes: number = ARCHIVE_FRAME_BYTES,
): Promise<{ bytes: number; sha256: string }> {
  if (key.length !== 32) throw new ArchiveError("the backup key must be 32 bytes");
  if (frameBytes < 1024 || frameBytes > MAX_FRAME_BYTES) throw new ArchiveError("bad frame size");
  const hash = createHash("sha256");
  let bytes = 0;
  async function* frames(): AsyncGenerator<Buffer> {
    hash.update(MAGIC);
    bytes += MAGIC.length;
    yield MAGIC;
    let pending: Buffer = Buffer.alloc(0);
    let held: Buffer | null = null;
    let index = 0;
    const emit = (plainFrame: Buffer, last: boolean): Buffer => {
      const out = sealFrame(key, archiveId, index++, last, plainFrame);
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

/** Open a data file into its tar stream, verifying every frame (and that the last one is last). */
export function openDataFile(path: string, key: Buffer, archiveId: string): Readable {
  if (key.length !== 32) throw new ArchiveError("the backup key must be 32 bytes");
  async function* plain(): AsyncGenerator<Buffer> {
    const total = (await stat(path)).size;
    const fh = await open(path, "r");
    try {
      const head = Buffer.alloc(MAGIC.length);
      await fh.read(head, 0, MAGIC.length, 0);
      if (!head.equals(MAGIC)) throw new ArchiveError("that isn't a Flagship backup's data file");
      let pos = MAGIC.length;
      let index = 0;
      const lenBuf = Buffer.alloc(4);
      for (;;) {
        if (pos + 4 > total) throw new ArchiveError("the backup's data file was cut short");
        await fh.read(lenBuf, 0, 4, pos);
        const n = lenBuf.readUInt32BE(0);
        if (n < TAG_BYTES || n > MAX_FRAME_BYTES + TAG_BYTES) throw new ArchiveError("the backup's data file is damaged");
        if (pos + 4 + n > total) throw new ArchiveError("the backup's data file was cut short");
        const body = Buffer.alloc(n);
        await fh.read(body, 0, n, pos + 4);
        pos += 4 + n;
        const last = pos === total;
        yield openFrame(key, archiveId, index++, last, body);
        if (last) return;
      }
    } finally {
      await fh.close();
    }
  }
  return Readable.from(plain(), { objectMode: false });
}

/** Write the backup file: the slots the owner's app made, and the body sealed under the content key. */
export async function writeBackupFile(
  path: string,
  a: { archiveId: string; key: Buffer; slots: BackupSlot[]; body: BackupBody; nonce: Buffer },
): Promise<{ bytes: number; text: string }> {
  const text = serializeBackupFile(sealBackupFile(a.archiveId, a.key, a.slots, a.body, a.nonce));
  await writeFile(path, text, { mode: 0o600 });
  return { bytes: Buffer.byteLength(text), text };
}

/**
 * Read a data file back the way a restore will: its size and SHA-256 are the ones just written,
 * and every frame opens (right key, right place, last frame last). The plain bytes are counted
 * and thrown away, so it needs no disk. A backup that fails this is not "saved".
 */
export async function checkDataFile(
  path: string,
  key: Buffer,
  archiveId: string,
  expected: { bytes: number; sha256: string },
): Promise<{ plainBytes: number }> {
  const size = (await stat(path)).size;
  if (size !== expected.bytes) throw new ArchiveError(`the data file is ${size} bytes, not the ${expected.bytes} written`);
  const hash = createHash("sha256");
  for await (const chunk of (await import("node:fs")).createReadStream(path)) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== expected.sha256) throw new ArchiveError("the data file does not match the hash written for it");
  let plainBytes = 0;
  for await (const chunk of openDataFile(path, key, archiveId)) plainBytes += (chunk as Buffer).length;
  if (plainBytes === 0) throw new ArchiveError("the data file opens to nothing");
  return { plainBytes };
}
