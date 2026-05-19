// Canonical service-identity + URL-fragment derivation. ONE source of
// truth shared by the .com Worker (control-plane) and the box daemon
// (server-daemon) so the URL a user sees never drifts between the two.
//
// serviceId is the IMMUTABLE composite `<creator>-<slug>` (single dash;
// usernames are hyphen-free so the FIRST hyphen is always the
// creator/slug boundary even when the slug itself contains hyphens).
//
// The URL fragment is CONDITIONAL on who is running the service:
//   running user IS the creator  -> `<slug>`            (harry runs harry-game1 -> game1)
//   running user is NOT the creator -> `<slug>-<creator>` (harry runs meta-game1 -> game1-meta)

/** Compose the immutable package id. */
export function composeServiceId(creator: string, slug: string): string {
  return `${creator}-${slug}`;
}

/** Inverse of {@link composeServiceId}. Splits at the FIRST hyphen.
 *  Returns null when there is no usable creator/slug boundary. */
export function parseServiceId(
  serviceId: string,
): { creator: string; slug: string } | null {
  const i = serviceId.indexOf("-");
  if (i <= 0 || i >= serviceId.length - 1) return null;
  return { creator: serviceId.slice(0, i), slug: serviceId.slice(i + 1) };
}

/** The host-relative URL fragment for `serviceId` when served on
 *  `username`'s pods. `<slug>` if the running user authored it,
 *  else `<slug>-<creator>`. Lowercased. Falls back to a sanitized
 *  serviceId if the id has no creator/slug boundary. */
export function deriveUrlFragment(serviceId: string, username: string): string {
  const parsed = parseServiceId(serviceId);
  if (!parsed) {
    return serviceId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
  }
  const creator = parsed.creator.toLowerCase();
  const slug = parsed.slug.toLowerCase();
  return creator === username.toLowerCase() ? slug : `${slug}-${creator}`;
}
