/**
 * Text rules for voi.ci pages and Messages (docs/voici-and-messages.md §2.4, §2.6, §7.2, §12.1): NFC, length in
 * Unicode code points after NFC, and the refusals every client and `.com` apply alike; the strict link matcher that
 * turns `https://` URLs in message text into tappable links; the profile link URL grammar; and the known-site table
 * (`voiciLinkSites.json`) that picks a link's icon.
 *
 * Refused everywhere: C0 controls except "\n" where a field allows newlines, DEL, C1 controls (U+0080-U+009F), the
 * bidi controls U+202A-U+202E and U+2066-U+2069, U+FEFF, lone surrogates, and an invisible (U+200B-U+200D, U+2060)
 * at the start or the end. A stored field must already be NFC (`not-nfc`); `prepareVoiciText` normalizes first.
 *
 * Exported API: VOICI_TEXT_RULES, VoiciTextField, VoiciTextRefusal, checkVoiciText, prepareVoiciText,
 * VOICI_LINK_URL_MAX, checkVoiciLinkUrl, voiciUrlHost, VoiciLinkMatch, findVoiciLinks, VoiciLinkSite,
 * VOICI_LINK_SITES, voiciLinkSite.
 */
import sitesTable from "./voiciLinkSites.json" with { type: "json" };

export type VoiciTextField =
  | "displayName"
  | "bio"
  | "linkLabel"
  | "postText"
  | "messageText"
  | "cardTitle"
  | "cardSite"
  | "cardDescription"
  | "nickname"
  | "reportNote";

/** min/max in code points after NFC; `newline` = "\n" allowed. */
export const VOICI_TEXT_RULES: Record<VoiciTextField, { min: number; max: number; newline: boolean }> = {
  displayName: { min: 1, max: 64, newline: false },
  bio: { min: 0, max: 280, newline: true },
  linkLabel: { min: 1, max: 40, newline: false },
  postText: { min: 1, max: 2000, newline: true },
  messageText: { min: 1, max: 2000, newline: true },
  cardTitle: { min: 1, max: 120, newline: false },
  cardSite: { min: 0, max: 60, newline: false },
  cardDescription: { min: 0, max: 200, newline: false },
  nickname: { min: 1, max: 40, newline: false },
  reportNote: { min: 0, max: 500, newline: true },
};

export type VoiciTextRefusal = "not-string" | "not-nfc" | "too-short" | "too-long" | "control" | "bidi" | "bom" | "surrogate" | "edge-invisible";

const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060]);

/** Checks a stored (already NFC) value against a field's rule. */
export function checkVoiciText(field: VoiciTextField, s: unknown): VoiciTextRefusal | null {
  if (typeof s !== "string") return "not-string";
  const rule = VOICI_TEXT_RULES[field];
  const cps: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return "surrogate";
      cps.push(((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000);
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return "surrogate";
    cps.push(c);
  }
  for (const c of cps) {
    if (c === 0x0a && rule.newline) continue;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return "control";
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return "bidi";
    if (c === 0xfeff) return "bom";
  }
  if (cps.length > 0 && (INVISIBLE.has(cps[0]!) || INVISIBLE.has(cps[cps.length - 1]!))) return "edge-invisible";
  if (s.normalize("NFC") !== s) return "not-nfc";
  if (cps.length < rule.min) return "too-short";
  if (cps.length > rule.max) return "too-long";
  return null;
}

/** Normalizes to NFC, then checks; what an editor or the compose box calls on typed text. */
export function prepareVoiciText(field: VoiciTextField, s: string): { ok: true; text: string } | { ok: false; code: VoiciTextRefusal } {
  if (typeof s !== "string") return { ok: false, code: "not-string" };
  let n: string;
  try {
    n = s.normalize("NFC");
  } catch {
    return { ok: false, code: "surrogate" };
  }
  const code = checkVoiciText(field, n);
  return code ? { ok: false, code } : { ok: true, text: n };
}

// ── URLs ───────────────────────────────────────────────────────────────────

export const VOICI_LINK_URL_MAX = 512;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = `${LABEL}(?:\\.${LABEL})+`;
const PATH_CHARS = "A-Za-z0-9\\-._~/?#\\[\\]@!$&'()*+,;=%";
const HTTPS_URL = new RegExp(`^https://(${HOST})(?::([0-9]{1,5}))?([/?#][${PATH_CHARS}]*)?$`);
const MAILTO = /^mailto:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

/**
 * A profile or post link: `https://<lowercase ASCII host>[:port][path]` (no userinfo, no spaces, punycode for IDNs),
 * or, when `allowMailto`, `mailto:<addr>`. At most 512 characters. Returns the refusal or null.
 */
export function checkVoiciLinkUrl(url: unknown, allowMailto = false): "not-string" | "too-long" | "scheme" | "malformed" | null {
  if (typeof url !== "string") return "not-string";
  if (url.length > VOICI_LINK_URL_MAX) return "too-long";
  if (url.startsWith("mailto:")) return allowMailto && MAILTO.test(url) ? null : allowMailto ? "malformed" : "scheme";
  if (!url.startsWith("https://")) return "scheme";
  const m = HTTPS_URL.exec(url);
  if (!m) return "malformed";
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return "malformed";
  return null;
}

/** The host shown under a link (lowercase; the mail domain for mailto:), or null when the URL is refused. */
export function voiciUrlHost(url: string): string | null {
  if (checkVoiciLinkUrl(url, true) !== null) return null;
  if (url.startsWith("mailto:")) return MAILTO.exec(url)![1]!;
  return HTTPS_URL.exec(url)![1]!;
}

export interface VoiciLinkMatch {
  /** UTF-16 offsets into the text, [start, end). */
  start: number;
  end: number;
  url: string;
  host: string;
}

const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "'", '"', "]"]);
const SCAN = new RegExp(`https://(${HOST})([/?#][${PATH_CHARS}]*)?`, "gi");

