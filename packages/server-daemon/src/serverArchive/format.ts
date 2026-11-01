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
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BACKUP_DATA_MAGIC,
  BACKUP_FRAME_BYTES,
  BACKUP_MAGIC,
  BACKUP_VERSION,
  parseBackupBody,
  parseBackupFile,
  serializeBackupFile,
  type BackupBody,
  type BackupSlot,
} from "@flagship/protocol";
import { localCipher, type ArchiveCipher } from "./archiveKeys.js";

export const ARCHIVE_FRAME_BYTES = BACKUP_FRAME_BYTES;
const TAG_BYTES = 16;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAGIC = Buffer.from(BACKUP_DATA_MAGIC, "utf8");

export class ArchiveError extends Error {}

/** The archive's key: raw bytes held here, or a cipher whose key may live in flagship-keyd. */
export type ArchiveKey = Buffer | ArchiveCipher;

function cipherOf(key: ArchiveKey, archiveId: string): ArchiveCipher {
  if (!Buffer.isBuffer(key)) {
    if (key.archiveId !== archiveId) throw new ArchiveError("that key is for another backup");
    return key;
  }
  if (key.length !== 32) throw new ArchiveError("the backup key must be 32 bytes");
  // The caller keeps (and zeroes) its buffer; this cipher only borrows it.
  return localCipher(key, archiveId);
}

/**
 * Seal `plain` (the tar stream) into the data file at `outPath`. Returns its
 * size and SHA-256 (they go into the backup file and the restore order).
 */
export async function sealDataFile(
  plain: Readable,
  key: ArchiveKey,
  archiveId: string,
  outPath: string,
  frameBytes: number = ARCHIVE_FRAME_BYTES,
): Promise<{ bytes: number; sha256: string }> {
  const cipher = cipherOf(key, archiveId);
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
    const emit = async (plainFrame: Buffer, last: boolean): Promise<Buffer> => {
      const body = await cipher.sealFrame(index++, last, plainFrame);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      const out = Buffer.concat([len, body]);
      hash.update(out);
      bytes += out.length;
      return out;
    };
    for await (const chunk of plain) {
      pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
      while (pending.length >= frameBytes) {
        // One frame is held back so the last one can be sealed as the last.
        if (held) yield await emit(held, false);
        held = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
      }
    }
    if (pending.length > 0) {
      if (held) yield await emit(held, false);
      held = pending;
    }
    yield await emit(held ?? Buffer.alloc(0), true);
  }
  await pipeline(Readable.from(frames(), { objectMode: false }), createWriteStream(outPath, { mode: 0o600 }));
  return { bytes, sha256: hash.digest("hex") };
}

/** Open a data file into its tar stream, verifying every frame (and that the last one is last). */
export function openDataFile(path: string, key: ArchiveKey, archiveId: string): Readable {
  const cipher = cipherOf(key, archiveId);
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
        if (body.length < TAG_BYTES) throw new ArchiveError("the backup's data file is damaged");
        yield await cipher.openFrame(index++, last, body);
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
  a: { archiveId: string; key: ArchiveKey; slots: BackupSlot[]; body: BackupBody },
): Promise<{ bytes: number; text: string }> {
  const { nonce, sealed } = await cipherOf(a.key, a.archiveId).sealBody(Buffer.from(JSON.stringify(a.body), "utf8"));
  const text = serializeBackupFile({ magic: BACKUP_MAGIC, v: BACKUP_VERSION, archiveId: a.archiveId, slots: a.slots, bodyNonceHex: nonce.toString("hex"), bodyHex: sealed.toString("hex") });
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
  key: ArchiveKey,
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

/**
 * Read the small backup file back from disk the way a restore will: it parses, it carries at
 * least one key slot, and its sealed body opens under the content key and names the data file
 * just made (size, SHA-256) and the apps just put in it. The slots themselves are made by the
 * owner's app from secrets this server never holds (a passcode, the account key), so whether a
 * slot opens is checked on the phone that made it, not here.
 */
export async function checkBackupFile(
  path: string,
  key: ArchiveKey,
  archiveId: string,
  expected: { dataBytes: number; dataSha256: string; apps: number },
): Promise<void> {
  let file;
  try {
    file = parseBackupFile(await readFile(path, "utf8"));
  } catch {
    throw new ArchiveError("the backup file does not read back");
  }
  if (file.archiveId !== archiveId) throw new ArchiveError("the backup file names another backup");
  if (file.slots.length === 0) throw new ArchiveError("the backup file has no key slot");
  let body: BackupBody | null;
  try {
    const plain = await cipherOf(key, archiveId).openBody(Buffer.from(file.bodyNonceHex, "hex"), Buffer.from(file.bodyHex, "hex"));
    body = parseBackupBody(plain.toString("utf8"));
  } catch {
    throw new ArchiveError("the backup file's sealed part does not open with the backup's key");
  }
  if (!body) throw new ArchiveError("the backup file's sealed part does not open with the backup's key");
  if (body.data.bytes !== expected.dataBytes || body.data.sha256 !== expected.dataSha256) {
    throw new ArchiveError("the backup file describes a different data file than the one written");
  }
  if (body.apps.length !== expected.apps) throw new ArchiveError("the backup file lists a different number of apps than the data file holds");
}
