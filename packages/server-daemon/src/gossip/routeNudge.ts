/**
 * `POST /internal/route-nudge` — the hub's "wake up, someone wants this
 * unclaimed meta-URL" prod.
 *
 * When a request arrives at the hub for an UNCLAIMED tier-2 meta-URL
 * (`<slug>.<user>.flagship.services`), the hub fans a plaintext
 *
 *     POST /internal/route-nudge   { "domain": "<sni>" }
 *
 * to every online box on the account. It is NOT CGK-sealed — the domain is
 * already public (CT-logged), so there is nothing to hide; the body is a bare
 * JSON object. On receipt a box:
 *
 *   1. parses `<sni>` → the service slug + user;
 *   2. if it does NOT run that service → 204, do nothing (someone else will);
 *   3. else runs the SAME per-service election the gossip loop runs
 *      (`electLeadForService(self + live siblings, slug)`):
 *        - self IS the elected lead (or there are no live siblings running it —
 *          the single-box case elects self) → CLAIM the route
 *          (`routeClaimer.claim(slug)` → `urlController.claim(fqdn)`) AND ensure
 *          the `<slug>.<user>` cert is loaded/pre-warmed so the hub's parked
 *          request is served without first waiting on ACME;
 *        - self is NOT the lead → 204, do nothing (the elected sibling claims).
 *
 * EVERYTHING is best-effort and idempotent: it ALWAYS replies 204, NEVER throws,
 * and claiming an already-held route is a no-op. This is the on-demand twin of
 * the periodic gossip election — a box that just came up (or whose 45s announce
 * round hasn't fired yet) claims its meta-URL the instant a real request needs
 * it, instead of after a full gossip tick.
 */
import { type CloutMember, electLeadForService } from "@flagship/protocol";
import { parseTier2ServiceFqdn } from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { RouteClaimer } from "./routeClaimer.js";
import type { SelfMember } from "./election.js";
import type { ViewMember } from "./siblingView.js";

const EMPTY_204: HttpResponse = { status: 204, body: "" };

/**
 * Ensure the tier-2 service cert for an elected meta-URL is present so a claim is
 * INSTANTLY serveable (the parked request must not wait on ACME). It is NOT a
 * minter: a tier-2 `<slug>.<user>` cert is minted by a heavier, phone-driven
 * IRK-signed flow (`/api/service-certs/mint`, which needs a live
 * `ServiceCertAuthority`) that a box cannot run unilaterally. So pre-warm =
 * "load it if it's already provisioned (held in memory or persisted on disk)".
 * A never-before-minted meta-URL still needs its existing phone provisioning
 * path; the value here is that the lead does not FIRST discover it needs a cert
 * at request time — a provisioned cert is loaded eagerly the moment this box
 * becomes the lead.
 */
export interface CertPrewarm {
  /**
   * Ensure the cert for `fqdn` is loaded. Returns whether it is now present.
   * Best-effort: never throws; a missing/unprovisioned cert resolves `false`.
   */
  ensure(fqdn: string): Promise<boolean>;
}

export interface RouteNudgeDeps {
  /** This box's account (UserId) — a nudge for a different account is ignored. */
  user: string;
  /** This box's id/FQDN (podCanonical) — its election identity. */
  serverFqdn: string;
  /** This box's birth-cert date (ms) — the seniority source for clout. */
  birthDate: number;
  /** Snapshot the slugs this box currently runs (re-read per nudge). */
  listServiceSlugs: () => string[];
  /** Live siblings, projected for the elector (re-read per nudge). */
  liveSiblings: () => ViewMember[];
  /** This box's standing owner set-leader vote issuedAt (ms), or null. */
  selfVoteIssuedAt?: () => number | null;
  /** The route-claim seam (→ urlController.claim/release). */
  claimer: RouteClaimer;
  /** Maps a service slug → its tier-2 `<slug>.<user>.<apex>` FQDN. */
  fqdnForService: (service: string) => string;
  /** Cert pre-warm seam — load the meta-URL cert before the claim. */
  certPrewarm?: CertPrewarm;
  onLog?: (m: string) => void;
}

