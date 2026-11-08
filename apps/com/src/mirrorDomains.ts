/**
 * Mirror domains — fshp.tech and fshp.app.
 *
 * Short alias zones that present the same public site as the control apex,
 * but speak in their own name: every *visible* mention of the control apex
 * or the services apex in a served HTML page is rewritten to the mirror
 * domain the visitor actually used. So that this advice never strands a
 * reader, every other hostname under a mirror redirects back to the real
 * plane it stands in for:
 *
 *   fshp.X/…                      → served as the apex, text rewritten
 *   www.fshp.X/…                  → 308 to fshp.X/… (same www policy as the apex)
 *   <cf-subhost>.fshp.X/…         → 308 to <cf-subhost>.flagshipserver.com/…
 *   <anything>.fshp.X/…           → 308 to <anything>.flagship.services/…
 *
 * Only presentation is rewritten. Script/style bodies, raw JS files and API
 * responses pass through byte-identical, because those carry protocol values
 * (server domains, registration URLs) that must name the real apexes. Email
 * addresses are left alone too: the mirror zones have no mail routing.
 */

export const MIRROR_APEXES: readonly string[] = ["fshp.tech", "fshp.app"];

/** Subhosts of the control apex that Cloudflare serves (rather than the
 *  user-content passthrough on flagship.services). */
const CONTROL_SUBHOSTS: ReadonlySet<string> = new Set([
  "webapp",
  "remote",
  "recovery",
  "boot",
  "web",
]);

export interface MirrorMatch {
  apex: string;
  /** Labels left of the mirror apex ("" for the bare apex). */
  sub: string;
}

export function matchMirror(hostname: string): MirrorMatch | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const apex of MIRROR_APEXES) {
    if (host === apex) return { apex, sub: "" };
    if (host.endsWith(`.${apex}`)) {
      return { apex, sub: host.slice(0, -(apex.length + 1)) };
    }
  }
  return null;
}

/** Redirect for a non-apex mirror host, or null when the host is the bare
 *  mirror apex and should be served. */
export function mirrorRedirect(
  m: MirrorMatch,
  url: URL,
  controlApex: string,
  servicesApex: string,
): Response | null {
  if (m.sub === "") return null;
  const tail = `${url.pathname}${url.search}`;
  let target: string;
  if (m.sub === "www") {
    target = `https://${m.apex}${tail}`;
  } else if (CONTROL_SUBHOSTS.has(m.sub)) {
    target = `https://${m.sub}.${controlApex}${tail}`;
  } else {
    target = `https://${m.sub}.${servicesApex}${tail}`;
  }
  return new Response(null, { status: 308, headers: { location: target } });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite visible apex mentions in an HTML document to the mirror domain.
 * Skips <script> and <style> bodies and anything directly after `@`
 * (email addresses).
 */
export function rewriteMirrorHtml(
  html: string,
  mirrorApex: string,
  controlApex: string,
  servicesApex: string,
): string {
  const domains = new RegExp(
    `(?<![@\\w-])(?:${escapeRe(controlApex)}|${escapeRe(servicesApex)})(?![\\w-])`,
    "gi",
  );
  const rawBlocks = /(<(script|style)\b[^>]*>[\s\S]*?<\/\2\s*>)/gi;
  return html
    .split(rawBlocks)
    .map((part, i) => {
      // split() with two capture groups yields [text, block, tagName, text, …].
      if (i % 3 === 0) return part.replace(domains, mirrorApex);
      return i % 3 === 1 ? part : "";
    })
    .join("");
}

/**
 * Re-skin an apex response for a mirror visitor: HTML bodies get their
 * domain mentions rewritten, and redirects that point back at the bare
 * control apex stay on the mirror.
 */
export async function applyMirror(
  res: Response,
  mirrorApex: string,
  controlApex: string,
  servicesApex: string,
): Promise<Response> {
  const headers = new Headers(res.headers);

  const location = headers.get("location");
  if (location) {
    const apexPrefix = `https://${controlApex}`;
    if (location === apexPrefix || location.startsWith(`${apexPrefix}/`) ||
        location.startsWith(`${apexPrefix}?`)) {
      headers.set("location", `https://${mirrorApex}${location.slice(apexPrefix.length)}`);
    }
  }

  const type = headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("text/html") || res.body === null) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  const html = await res.text();
  const rewritten = rewriteMirrorHtml(html, mirrorApex, controlApex, servicesApex);
  headers.delete("content-length");
  headers.delete("etag");
  return new Response(rewritten, { status: res.status, statusText: res.statusText, headers });
}
