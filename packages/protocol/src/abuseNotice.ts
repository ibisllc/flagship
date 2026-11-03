/**
 * Abuse reports, notices and suspensions (docs/abuse-handling.md).
 *
 * Anyone may report a voi.ci link or page, or a Flagship app by its hostname. An operator may send the account a
 * notice (what, why, what to do, by when); the account's admin marks it done with a signed note:
 *
 *   flagship/abuse-notice-done/v1|<username lowercase>|<noticeId>|<sha256 hex of the UTF-8 note>|<issuedAt>
 *
 * Ed25519, signed with the account's sensitive-order key (the admin root, or the IRK on an account that pins none),
 * checked by `.com` through `authorizeSensitiveComOp`. The note is hashed so it may hold any text; it travels beside
 * the signature and `.com` checks the hash.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_ABUSE_NOTICE_DONE = "flagship/abuse-notice-done/v1";

/** What a reporter may say a link or app is (the public form's list). */
export const ABUSE_REPORT_REASONS = [
  "spam",
  "phishing",
  "malware",
  "csam",
  "harassment",
  "impersonation",
  "copyright",
  "illegal",
  "other",
] as const;
export type AbuseReportReason = (typeof ABUSE_REPORT_REASONS)[number];

/** The category an operator names on a notice or a suspension. */
export const ABUSE_CATEGORIES = [
  "spam",
  "phishing",
  "active-phishing",
  "malware",
  "csam",
  "harassment",
  "impersonation",
  "copyright",
  "illegal",
  "other",
] as const;
export type AbuseCategory = (typeof ABUSE_CATEGORIES)[number];

/** The only categories an operator may suspend for before a notice's deadline (abuse.html "Response targets"). */
export const ABUSE_URGENT_CATEGORIES: readonly AbuseCategory[] = ["csam", "active-phishing", "malware"];

/** What the notice asks the account to do. */
export const ABUSE_NOTICE_ACTIONS = ["modify", "take-down"] as const;
export type AbuseNoticeAction = (typeof ABUSE_NOTICE_ACTIONS)[number];

/** What a notice is about. */
export const ABUSE_SUBJECT_KINDS = ["app", "page", "link", "box"] as const;
export type AbuseSubjectKind = (typeof ABUSE_SUBJECT_KINDS)[number];

export const ABUSE_NOTICE_NOTE_MAX = 1000;
const NOTICE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface AbuseNoticeDone {
  username: string;
  noticeId: string;
  note: string;
  issuedAt: number;
}

const enc = (s: string) => new TextEncoder().encode(s);

export function abuseNoteSha256Hex(note: string): string {
  return hex(sha256(enc(note)));
}

export function canonicalAbuseNoticeDone(d: AbuseNoticeDone): Bytes {
  const username = typeof d.username === "string" ? d.username.toLowerCase() : "";
  if (!USERNAME.test(username)) throw new Error(`${TAG_ABUSE_NOTICE_DONE}: bad username`);
  if (typeof d.noticeId !== "string" || !NOTICE_ID.test(d.noticeId)) throw new Error(`${TAG_ABUSE_NOTICE_DONE}: bad noticeId`);
  if (typeof d.note !== "string" || d.note.length > ABUSE_NOTICE_NOTE_MAX) throw new Error(`${TAG_ABUSE_NOTICE_DONE}: bad note`);
  if (typeof d.issuedAt !== "number" || !Number.isSafeInteger(d.issuedAt) || d.issuedAt <= 0) throw new Error(`${TAG_ABUSE_NOTICE_DONE}: bad issuedAt`);
  return enc([TAG_ABUSE_NOTICE_DONE, username, d.noticeId, abuseNoteSha256Hex(d.note), String(d.issuedAt)].join("|"));
}

export function signAbuseNoticeDone(d: AbuseNoticeDone, seed: Bytes): Bytes {
  return ed.sign(canonicalAbuseNoticeDone(d), seed);
}

export function verifyAbuseNoticeDone(d: AbuseNoticeDone, signature: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(signature, canonicalAbuseNoticeDone(d), pub);
  } catch {
    return false;
  }
}

export function isAbuseReportReason(v: unknown): v is AbuseReportReason {
  return typeof v === "string" && (ABUSE_REPORT_REASONS as readonly string[]).includes(v);
}

export function isAbuseCategory(v: unknown): v is AbuseCategory {
  return typeof v === "string" && (ABUSE_CATEGORIES as readonly string[]).includes(v);
}
