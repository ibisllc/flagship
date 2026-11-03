/**
 * Owner-authenticated journal read (diagnostics) — `flagship/journal-read/v2`.
 *
 *   flagship/journal-read/v2|<serverId>|<unit>|<lines>|<nonce>|<issuedAt>
 *
 * v2 (review 2026-10-25 #15) adds a single-use nonce (32 lowercase hex) to the
 * signed bytes, so the box can refuse a replay inside the 5-minute window. v1
 * (no nonce) is gone: no box takes it.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

/**
 * Owner-authenticated journal read (diagnostics). Deliberately NOT a
 * PhoneOrder — it mutates nothing — but it rides the SAME owner-IRK envelope
 * + replay-window security as `/api/power`: the daemon verifies the signature
 * against its config-pinned owner IRK and serves the systemd journal of
 * `unit` over the box's OWN pinned pipe. `.com` never sees the request or the
 * logs (the box terminates TLS; the request goes phone→box direct). The
 * daemon additionally clamps `unit` to an allowlist and `lines` to a max, so
 * a valid signature can only ever read a known unit's recent tail.
 */
export interface JournalRequest {
  serverId: ServerId;
  /** systemd unit to read; the daemon clamps this to an allowlist. */
  unit: string;
  /** trailing lines requested; the daemon clamps the max. */
  lines: number;
  /** Single use: 16 random bytes as 32 lowercase hex; the box keeps the ones it took. */
  nonce: string;
  issuedAt: number;
}

export const TAG_JOURNAL_READ = "flagship/journal-read/v2";
export const JOURNAL_NONCE_RE = /^[0-9a-f]{32}$/;

export function canonicalJournalRequest(r: JournalRequest): Bytes {
  legacyFieldGuard("serverId", r.serverId);
  legacyFieldGuard("unit", r.unit);
  if (typeof r.nonce !== "string" || !JOURNAL_NONCE_RE.test(r.nonce)) throw new Error("journal-read: nonce must be 32 lowercase hex");
  return new TextEncoder().encode(
    [TAG_JOURNAL_READ, r.serverId, r.unit, String(r.lines), r.nonce, String(r.issuedAt)].join("|"),
  );
}

export function signJournalRequest(r: JournalRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalJournalRequest(r), irk.privateKey);
}

export function verifyJournalRequest(r: JournalRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalJournalRequest(r), irkPub);
  } catch {
    return false;
  }
}
