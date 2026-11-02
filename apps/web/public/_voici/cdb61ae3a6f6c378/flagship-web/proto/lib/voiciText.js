// voi.ci text rules, links, known sites and visitor names (docs/voici-and-messages.md §2.4, §2.6, §6.2, §7.2,
// §12.1). Browser twin of packages/protocol/src/voiciText.ts (+ voiciLinkSites.json, embedded below; the vectors
// test asserts it equals the shared table) and voiciPseudonymName.ts. Import it through lib/voiciProtocol.js.
//
// Exported API: VOICI_TEXT_RULES, checkVoiciText, prepareVoiciText, VOICI_LINK_URL_MAX, checkVoiciLinkUrl,
// voiciUrlHost, findVoiciLinks, VOICI_LINK_SITES, voiciLinkSite, voiciPseudonymCode, voiciPseudonymName.

import { hexToBytes, isLowerHex, sha256 } from "./voiciCore.js";

/** min/max in code points after NFC; `newline` = "\n" allowed. */
export const VOICI_TEXT_RULES = {
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

const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060]);

/** Checks a stored (already NFC) value; returns the refusal code or null. */
export function checkVoiciText(field, s) {
  if (typeof s !== "string") return "not-string";
  const rule = VOICI_TEXT_RULES[field];
  const cps = [];
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
  if (cps.length > 0 && (INVISIBLE.has(cps[0]) || INVISIBLE.has(cps[cps.length - 1]))) return "edge-invisible";
  if (s.normalize("NFC") !== s) return "not-nfc";
  if (cps.length < rule.min) return "too-short";
  if (cps.length > rule.max) return "too-long";
  return null;
}

/** Normalizes to NFC, then checks: {ok:true, text} | {ok:false, code}. */
export function prepareVoiciText(field, s) {
  if (typeof s !== "string") return { ok: false, code: "not-string" };
  let n;
  try {
    n = s.normalize("NFC");
  } catch {
    return { ok: false, code: "surrogate" };
  }
  const code = checkVoiciText(field, n);
  return code ? { ok: false, code } : { ok: true, text: n };
}

// ── URLs ──────────────────────────────────────────────────────────────────

export const VOICI_LINK_URL_MAX = 512;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = `${LABEL}(?:\\.${LABEL})+`;
const PATH_CHARS = "A-Za-z0-9\\-._~/?#\\[\\]@!$&'()*+,;=%";
const HTTPS_URL = new RegExp(`^https://(${HOST})(?::([0-9]{1,5}))?([/?#][${PATH_CHARS}]*)?$`);
const MAILTO = /^mailto:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

/** A profile or post link; returns "not-string" | "too-long" | "scheme" | "malformed" | null. */
export function checkVoiciLinkUrl(url, allowMailto = false) {
  if (typeof url !== "string") return "not-string";
  if (url.length > VOICI_LINK_URL_MAX) return "too-long";
  if (url.startsWith("mailto:")) return allowMailto && MAILTO.test(url) ? null : allowMailto ? "malformed" : "scheme";
  if (!url.startsWith("https://")) return "scheme";
  const m = HTTPS_URL.exec(url);
  if (!m) return "malformed";
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return "malformed";
  return null;
}

/** The host shown under a link (the mail domain for mailto:), or null when the URL is refused. */
export function voiciUrlHost(url) {
  if (checkVoiciLinkUrl(url, true) !== null) return null;
  if (url.startsWith("mailto:")) return MAILTO.exec(url)[1];
  return HTTPS_URL.exec(url)[1];
}

const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "'", '"', "]"]);
const SCAN = new RegExp(`https://(${HOST})([/?#][${PATH_CHARS}]*)?`, "gi");

/** The links in message text: [{start, end, url, host}] (UTF-16 offsets, [start, end)). */
export function findVoiciLinks(text) {
  const out = [];
  SCAN.lastIndex = 0;
  let m;
  while ((m = SCAN.exec(text)) !== null) {
    const start = m.index;
    const prev = start > 0 ? text[start - 1] : "";
    if (/[A-Za-z0-9]/.test(prev)) continue;
    const hostEnd = start + 8 + m[1].length;
    const after = text[hostEnd] ?? "";
    if (after === "@" || after === ":" || /[A-Za-z0-9-]/.test(after)) {
      if (after === "@" || after === ":") SCAN.lastIndex = Math.max(SCAN.lastIndex, hostEnd + 1);
      continue;
    }
    let raw = m[0];
    while (raw.length > 8 + m[1].length && TRAILING.has(raw[raw.length - 1])) raw = raw.slice(0, -1);
    if (raw.length > 2048) continue;
    const host = m[1].toLowerCase();
    out.push({ start, end: start + raw.length, url: "https://" + host + raw.slice(8 + m[1].length), host });
  }
  return out;
}

// ── known sites (packages/protocol/src/voiciLinkSites.json) ──────────────

