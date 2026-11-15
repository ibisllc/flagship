/**
 * The org directory (docs/org-directory.md §2): each seat's (or pending person's) names, sealed under
 * the org directory key (`flagship/org-key-ring/v1`, kind `directory-key`, sealed to org admins only).
 *
 *   body   flagship/org-directory-entry/v1|body|<seatId>|<pendingId>|<pseudonym>|<displayName>|<email>|<externalId>|<source>|<groups>|<updatedAt>
 *   aad    flagship/org-directory-entry/v1|seal|<orgId>|<entryId>|<keyVersion>|<sizeBucket>
 *   key    HKDF-SHA256(directoryKey, info = flagship/org-directory-entry/v1|key|<orgId>|<entryId>|<keyVersion>)
 *   write  flagship/org-directory-entry/v1|<orgId>|<entryId>|<keyVersion>|<sizeBucket>|<sealedSha256>|<issuedAt>
 *
 * Every free-text field (pseudonym, names, email, external id, each group) travels as unpadded
 * base64url of its UTF-8, and groups are comma-joined, so no value can carry a `|` or a `,` and shift
 * a field boundary (AT-ENV-09). Exactly one of seatId / pendingId is set (32 hex), the other empty.
 * The sealed body is `nonce(12) || AES-256-GCM(len(u16be) || body || zero padding to sizeBucket)`, so
 * `.com` learns the bucket and nothing else. Writing an entry needs one org admin's approval over the
 * write form (the same weight as an invite); `.com` keeps the newest per entryId. Names never reach
 * `.com` unsealed and never enter a model prompt (owner rule, 2026-10-12).
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import { OrgAuthorityError, orgSha256Hex } from "./orgAuthority.js";
import type { Bytes } from "./types.js";

export const TAG_ORG_DIRECTORY_ENTRY = "flagship/org-directory-entry/v1";
export const ORG_DIRECTORY_BUCKETS: readonly number[] = [256, 512, 1024, 2048, 4096, 8192];
export const ORG_DIRECTORY_MAX_GROUPS = 32;
export const ORG_DIRECTORY_LIMITS = { pseudonym: 128, displayName: 256, email: 320, externalId: 256, group: 256 } as const;

const HEX16 = /^[0-9a-f]{32}$/;
const SOURCE = /^[a-z][a-z0-9-]{1,31}$/;
const B64U = /^[A-Za-z0-9_-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

const enc = (s: string): Bytes => new TextEncoder().encode(s);
const dec = (b: Bytes): string => new TextDecoder("utf-8", { fatal: true }).decode(b);
const fail = (detail: string): never => {
  throw new OrgAuthorityError("malformed", detail);
};
function uint(name: string, v: unknown): void {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(name);
}
function fromHex(s: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) fail("hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function b64uEncode(b: Bytes): string {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < b.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < b.length) out += B64[n & 63]!;
  }
  return out;
}
function b64uDecode(s: string): Bytes {
  if (!B64U.test(s) || s.length % 4 === 1) fail("base64url");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  const bytes = new Uint8Array(out);
  if (b64uEncode(bytes) !== s) fail("base64url not canonical");
  return bytes;
}

/** A free-text field: no control characters, at most `max` UTF-8 bytes, `required` means non-empty. */
function text(name: string, v: unknown, max: number, required = false): string {
  if (typeof v !== "string") return fail(name);
  if (required && v.trim().length === 0) fail(`${name} empty`);
  if (CONTROL.test(v) || enc(v).length > max || v !== v.normalize("NFC")) fail(name);
  return v;
}

export interface OrgDirectoryEntry {
  /** The seat this entry names (32 hex), or "" for a person not admitted yet. */
  seatId: string;
  /** A pending person (a connector's proposal, an invite not yet accepted), or "". */
  pendingId: string;
  /** The name the inviter chose; what the org's screens show. */
  pseudonym: string;
  displayName: string;
  email: string;
  externalId: string;
  /** `manual`, `scim`, `ldap` or a custom connector kind. */
  source: string;
  groups: string[];
  updatedAt: number;
}

