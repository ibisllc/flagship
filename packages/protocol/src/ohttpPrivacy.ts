// Where private requests go, and what happens when our relay fails
// (docs/outbound-proxy.md "Failure handling", docs/payments-privacy-and-rails.md
// §5.4). Shared by `.com` (the config it serves), the box, the webapp, iOS and
// Android; `test-vectors/ohttp/spend-route.json` pins every rule.
//
// Owner rule (2026-11-17): if infrastructure we provide fails, everything keeps
// working. A relay outage never breaks a payment or a box: a spend waits and
// retries, and goes direct (marked) rather than let a plan lapse.

import { parseOhttpKeyConfig, type OhttpKeyConfig } from "./ohttp.js";

/** One relay the apps and boxes may use, in the order `.com` lists them. */
export interface OhttpRelayEntry {
  url: string;
  /** Who runs it, shown to the owner ("Flagship (interim)", a provider's name). */
  operator: string;
  /** Run by Flagship until a third-party contract exists: hides the address from `.com`'s logs, no non-collusion. */
  interim: boolean;
}

/** `GET /api/ohttp/config` (also `ohttp` in `GET /api/payments/config`). */
export interface OhttpPublicConfig {
  v: 1;
  /** The gateway's current key configuration (RFC 9458 §3), hex; null until the gateway has a key. */
  keyConfigHex: string | null;
  relays: OhttpRelayEntry[];
}

/**
 * Hosts a relay may never be on: Cloudflare's own names and our control apex
 * (`.com` runs on Cloudflare, so a relay there puts relay and gateway with one
 * operator). A name whose DNS is proxied by Cloudflare can't be seen from here;
 * the runbook says to keep a relay's record DNS-only.
 */
export function isForbiddenRelayHost(host: string, controlApex: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const apex = controlApex.toLowerCase();
  const under = (d: string) => h === d || h.endsWith(`.${d}`);
  return (
    under(apex) ||
    under("cloudflare.com") ||
    under("cloudflare.net") ||
    under("workers.dev") ||
    under("pages.dev") ||
    under("cloudflare-gateway.com") ||
    under("cloudflareclient.com")
  );
}

function relayEntryOf(v: unknown, controlApex: string | null): OhttpRelayEntry | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.url !== "string" || typeof r.operator !== "string" || typeof r.interim !== "boolean") return null;
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash) return null;
  if (controlApex && isForbiddenRelayHost(u.hostname, controlApex)) return null;
  const operator = r.operator.trim();
  if (!operator || operator.length > 80) return null;
  return { url: r.url, operator, interim: r.interim };
}

/**
 * Parse `.com`'s config. Bad relays are dropped one by one; a missing or bad key
 * means no relay at all (the caller then sends directly, marked `unconfigured`).
 * `controlApex` (when given) also drops relays on forbidden hosts.
 */
export function parseOhttpPublicConfig(v: unknown, controlApex: string | null = null): OhttpPublicConfig {
  const empty: OhttpPublicConfig = { v: 1, keyConfigHex: null, relays: [] };
  if (!v || typeof v !== "object") return empty;
  const o = v as Record<string, unknown>;
  const keyHex = typeof o.keyConfigHex === "string" && /^([0-9a-f]{2})+$/.test(o.keyConfigHex) ? o.keyConfigHex : null;
  if (!keyHex || !ohttpKeyConfigFromHex(keyHex)) return empty;
  const relays = (Array.isArray(o.relays) ? o.relays : [])
    .map((r) => relayEntryOf(r, controlApex))
    .filter((r): r is OhttpRelayEntry => r !== null)
    .slice(0, 4);
  return { v: 1, keyConfigHex: keyHex, relays };
}

export function ohttpKeyConfigFromHex(hex: string): OhttpKeyConfig | null {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) return null;
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return parseOhttpKeyConfig(b);
}

/**
 * `.com`'s relay list from its environment: `OHTTP_RELAYS` is a JSON array of
 * `{url, operator, interim}`; otherwise the single `OHTTP_RELAY_URL` with
 * `OHTTP_RELAY_OPERATOR` (default "Flagship (interim)") and `OHTTP_RELAY_INTERIM`
 * ("0" = third party; anything else, or unset, = interim).
 */
export function ohttpRelaysFromEnv(
  env: { OHTTP_RELAYS?: string; OHTTP_RELAY_URL?: string; OHTTP_RELAY_OPERATOR?: string; OHTTP_RELAY_INTERIM?: string },
  controlApex: string,
): OhttpRelayEntry[] {
  let raw: unknown[] = [];
  if (env.OHTTP_RELAYS) {
    try {
      const j = JSON.parse(env.OHTTP_RELAYS) as unknown;
      if (Array.isArray(j)) raw = j;
    } catch {
      raw = [];
    }
  } else if (env.OHTTP_RELAY_URL) {
    raw = [
      {
        url: env.OHTTP_RELAY_URL,
        operator: env.OHTTP_RELAY_OPERATOR?.trim() || "Flagship (interim)",
        interim: env.OHTTP_RELAY_INTERIM !== "0",
      },
    ];
  }
  return raw.map((r) => relayEntryOf(r, controlApex)).filter((r): r is OhttpRelayEntry => r !== null).slice(0, 4);
}

/** What a private request is for; decides whether a relay outage may send it directly. */
export type PrivateSpendKind = "interactive" | "trickle" | "overage";

/** A trickle spend goes direct once the plan would lapse (end + grace) within this. */
export const DIRECT_BEFORE_LAPSE_MS = 24 * 3_600_000;

/**
 * After every relay failed: may this spend go directly to `.com` (marked
 * `x-flagship-relay-fallback`)? `lapseInMs` is the time until the plan lapses
 * (its end plus the grace, minus now), null when no plan is paid.
 *
 *   - interactive (the owner chose a plan and is waiting): yes.
 *   - trickle: only when the plan would lapse within a day, or none is paid
 *     (nothing to protect by waiting); otherwise it waits and retries.
 *   - overage: never (missing a block slows the account like Free; nothing breaks).
 */
export function ohttpSpendMayGoDirect(kind: PrivateSpendKind, lapseInMs: number | null): boolean {
  if (kind === "interactive") return true;
  if (kind === "overage") return false;
  return lapseInMs === null || lapseInMs < DIRECT_BEFORE_LAPSE_MS;
}

/** Wait before trying the relay again after `failures` failed rounds (5 min doubling, at most 6 h). */
export function relayRetryAfterMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const base = 5 * 60_000;
  return Math.min(6 * 3_600_000, base * 2 ** Math.min(20, Math.floor(failures) - 1));
}

/** `lapseInMs` for `ohttpSpendMayGoDirect` from a plan's paid-until (0 = none) and the grace. */
export function planLapseInMs(paidUntil: number, graceMs: number, now: number): number | null {
  if (!paidUntil || paidUntil <= 0) return null;
  return paidUntil + graceMs - now;
}
