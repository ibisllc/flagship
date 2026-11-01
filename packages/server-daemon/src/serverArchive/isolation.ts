/**
 * Where this box's backup, restore and copy effects ran since the daemon started (plan G6/R6):
 * the keys in flagship-keyd or here, an app's files folder read and written by the broker or by
 * this process, and archives checked by the Rust checker or its TS twin. Counts only, no names or
 * keys; shown to the owner on the backups and restore views and read by the gym.
 */
import { tarCheckStats } from "./tarCheck.js";

export const archiveIsolationStats = {
  /** Archives whose content key went to keyd (made, imported). */
  keydArchives: 0,
  /** Frames keyd sealed or opened. */
  keydFrames: 0,
  /** keyd refusals (a wrong key, a frame out of order). */
  keydRefusals: 0,
  /** App files folders dumped, restored or measured through the broker's `appdata.files`. */
  brokerFiles: 0,
  /** Of which the broker refused (its own archive check, or its policy). */
  brokerRefusals: 0,
};

export interface IsolationView {
  keys: "keyd" | "daemon";
  files: "broker" | "daemon";
  extraction: "rust" | "ts";
  counts: typeof archiveIsolationStats & { tarChecksRust: number; tarChecksTs: number; archivesRefused: number };
  lastRefusal: { code: string; checker: "rust" | "ts"; at: number } | null;
}

export function isolationView(keys: "keyd" | "daemon", files: "broker" | "daemon", extraction: "rust" | "ts"): IsolationView {
  return {
    keys,
    files,
    extraction,
    counts: { ...archiveIsolationStats, tarChecksRust: tarCheckStats.rust, tarChecksTs: tarCheckStats.ts, archivesRefused: tarCheckStats.refused },
    lastRefusal: tarCheckStats.lastRefusal,
  };
}