/**
 * Build the `/internal/route-nudge` handler. Mounts on the same HTTP chain as
 * `/internal/gossip` (returns null for any other path so the chain continues).
 */
export function buildRouteNudgeHandler(deps: RouteNudgeDeps) {
  const user = deps.user.toLowerCase();
  const log = deps.onLog ?? (() => {});
  // Derive the apex from this box's FQDN tail so the SNI is parsed under the
  // SAME zone the claimer forms its FQDNs in. `<server>.<user>.<apex>` → apex
  // is everything after the first two labels; fall back to production.
  const apex = apexFromBoxFqdn(deps.serverFqdn) ?? "flagship.services";

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (stripQuery(req.path) !== "/internal/route-nudge") return null;
    if (req.method !== "POST") return { status: 405, body: "" };

    try {
      // 1. Parse the body → the SNI. A malformed body / missing domain → 204.
      const domain = parseDomain(req.body);
      if (!domain) return EMPTY_204;

      // 2. Parse the SNI → { service, username }. A box name, the user apex, a
      //    deeper hierarchy, or a name outside our apex → not a meta-URL → 204.
      const parsed = parseTier2ServiceFqdn(domain, apex);
      if (!parsed) return EMPTY_204;
      // Scope guard: a nudge for a different account is not ours.
      if (parsed.username.toLowerCase() !== user) return EMPTY_204;

      const slug = parsed.service.toLowerCase();

      // 3. We must actually RUN this service to be a candidate.
      const myServices = deps.listServiceSlugs().map((s) => s.toLowerCase());
      if (!myServices.includes(slug)) return EMPTY_204;

      // 4. Run the per-service election over {self-as-live} ∪ {live siblings}.
      const self: SelfMember = {
        id: deps.serverFqdn.toLowerCase(),
        domain: deps.serverFqdn.toLowerCase(),
        birthDate: deps.birthDate,
        voteIssuedAt: deps.selfVoteIssuedAt?.() ?? null,
        services: myServices,
      };
      const members: CloutMember[] = [
        {
          id: self.id,
          domain: self.domain,
          birthDate: self.birthDate,
          voteIssuedAt: self.voteIssuedAt,
          liveness: "live",
          services: self.services,
        },
        ...deps.liveSiblings().map((s) => ({
          id: s.id,
          domain: s.domain,
          birthDate: s.birthDate,
          voteIssuedAt: s.voteIssuedAt,
          liveness: s.liveness,
          services: s.services,
        })),
      ];
      const lead = electLeadForService(members, slug);
      // No live runner at all shouldn't happen (we run it, we're live) — but be
      // defensive: if the elector returns null, claim (single-box semantics).
      const selfIsLead = lead === null || lead.id === self.id;
      if (!selfIsLead) {
        log(`[route-nudge] ${slug}: a higher-clout sibling leads — not claiming`);
        return EMPTY_204;
      }

      // 5. Self is the lead. Pre-warm the cert FIRST (so the claim is instantly
      //    serveable), then claim. Both best-effort; a cert miss never blocks
      //    the claim (the hub's parked request is better served by a claimed
      //    route + a cert that lands a beat later than by no route at all).
      const fqdn = deps.fqdnForService(slug);
      if (deps.certPrewarm) {
        try {
          const ready = await deps.certPrewarm.ensure(fqdn);
          log(
            `[route-nudge] ${slug}: cert pre-warm ${ready ? "ready" : "not provisioned (phone mint still needed)"} for ${fqdn}`,
          );
        } catch (e) {
          log(`[route-nudge] ${slug}: cert pre-warm failed: ${(e as Error).message}`);
        }
      }
      try {
        await deps.claimer.claim(slug); // idempotent — no-op if already held
        log(`[route-nudge] ${slug}: claimed ${fqdn}`);
      } catch (e) {
        log(`[route-nudge] ${slug}: claim failed: ${(e as Error).message}`);
      }
    } catch {
      // Never leak / never throw — a bad nudge is indistinguishable from noise.
    }
    return EMPTY_204;
  };
}

