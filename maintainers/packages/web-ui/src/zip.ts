/**
 * Minimal STORE-only ZIP writer.
 *
 * We use this for the static-adapter "download as ZIP" fallback. The
 * archive carries `.maintainers/`-relative paths so the user can
 * unzip-and-commit. STORE (no compression) is acceptable because
 * `.maintainers/` is text JSON measured in kilobytes; we'd rather have
 * zero deps than save 80% on 5 KB.
 *
 * Reference: PKZIP APPNOTE 6.3.x sections 4.3.6 - 4.3.16.
 */

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  /** UTC date. Defaults to now. */
  modifiedAt?: Date;
}

/**
 * Build a single ZIP file containing the given entries.
 *
 * Encodes paths as UTF-8 with the language-encoding (UTF-8) flag set
 * (bit 11 of the general-purpose bit flag) so unzip tools render
 * non-ASCII names correctly.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const centralDirectoryEntries: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.path);
    const data = entry.bytes;
    const crc = crc32(data);
    const { dosDate, dosTime } = dosDateTime(entry.modifiedAt ?? new Date());

    // Local file header
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lfhView = new DataView(lfh.buffer);
    lfhView.setUint32(0, 0x04034b50, true);   // signature
    lfhView.setUint16(4, 20, true);            // version needed
    lfhView.setUint16(6, 0x0800, true);        // GP flag: bit 11 (UTF-8)
    lfhView.setUint16(8, 0, true);             // method: STORE
    lfhView.setUint16(10, dosTime, true);
    lfhView.setUint16(12, dosDate, true);
    lfhView.setUint32(14, crc, true);
    lfhView.setUint32(18, data.length, true);
    lfhView.setUint32(22, data.length, true);
    lfhView.setUint16(26, nameBytes.length, true);
    lfhView.setUint16(28, 0, true);            // extra-field length
    lfh.set(nameBytes, 30);
    parts.push(lfh);
    parts.push(data);

    // Central-directory header for this entry
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cdhView = new DataView(cdh.buffer);
    cdhView.setUint32(0, 0x02014b50, true);   // signature
    cdhView.setUint16(4, 20, true);            // version made by
    cdhView.setUint16(6, 20, true);            // version needed
    cdhView.setUint16(8, 0x0800, true);        // GP flag
    cdhView.setUint16(10, 0, true);            // method: STORE
    cdhView.setUint16(12, dosTime, true);
    cdhView.setUint16(14, dosDate, true);
    cdhView.setUint32(16, crc, true);
    cdhView.setUint32(20, data.length, true);
    cdhView.setUint32(24, data.length, true);
    cdhView.setUint16(28, nameBytes.length, true);
    cdhView.setUint16(30, 0, true);            // extra-field length
    cdhView.setUint16(32, 0, true);            // comment length
    cdhView.setUint16(34, 0, true);            // disk number start
    cdhView.setUint16(36, 0, true);            // internal attributes
    cdhView.setUint32(38, 0, true);            // external attributes
    cdhView.setUint32(42, offset, true);       // local header offset
    cdh.set(nameBytes, 46);
    centralDirectoryEntries.push(cdh);

    offset += lfh.length + data.length;
  }

  const centralDirectoryStart = offset;
  let centralDirectorySize = 0;
  for (const cdh of centralDirectoryEntries) {
    parts.push(cdh);
    centralDirectorySize += cdh.length;
  }

  // End-of-central-directory
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);     // signature
  eocdView.setUint16(4, 0, true);              // disk number
  eocdView.setUint16(6, 0, true);              // disk with CD
  eocdView.setUint16(8, entries.length, true); // CD records on this disk
  eocdView.setUint16(10, entries.length, true); // total CD records
  eocdView.setUint32(12, centralDirectorySize, true);
  eocdView.setUint32(16, centralDirectoryStart, true);
  eocdView.setUint16(20, 0, true);             // comment length
  parts.push(eocd);

  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * CRC-32 (IEEE 802.3 / zlib polynomial). Table-driven; we build the
 * table lazily on first call.
 */
let CRC_TABLE: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const idx = (crc ^ data[i]!) & 0xff;
    crc = (CRC_TABLE[idx]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { dosDate: number; dosTime: number } {
  const y = d.getUTCFullYear();
  const dosDate =
    ((Math.max(y - 1980, 0) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0x0f) << 5) | (d.getUTCDate() & 0x1f);
  const dosTime =
    ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | ((d.getUTCSeconds() >>> 1) & 0x1f);
  return { dosDate, dosTime };
}
