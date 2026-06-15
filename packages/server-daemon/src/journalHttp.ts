import { execFile } from "node:child_process";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import { verifyJournalRequest, type JournalRequest } from "@flagship/protocol";

/**
 * Diagnostics surface — `POST /api/journal`. Rides the same daemon HTTP plane
 * as `/api/power` and verifies against the SAME box config-pinned owner IRK.
 * Body is an `{ request, signature }` envelope where `request` is a
 * `JournalRequest` `{ serverId, unit, lines, issuedAt }`. On a valid IRK
 * signature within the replay window it returns the trailing `lines` of the
 * unit's systemd journal as a JSON string array.
 *
 * Privacy: this is served by the daemon over the box's OWN pinned pipe
 * (phone→box direct). `.com` terminates no TLS for it and never sees the
 * logs. Two hard limits keep a valid owner request from over-reaching:
 *   - `unit` is clamped to an allowlist (the flagship units), so a signature
 *     can never be steered at an arbitrary unit's logs.
 *   - `lines` is clamped to `maxLines`.
 * `journalctl` is invoked via execFile (argv, no shell) — no shell-injection
 * surface — and the unit is allowlisted before exec regardless.
 *
 * Returns null for any other path so it falls through the handler chain.
 */
const H = { "content-type": "application/json" };

/** Reads trailing journal lines for a unit. Injectable so tests never shell out. */
export interface JournalReader {
  read(unit: string, lines: number): Promise<string[]>;
}

/**
 * Default reader: `journalctl -u <unit> -n <lines> --no-pager --output short-iso`.
 * The unit is allowlisted by the handler before this runs; execFile passes an
 * argv (no shell), so there is no injection surface even so.
 */
export class JournalctlReader implements JournalReader {
  read(unit: string, lines: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(
        "journalctl",
        ["-u", unit, "-n", String(lines), "--no-pager", "--output", "short-iso"],
        { maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(String(stdout).split("\n").filter((l) => l.length > 0));
        },
      );
    });
  }
}

export interface JournalHttpOptions {
  serverId: string;
  ownerIrkPub: Uint8Array;
  reader: JournalReader;
  /** Units the owner may read. Default: the flagship units. */
  allowedUnits?: string[];
  /** Max lines per request (clamp). Default 500. */
  maxLines?: number;
  now?: () => number;
  /** Replay window for `issuedAt`. Default 5 min — mirrors `/api/power`. */
  maxAgeMs?: number;
}

const DEFAULT_ALLOWED_UNITS = ["flagship-daemon", "flagship-data-services"];

export function buildJournalHttp(opts: JournalHttpOptions) {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const maxLines = opts.maxLines ?? 500;
  const allowed = opts.allowedUnits ?? DEFAULT_ALLOWED_UNITS;

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path !== "/api/journal") return null;
    if (req.method !== "POST") {
      return { status: 405, headers: H, body: JSON.stringify({ error: "method not allowed" }) };
    }
    let env: { request?: Record<string, unknown>; signature?: unknown };
    try {
      env = JSON.parse(req.body.toString("utf8"));
    } catch {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid json" }) };
    }
    const r = env.request;
    if (!r || typeof r !== "object" || typeof env.signature !== "string") {
      return { status: 400, headers: H, body: JSON.stringify({ error: "malformed body" }) };
    }
    if (typeof r.serverId !== "string" || r.serverId !== opts.serverId) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "serverId mismatch" }) };
    }
    if (typeof r.issuedAt !== "number") {
      return { status: 400, headers: H, body: JSON.stringify({ error: "issuedAt must be a number" }) };
    }
    if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "stale request" }) };
    }
    const parsed = parseJournalRequest(r);
    if (!parsed) {
      return { status: 400, headers: H, body: JSON.stringify({ error: "malformed journal request" }) };
    }
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid signature hex" }) };
    }
    // Verify the owner IRK signature BEFORE touching the journal or even
    // disclosing the allowlist verdict — `unit` is part of the signed bytes,
    // so only the owner can choose it.
    if (!verifyJournalRequest(parsed, sig, opts.ownerIrkPub)) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "invalid signature" }) };
    }
    if (!allowed.includes(parsed.unit)) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "unit not allowed" }) };
    }
    const lines = Math.max(1, Math.min(maxLines, Math.floor(parsed.lines)));
    let out: string[];
    try {
      out = await opts.reader.read(parsed.unit, lines);
    } catch {
      return { status: 500, headers: H, body: JSON.stringify({ error: "journal read failed" }) };
    }
    return { status: 200, headers: H, body: JSON.stringify({ ok: true, unit: parsed.unit, lines: out }) };
  };
}

function parseJournalRequest(r: Record<string, unknown>): JournalRequest | null {
  if (
    typeof r.serverId !== "string" ||
    typeof r.unit !== "string" ||
    typeof r.lines !== "number" ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return { serverId: r.serverId, unit: r.unit, lines: r.lines, issuedAt: r.issuedAt };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
