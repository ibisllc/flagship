/**
 * What a model (the box's own AI, or an IDE agent over MCP) may learn about
 * the person it is building for: nothing. A compromised or curious AI
 * provider must not be able to tie a request to a Flagship account, a
 * server, the owner's other apps, their address or their time zone. See
 * docs/ai-privacy-and-staging.md.
 *
 * Prompts are written to carry no such facts in the first place; this is the
 * second line, applied to every box-generated text a model reads back (tool
 * results, deploy errors, container logs, journal summaries). It is NOT
 * applied to the repo's own files, which belong to the repo, and rewriting
 * them would corrupt the code the model edits.
 */

export interface ModelPrivacyTerms {
  /** The owner's account name. */
  username: string;
  /** The box's own address, e.g. `home3.plucky-avocet.flagship.services`. */
  serverFqdn: string;
  /** Anything else that names this owner or box (service ids, aliases). */
  extra?: string[];
}

export type ModelRedactor = (text: string) => string;

const PLACEHOLDER_HOST = "app.example";
const PLACEHOLDER_USER = "owner";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

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
    for (const term of [...(t.extra ?? []), user].filter((x) => x && x.length >= 3)) {
      out = out.replace(new RegExp(`(?<![a-z0-9])${escapeRe(term)}(?![a-z0-9])`, "gi"), PLACEHOLDER_USER);
    }
    // Public addresses would place the owner on a map; private ones (the
    // container network) say nothing.
    out = out.replace(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g, (ip) => (PRIVATE_V4.test(ip) ? ip : "203.0.113.1"));
    out = out.replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, (ip) =>
      /^(fe80|fc|fd|::1)/i.test(ip) ? ip : "2001:db8::1",
    );
    return out;
  };
}

/** Pass-through, for paths with nothing box-specific to hide (tests, demos). */
export const noRedaction: ModelRedactor = (s) => s;
