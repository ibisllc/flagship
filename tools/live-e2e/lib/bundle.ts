// The one `.flagship` backup file (docs/server-backup-and-clone.md "The one
// file"): "FLGSHBK1", the metadata part's length L (u64 big-endian), the
// metadata part (the backup file JSON), then the data part.
import { assert } from "./harness.js";

export const BUNDLE_MAGIC = "FLGSHBK1";

export function splitBundle(buf: Buffer): { backupText: string; data: Buffer; dataOffset: number } {
  assert(buf.length >= 16 && buf.subarray(0, 8).toString("latin1") === BUNDLE_MAGIC, `not a .flagship file: ${buf.subarray(0, 8).toString("latin1")}`);
  const len = Number(buf.readBigUInt64BE(8));
  assert(len >= 1 && len <= 262_144 && 16 + len <= buf.length, `metadata length ${len}`);
  return { backupText: buf.subarray(16, 16 + len).toString("utf8"), data: buf.subarray(16 + len), dataOffset: 16 + len };
}
