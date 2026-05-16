// Custom (external) domain attach — the .com POST/GET path (#79A).
//
// DECIDED DESIGN (see project_external_domains memory +
// docs/plan-external-domains-and-demo.md): the POST only RECORDS the
// request (status='pending') and rate-limits. It does NOT verify the
// CNAME — that is out-of-band (Phase 4 #79B/#82), which flips the row
// to active/failed and pushes the outcome. So:
//
//   - 200 { recorded:true }  = "in the DB; .com will verify the CNAME
//                               later and push the outcome" — NOT
//                               confirmed. The phone uses the domain
//                               in UX immediately on 200.
//   - 429 { error }          = the ONLY synchronous denial — the
//                               300s dual rate limit. The error
//                               string is BYTE-IDENTICAL to the iOS
//                               Mock ("Too soon — try again in Ns.",
//                               U+2014 em dash) so Live == Mock wire.
//   - 400 / 403              = malformed / bad-signature / apex.
//
// A new request DESTRUCTIVELY replaces any prior order for the
// (appId,user) pair (irreversible; doubles as the only "forget"
// affordance) — enforced at the storage layer's upsert.

import { verifySetCustomDomain, type SetCustomDomain } from "@flagship/protocol";
import type { CustomDomainOrderStorage, UsernameStorage } from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface CustomDomainDeps {
  usernames: UsernameStorage;
  customDomainOrders: CustomDomainOrderStorage;
  now?: () => number;
  /**
   * Same-shaped helper the Phase-4 verifier uses. Optional: when an
   * ACTIVE custom domain is destructively replaced, the verifier only
   * ever sees the NEW (pending) fqdn, so it never deletes the OLD
   * redirection — it would linger in `.services` RAM until a sweep /
   * cold-start reconcile. Emitting DELETE(oldFqdn) here closes that
   * window immediately. Stale-routing cleanup, not a security hole;
   * absent ⇒ skip (the sweep still eventually reconciles).
   */
  pushRedirection?: (
    op: "add" | "delete",
    fqdn: string,
    podCanonical?: string,
  ) => Promise<void>;
}

const USERNAME_RE = /^[a-z0-9]{1,63}$/;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
/** Decided: 300s minimum between custom-domain changes (dual: the
 *  client mirrors a UX cooldown; this is the server backstop). */
export const CUSTOM_DOMAIN_RATE_LIMIT_MS = 5 * 60_000;

// Hostname label: RFC-1035-ish, 1..63, no leading/trailing hyphen.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const FQDN_RE = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);

/** Structural-only apex guard (decided: no PSL/DNS here — that stays a
 *  client structural check + the real proof is the CNAME, verified in
 *  Phase 4). We require at least one label in front of a 2-label
 *  registrable name, i.e. ≥3 labels: `shop.example.com` ok,
 *  `example.com` rejected. Defense-in-depth alongside the client. */
function fqdnError(fqdn: string): string | null {
  const f = fqdn.trim().toLowerCase();
  if (f.length === 0 || f.length > 253) return "fqdn missing or too long";
  if (f.includes("/") || f.includes(":")) return "fqdn must be a bare hostname (no scheme or path)";
  if (!FQDN_RE.test(f)) return "fqdn is not a valid hostname";
  if (f.split(".").length < 3) {
    return "apex domains are not supported — attach a subdomain like www.example.com and redirect the apex to it";
  }
  return null;
}

function tooSoon(waitSeconds: number): HandlerResponseWithHeaders {
  // U+2014 em dash + trailing period — MUST byte-match the iOS Mock
  // (FlagshipServerClient: "Too soon — try again in \(wait)s.").
  return { status: 429, body: { error: `Too soon — try again in ${waitSeconds}s.` } };
}

/** POST /api/users/:u/apps/:appId/custom-domain */
export async function handleSetCustomDomain(
  deps: CustomDomainDeps,
  username: string,
  appIdFromUrl: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) return malformed("malformed username");

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.appId !== "string" ||
    typeof r.fqdn !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.username.toLowerCase() !== u) return forbidden("username / url mismatch");
  if (r.appId !== appIdFromUrl) return forbidden("appId / url mismatch");
  if (Math.abs(now - r.issuedAt) > DEFAULT_MAX_AGE_MS) return forbidden("stale request");

  const fqdn = r.fqdn.trim().toLowerCase();
  const fErr = fqdnError(fqdn);
  if (fErr) return malformed(fErr);

  const userRec = await deps.usernames.get(u);
  if (!userRec) return notFound("unknown username");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  const claim: SetCustomDomain = {
    username: u,
    appId: r.appId,
    fqdn,
    issuedAt: r.issuedAt,
  };
  if (!verifySetCustomDomain(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  // 300s rate limit off the prior row's last_changed (the server is
  // the backstop; the client mirrors a UX cooldown).
  const existing = await deps.customDomainOrders.get(u, r.appId);
  if (existing) {
    const elapsed = now - existing.lastChanged;
    if (elapsed < CUSTOM_DOMAIN_RATE_LIMIT_MS) {
      return tooSoon(Math.ceil((CUSTOM_DOMAIN_RATE_LIMIT_MS - elapsed) / 1000));
    }
  }

  // Replace-time stale-routing cleanup: if the prior order was ACTIVE
  // (a redirection is live in `.services` RAM for its fqdn) and the
  // fqdn is actually changing, proactively DELETE the old redirection.
  // The async verifier only ever sees the NEW pending fqdn, so without
  // this the old one lingers until the #82 sweep / a cold-start. Best
  // effort — a transient `.services` hiccup must not fail the attach
  // request (the row is recorded regardless; the sweep backstops).
  if (
    deps.pushRedirection &&
    existing &&
    existing.status === "active" &&
    existing.podCanonical &&
    existing.fqdn.toLowerCase() !== fqdn
  ) {
    try {
      await deps.pushRedirection("delete", existing.fqdn);
    } catch (e) {
      console.warn(
        `[customDomain] replace-time DELETE(${existing.fqdn}) failed; sweep will reconcile: ${(e as Error).message}`,
      );
    }
  }

  // Destructive upsert: records the request as pending; any prior
  // order for the pair is wholesale replaced (storage-layer upsert).
  await deps.customDomainOrders.upsert({
    appId: r.appId,
    userId: u,
    fqdn,
    status: "pending",
    lastChanged: now,
    failCount: 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  return ok({ recorded: true });
}

/** GET /api/users/:u/apps/:appId/custom-domain — current order (if any). */
export async function handleGetCustomDomain(
  deps: CustomDomainDeps,
  username: string,
  appId: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) return malformed("malformed username");
  const row = await deps.customDomainOrders.get(u, appId);
  if (!row) return ok({ fqdn: null });
  return ok({
    fqdn: row.fqdn,
    status: row.status,
    confirmed: row.status === "active",
  });
}