export const VOICI_LINK_SITES = Object.freeze([
  {id: "github", hosts: ["github.com"], label: "GitHub"},
  {id: "gitlab", hosts: ["gitlab.com"], label: "GitLab"},
  {id: "codeberg", hosts: ["codeberg.org"], label: "Codeberg"},
  {id: "mastodon", hosts: ["mastodon.social","mastodon.online"], label: "Mastodon"},
  {id: "bluesky", hosts: ["bsky.app"], label: "Bluesky"},
  {id: "linkedin", hosts: ["linkedin.com"], label: "LinkedIn"},
  {id: "instagram", hosts: ["instagram.com"], label: "Instagram"},
  {id: "youtube", hosts: ["youtube.com","youtu.be"], label: "YouTube"},
  {id: "tiktok", hosts: ["tiktok.com"], label: "TikTok"},
  {id: "x", hosts: ["x.com","twitter.com"], label: "X"},
  {id: "threads", hosts: ["threads.net","threads.com"], label: "Threads"},
  {id: "facebook", hosts: ["facebook.com","fb.com"], label: "Facebook"},
  {id: "twitch", hosts: ["twitch.tv"], label: "Twitch"},
  {id: "substack", hosts: ["substack.com"], label: "Substack"},
  {id: "medium", hosts: ["medium.com"], label: "Medium"},
  {id: "patreon", hosts: ["patreon.com"], label: "Patreon"},
  {id: "kofi", hosts: ["ko-fi.com"], label: "Ko-fi"},
  {id: "buymeacoffee", hosts: ["buymeacoffee.com"], label: "Buy Me a Coffee"},
  {id: "spotify", hosts: ["open.spotify.com","spotify.com"], label: "Spotify"},
  {id: "soundcloud", hosts: ["soundcloud.com"], label: "SoundCloud"},
  {id: "bandcamp", hosts: ["bandcamp.com"], label: "Bandcamp"},
  {id: "applemusic", hosts: ["music.apple.com"], label: "Apple Music"},
  {id: "behance", hosts: ["behance.net"], label: "Behance"},
  {id: "dribbble", hosts: ["dribbble.com"], label: "Dribbble"},
  {id: "stackoverflow", hosts: ["stackoverflow.com"], label: "Stack Overflow"},
  {id: "reddit", hosts: ["reddit.com"], label: "Reddit"},
  {id: "discord", hosts: ["discord.gg","discord.com"], label: "Discord"},
  {id: "telegram", hosts: ["t.me","telegram.me"], label: "Telegram"},
  {id: "signal", hosts: ["signal.me","signal.group"], label: "Signal"},
  {id: "whatsapp", hosts: ["wa.me","whatsapp.com"], label: "WhatsApp"},
  {id: "pinterest", hosts: ["pinterest.com"], label: "Pinterest"},
  {id: "tumblr", hosts: ["tumblr.com"], label: "Tumblr"},
  {id: "flickr", hosts: ["flickr.com"], label: "Flickr"},
  {id: "vimeo", hosts: ["vimeo.com"], label: "Vimeo"},
  {id: "etsy", hosts: ["etsy.com"], label: "Etsy"},
  {id: "goodreads", hosts: ["goodreads.com"], label: "Goodreads"},
  {id: "letterboxd", hosts: ["letterboxd.com"], label: "Letterboxd"},
  {id: "strava", hosts: ["strava.com"], label: "Strava"},
  {id: "orcid", hosts: ["orcid.org"], label: "ORCID"},
  {id: "keybase", hosts: ["keybase.io"], label: "Keybase"},
  {id: "flagship", hosts: ["flagship.services","voi.ci"], label: "Flagship"},
  {id: "email", hosts: [], label: "Email"},
]);
const MASTODON_PATH = /^\/@[A-Za-z0-9_]{1,30}(?:@[a-z0-9.-]+)?\/?$/;

/** The site id for a link's icon ("email" for mailto:, a table id, "mastodon" for a /@user path), or null. */
export function voiciLinkSite(url) {
  const host = voiciUrlHost(url);
  if (host === null) return null;
  if (url.startsWith("mailto:")) return "email";
  for (const s of VOICI_LINK_SITES) {
    if (s.hosts.some((h) => host === h || host.endsWith("." + h))) return s.id;
  }
  const rest = HTTPS_URL.exec(url)[3] ?? "";
  const path = rest.split(/[?#]/)[0];
  return MASTODON_PATH.test(path) ? "mastodon" : null;
}

// ── visitor names (§6.2) ──────────────────────────────────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes) {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 0x1f];
  return out;
}

/** Four base32 characters of SHA-256 over the raw 32-byte pseudonym key. */
export function voiciPseudonymCode(pseudonymPubHex) {
  if (!isLowerHex(pseudonymPubHex, 32)) throw new Error("pseudonym key must be 32 bytes of lowercase hex");
  return base32Encode(sha256(hexToBytes(pseudonymPubHex))).slice(0, 4);
}

export function voiciPseudonymName(pseudonymPubHex, prefix = "Visitor ") {
  return prefix + voiciPseudonymCode(pseudonymPubHex);
}