export function checkOrgDirectoryEntry(e: OrgDirectoryEntry): void {
  if (e.seatId !== "" && !HEX16.test(e.seatId)) fail("seatId");
  if (e.pendingId !== "" && !HEX16.test(e.pendingId)) fail("pendingId");
  if ((e.seatId === "") === (e.pendingId === "")) fail("exactly one of seatId and pendingId");
  text("pseudonym", e.pseudonym, ORG_DIRECTORY_LIMITS.pseudonym, true);
  text("displayName", e.displayName, ORG_DIRECTORY_LIMITS.displayName);
  text("email", e.email, ORG_DIRECTORY_LIMITS.email);
  text("externalId", e.externalId, ORG_DIRECTORY_LIMITS.externalId);
  if (typeof e.source !== "string" || !SOURCE.test(e.source)) fail("source");
  if (!Array.isArray(e.groups) || e.groups.length > ORG_DIRECTORY_MAX_GROUPS) fail("groups");
  for (const g of e.groups) text("group", g, ORG_DIRECTORY_LIMITS.group, true);
  const sorted = [...e.groups].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((g, i) => g !== e.groups[i])) fail("groups not sorted and unique");
  uint("updatedAt", e.updatedAt);
}

const t = (s: string) => b64uEncode(enc(s));

export function canonicalOrgDirectoryEntryBody(e: OrgDirectoryEntry): Bytes {
  checkOrgDirectoryEntry(e);
  return enc(
    [
      TAG_ORG_DIRECTORY_ENTRY,
      "body",
      e.seatId,
      e.pendingId,
      t(e.pseudonym),
      t(e.displayName),
      t(e.email),
      t(e.externalId),
      e.source,
      e.groups.map(t).join(","),
      e.updatedAt,
    ].join("|"),
  );
}

/** Parses a body strictly: it must be exactly the canonical form of what it decodes to. */
export function parseOrgDirectoryEntryBody(bytes: Bytes): OrgDirectoryEntry {
  const s = dec(bytes);
  const p = s.split("|");
  if (p.length !== 11 || p[0] !== TAG_ORG_DIRECTORY_ENTRY || p[1] !== "body") fail("body");
  const txt = (x: string) => dec(b64uDecode(x));
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(p[10]!)) fail("updatedAt");
  const e: OrgDirectoryEntry = {
    seatId: p[2]!,
    pendingId: p[3]!,
    pseudonym: txt(p[4]!),
    displayName: txt(p[5]!),
    email: txt(p[6]!),
    externalId: txt(p[7]!),
    source: p[8]!,
    groups: p[9] === "" ? [] : p[9]!.split(",").map(txt),
    updatedAt: Number(p[10]),
  };
  if (dec(canonicalOrgDirectoryEntryBody(e)) !== s) fail("body not canonical");
  return e;
}

/** A sealed entry as `.com` stores it. */
export interface OrgDirectorySealed {
  orgId: string;
  /** Opaque, random per person; kept across updates of that person's entry. */
  entryId: string;
  /** The `directory-key` ring version it is sealed under. */
  keyVersion: number;
  sizeBucket: number;
  sealedHex: string;
  issuedAt: number;
}

function checkHeader(s: Pick<OrgDirectorySealed, "orgId" | "entryId" | "keyVersion" | "sizeBucket">): void {
  if (typeof s.orgId !== "string" || !HEX16.test(s.orgId)) fail("orgId");
  if (typeof s.entryId !== "string" || !HEX16.test(s.entryId)) fail("entryId");
  uint("keyVersion", s.keyVersion);
  if (s.keyVersion < 1) fail("keyVersion");
  if (!ORG_DIRECTORY_BUCKETS.includes(s.sizeBucket)) fail("sizeBucket");
}

function aad(s: Pick<OrgDirectorySealed, "orgId" | "entryId" | "keyVersion" | "sizeBucket">): Bytes {
  checkHeader(s);
  return enc([TAG_ORG_DIRECTORY_ENTRY, "seal", s.orgId, s.entryId, s.keyVersion, s.sizeBucket].join("|"));
}

/** What an org admin's approval signs to store (or replace) an entry on `.com`. */
export function canonicalOrgDirectoryWrite(s: OrgDirectorySealed): Bytes {
  checkHeader(s);
  if (typeof s.sealedHex !== "string" || s.sealedHex.length !== 2 * (12 + s.sizeBucket + 16)) fail("sealedHex length");
  uint("issuedAt", s.issuedAt);
  const sealedSha = orgSha256Hex(fromHex(s.sealedHex));
  return enc([TAG_ORG_DIRECTORY_ENTRY, s.orgId, s.entryId, s.keyVersion, s.sizeBucket, sealedSha, s.issuedAt].join("|"));
}

export function orgDirectoryEntryKey(directoryKey: Bytes, orgId: string, entryId: string, keyVersion: number): Bytes {
  if (directoryKey.length !== 32) fail("directory key");
  if (!HEX16.test(orgId) || !HEX16.test(entryId)) fail("ids");
  uint("keyVersion", keyVersion);
  return hkdf(sha256, directoryKey, new Uint8Array(0), enc([TAG_ORG_DIRECTORY_ENTRY, "key", orgId, entryId, keyVersion].join("|")), 32);
}