/**
 * The links in message text: `https://` (any case) + a host of at least two labels + an optional path, preceded by
 * the start or a non-alphanumeric character. A URL whose host is followed by "@" (userinfo) or ":" (port) is not a
 * link at all; trailing `.,;:!?)'"]` are left out; longer than 2,048 characters is not a link. The URL is returned
 * with "https://" and the host lowercased.
 */
export function findVoiciLinks(text: string): VoiciLinkMatch[] {
  const out: VoiciLinkMatch[] = [];
  SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCAN.exec(text)) !== null) {
    const start = m.index;
    const prev = start > 0 ? text[start - 1]! : "";
    if (/[A-Za-z0-9]/.test(prev)) continue;
    const hostEnd = start + 8 + m[1]!.length;
    const after = text[hostEnd] ?? "";
    if (after === "@" || after === ":" || /[A-Za-z0-9-]/.test(after)) {
      if (after === "@" || after === ":") SCAN.lastIndex = Math.max(SCAN.lastIndex, hostEnd + 1);
      continue;
    }
    let raw = m[0];
    while (raw.length > 8 + m[1]!.length && TRAILING.has(raw[raw.length - 1]!)) raw = raw.slice(0, -1);
    if (raw.length > 2048) continue;
    const host = m[1]!.toLowerCase();
    out.push({ start, end: start + raw.length, url: "https://" + host + raw.slice(8 + m[1]!.length), host });
  }
  return out;
}

// ── known sites ────────────────────────────────────────────────────────────

export interface VoiciLinkSite {
  id: string;
  hosts: string[];
  label: string;
}

export const VOICI_LINK_SITES: readonly VoiciLinkSite[] = sitesTable as VoiciLinkSite[];
const MASTODON_PATH = /^\/@[A-Za-z0-9_]{1,30}(?:@[a-z0-9.-]+)?\/?$/;

/**
 * The site id for a link's icon: "email" for mailto:, a table entry whose host equals the URL's host or is a suffix
 * of it at a dot, else "mastodon" for a `/@user` path on any host, else null. Null for a refused URL.
 */
export function voiciLinkSite(url: string): string | null {
  const host = voiciUrlHost(url);
  if (host === null) return null;
  if (url.startsWith("mailto:")) return "email";
  for (const s of VOICI_LINK_SITES) {
    if (s.hosts.some((h) => host === h || host.endsWith("." + h))) return s.id;
  }
  const rest = HTTPS_URL.exec(url)![3] ?? "";
  const path = rest.split(/[?#]/)[0]!;
  return MASTODON_PATH.test(path) ? "mastodon" : null;
}
