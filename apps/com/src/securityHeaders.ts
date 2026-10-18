/**
 * The headers every page of flagshipserver.com carries, in ONE place so the
 * Worker (route.ts `withSecurityHeaders`) and the static `_headers` files
 * (scripts/static-assets.ts) can never drift: a file the assets layer serves
 * without waking the Worker (docs/runbooks/workers-cpu-budget.md "Static assets")
 * must come out with the same headers it would have had through the Worker.
 *
 * No page on these hosts is meant to sit in a frame (recovery opens as a popup),
 * and a framed webapp or remote session could have its clicks steered by an
 * overlay, so framing is refused everywhere.
 */

/**
 * CSP for the webapp shell on `webapp.` and `remote.`. Scripts come only from
 * the shell itself (no inline script, no eval); the shell talks only to the
 * control apex and its sub-origins and to the account's servers under the
 * services apex. Inline styles stay allowed: the views set `style=`
 * attributes throughout.
 */
export function shellCspFor(apex: string, services: string): string {
  return (
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self'; " +
    `connect-src 'self' https://${apex} wss://${apex} https://*.${apex} wss://*.${apex} ` +
    `https://*.${services} wss://*.${services}; ` +
    "worker-src 'self'; " +
    "manifest-src 'self'; " +
    "media-src 'self' blob:; " +
    "frame-src 'none'; " +
    "frame-ancestors 'none'; " +
    "form-action 'self'; " +
    "base-uri 'none'; " +
    "object-src 'none'"
  );
}

export interface SecurityHeaderOptions {
  apex: string;
  services: string;
  /** HSTS only goes on https responses. */
  https: boolean;
}

/** Header name (lower case) and value, in the order they are applied. */
export function securityHeaders(kind: "shell" | "site", o: SecurityHeaderOptions): [string, string][] {
  const list: [string, string][] = [
    ["content-security-policy", kind === "shell" ? shellCspFor(o.apex, o.services) : "frame-ancestors 'none'"],
    ["x-frame-options", "DENY"],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", kind === "shell" ? "no-referrer" : "strict-origin-when-cross-origin"],
  ];
  if (o.https) list.push(["strict-transport-security", "max-age=31536000"]);
  return list;
}
