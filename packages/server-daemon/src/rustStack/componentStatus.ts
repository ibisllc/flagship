/**
 * Which implementation each Rust-path component is running (`/run/flagship-rust/<component>.status`,
 * written by flagship-rust-select, rustStack/units.ts), as `GET /api/stack` shows it to the owner's
 * sessions and the live gym asserts it (docs/architecture-v2/rust-consolidation.md row 1: "a gym check
 * that asserts which keyd served"). Only the selector's own fields pass; anything malformed reads as
 * null. Never throws.
 */
import { readFile } from "node:fs/promises";
import { RUST_COMPONENTS, RUST_RUN_DIR, type RustComponent } from "./units.js";

export interface RustComponentStatus {
  component: RustComponent;
  choice: "rust" | "ts";
  /** pinned | running | not-ready | switched-off | no-binary | unpinned | hash-mismatch | failed-to-start */
  reason: string;
  /** SHA-256 of the Rust binary the selector found ("" when none). */
  sha256: string;
  /** SHA-256 the release's signed PINS.json names ("" when none). */
  pinned: string;
  /** The box's Rust switch ("on" | "off"). */
  switch: "on" | "off";
  /** Unix seconds of the selector's decision. */
  at: number;
}

export type RustComponentStatuses = Record<RustComponent, RustComponentStatus | null>;

const SHA = /^(|[0-9a-f]{64})$/;
const REASON = /^[a-z-]{1,32}$/;

export function parseRustComponentStatus(component: RustComponent, text: string | null | undefined): RustComponentStatus | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 4096) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.component !== component) return null;
  if (r.choice !== "rust" && r.choice !== "ts") return null;
  if (typeof r.reason !== "string" || !REASON.test(r.reason)) return null;
  if (typeof r.sha256 !== "string" || !SHA.test(r.sha256)) return null;
  if (typeof r.pinned !== "string" || !SHA.test(r.pinned)) return null;
  if (r.switch !== "on" && r.switch !== "off") return null;
  if (typeof r.at !== "number" || !Number.isSafeInteger(r.at) || r.at < 0) return null;
  return { component, choice: r.choice, reason: r.reason, sha256: r.sha256, pinned: r.pinned, switch: r.switch, at: r.at };
}

/** Reads every component's status file; a missing or unreadable one is null. */
export async function readRustComponentStatuses(
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
  runDir: string = RUST_RUN_DIR,
): Promise<RustComponentStatuses> {
  const out = {} as RustComponentStatuses;
  for (const c of RUST_COMPONENTS) {
    let text: string | null = null;
    try {
      text = await read(`${runDir}/${c}.status`);
    } catch {
      text = null;
    }
    out[c] = parseRustComponentStatus(c, text);
  }
  return out;
}
