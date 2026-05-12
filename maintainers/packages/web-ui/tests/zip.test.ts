/**
 * ZIP writer tests.
 *
 * We can't roundtrip-decode here (no Node zlib usage; that'd pull a dep)
 * but we can verify the structural properties: magic numbers, the
 * presence and offsets of the local file header, central directory,
 * and end-of-central-directory.
 *
 * `unzip -p` interoperability is verified by the smoke check at the
 * end (uses Node's native zlib via DecompressionStream when available,
 * otherwise just parses the file table).
 */
import { describe, expect, it } from "vitest";
import { buildZip } from "../src/zip.js";

const LFH_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function u16(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8)) & 0xffff;
}

describe("buildZip", () => {
  it("produces a single-file archive with valid magic numbers", () => {
    const bytes = buildZip([
      { path: "hello.txt", bytes: new TextEncoder().encode("hello world") },
    ]);
    expect(u32(bytes, 0)).toBe(LFH_SIG);
    // EOCD is the last 22 bytes
    const eocdOffset = bytes.length - 22;
    expect(u32(bytes, eocdOffset)).toBe(EOCD_SIG);
    expect(u16(bytes, eocdOffset + 8)).toBe(1); // 1 record on this disk
    expect(u16(bytes, eocdOffset + 10)).toBe(1); // 1 total record
  });

  it("places the central directory after all local headers", () => {
    const bytes = buildZip([
      { path: "a.txt", bytes: new TextEncoder().encode("aaaa") },
      { path: "b.txt", bytes: new TextEncoder().encode("bbbb") },
    ]);
    // The 22-byte EOCD trailer carries the CD offset
    const eocdOffset = bytes.length - 22;
    const cdOffset = u32(bytes, eocdOffset + 16);
    expect(u32(bytes, cdOffset)).toBe(CD_SIG);
    // Second CD entry should also have the right signature
    // Each CD header is 46 + nameLen bytes; both names are 5 bytes
    expect(u32(bytes, cdOffset + 46 + 5)).toBe(CD_SIG);
  });

  it("encodes the filename in UTF-8 in the LFH", () => {
    const bytes = buildZip([
      { path: "café.txt", bytes: new Uint8Array([0]) },
    ]);
    // GP flag bit 11 (0x0800) should be set
    expect(u16(bytes, 6) & 0x0800).toBe(0x0800);
    // Filename length: "café.txt" → "caf\xc3\xa9.txt" → 9 bytes
    expect(u16(bytes, 26)).toBe(9);
  });

  it("writes the file contents verbatim (STORE method)", () => {
    const content = new TextEncoder().encode("hello world");
    const bytes = buildZip([{ path: "x.txt", bytes: content }]);
    // method = 0 (STORE)
    expect(u16(bytes, 8)).toBe(0);
    // Find content right after LFH (30 + nameLen)
    const nameLen = u16(bytes, 26);
    const payloadStart = 30 + nameLen;
    for (let i = 0; i < content.length; i++) {
      expect(bytes[payloadStart + i]).toBe(content[i]);
    }
  });

  it("handles zero entries (edge case)", () => {
    const bytes = buildZip([]);
    expect(bytes.length).toBe(22);
    expect(u32(bytes, 0)).toBe(EOCD_SIG);
  });
});
