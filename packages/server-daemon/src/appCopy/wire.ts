/**
 * What the two boxes of a copy say to each other (docs/app-placement.md §5).
 *
 * The target fetches from the source's public HTTPS surface:
 *
 *   POST /api/app-copy/export
 *     { from, grant, signature, part, offset, issuedAt, auth }
 *
 * `grant` + `signature` are the owner's `flagship/app-copy/v1` order; `auth`
 * is the TARGET box's identity-key signature over
 *
 *   flagship/app-copy-fetch/v1|<from>|<to>|<serviceId>|<grant.issuedAt>|<owner signature hex>|<part>|<offset>|<issuedAt>
 *
 * which the source checks against the key `.com`'s server directory holds for
 * `from` (and refuses a revoked one), exactly like peer backup's frames
 * (peerBackup/httpPeerLink.ts). `part` is `meta` (poll until the source has
 * made the bundle; then the bundle's description), a data part (`image`,
 * `db:<store>`, `files`, and `source`: the working tree of an app built on the
 * source, as `{files, binaries}` JSON) read in chunks from `offset`, or `done`.
 *
 * Owner env values ride only sealed under a key both boxes derive from the
 * account's shared gossip key (CGK); a box without it sends the names alone.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { AppCopyGrant } from "@flagship/protocol";
import type { AppMembershipSnapshot } from "../membership.js";

export const APP_COPY_EXPORT_PATH = "/api/app-copy/export";
export const TAG_APP_COPY_FETCH = "flagship/app-copy-fetch/v1";
const TAG_APP_COPY_ENV = "flagship/app-copy-env/v1";

/** Bytes a data-part response carries at most. */
export const APP_COPY_CHUNK_BYTES = 8 * 1024 * 1024;

export const PART_RE = /^(meta|done|image|files|source|db:[A-Za-z0-9_-]{1,63})$/;

export interface FetchEnvelope {
  from: string;
  to: string;
  serviceId: string;
  grantIssuedAt: number;
  grantSignature: string;
  part: string;
  offset: number;
  issuedAt: number;
}

export function fetchEnvelopeBytes(e: FetchEnvelope): Uint8Array {
  return new TextEncoder().encode(
    [
      TAG_APP_COPY_FETCH,
      e.from,
      e.to,
      e.serviceId,
      String(e.grantIssuedAt),
      e.grantSignature.toLowerCase(),
      e.part,
      String(e.offset),
      String(e.issuedAt),
    ].join("|"),
  );
}

export interface ExportRequestBody {
  from: string;
  grant: AppCopyGrant;
  signature: string;
  part: string;
  offset: number;
  issuedAt: number;
  auth: string;
}

export interface CopyAccessEntry {
  mode: "open" | "restricted";
  allow: string[];
  groups: Record<string, string[]>;
}

export interface SealedEnv {
  nonce: string;
  ciphertext: string;
}

/** The bundle's description: the source's answer to `meta` once it is ready. */
export interface CopyMeta {
  v: 1;
  serviceId: string;
  creator: string;
  slug: string;
  manifestJson: string;
  appliedMigrations: string[];
  parts: Array<{ name: string; bytes: number; sha256: string }>;
  /** Who may reach the app (mode + allow-list); null when it has no entry. */
  access: CopyAccessEntry | null;
  membership: AppMembershipSnapshot | null;
  env: { names: string[]; sealed?: SealedEnv };
  /** The owner-signed access list the source enforces; null on the default list. */
  accessList: string | null;
}

export interface EnvContext {
  sourceServer: string;
  targetServer: string;
  serviceId: string;
  grantIssuedAt: number;
}

/** Derives the account-shared env key from `info` (KeyCustodian.deriveAppCopyEnvKey). */
export type CopyEnvKey = (info: Uint8Array) => Uint8Array;

export function envInfo(c: EnvContext): Buffer {
  return Buffer.from([TAG_APP_COPY_ENV, c.sourceServer, c.targetServer, c.serviceId, String(c.grantIssuedAt)].join("|"));
}

/** The same derivation from a raw CGK (tests; the box goes through its custodian). */
export function copyEnvKeyFromCgk(cgk: Uint8Array): CopyEnvKey {
  return (info) => new Uint8Array(hkdfSync("sha256", cgk, Buffer.alloc(0), info, 32));
}

function envKey(key: CopyEnvKey, c: EnvContext): Buffer {
  return Buffer.from(key(envInfo(c)));
}

export function sealCopyEnv(env: Record<string, string>, key: CopyEnvKey, c: EnvContext): SealedEnv {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", envKey(key, c), nonce);
  cipher.setAAD(envInfo(c));
  const ct = Buffer.concat([cipher.update(JSON.stringify(env), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString("hex"), ciphertext: ct.toString("hex") };
}

/** Null when this box's key can't open it (another account's, or none). */
export function openCopyEnv(sealed: SealedEnv, key: CopyEnvKey, c: EnvContext): Record<string, string> | null {
  try {
    const ct = Buffer.from(sealed.ciphertext, "hex");
    if (ct.length < 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", envKey(key, c), Buffer.from(sealed.nonce, "hex"));
    decipher.setAAD(envInfo(c));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8");
    const v = JSON.parse(plain) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val !== "string") return null;
      out[k] = val;
    }
    return out;
  } catch {
    return null;
  }
}

/** `home.harry.flagship.services` → `harry.flagship.services`: the account's zone. */
export function accountZone(serverFqdn: string): string {
  const i = serverFqdn.indexOf(".");
  return i < 0 ? "" : serverFqdn.slice(i + 1).toLowerCase();
}

export function sameAccount(a: string, b: string): boolean {
  const za = accountZone(a);
  return za.length > 0 && za.includes(".") && za === accountZone(b);
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(h: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) return null;
  return new Uint8Array(Buffer.from(h, "hex"));
}

/** The `source` part: an app's working tree (text files, and the rest as base64). */
export interface CopySourceTree {
  files: Record<string, string>;
  binaries: Record<string, string>;
}
