// P1.22 — custom-domain DNS verification.
//
// Phone asks the daemon to confirm a user-claimed custom FQDN is
// actually pointing at this pod. We look for a TXT record at
// `_flagship.<fqdn>` whose value matches an expected token derived
// deterministically from (serverFqdn, customFqdn). The user pre-
// publishes the token via their DNS provider; once we see it propagate,
// status flips from `pending` to `verified`.
//
// DNS resolution uses Cloudflare DoH by default (no native dnssd
// dependency on the daemon side). Tests inject a deterministic
// resolver that doesn't touch the network.

import crypto from "node:crypto";
import type {
  VerifyCustomDomainResponse,
} from "./types.js";
import type { FetchLike } from "@flagship/llm-providers";

export interface DnsResolver {
  /** Return all TXT record values at the supplied host. */
  resolveTxt(host: string): Promise<string[]>;
}

export async function verifyCustomDomain(args: {
  fqdn: string;
  serverFqdn: string;
  resolver: DnsResolver | null;
  fetchImpl?: FetchLike;
}): Promise<VerifyCustomDomainResponse> {
  const expected = expectedTxtToken(args.serverFqdn, args.fqdn);
  const resolver = args.resolver ?? new DohResolver(args.fetchImpl);
  let observed: string[] = [];
  try {
    observed = await resolver.resolveTxt(`_flagship.${stripTrailingDot(args.fqdn)}`);
  } catch (e) {
    return {
      fqdn: args.fqdn,
      status: "failed",
      expectedTxtRecord: expected,
      observedTxtRecord: undefined,
      reason: `DNS lookup failed: ${(e as Error).message}`,
    };
  }
  const hit = observed.find((t) => t === expected);
  if (hit) {
    return {
      fqdn: args.fqdn,
      status: "verified",
      expectedTxtRecord: expected,
      observedTxtRecord: hit,
    };
  }
  return {
    fqdn: args.fqdn,
    status: "pending",
    expectedTxtRecord: expected,
    observedTxtRecord: observed[0],
    reason:
      observed.length === 0
        ? "Waiting for DNS propagation (typical: 1–5 minutes)."
        : "TXT record found but value doesn't match expected token. Re-paste the expected value.",
  };
}

/** Deterministic, public token. The user publishes this verbatim. */
export function expectedTxtToken(serverFqdn: string, customFqdn: string): string {
  const h = crypto.createHash("sha256");
  h.update("flagship/url-verify/v1|");
  h.update(stripTrailingDot(serverFqdn));
  h.update("|");
  h.update(stripTrailingDot(customFqdn));
  // 16 chars of hex is plenty — anti-collision, easy to copy/paste.
  return `flagship-verify=${h.digest("hex").slice(0, 16)}`;
}

function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/**
 * Cloudflare DoH resolver. We hit `https://cloudflare-dns.com/dns-query`
 * with `accept: application/dns-json` (RFC 8484 JSON encoding). No NPM
 * dependency, no DNSSEC, no AD bit check — this is best-effort name
 * resolution for a user-facing UX gate, not a security boundary.
 */
class DohResolver implements DnsResolver {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async resolveTxt(host: string): Promise<string[]> {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", host);
    url.searchParams.set("type", "TXT");
    const r = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/dns-json" },
    });
    if (!r.ok) throw new Error(`DoH HTTP ${r.status}`);
    const json = (await r.json()) as { Answer?: Array<{ data?: string }> };
    const answers = json.Answer ?? [];
    return answers
      .map((a) => normalizeTxt(a.data ?? ""))
      .filter((s) => s.length > 0);
  }
}

/**
 * Cloudflare DoH wraps TXT values in literal quote characters
 * (`"flagship-verify=…"`). Long records can also come back as multiple
 * quoted strings concatenated. Normalize to a single bare string.
 */
function normalizeTxt(raw: string): string {
  if (!raw) return "";
  // Strip surrounding quotes per "value" segment, then concatenate.
  const parts: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) parts.push(m[1] ?? "");
  if (parts.length === 0) {
    // Unquoted shape — return as-is.
    return raw.trim();
  }
  return parts.join("");
}
