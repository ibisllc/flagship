// isServerTrusted — the app-scope maintainer-trust verdict + the per-cert
// override set. This is the FOUNDATION the whole enforcement rides on
// (docs/maintainer-trust-enforcement.md §"Apps: isServerTrusted + halt +
// override"):
//
//   - A single boolean (`isServerTrusted()`) gates ALL backend interaction.
//     While the control server is untrusted AND its cert is not overridden,
//     the .com chokepoint (lib/comFetch.js) and box calls short-circuit.
//   - "No verdict yet" (boot hasn't run, or a network error fetching the
//     blessing) is DISTINCT from "untrusted". We never brick on a network
//     failure — only a *valid blessing that fails verification* flips
//     untrusted. Until a verdict lands the app is treated as trusted (so a
//     transient .com outage doesn't lock the user out).
//   - Override is a deliberate biometric/PIN-gated user action recorded as a
//     signed TrustException scoped to exactly one cert-hash (lib/trustException.js).
//     Even after override the red sliver line persists — the degraded state
//     stays visible.
//
// The BAKED_PIN here is the link-1 anchor — the SAME literal as
// packages/protocol/src/maintainerCa.ts MAINTAINER_PINNED_MANDATE_HASH. A test
// asserts they stay in lockstep.

import { verifyComBlessing } from "./maintainerTrust.js";
import { controlApex } from "./apex.js";

// Re-baked per surface (#30 generalised) — keep byte-identical to
// packages/protocol/src/maintainerCa.ts MAINTAINER_PINNED_MANDATE_HASH.
export const BAKED_PIN = "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae";

const COM_BLESSING_PATH = "/api/maintainer-blessing";
const APEX = controlApex();

// The "control" cert-class slug is derived from the served CA pubkey:
//   certHash = sha256hex(utf8(caPubkey)).  The slug shown in the sliver is the
// first 8 hex chars of that hash (shared contract across all surfaces).
async function controlCertHash(caPubkey) {
  const bytes = new TextEncoder().encode(caPubkey);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let s = "";
  for (let i = 0; i < h.length; i++) s += h[i].toString(16).padStart(2, "0");
  return s;
}

class ServerTrustStore {
  constructor() {
    // null = no verdict yet (boot not run / network error). Otherwise a
    // verdict object { trusted, caPubkey, reason, certClass, certHash }.
    this._verdict = null;
    // certHash → exception record, for certs the owner has accepted.
    this._overrides = new Map();
    // Per-cert RELAY failures aggregated across the user's pods (lib/relayTrust.js).
    // A SEPARATE source from the control-CA `_verdict`: it feeds the red sliver
    // but NEVER the `isServerTrusted()` global halt (a relay-cert failure is a
    // warning + override, not a .com I/O halt). Each entry:
    //   { certClass:"relay", certHash, servers:[], serverCount, overridden }.
    this._relayFailures = [];
    this._subscribers = new Set();
  }

  /** The raw verdict (or null when none yet). */
  get verdict() {
    return this._verdict;
  }

  /**
   * The gate the whole app reads. True ⇒ backend interaction is allowed.
   *   - no verdict yet → true (don't brick before/around a fetch).
   *   - verdict trusted → true.
   *   - verdict untrusted but the failing cert is overridden → true (calls
   *     resume; the red sliver stays).
   *   - verdict untrusted, not overridden → false (halt all backend).
   */
  isServerTrusted() {
    const v = this._verdict;
    if (!v) return true;
    if (v.trusted) return true;
    if (v.certHash && this._overrides.has(v.certHash)) return true;
    return false;
  }

  /** Failing-cert descriptors the sliver renders (empty when trusted/overridden-irrelevant).
   *  Always returns the failing cert even when overridden — the sliver line
   *  persists after override. One entry per failing certHash, MERGING two
   *  sources: the control-CA `_verdict` (the global-halt class) and the
   *  per-cert RELAY failures aggregated across the user's pods. A relay entry
   *  is "overridden" when EITHER the box relayed a covering exception
   *  (wire-driven, standing) OR this device signed one locally. */
  failingCerts() {
    const out = [];
    const v = this._verdict;
    if (v && !v.trusted && v.certHash) {
      out.push({
        certClass: v.certClass ?? "control",
        certHash: v.certHash,
        overridden: this._overrides.has(v.certHash),
      });
    }
    for (const f of this._relayFailures) {
      if (!f || !f.certHash) continue;
      out.push({
        certClass: "relay",
        certHash: f.certHash,
        serverCount: f.serverCount ?? (Array.isArray(f.servers) ? f.servers.length : 0),
        servers: Array.isArray(f.servers) ? f.servers : [],
        overridden: !!f.overridden || this._overrides.has(f.certHash),
      });
    }
    return out;
  }

  subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  _emit() {
    for (const fn of this._subscribers) {
      try {
        fn(this);
      } catch {
        /* a bad subscriber must not wedge the others */
      }
    }
  }

  /** Record a verdict (from boot's blessing verification). Pass the raw
   *  verifyComBlessing() result; we attach the control cert-hash. */
  async setVerdict(result) {
    const certHash =
      !result.trusted && result.caPubkey ? await controlCertHash(result.caPubkey) : null;
    this._verdict = {
      trusted: !!result.trusted,
      caPubkey: result.caPubkey ?? null,
      reason: result.reason,
      certClass: "control",
      certHash,
    };
    this._emit();
    return this._verdict;
  }

  /** Clear the verdict back to "no verdict yet" (e.g. a network error path
   *  that wants to explicitly NOT assert untrusted). */
  clearVerdict() {
    if (this._verdict === null) return;
    this._verdict = null;
    this._emit();
  }

  /** Replace the per-cert RELAY failure set (from lib/relayTrust.js, verified +
   *  aggregated across `/pods`). Idempotent: an unchanged set never churns
   *  subscribers. This source drives the sliver but NOT `isServerTrusted()`. */
  setRelayFailures(failures) {
    const next = Array.isArray(failures) ? failures : [];
    if (JSON.stringify(next) === JSON.stringify(this._relayFailures)) return;
    this._relayFailures = next;
    this._emit();
  }

  /** The current per-cert relay failure set (test/introspection helper). */
  relayFailures() {
    return this._relayFailures.slice();
  }

  /** Mark a cert-hash as overridden (the owner accepted it). Idempotent. */
  markOverridden(certHash, record) {
    if (!certHash) return;
    const prev = this._overrides.get(certHash);
    if (prev && JSON.stringify(prev) === JSON.stringify(record ?? {})) return;
    this._overrides.set(certHash, record ?? { certHash });
    this._emit();
  }

  /** Is this cert-hash overridden? */
  isOverridden(certHash) {
    return this._overrides.has(certHash);
  }

  /** Apply a set of exception records (e.g. synced from .com on boot). */
  applyOverrides(records) {
    let changed = false;
    for (const r of records ?? []) {
      if (r && r.certHash && !this._overrides.has(r.certHash)) {
        this._overrides.set(r.certHash, r);
        changed = true;
      }
    }
    if (changed) this._emit();
  }

  /** Test/boot helper: reset everything. */
  _reset() {
    this._verdict = null;
    this._overrides.clear();
    this._relayFailures = [];
    this._emit();
  }
}

export const serverTrust = new ServerTrustStore();

/** The control cert-hash for a served CA pubkey (sha256hex(utf8(caPubkey))). */
export { controlCertHash };

/**
 * Fetch + verify the control-server blessing and record the verdict. Uses the
 * CLIENT'S clock. A network/parse failure is NOT a verdict (returns
 * {ok:false, networkError:true} and leaves the store at "no verdict yet" — the
 * app stays usable). Only a valid blessing that fails verification flips
 * untrusted.
 *
 * @param {object} [deps]  injection seam for tests
 *   deps.fetchImpl  — fetch (defaults to global)
 *   deps.now        — () => epoch ms (defaults to Date.now)
 *   deps.pin        — baked pin (defaults to BAKED_PIN)
 *   deps.base       — .com base (defaults to APEX)
 */
export async function refreshServerTrust(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const nowMs = (deps.now ?? Date.now)();
  const pin = deps.pin ?? BAKED_PIN;
  const base = deps.base ?? APEX;
  if (!fetchImpl) return { ok: false, networkError: true };

  let body;
  try {
    const r = await fetchImpl(`${base}${COM_BLESSING_PATH}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) {
      // A 5xx/404 is a server-side problem, not a verification failure — no
      // verdict (don't brick). A persistently-missing endpoint just means the
      // blessing hasn't been exposed yet.
      return { ok: false, networkError: true, status: r.status };
    }
    body = await r.json();
  } catch {
    return { ok: false, networkError: true };
  }

  const result = await verifyComBlessing(body, nowMs, pin);
  const verdict = await serverTrust.setVerdict(result);
  return { ok: true, verdict };
}
