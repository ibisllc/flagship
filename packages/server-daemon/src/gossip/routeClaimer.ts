/**
 * The route-claim seam. Each round, after electing a per-service leader, the
 * gossip loop applies the rule:
 *
 *   - self IS the elected lead AND does NOT hold the route  → CLAIM it
 *   - self is NOT the lead AND currently holds it           → RELEASE it
 *   - otherwise (steady)                                    → no-op
 *
 * `RouteClaimer` is the abstraction over how a box actually grabs/drops a
 * tier-2 leader-routed `<service>.<user>` FQDN at the hub. The LIVE wiring
 * (`urlControllerRouteClaimer`) drives the daemon's `UrlController`
 * (`claim`/`release` push a tunnel HELLO update); tests inject a mock.
 */

export interface RouteClaimer {
  /** Claim the tier-2 route for `service`. Idempotent. */
  claim(service: string): Promise<void>;
  /** Release the tier-2 route for `service`. Idempotent. */
  release(service: string): Promise<void>;
  /** Does this box currently hold the route for `service`? */
  holds(service: string): boolean;
}

/**
 * Adapt the daemon's `UrlController` (claim/release/list over FQDNs) into a
 * slug-keyed RouteClaimer. The tier-2 leader-routed FQDN for a service slug is
 * `<slug>.<user>.flagship.services` — `fqdnForService` builds it from the box's
 * own user + the services-zone apex so the seam is the only place that name is
 * formed.
 */
export function urlControllerRouteClaimer(deps: {
  urlController: {
    claim(fqdn: string): Promise<void>;
    release(fqdn: string): Promise<void>;
    list(): string[];
  };
  /** Maps a service slug → the tier-2 FQDN this box would claim for it. */
  fqdnForService: (service: string) => string;
}): RouteClaimer {
  return {
    async claim(service) {
      await deps.urlController.claim(deps.fqdnForService(service));
    },
    async release(service) {
      await deps.urlController.release(deps.fqdnForService(service));
    },
    holds(service) {
      const fqdn = deps.fqdnForService(service).toLowerCase();
      return deps.urlController.list().some((f) => f.toLowerCase() === fqdn);
    },
  };
}

/**
 * Build the tier-2 leader-routed FQDN for a slug: `<slug>.<user>.<apex>`.
 * `apex` defaults to the production services zone.
 */
export function tier2FqdnFor(
  user: string,
  apex = "flagship.services",
): (service: string) => string {
  const u = user.toLowerCase();
  const a = apex.toLowerCase();
  return (service: string) => `${service.toLowerCase()}.${u}.${a}`;
}
