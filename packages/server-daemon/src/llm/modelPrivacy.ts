/**
 * What a model (the box's own AI, or an IDE agent over MCP) may learn about
 * the person it is building for: nothing. A compromised or curious AI
 * provider must not be able to tie a request to a Flagship account, a
 * server, the owner's other apps, their address, their time zone or locale,
 * or their habits. See docs/ai-privacy-and-staging.md.
 *
 * Prompts are written to carry no such facts in the first place; this is the
 * second line, applied to every box-generated text a model reads back (tool
 * results, deploy and build errors, container logs, build output, file
 * listings of the staging copy's data, journal summaries, GPU and local-model
 * errors). It is NOT applied to the repo's own files, which belong to the
 * repo, and rewriting them would corrupt the code the model edits.
 *
 * Every model-facing path is listed in `MODEL_BOUNDARY` (modelBoundary.ts);
 * tests/llm/redactionCoverage.test.ts fails when one skips this redactor.
 */

export interface ModelPrivacyTerms {
  /** The owner's account name. */
  username: string;
  /** The box's own address, e.g. `home3.plucky-avocet.flagship.services`. */
  serverFqdn: string;
  /** Anything else that names this owner or box (service ids, aliases). */
  extra?: string[];
  /** The machine's own host name (what `hostname` prints). */
  hostname?: string;
  /** People the box knows by name: the owner's display name, a git author name. */
  people?: string[];
  /** Email addresses the box knows belong to the owner (a git author email). */
  emails?: string[];
}

export type ModelRedactor = (text: string) => string;

export const PLACEHOLDER_HOST = "app.example";
export const PLACEHOLDER_USER = "owner";
export const PLACEHOLDER_EMAIL = "owner@example.com";
export const PLACEHOLDER_TIME = "2000-01-01T00:00:00Z";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** IANA zone names ("Europe/Berlin", "America/Argentina/Salta"): where the owner is. */
const TIME_ZONE = /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Z][A-Za-z_-]+(?:\/[A-Z][A-Za-z_-]+)?\b/g;
/** POSIX locales ("de_DE.UTF-8", "pt_BR@euro"): what language and country they live in. */
const LOCALE = /\b[a-z]{2,3}_[A-Z]{2}(?:\.[A-Za-z0-9-]+)?(?:@[a-z]+)?\b/g;
/** ISO 8601 date-times with a clock (and any offset): when the owner works. */
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:\s?(?:Z|[+-]\d{2}(?::?\d{2})?|UTC|GMT)\b)?/g;
/** RFC 1123 / HTTP dates ("Sat, 24 Oct 2026 14:03:11 GMT"). */
const HTTP_TIME = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} (?:GMT|UTC|[+-]\d{4})/g;
/** git's and ctime's dates ("Sat Oct 24 14:03:11 2026 +0200"). */
const GIT_TIME = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}(?: [+-]\d{4})?/g;
/** A numeric UTC offset on its own ("UTC+02:00"): the time zone without its name. */
const UTC_OFFSET = /\b(?:UTC|GMT)[+-]\d{1,2}(?::?\d{2})?\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
/** Domains that name nobody (sample data, documentation). */
const NEUTRAL_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|test|invalid|localhost|local)$/i;
/** Home folders carry the login name. */
const HOME_DIR = /(\/home\/|\/Users\/)([^/\s"'`:]+)/g;
const MAC = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi;

/** A redactor over the terms the box knows right now. */
export function buildModelRedactor(terms: () => ModelPrivacyTerms): ModelRedactor {
  return (text: string) => {
    if (!text) return text;
    const t = terms();
    let out = text;
    const fqdn = t.serverFqdn.toLowerCase();
    if (fqdn) {
      // Any name under the box's own address (`<app>.<server>.<user>…`) and
      // the address itself.
      out = out.replace(new RegExp(`([a-z0-9-]+\\.)*${escapeRe(fqdn)}`, "gi"), PLACEHOLDER_HOST);
    }
    // The account's own zone (`<app>.<user>.flagship.services`, tier-2 names).
    const user = t.username.toLowerCase();
    if (user) {
      out = out.replace(new RegExp(`([a-z0-9-]+\\.)*${escapeRe(user)}\\.flagship\\.services`, "gi"), PLACEHOLDER_HOST);
    }
    // Known addresses before the generic rule, so their domains don't survive either.
    for (const e of (t.emails ?? []).filter((x) => x.includes("@"))) {
      out = out.replace(new RegExp(escapeRe(e), "gi"), PLACEHOLDER_EMAIL);
    }
    out = out.replace(EMAIL, (m, domain: string) => (NEUTRAL_EMAIL_DOMAIN.test(domain) ? m : PLACEHOLDER_EMAIL));
    out = out.replace(HOME_DIR, (_m, root: string) => `${root}${PLACEHOLDER_USER}`);
    // The server's own short name ("home3", "kitchen") when it is distinctive enough to find.
    const label = fqdn.split(".")[0] ?? "";
    const shortName = label.length >= 5 || /\d/.test(label) ? [label] : [];
    // A person's name in any spelling a file or id would use, and each of its parts.
    const people = (t.people ?? []).flatMap((p) => {
      const parts = p.trim().split(/[\s._-]+/).filter((x) => x.length >= 3);
      return [p, ...["-", "_", ".", ""].map((sep) => parts.join(sep)), ...parts];
    });
    const names = [...(t.extra ?? []), ...people, t.hostname ?? "", ...shortName, user]
      .map((x) => x.trim())
      .filter((x) => x && x.length >= 3)
      .sort((a, b) => b.length - a.length);
    for (const term of names) {
      // Also as an identifier would spell it: `plucky-avocet` in `PLUCKY_AVOCET_TOKEN`.
      for (const spelling of new Set([term, term.replace(/[-.\s]/g, "_")])) {
        out = out.replace(new RegExp(`(?<![a-z0-9])${escapeRe(spelling)}(?![a-z0-9])`, "gi"), PLACEHOLDER_USER);
      }
    }
    // When and where: clock times, time zones and locales say when the owner works and where.
    out = out.replace(ISO_TIME, PLACEHOLDER_TIME);
    out = out.replace(HTTP_TIME, "Sat, 01 Jan 2000 00:00:00 GMT");
    out = out.replace(GIT_TIME, "Sat Jan 1 00:00:00 2000 +0000");
    out = out.replace(UTC_OFFSET, "UTC");
    out = out.replace(TIME_ZONE, "UTC");
    out = out.replace(LOCALE, "C.UTF-8");
    // Public addresses would place the owner on a map; private ones (the
    // container network) say nothing.
    out = out.replace(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g, (ip) => (PRIVATE_V4.test(ip) ? ip : "203.0.113.1"));
    // A network card's address is a serial number for the machine.
    out = out.replace(MAC, "02:00:00:00:00:00");
    out = out.replace(/(?<![0-9a-z:])(?:[0-9a-f]{1,4}(?::|::)){2,7}[0-9a-f]{0,4}(?![0-9a-z:])/gi, (ip) =>
      (ip.match(/:/g) ?? []).length < 3 || /^(fe80|fc|fd|02:00:00:00:00:00$)/i.test(ip) ? ip : "2001:db8::1",
    );
    return out;
  };
}

/** Pass-through, for paths with nothing box-specific to hide (tests, demos). */
export const noRedaction: ModelRedactor = (s) => s;
