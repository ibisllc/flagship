/**
 * The owner's approval to download a server backup in a browser
 * (docs/server-backup-and-clone.md, "Download in a browser").
 *
 *   flagship/archive-download/v1|<serverDomain>|<archiveId>|<requestId>|<issuedAt ms>
 *
 * The browser's download page (served by the box) shows a QR naming a fresh
 * `requestId`; the owner's app shows the same 6-digit code, asks for Face ID,
 * and signs this with the sensitive-order key. The box verifies it under its
 * pinned authority and only then serves the file to requests carrying that
 * `requestId`. The approval is the signature, never a flag the box takes on
 * trust.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_ARCHIVE_DOWNLOAD = "flagship/archive-download/v1";

export interface ArchiveDownloadApproval {
  /** The box holding the backup (its FQDN). */
  serverDomain: string;
  /** The backup's id (16 bytes, lowercase hex). */
  archiveId: string;
  /** The browser page's one-time request id (16 bytes, lowercase hex). */
  requestId: string;
  /** Unix ms. */
  issuedAt: number;
}

const HEX32 = /^[0-9a-f]{32}$/;

export function archiveDownloadCanonicalBytes(a: ArchiveDownloadApproval): Bytes {
  if (a.serverDomain.length === 0) throw new Error("archive-download: empty serverDomain");
  legacyFieldGuard("serverDomain", a.serverDomain);
  if (!HEX32.test(a.archiveId)) throw new Error("archive-download: bad archiveId");
  if (!HEX32.test(a.requestId)) throw new Error("archive-download: bad requestId");
  if (!Number.isSafeInteger(a.issuedAt) || a.issuedAt < 0) throw new Error("archive-download: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_ARCHIVE_DOWNLOAD, a.serverDomain, a.archiveId, a.requestId, String(a.issuedAt)].join("|"),
  );
}

export function signArchiveDownloadApproval(a: ArchiveDownloadApproval, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(archiveDownloadCanonicalBytes(a));
}

/** Never throws: a malformed approval simply fails. */
export function verifyArchiveDownloadApproval(a: ArchiveDownloadApproval, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, archiveDownloadCanonicalBytes(a), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON approval (no signature check). */
export function parseArchiveDownloadApproval(v: unknown): ArchiveDownloadApproval | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.archiveId !== "string" || typeof r.requestId !== "string") return null;
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt)) return null;
  const a: ArchiveDownloadApproval = { serverDomain: r.serverDomain, archiveId: r.archiveId, requestId: r.requestId, issuedAt: r.issuedAt };
  try {
    archiveDownloadCanonicalBytes(a);
  } catch {
    return null;
  }
  return a;
}

/**
 * The 6-digit code the download page and the approving app both show, so the
 * owner can see that the QR they scanned is the page in front of them.
 */
export function archiveDownloadCode(requestId: string): string {
  if (!HEX32.test(requestId)) throw new Error("archive-download: bad requestId");
  return String(Number.parseInt(requestId.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}
