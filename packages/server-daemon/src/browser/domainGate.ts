/**
 * Per-app navigation allowlist enforcement.
 *
 * Each installed app declares its `browser.domains` in `flagship.app.json`.
 * The user reviewed + approved that list at install time. This module
 * holds the current grants and decides allow/deny on every navigation
 * the apiHandlers route through.
 *
 * Matching uses `matchBrowserDomain` from @flagship/protocol — the
 * exact same function the manifest parser validates against, so the
 * runtime gate cannot drift from the install-time review.
 *
 * Schemes other than http/https are denied unconditionally:
 *   - `data:` / `blob:` / `javascript:` could be abused to land on
 *     a page that then makes cross-origin requests to non-allowlisted
 *     hosts.
 *   - `file://` / `chrome:` are out of scope.
 *
 * The gate also rejects hostless URLs (relative paths shouldn't reach
 * here in the first place; defense in depth).
 */

import { matchBrowserDomain } from "@flagship/protocol";

export type GateDecision = "allow" | "deny";

export class DomainGate {
  private grants = new Map<string, string[]>();

  /** Install-time grant: replace this app's allowed domains with the manifest's. */
  setGrant(serviceId: string, domains: string[]): void {
    // Defensive copy so callers can't mutate after the fact.
    this.grants.set(serviceId, [...domains]);
  }

  /** Drop the grant entirely (uninstall). After this, every check returns deny. */
  revoke(serviceId: string): void {
    this.grants.delete(serviceId);
  }

  /** True if a grant exists for the app (whether or not a specific URL is allowed). */
  hasGrant(serviceId: string): boolean {
    return this.grants.has(serviceId);
  }

  /** Snapshot for diagnostics / phone display. */
  grantsFor(serviceId: string): string[] {
    return [...(this.grants.get(serviceId) ?? [])];
  }

  /**
   * Decide whether `serviceId` may navigate to `url`. Defense rules:
   *   - URL must parse and use http/https scheme.
   *   - App must have a grant.
   *   - URL's host must match at least one entry under that grant.
   *
   * Returns explicit allow/deny — callers translate deny into HTTP 403
   * + a structured error (so the app knows the manifest needs the
   * domain added, vs a generic 4xx that looks like a bug).
   */
  check(serviceId: string, url: string): GateDecision {
    const entries = this.grants.get(serviceId);
    if (!entries || entries.length === 0) return "deny";
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "deny";
      if (!u.hostname) return "deny";
      host = u.hostname.toLowerCase();
    } catch {
      return "deny";
    }
    for (const entry of entries) {
      if (matchBrowserDomain(entry, host)) return "allow";
    }
    return "deny";
  }
}
