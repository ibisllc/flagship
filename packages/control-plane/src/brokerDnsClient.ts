/**
 * Thin client used by the main `.com` Worker to delegate DNS writes to
 * the standalone `dns-broker` Worker (see `apps/dns-broker/`). The
 * broker is the only Worker that holds the `CLOUDFLARE_DNS_API_TOKEN`.
 *
 * Two integration points:
 *
 *   1. `serverRegister.ts` calls `client.upsert(...)` to publish A/AAAA
 *      after a successful registration. The broker enforces the
 *      registration-proof + IP-allowlist invariants independently; the
 *      main Worker just hands off.
 *
 *   2. `controlPlaneRoutes.ts` intercepts `/api/dns-01/publish` and
 *      `/api/dns-01/delete` before they reach `handleDns01Publish` /
 *      `handleDns01Delete`, translates the daemon-signed envelope into
 *      a broker RPC, and proxies the broker's response. See
 *      `proxyDns01PublishToBroker` / `proxyDns01DeleteToBroker` below.
 *
 * The broker URL is supplied via the `DNS_BROKER_URL` env var on the
 * main Worker; the broker token is NEVER exposed here.
 */

import type { CloudflareDnsRecord } from "./cloudflareDns.js";

export interface BrokerDnsClientConfig {
  brokerUrl: string;
  /** Test seam: override `fetch`. */
  fetcher?: typeof fetch;
}

/**
 * Drop-in stand-in for the subset of `CloudflareDnsClient` that
 * `serverRegister.ts` uses (`upsert` only). Calls the broker's
 * `publishARecord` RPC. Returns a synthetic `CloudflareDnsRecord` so
 * the caller's existing log line still compiles; only `id` and
 * `content` are meaningful (CF's other fields aren't tracked through
 * the broker).
 */
export class BrokerDnsClient {
  constructor(private cfg: BrokerDnsClientConfig) {}

  async upsert(opts: {
    name: string;
    type: "A" | "AAAA" | "TXT" | "CNAME";
    content: string;
    ttl?: number;
    proxied?: boolean;
  }): Promise<CloudflareDnsRecord> {
    if (opts.type !== "A" && opts.type !== "AAAA") {
      // The broker exposes ACME-TXT and A/AAAA only; other record types
      // are deliberately not exposed.
      throw new Error(`BrokerDnsClient: unsupported record type ${opts.type}`);
    }
    const recordName = classifyARecordName(opts.name);
    if (!recordName) {
      throw new Error(`BrokerDnsClient: unrecognised A-record name ${opts.name}`);
    }
    const body = {
      kind: "publishARecord" as const,
      serverId: serverIdFromName(opts.name),
      recordType: opts.type,
      targetIp: opts.content,
      recordName,
    };
    const resp = await this.rpc(body);
    if (!resp.ok) throw new Error("BrokerDnsClient: publishARecord refused");
    return {
      id: typeof resp.recordId === "string" ? resp.recordId : "",
      type: opts.type,
      name: opts.name,
      content: opts.content,
      proxied: false,
      ttl: opts.ttl ?? 60,
    };
  }

  async rpc(body: unknown): Promise<{ ok: boolean; recordId?: unknown; [k: string]: unknown }> {
    const fetcher = this.cfg.fetcher ?? fetch;
    const resp = await fetcher(`${this.cfg.brokerUrl.replace(/\/$/, "")}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // Broker always replies JSON; on any non-200 we return ok:false.
    let parsed: { ok?: unknown; recordId?: unknown } = {};
    try {
      parsed = (await resp.json()) as { ok?: unknown; recordId?: unknown };
    } catch {
      return { ok: false };
    }
    return {
      ...parsed,
      ok: resp.ok && parsed.ok === true,
    };
  }
}

/**
 * Map an A/AAAA record name back to the broker's `recordName` variant.
 *
 *   <server>.<user>.<apex>     → "pod-apex"
 *   *.<server>.<user>.<apex>   → "pod-wildcard"
 *
 * Cert model A′ publishes per-box records only; the model-C user-zone
 * variants were removed here AND in the broker policy, so a user-zone
 * name fails fast on the client instead of round-tripping to a deny.
 *
 * The broker re-derives the concrete name from the variant + serverId
 * — we send the variant so the broker can independently confirm we
 * aren't smuggling a different name through the policy gate.
 */
function classifyARecordName(name: string): "pod-apex" | "pod-wildcard" | null {
  const lower = name.toLowerCase();
  const isWildcard = lower.startsWith("*.");
  const bare = isWildcard ? lower.slice(2) : lower;
  if (!bare.endsWith(".flagship.services")) return null;
  const head = bare.slice(0, -".flagship.services".length);
  const labels = head.split(".");
  if (labels.length === 2) {
    return isWildcard ? "pod-wildcard" : "pod-apex";
  }
  return null;
}

function serverIdFromName(name: string): string {
  const lower = name.toLowerCase();
  const bare = lower.startsWith("*.") ? lower.slice(2) : lower;
  if (!bare.endsWith(".flagship.services")) return bare;
  const head = bare.slice(0, -".flagship.services".length);
  const labels = head.split(".");
  if (labels.length === 1) {
    // user zone — there's no single serverId; we synthesize a placeholder
    // by re-using the user label as `<user>.flagship.services` because
    // the broker derives the user-zone from the serverId's user label.
    // Callers should NOT use upsert() for user-zone writes; serverRegister
    // never does (it always supplies a concrete name with a serverId in
    // it). This branch is conservative-safe.
    return bare;
  }
  return bare;
}

/**
 * Translate an inbound `/api/dns-01/publish` body (the daemon-signed
 * envelope already validated by `handleDns01Publish` in dev mode, or
 * unvalidated in broker-first mode) into the broker's `publishTxtChallenge`
 * RPC shape and forward. Returns the broker's Response verbatim; the
 * caller wraps in its preferred response shape.
 */
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
    return { status: 400, body: { error: "malformed body" } };
  }
  const rpc = {
    kind: "publishTxtChallenge" as const,
    recordName: r.recordName,
    recordValue: args.body.recordValue,
    authority: {
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
    return { status: 400, body: { error: "malformed body" } };
  }
  const rpc = {
    kind: "deleteRecord" as const,
    recordId: r.recordId,
    recordKind: "acme" as const,
    authority: {
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
