import { malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

/**
 * The blessed Debian base ISO the desktop burner should be holding.
 *
 * `sha256` MUST be pinned to the value in Debian's official signed
 * SHA256SUMS (the `attestation` URL points at that signed file) so the
 * burner can verify the download end-to-end without trusting us. We are
 * just a pointer; the cryptographic root is Debian's signature.
 */
export interface IsoManifest {
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  attestation: string;
}

export interface IsoManifestDeps {
  /**
   * The single blessed manifest, or null when none is configured.
   * "Hold an old release" / "fast-track a new one" is purely a matter
   * of what this is set to server-side — there is no action/keep/urgent
   * field on the wire.
   */
  blessedManifest: IsoManifest | null;
}

const ALLOWED_PLATFORMS = new Set(["mac", "linux", "windows"]);
const SHA256_RE = /^[0-9a-f]{64}$/i;

interface IsoManifestRequestBody {
  platform?: unknown;
  burnerVersion?: unknown;
  current?: unknown;
}

/**
 * Decide whether the burner needs to (re)fetch the base ISO.
 *
 *   - no blessed manifest configured        → { download: null }
 *   - request.current.sha256 === blessed     → { download: null }
 *   - otherwise                              → { download: <blessed> }
 *
 * The burner is a dumb executor: it sends what it has and does exactly
 * what we tell it. All policy lives here.
 */
export function handleIsoManifest(
  deps: IsoManifestDeps,
  body: IsoManifestRequestBody | undefined,
): HandlerResponseWithHeaders {
  if (!body || typeof body !== "object") return malformed("malformed body");

  const { platform, burnerVersion, current } = body;

  if (typeof platform !== "string" || !ALLOWED_PLATFORMS.has(platform)) {
    return malformed("platform must be one of mac, linux, windows");
  }
  if (typeof burnerVersion !== "string" || burnerVersion.length === 0) {
    return malformed("burnerVersion must be a non-empty string");
  }

  let currentSha: string | null = null;
  if (current !== null && current !== undefined) {
    if (typeof current !== "object") return malformed("malformed current");
    const c = current as { version?: unknown; sha256?: unknown };
    if (typeof c.version !== "string") {
      return malformed("current.version must be a string");
    }
    if (typeof c.sha256 !== "string" || !SHA256_RE.test(c.sha256)) {
      return malformed("current.sha256 must be a 64-char hex string");
    }
    currentSha = c.sha256.toLowerCase();
  }

  const blessed = deps.blessedManifest;
  if (!blessed) return ok({ download: null });

  if (currentSha !== null && currentSha === blessed.sha256.toLowerCase()) {
    return ok({ download: null });
  }

  return ok({ download: blessed });
}
