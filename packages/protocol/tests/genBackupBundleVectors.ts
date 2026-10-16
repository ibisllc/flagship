// Regenerates test-vectors/server-backup-bundle/vectors.json:
//   npx tsx packages/protocol/tests/genBackupBundleVectors.ts
// Every input is fixed, so the output is byte-stable.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupBundleHeader } from "../src/serverBackup.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const meta = new TextEncoder().encode('{"magic":"flagship-backup","v":2}');
const data = new TextEncoder().encode("flagship-backup-data/v2\n\u0000\u0001\u0002");
const bundle = new Uint8Array([...backupBundleHeader(meta.length), ...meta, ...data]);
const out = {
  about:
    "The one-file backup (docs/server-backup-and-clone.md, 'The one file'): 8 bytes 'FLGSHBK1', the metadata part's length L as a u64 big-endian, the metadata part (the backup file), then the data part (the data file) to EOF. L is 1..262144.",
  headers: [1, 33, 4096, 262144].map((metaLength) => ({ metaLength, headerHex: hex(backupBundleHeader(metaLength)) })),
  example: { metaHex: hex(meta), dataHex: hex(data), bundleHex: hex(bundle), metaLength: meta.length, dataOffset: 16 + meta.length },
  invalid: [
    { why: "not a Flagship backup", headHex: hex(new TextEncoder().encode("FLGSHBK2")) + "0000000000000021", fileBytes: 100 },
    { why: "zero-length metadata", headHex: hex(new TextEncoder().encode("FLGSHBK1")) + "0000000000000000", fileBytes: 100 },
    { why: "metadata longer than the limit", headHex: hex(new TextEncoder().encode("FLGSHBK1")) + "0000000000040001", fileBytes: 1e6 },
    { why: "cut short before the data", headHex: hex(new TextEncoder().encode("FLGSHBK1")) + "0000000000000021", fileBytes: 49 },
    { why: "shorter than a header", headHex: hex(new TextEncoder().encode("FLGSHBK1")), fileBytes: 8 },
  ],
};
const path = join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/server-backup-bundle/vectors.json");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
