/**
 * Manifest → container image-ref resolution.
 *
 * A marketplace listing carries its public `flagship.app.json` manifest
 * (`manifestJson` on the listing / the checked-out `flagship.app.json` in the
 * clone). The container the daemon actually runs is named by
 * `runtime.image` (see docs/manifest.md — "OCI ref the daemon can pull").
 * The scanner grades THAT image (`trivy image <ref>`), so it must resolve the
 * ref out of the manifest before it can scan.
 *
 * Pure + deterministic + I/O-free so it is unit-testable without Trivy /
 * Docker / a network. A manifest with no usable `runtime.image` resolves to
 * `null` — the caller LOGS + SKIPS that listing (it is not an F: the scanner
 * simply has no image to pull this round), never crashing the queue drain.
 */

/**
 * A conservative OCI-reference shape check. We are not trying to fully
 * validate a distribution spec reference here — only to reject obvious
 * garbage (empty, whitespace, control chars, a bare tag) so a malformed
 * manifest resolves to `null` (skip) rather than handing `trivy image` a
 * string it will choke on. Accepts `repo`, `repo:tag`, `host/repo:tag`,
 * `host:port/ns/repo@sha256:…`.
 */
const OCI_REF_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\:[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?:\:[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extract the container image ref from a parsed manifest object.
 * Returns the trimmed ref string, or `null` when the manifest has no
 * usable `runtime.image`.
 */
export function resolveImageRef(manifest: unknown): string | null {
  if (!isPlainObject(manifest)) return null;
  const runtime = manifest["runtime"];
  if (!isPlainObject(runtime)) return null;
  const image = runtime["image"];
  if (typeof image !== "string") return null;
  const ref = image.trim();
  if (ref.length === 0 || ref.length > 512) return null;
  if (!OCI_REF_RE.test(ref)) return null;
  return ref;
}

/**
 * Parse a manifest JSON string and resolve its image ref. Tolerant of a
 * missing / non-JSON string (both resolve to `null` = skip). This is the
 * form the scan-queue hands the drain loop (`manifestJson` off the listing).
 */
export function resolveImageRefFromJson(
  manifestJson: string | null | undefined,
): string | null {
  if (typeof manifestJson !== "string" || manifestJson.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  return resolveImageRef(parsed);
}

/**
 * The `docker://`-prefixed form the `TrivyRunner` seam uses to discriminate
 * an image scan (`trivy image <ref>`) from a source-tree scan
 * (`trivy fs <path>`). Returns `null` when the manifest has no image ref.
 */
export function imageScanTargetFromManifest(manifest: unknown): string | null {
  const ref = resolveImageRef(manifest);
  return ref === null ? null : `docker://${ref}`;
}
