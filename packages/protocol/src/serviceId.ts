// Canonical service-identity + URL-fragment derivation. ONE source of
// truth shared by the .com Worker (control-plane) and the box daemon
// (server-daemon) so the URL a user sees never drifts between the two.
//
// serviceId is the IMMUTABLE composite `<creator>--<slug>` (DOUBLE dash —
// docs/service-addressing-double-dash.md). Both the creator (a username) and the
// slug may contain SINGLE dashes; neither may contain `--`, so the single `--`
// is always the creator/slug boundary.
//
// The URL fragment is CONDITIONAL on who is running the service:
//   running user IS the creator     -> `<slug>`              (harry runs harry--game1 -> game1)
//   running user is NOT the creator -> `<slug>--<creator>`   (harry runs meta--game1 -> game1--meta)

/** The reserved slug/creator delimiter. Banned INSIDE either half. */
export const SERVICE_ID_DELIM = "--";

/** Compose the immutable package id `<creator>--<slug>`. */
export function composeServiceId(creator: string, slug: string): string {
  return `${creator}${SERVICE_ID_DELIM}${slug}`;
}

/** Inverse of {@link composeServiceId}. Splits on the single `--`. Returns null
 *  when there is no usable creator/slug boundary — i.e. zero or more than one
 *  `--` (one of the halves would have to contain `--`, which is forbidden), or an
 *  empty half. */
export function parseServiceId(
  serviceId: string,
): { creator: string; slug: string } | null {
  const parts = serviceId.split(SERVICE_ID_DELIM);
  if (parts.length !== 2) return null; // 0 or ≥2 delimiters → malformed
  const creator = parts[0];
  const slug = parts[1];
  if (!creator || !slug) return null; // empty half → malformed
  return { creator, slug };
}

/** The host-relative URL fragment for `serviceId` when served on `username`'s
 *  pods. `<slug>` if the running user authored it, else `<slug>--<creator>`.
 *  Lowercased. Falls back to a sanitized serviceId if the id has no
 *  creator/slug boundary. */
export function deriveUrlFragment(serviceId: string, username: string): string {
  const parsed = parseServiceId(serviceId);
  if (!parsed) {
    return serviceId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
  }
  const creator = parsed.creator.toLowerCase();
  const slug = parsed.slug.toLowerCase();
  return creator === username.toLowerCase()
    ? slug
    : `${slug}${SERVICE_ID_DELIM}${creator}`;
}
