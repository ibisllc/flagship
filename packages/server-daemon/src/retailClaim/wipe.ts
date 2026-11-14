// The retail wipe (docs/retail-box-setup.md §8.2, §15): crypto-erase the owner's LUKS volume once
// the reset marker is on disk (resetPolicy.ts), then check nothing of the header is left. A box
// whose wipe fails keeps the marker and stays locked: it serves nothing until a fresh reset.
//
// The image says what to erase in its marker file. Only a retail image has one; a VM appliance or
// a USB install never does, so none of this runs there.
//
// Not built yet: putting the factory image back from a recovery partition, because no retail
// partition layout exists (docs/retail-box-setup.md §13.3 item 10). Until it does, the erase makes
// the old owner's data unreadable from the next boot, and the OS stays as it is.

import { open, readFile } from "node:fs/promises";
import { randomFillSync } from "node:crypto";
import { verifyWipe, WIPE_READ_BYTES } from "./wipeVerifier.js";

export const RETAIL_IMAGE_MARKER = "/etc/flagship/retail-image.json";

export interface RetailImage {
  v: 1;
  /** The LUKS device that holds everything an owner put on the box. */
  dataLuksDevice: string | null;
  /** The factory image's partition, once the layout defines one. */
  recoveryPartition: string | null;
}

const DEVICE = /^\/dev\/(?:disk\/by-(?:partlabel|partuuid|uuid|id)\/[A-Za-z0-9._:-]{1,128}|[a-z][a-z0-9]{1,31})$/;

/**
 * The retail image's marker, or null on any other box. A damaged marker still means a retail box,
 * with nothing it may erase: a reset then stops at the lock instead of guessing a device.
 */
export async function readRetailImage(path = RETAIL_IMAGE_MARKER, read: (p: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<RetailImage | null> {
  let text: string;
  try {
    text = await read(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { v: 1, dataLuksDevice: null, recoveryPartition: null };
  }
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const dev = (v: unknown) => (typeof v === "string" && DEVICE.test(v) ? v : null);
    if (o.v !== 1) throw new Error("version");
    return { v: 1, dataLuksDevice: dev(o.dataLuksDevice), recoveryPartition: dev(o.recoveryPartition) };
  } catch {
    return { v: 1, dataLuksDevice: null, recoveryPartition: null };
  }
}

const LUKS2_DEFAULT_HEADER = 16 * 1024 * 1024;
const LUKS2_SECONDARY_AT = 16 * 1024;

/** Bytes of LUKS header and key material before the data, from `cryptsetup luksDump`. */
export function luksHeaderBytes(dump: string): number {
  const v2 = /Data segments:[\s\S]*?offset:\s*(\d+)\s*\[bytes\]/.exec(dump);
  if (v2) return Math.max(Number(v2[1]), LUKS2_SECONDARY_AT + WIPE_READ_BYTES);
  const v1 = /Payload offset:\s*(\d+)/.exec(dump);
  if (v1) return Math.max(Number(v1[1]) * 512, WIPE_READ_BYTES);
  return LUKS2_DEFAULT_HEADER;
}

export interface BlockIo {
  readAt(device: string, offset: number, length: number): Promise<Uint8Array>;
  /** Overwrites [0, length) with random bytes and fsyncs. */
  overwriteHead(device: string, length: number): Promise<void>;
}

export const nodeBlockIo: BlockIo = {
  async readAt(device, offset, length) {
    const h = await open(device, "r");
    try {
      const b = Buffer.alloc(length);
      const { bytesRead } = await h.read(b, 0, length, offset);
      return b.subarray(0, bytesRead);
    } finally {
      await h.close();
    }
  },
  async overwriteHead(device, length) {
    const h = await open(device, "r+");
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let off = 0; off < length; off += chunk.length) {
        const n = Math.min(chunk.length, length - off);
        randomFillSync(chunk, 0, n);
        await h.write(chunk, 0, n, off);
      }
      await h.sync();
    } finally {
      await h.close();
    }
  },
};

export type Run = (cmd: string, args: string[]) => Promise<string>;

/**
 * Destroys every key slot (`cryptsetup erase`), overwrites the whole header area with random
 * bytes, and reads it back. The open mapping keeps working from memory until the box restarts;
 * after that nothing opens the volume again.
 */
export async function cryptoEraseLuks(device: string, run: Run, io: BlockIo, log: (m: string) => void = () => {}): Promise<{ headerBytes: number }> {
  if (!DEVICE.test(device)) throw new Error("not a device this box erases");
  let dump = "";
  try {
    dump = await run("cryptsetup", ["luksDump", device]);
  } catch (e) {
    log(`[retail] luksDump failed (${(e as Error).message}); erasing the default LUKS2 header size`);
  }
  const headerBytes = luksHeaderBytes(dump);
  await run("cryptsetup", ["erase", "--batch-mode", device]).catch((e) => log(`[retail] cryptsetup erase: ${(e as Error).message}; overwriting the header anyway`));
  await io.overwriteHead(device, headerBytes);
  for (const at of [0, LUKS2_SECONDARY_AT]) {
    if (at + WIPE_READ_BYTES > headerBytes) continue;
    const v = verifyWipe(await io.readAt(device, at, WIPE_READ_BYTES));
    if (!v.ok) throw new Error(`the wipe check failed at ${at}: ${v.reason}`);
  }
  log(`[retail] crypto-erased ${device} (${headerBytes} header bytes)`);
  return { headerBytes };
}

export interface RetailWipeResult {
  erased: boolean;
  reimaged: boolean;
}

/**
 * The root step (setup.ts `retail-wipe`). It runs only on a retail image and only while the reset
 * marker is on disk, so the marker always goes down before the erase, whoever asks.
 */
export async function retailWipeAsRoot(d: {
  image: RetailImage | null;
  markerPresent: boolean;
  run: Run;
  io?: BlockIo;
  log?: (m: string) => void;
}): Promise<RetailWipeResult> {
  const log = d.log ?? (() => {});
  if (!d.image) throw new Error("not a retail image");
  if (!d.markerPresent) throw new Error("no reset marker: a wipe starts only after it is written");
  if (!d.image.dataLuksDevice) throw new Error("the retail image names no data volume");
  await cryptoEraseLuks(d.image.dataLuksDevice, d.run, d.io ?? nodeBlockIo, log);
  if (d.image.recoveryPartition) log("[retail] reimaging from the recovery partition is not built; the OS stays as it is");
  return { erased: true, reimaged: false };
}
