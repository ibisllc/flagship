/**
 * The owner's order to copy an installed app from one of their servers to
 * another (docs/app-placement.md §5), signed by the sensitive-order key
 * (admin root when held, else the owner IRK):
 *
 *   flagship/app-copy/v1|<sourceServer>|<targetServer>|<serviceId>|<issuedAt ms>
 *
 * The phone sends it to the TARGET box, which presents it to the source when
 * it fetches the app; both boxes verify it and each checks that it names
 * itself in its own role.
 *
 * `test-vectors/app-copy/vectors.json` is the cross-platform reference.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_APP_COPY = "flagship/app-copy/v1";

export interface AppCopyGrant {
  /** The box the app is copied from (its FQDN). */
  sourceServer: string;
  /** The box the app is copied onto (its FQDN). */
  targetServer: string;
  /** The installed service, `<creator>--<slug>`. */
  serviceId: string;
  /** Unix ms. */
  issuedAt: number;
}

export function appCopyGrantCanonicalBytes(g: AppCopyGrant): Bytes {
  if (g.sourceServer.length === 0) throw new Error("app-copy: empty sourceServer");
  if (g.targetServer.length === 0) throw new Error("app-copy: empty targetServer");
  if (g.serviceId.length === 0) throw new Error("app-copy: empty serviceId");
  legacyFieldGuard("sourceServer", g.sourceServer);
  legacyFieldGuard("targetServer", g.targetServer);
  legacyFieldGuard("serviceId", g.serviceId);
  if (!Number.isSafeInteger(g.issuedAt) || g.issuedAt < 0) throw new Error("app-copy: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_COPY, g.sourceServer, g.targetServer, g.serviceId, String(g.issuedAt)].join("|"),
  );
}

export function signAppCopyGrant(g: AppCopyGrant, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appCopyGrantCanonicalBytes(g));
}

/** Never throws: a malformed grant simply fails. */
export function verifyAppCopyGrant(g: AppCopyGrant, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appCopyGrantCanonicalBytes(g), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON grant (no signature check). */
export function parseAppCopyGrant(v: unknown): AppCopyGrant | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.sourceServer !== "string" || typeof r.targetServer !== "string" || typeof r.serviceId !== "string") {
    return null;
  }
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt)) return null;
  const g: AppCopyGrant = {
    sourceServer: r.sourceServer,
    targetServer: r.targetServer,
    serviceId: r.serviceId,
    issuedAt: r.issuedAt,
  };
  try {
    appCopyGrantCanonicalBytes(g);
  } catch {
    return null;
  }
  return g;
}