export function orgDirectoryBucket(bodyLength: number): number {
  const b = ORG_DIRECTORY_BUCKETS.find((x) => x >= bodyLength + 2);
  if (b === undefined) fail("entry too large");
  return b!;
}

export function sealOrgDirectoryEntry(args: {
  orgId: string;
  entryId: string;
  keyVersion: number;
  directoryKey: Bytes;
  entry: OrgDirectoryEntry;
  issuedAt: number;
  /** Vectors only: a fixed 12-byte nonce. */
  nonce?: Bytes;
}): OrgDirectorySealed {
  const body = canonicalOrgDirectoryEntryBody(args.entry);
  const sizeBucket = orgDirectoryBucket(body.length);
  const header = { orgId: args.orgId, entryId: args.entryId, keyVersion: args.keyVersion, sizeBucket };
  const padded = new Uint8Array(sizeBucket);
  padded[0] = body.length >> 8;
  padded[1] = body.length & 255;
  padded.set(body, 2);
  const nonce = args.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (nonce.length !== 12) fail("nonce");
  const key = orgDirectoryEntryKey(args.directoryKey, args.orgId, args.entryId, args.keyVersion);
  const ct = gcm(key, nonce, aad(header)).encrypt(padded);
  const sealed = new Uint8Array(12 + ct.length);
  sealed.set(nonce, 0);
  sealed.set(ct, 12);
  const out: OrgDirectorySealed = { ...header, sealedHex: hex(sealed), issuedAt: args.issuedAt };
  canonicalOrgDirectoryWrite(out);
  return out;
}

/** Opens a sealed entry with the directory key of its version. Throws on any mismatch. */
export function openOrgDirectoryEntry(s: OrgDirectorySealed, directoryKey: Bytes): OrgDirectoryEntry {
  canonicalOrgDirectoryWrite(s);
  const sealed = fromHex(s.sealedHex);
  const key = orgDirectoryEntryKey(directoryKey, s.orgId, s.entryId, s.keyVersion);
  let padded: Bytes;
  try {
    padded = gcm(key, sealed.subarray(0, 12), aad(s)).decrypt(sealed.subarray(12));
  } catch {
    return fail("does not open");
  }
  const len = (padded[0]! << 8) | padded[1]!;
  if (len + 2 > padded.length || padded.subarray(2 + len).some((x) => x !== 0)) fail("padding");
  return parseOrgDirectoryEntryBody(padded.subarray(2, 2 + len));
}

export interface OrgDirectoryView {
  /** Newest entry per seat. */
  bySeat: Map<string, OrgDirectoryEntry & { entryId: string }>;
  /** Newest entry per pending person. */
  byPending: Map<string, OrgDirectoryEntry & { entryId: string }>;
  /** Entries that did not open (another key version, damaged, or not for this org). */
  unopened: string[];
}

/**
 * Opens every sealed entry with the directory keys this admin holds (version → key) and keeps the
 * newest per person (by `updatedAt`, then `issuedAt`). An entry whose seatId another entry already
 * claims with a newer `updatedAt` loses, so a replayed older entry cannot rename someone.
 */
export function openOrgDirectory(orgId: string, sealed: readonly OrgDirectorySealed[], keys: ReadonlyMap<number, Bytes>): OrgDirectoryView {
  const bySeat: OrgDirectoryView["bySeat"] = new Map();
  const byPending: OrgDirectoryView["byPending"] = new Map();
  const unopened: string[] = [];
  for (const s of sealed) {
    const k = keys.get(s?.keyVersion);
    if (!k || s.orgId !== orgId) {
      unopened.push(String(s?.entryId));
      continue;
    }
    let e: OrgDirectoryEntry;
    try {
      e = openOrgDirectoryEntry(s, k);
    } catch {
      unopened.push(s.entryId);
      continue;
    }
    const map = e.seatId !== "" ? bySeat : byPending;
    const id = e.seatId !== "" ? e.seatId : e.pendingId;
    const prev = map.get(id);
    if (!prev || prev.updatedAt < e.updatedAt) map.set(id, { ...e, entryId: s.entryId });
  }
  return { bySeat, byPending, unopened };
}

/** The name a screen shows for a seat: its pseudonym, else null (the screen says "a person"). */
export function orgDirectoryName(view: Pick<OrgDirectoryView, "bySeat">, seatId: string): string | null {
  return view.bySeat.get(seatId)?.pseudonym ?? null;
}

