/**
 * Thin helpers used by the main `.com` Worker to delegate DNS writes to
 * the standalone `dns-broker` Worker (see `apps/dns-broker/`). The
 * broker is the only Worker that holds the `CLOUDFLARE_DNS_API_TOKEN`.
 *
 * `.com` no longer publishes A/AAAA records through the broker (the zone's
 * root wildcard answers every name, docs/wildcard-dns.md); what is left is:
 *
 *   `controlPlaneRoutes.ts` intercepts `/api/dns-01/publish` and
 *      `/api/dns-01/delete` before they reach `handleDns01Publish` /
 *      `handleDns01Delete`, translates the daemon-signed envelope into
 *      a broker RPC, and proxies the broker's response. See
 *      `proxyDns01PublishToBroker` / `proxyDns01DeleteToBroker` below.
 *
 * The broker URL is supplied via the `DNS_BROKER_URL` env var on the
 * main Worker; the broker token is NEVER exposed here.
 */

import { malformed } from "./types.js";

/**
 * Translate an inbound `/api/dns-01/publish` body (the daemon-signed
 * envelope already validated by `handleDns01Publish` in dev mode, or
 * unvalidated in broker-first mode) into the broker's `publishTxtChallenge`
 * RPC shape and forward. Returns the broker's Response verbatim; the
 * caller wraps in its preferred response shape.
 */
interface ServiceCertAuthorityEnvelope {
  authority?: {
    username?: unknown;
    serviceFqdn?: unknown;
    boxServerId?: unknown;
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  signature?: unknown;
}

/**
 * Translate the daemon's optional forwarded ServiceCertAuthority into the
 * broker wire shape (or null when absent/malformed — the broker then sees a
 * plain pod authority and denies any out-of-namespace name itself).
 */
function serviceCertWire(env: ServiceCertAuthorityEnvelope | undefined): {
  authority: {
    username: string;
    serviceFqdn: string;
    boxServerId: string;
    issuedAt: number;
    expiresAt: number;
  };
  authoritySignatureHex: string;
} | null {
  const a = env?.authority;
  if (
    !env ||
    !a ||
    typeof a.username !== "string" ||
    typeof a.serviceFqdn !== "string" ||
    typeof a.boxServerId !== "string" ||
    typeof a.issuedAt !== "number" ||
    typeof a.expiresAt !== "number" ||
    typeof env.signature !== "string"
  ) {
    return null;
  }
  return {
    authority: {
      username: a.username,
      serviceFqdn: a.serviceFqdn,
      boxServerId: a.boxServerId,
      issuedAt: a.issuedAt,
      expiresAt: a.expiresAt,
    },
    authoritySignatureHex: env.signature,
  };
}

export async function proxyDns01PublishToBroker(args: {
  brokerUrl: string;
  body: {
    request?: {
      serverId?: unknown;
      recordName?: unknown;
      recordValueHash?: unknown;
      issuedAt?: unknown;
    };
    signature?: unknown;
    recordValue?: unknown;
    serviceCertAuthority?: ServiceCertAuthorityEnvelope;
    serverWildcardGrant?: { issuedAt?: unknown; signature?: unknown };
  };
  fetcher?: typeof fetch;
}): Promise<{ status: number; body: unknown }> {
  const r = args.body.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.recordName !== "string" ||
    typeof r.recordValueHash !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof args.body.signature !== "string" ||
    typeof args.body.recordValue !== "string"
  ) {
    return malformed("malformed body");
  }
  const svc = serviceCertWire(args.body.serviceCertAuthority);
  const grant = serverWildcardGrantWire(args.body.serverWildcardGrant);
  const rpc = {
    kind: "publishTxtChallenge" as const,
    recordName: r.recordName,
    recordValue: args.body.recordValue,
    authority: grant
      ? {
          type: "server-wildcard" as const,
          serverId: r.serverId,
          recordValueHashHex: r.recordValueHash,
          issuedAt: r.issuedAt,
          signatureHex: args.body.signature,
          grant,
        }
      : svc
      ? {
          type: "service-cert" as const,
          serverId: r.serverId,
          recordValueHashHex: r.recordValueHash,
          issuedAt: r.issuedAt,
          signatureHex: args.body.signature,
          ...svc,
        }
      : {
          type: "pod" as const,
          serverId: r.serverId,
          recordValueHashHex: r.recordValueHash,
          issuedAt: r.issuedAt,
          signatureHex: args.body.signature,
        },
  };
  const fetcher = args.fetcher ?? fetch;
  const resp = await fetcher(`${args.brokerUrl.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rpc),
  });
  let parsed: { ok?: unknown; recordId?: unknown } = {};
  try {
    parsed = (await resp.json()) as { ok?: unknown; recordId?: unknown };
  } catch {
    return { status: 502, body: { error: "broker unreachable" } };
  }
  if (!resp.ok || parsed.ok !== true) {
    return { status: resp.status, body: { error: "publish failed" } };
  }
  return { status: 200, body: { recordId: parsed.recordId ?? "" } };
}

export async function proxyDns01DeleteToBroker(args: {
  brokerUrl: string;
  body: {
    request?: {
      serverId?: unknown;
      recordId?: unknown;
      issuedAt?: unknown;
    };
    signature?: unknown;
    serviceCertAuthority?: ServiceCertAuthorityEnvelope;
    serverWildcardGrant?: { issuedAt?: unknown; signature?: unknown };
  };
  fetcher?: typeof fetch;
}): Promise<{ status: number; body: unknown }> {
  const r = args.body.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.recordId !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof args.body.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  const svc = serviceCertWire(args.body.serviceCertAuthority);
  const grant = serverWildcardGrantWire(args.body.serverWildcardGrant);
  const rpc = {
    kind: "deleteRecord" as const,
    recordId: r.recordId,
    recordKind: "acme" as const,
    authority: grant
      ? {
          type: "server-wildcard-acme" as const,
          serverId: r.serverId,
          issuedAt: r.issuedAt,
          signatureHex: args.body.signature,
          grant,
        }
      : svc
      ? {
          type: "service-cert-acme" as const,
          serverId: r.serverId,
          issuedAt: r.issuedAt,
          signatureHex: args.body.signature,
          ...svc,
        }
      : {
          type: "pod-acme" as const,
          serverId: r.serverId,
          issuedAt: r.issuedAt,
          signatureHex: args.body.signature,
        },
  };
  const fetcher = args.fetcher ?? fetch;
  const resp = await fetcher(`${args.brokerUrl.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rpc),
  });
  let parsed: { ok?: unknown } = {};
  try {
    parsed = (await resp.json()) as { ok?: unknown };
  } catch {
    return { status: 502, body: { error: "broker unreachable" } };
  }
  if (!resp.ok || parsed.ok !== true) {
    return { status: resp.status, body: { error: "delete failed" } };
  }
  return { status: 200, body: { ok: true } };
}

/** The admin's server-wildcard grant as the box sent it, in the broker's wire form; only for the account-name challenge. */
function serverWildcardGrantWire(g: { issuedAt?: unknown; signature?: unknown } | undefined): { issuedAt: number; signatureHex: string } | null {
  if (!g || typeof g.issuedAt !== "number" || typeof g.signature !== "string") return null;
  return { issuedAt: g.issuedAt, signatureHex: g.signature };
}
