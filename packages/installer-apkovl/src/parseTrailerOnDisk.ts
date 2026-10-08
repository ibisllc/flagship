import { parseTrailer } from "@flagship/iso-personalizer";
import type { ParsedTrailer } from "@flagship/iso-personalizer";

/**
 * Same trailer-reading logic the installer's flagship-trailer-validate
 * shell helper does, but as pure TS. Used by tests to simulate what
 * happens at boot without a real block device, and by future tooling
 * that wants to inspect a personalized ISO server-side.
 *
 * Reads only the last 64 KiB (the cap on trailer size) so it works on
 * arbitrarily large block devices/files.
 */
export interface ReadHandle {
  size(): number | Promise<number>;
  /** Read `length` bytes starting at `offset` into a fresh Uint8Array. */
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}

const MAX_TRAILER_LOOKBACK = 64 * 1024;

export async function parseTrailerFromHandle(
  handle: ReadHandle,
): Promise<ParsedTrailer | null> {
  const size = await handle.size();
  const lookback = Math.min(MAX_TRAILER_LOOKBACK, size);
  if (lookback < 100) return null;
  const tail = await handle.read(size - lookback, lookback);
  return parseTrailer(tail);
}

/**
 * Bytes-backed handle, mostly for tests.
 */
export function bytesHandle(buf: Uint8Array): ReadHandle {
  return {
    size: () => buf.length,
    read: (offset, length) => buf.subarray(offset, offset + length).slice(),
  };
}
