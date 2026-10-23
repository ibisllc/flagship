/**
 * Browser-side origin generations (N11, owner decisions 2026-10-24). A browser keeps cookies,
 * storage, caches and service workers per address; if different code later answers at the same
 * address it inherits all of that from every past visitor. Addresses never change here. Instead each
 * app has a generation, and a returning visitor whose browser holds an older one goes once through a
 * redirect that has the browser drop that address's stored data.
 *
 * The generation changes only when the author does: the host account's stable identity (a reclaimed
 * name is a new account), the app, and, for another author's app, an identity change the owner
 * approved with no continuity chain. An author's own updates and key rotations keep it: the owner
 * trusts the author to update the app.
 *
 * This protects visitors from a change of author under an honest host. It cannot protect them from the
 * host: the host's box serves that address and can serve any code there.
 */
import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export const GENERATION_COOKIE = "__Host-Flagship-Generation";
export const GENERATION_PATH = "/__flagship/generation";
/** Marks the redirect back from GENERATION_PATH, so a browser that refuses cookies is let through, not looped. */
const RETURN_MARK = "__flagship_gen";

export function originGeneration(o: { hostAccountKeyHex: string; app: string; identityGeneration?: number; authorChanges?: number }): string {
  return createHash("sha256")
    .update(["flagship/origin-generation/v1", o.hostAccountKeyHex.toLowerCase(), o.app.toLowerCase(), o.identityGeneration ?? 0, o.authorChanges ?? 0].join("|"))
    .digest("hex")
    .slice(0, 32);
}

function cookies(header: string | undefined): Array<[string, string]> {
  if (!header) return [];
  return header.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? [p, ""] as [string, string] : [p.slice(0, i), p.slice(i + 1)] as [string, string];
  });
}

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw.length > 2048) return "/";
  return raw;
}

/** A browser's top-level page load. Every current browser says so (`Sec-Fetch-Mode: navigate`); a script or tool that does not is never redirected. */
function isNavigation(req: HttpRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return (req.headers as Record<string, string | undefined>)["sec-fetch-mode"] === "navigate";
}

export interface GenerationGateOptions {
  /** The current generation of the app an SNI-selected service id names, or null to leave it alone. */
  generationOf: (serviceRef: string) => string | null;
  /** Cookies the box itself sets (member sign-in): kept, they are not the app's. */
  boxCookies: readonly string[];
}

/** An app gate: ahead of the app and its access rules, on top-level navigations only. */
export function buildGenerationGate(o: GenerationGateOptions) {
  const keep = new Set([GENERATION_COOKIE, ...o.boxCookies]);
  return async function gate(req: HttpRequest, appServiceRef: string | null): Promise<HttpResponse | null> {
    if (!appServiceRef) return null;
    const q = req.path.indexOf("?");
    const path = q < 0 ? req.path : req.path.slice(0, q);
    const query = new URLSearchParams(q < 0 ? "" : req.path.slice(q + 1));
    const gen = o.generationOf(appServiceRef);

    if (path === GENERATION_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, headers: { "content-type": "text/plain" }, body: "method not allowed" };
      const next = safeNext(query.get("next"));
      const back = `${next}${next.includes("?") ? "&" : "?"}${RETURN_MARK}=1`;
      const headers: Record<string, string> = { location: back, "cache-control": "no-store" };
      if (gen && query.get("g") === gen) headers["set-cookie"] = `${GENERATION_COOKIE}=${gen}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`;
      return { status: 303, headers, body: "" };
    }

    if (!gen || !isNavigation(req)) return null;
    const jar = cookies((req.headers as Record<string, string | undefined>)["cookie"]);
    const held = jar.find(([k]) => k === GENERATION_COOKIE)?.[1];
    if (held === gen) {
      if (query.has(RETURN_MARK)) {
        query.delete(RETURN_MARK);
        const qs = query.toString();
        return { status: 303, headers: { location: qs ? `${path}?${qs}` : path, "cache-control": "no-store" }, body: "" };
      }
      return null;
    }
    // Came back from the generation path without the cookie: this browser keeps no cookies, so it
    // keeps nothing to inherit either. Let it through.
    if (query.has(RETURN_MARK)) return null;

    const next = q < 0 ? path : `${path}?${query.toString()}`;
    const expire = jar.filter(([k]) => !keep.has(k) && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(k)).map(([k]) => `${k}=; Path=/; Max-Age=0; Secure`);
    const headers: Record<string, string> = {
      location: `${GENERATION_PATH}?g=${gen}&next=${encodeURIComponent(next)}`,
      "cache-control": "no-store",
      // Not "cookies": that directive reaches every app under the registrable domain. This app's own
      // cookies are expired by name below; storage, caches and service workers are per address.
      "clear-site-data": `"storage", "cache", "executionContexts"`,
    };
    if (expire.length > 0) headers["set-cookie"] = expire.join("\n");
    return { status: 303, headers, body: "" };
  };
}