/** Parse `{ "domain": "<sni>" }` → the domain, or null on any malformation. */
function parseDomain(body: Buffer | Uint8Array): string | null {
  try {
    const text = Buffer.isBuffer(body)
      ? body.toString("utf8")
      : Buffer.from(body).toString("utf8");
    const obj = JSON.parse(text) as { domain?: unknown };
    if (typeof obj.domain !== "string" || obj.domain.length === 0) return null;
    return obj.domain.trim().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The apex (zone) for a box FQDN `<server>.<user>.<apex…>` is everything after
 * the first two labels. Returns null when the FQDN has fewer than three labels.
 */
export function apexFromBoxFqdn(fqdn: string): string | null {
  const labels = fqdn.toLowerCase().split(".");
  if (labels.length < 3) return null;
  return labels.slice(2).join(".");
}

function stripQuery(p: string): string {
  const i = p.indexOf("?");
  return i >= 0 ? p.slice(0, i) : p;
}

/** The CertManager surface the live pre-warm needs (a subset). */
export interface PrewarmCertManager {
  /** True iff a custom cert for `fqdn` is present AND has ≥ windowMs left. */
  customNeedsRenewal(fqdn: string, windowMs?: number, now?: number): boolean;
  /** Install (or replace) the custom cert for an exact FQDN. */
  installCustom(
    fqdn: string,
    cert: { certPem: string; privateKeyPem: string },
    notAfterMs: number,
  ): void;
}

/** The persisted-cert store surface the live pre-warm needs (a subset). */
export interface PrewarmCertStore {
  loadCert(fqdn: string): Promise<{
    certPem: string;
    privateKeyPem: string;
    names: string[];
    notAfter: number;
  } | null>;
}

/**
 * Live cert pre-warm: load an already-provisioned tier-2 `<slug>.<user>` cert
 * from the persisted service-cert store into the CertManager's custom-SNI tier
 * so the meta-URL serves immediately when this box claims it.
 *
 * It does NOT mint: minting a tier-2 cert requires the phone's IRK-signed
 * `ServiceCertAuthority` (see serviceCertHttp `/api/service-certs/mint`) which a
 * box cannot produce on its own. So `ensure` resolves:
 *   - `true`  → a usable cert is already installed (or was just loaded from disk);
 *   - `false` → no provisioned cert exists; the phone must mint one (the route is
 *               still claimed by the caller — the cert simply lands later).
 */
export function buildCertPrewarm(deps: {
  certManager: PrewarmCertManager;
  store: PrewarmCertStore;
  now?: () => number;
}): CertPrewarm {
  const now = deps.now ?? (() => Date.now());
  return {
    async ensure(fqdn: string): Promise<boolean> {
      const key = fqdn.toLowerCase();
      const t = now();
      // Already loaded + not expiring → nothing to do. `customNeedsRenewal`
      // returns false only when a present cert has comfortable life left; we
      // gate on "present with ANY life" here, so use a 0ms window to mean
      // "merely present and unexpired".
      if (!deps.certManager.customNeedsRenewal(key, 0, t)) return true;
      // Not currently in memory (or expired) — try to load a provisioned cert
      // from disk.
      let persisted: Awaited<ReturnType<PrewarmCertStore["loadCert"]>> = null;
      try {
        persisted = await deps.store.loadCert(key);
      } catch {
        return false;
      }
      if (!persisted) return false;
      if (persisted.notAfter <= t) return false; // expired on disk → can't serve
      deps.certManager.installCustom(
        key,
        { certPem: persisted.certPem, privateKeyPem: persisted.privateKeyPem },
        persisted.notAfter,
      );
      return true;
    },
  };
}
