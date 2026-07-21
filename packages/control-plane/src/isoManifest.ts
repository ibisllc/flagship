import { malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

/**
 * The blessed Debian base ISO the desktop builder should be holding.
 *
 * `sha256` MUST be pinned to the value in Debian's official signed
 * SHA256SUMS (the `attestation` URL points at that signed file) so the
 * builder can verify the download end-to-end without trusting us. We are
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
  /**
   * The blessed arm64 manifest, or null when none is configured. Served
   * only when the request asks for `arch: "arm64"` — the desktop apps'
   * HOST-a-VM path on an arm64 machine (Apple-silicon Macs under
   * Virtualization.framework boot native-arch guests only; arm64
   * Linux/Chromebook KVM hosts likewise want a native guest). BURNING
   * always stays amd64 — real boxes are x86 — so an absent `arch`
   * keeps the original manifest and old builders are byte-compatible.
   */
  blessedManifestArm64?: IsoManifest | null;
}

const ALLOWED_PLATFORMS = new Set(["mac", "linux", "windows"]);
const ALLOWED_ARCHES = new Set(["amd64", "arm64"]);
const SHA256_RE = /^[0-9a-f]{64}$/i;

interface IsoManifestRequestBody {
  platform?: unknown;
  builderVersion?: unknown;
  current?: unknown;
  arch?: unknown;
}

/**
 * Decide whether the builder needs to (re)fetch the base ISO.
 *
 *   - no blessed manifest configured        → { download: null }
 *   - request.current.sha256 === blessed     → { download: null }
 *   - otherwise                              → { download: <blessed> }
 *
 * The builder is a dumb executor: it sends what it has and does exactly
 * what we tell it. All policy lives here.
 */
export function handleIsoManifest(
  deps: IsoManifestDeps,
  body: IsoManifestRequestBody | undefined,
): HandlerResponseWithHeaders {
  if (!body || typeof body !== "object") return malformed("malformed body");

  const { platform, builderVersion, current, arch } = body;

  if (typeof platform !== "string" || !ALLOWED_PLATFORMS.has(platform)) {
    return malformed("platform must be one of mac, linux, windows");
  }
  if (typeof builderVersion !== "string" || builderVersion.length === 0) {
    return malformed("builderVersion must be a non-empty string");
  }
  if (
    arch !== undefined &&
    (typeof arch !== "string" || !ALLOWED_ARCHES.has(arch))
  ) {
    return malformed("arch must be one of amd64, arm64");
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

  const blessed =
    arch === "arm64" ? (deps.blessedManifestArm64 ?? null) : deps.blessedManifest;
  if (!blessed) return ok({ download: null });

  if (currentSha !== null && currentSha === blessed.sha256.toLowerCase()) {
    return ok({ download: null });
  }

  return ok({ download: blessed });
}
