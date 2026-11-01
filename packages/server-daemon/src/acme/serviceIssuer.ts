import acme from "acme-client";
import { createHash, createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { signServingRecord, type CertificateOrder } from "@flagship/protocol";

/**
 * The box's side of `.com`'s certificate issuance service (docs/architecture-v2/issuance-service.md). The box makes
 * the key and the request (locally, or inside flagship-keyd), signs a `certificate-order/v1` with its identity key and
 * polls until `.com` hands back the chain. The box never talks to the CA and never writes a DNS record.
 *
 *   control  exactly `<server>.<user>.<apex>`            (also after the app lease lapsed: recovery)
 *   apps     `*.<server>.<user>.<apex>` (+ `*.<user>.<apex>` with the admin's wildcard grant)
 */
export type BoxCertClass = "control" | "apps";

/** Where the leaf key lives. `local` keeps the PEM in this process; `keyd` keeps it in flagship-keyd. */
export interface CsrSource {
  create(names: string[]): Promise<{ csrDer: Uint8Array; privateKeyPem: string; handle: string | null }>;
}

export function localCsrSource(): CsrSource {
  return {
    async create(names) {
      const key = await acme.crypto.createPrivateEcdsaKey("P-256");
      const [, csrPem] = await acme.crypto.createCsr({ commonName: names[0]!, altNames: names }, key);
      const b64 = csrPem.toString("utf8").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
      return { csrDer: new Uint8Array(Buffer.from(b64, "base64")), privateKeyPem: key.toString("utf8"), handle: null };
    },
  };
}

export interface KeydCsrApi {
  tlsCreateKey(names: string[]): Promise<{ handle: string }>;
  tlsCsr(handle: string): Promise<Uint8Array>;
}

export function keydCsrSource(keyd: KeydCsrApi): CsrSource {
  return {
    async create(names) {
      const { handle } = await keyd.tlsCreateKey(names);
      return { csrDer: await keyd.tlsCsr(handle), privateKeyPem: "", handle };
    },
  };
}

/** `.com` said no for now; `retryAt` is when asking again can work. */
export class IssuanceDeferred extends Error {
  constructor(
    readonly code: string,
    readonly retryAt: number,
    message: string,
  ) {
    super(message);
    this.name = "IssuanceDeferred";
  }
}

/** `.com` refused or the order failed; `code` is the service's. */
export class IssuanceRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "IssuanceRefused";
  }
}

export interface IssuedCertificate {
  cls: BoxCertClass;
  names: string[];
  chainPem: string;
  privateKeyPem: string;
  handle: string | null;
  notBefore: number;
  notAfter: number;
}

export interface ServiceIssuerOptions {
  controlPlaneBaseUrl: string;
  serverFqdn: string;
  /** The box's identity public key, lowercase hex. */
  boxPubHex: string;
  signAsBox(msg: Uint8Array): Uint8Array;
  /** The registration generation `.com` reported (heartbeat); 1 before it has said. */
  regGen(): number;
  /** The admin's grant for the account's app names on this box, when held. */
  wildcardGrant(): { issuedAt: number; signatureHex: string } | undefined;
  csr: CsrSource;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The names a box class asks for, sorted the way `.com` derives them. */
export function boxClassNames(serverFqdn: string, cls: BoxCertClass, accountWildcard: boolean): string[] {
  const fqdn = serverFqdn.toLowerCase();
  if (cls === "control") return [fqdn];
  const zone = fqdn.split(".").slice(1).join(".");
  return (accountWildcard ? [`*.${fqdn}`, `*.${zone}`] : [`*.${fqdn}`]).sort();
}

export class ServiceIssuer {
  private readonly f: typeof fetch;
  constructor(private readonly o: ServiceIssuerOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  names(cls: BoxCertClass): string[] {
    return boxClassNames(this.o.serverFqdn, cls, cls === "apps" && this.o.wildcardGrant() !== undefined);
  }

  async issue(cls: BoxCertClass): Promise<IssuedCertificate> {
    const now = this.o.now ?? Date.now;
    const names = this.names(cls);
    const account = this.o.serverFqdn.toLowerCase().split(".")[1]!;
    const { csrDer, privateKeyPem, handle } = await this.o.csr.create(names);
    const order: CertificateOrder = {
      class: cls,
      device: this.o.boxPubHex.toLowerCase(),
      regGen: this.o.regGen(),
      csrSha256: createHash("sha256").update(csrDer).digest("hex"),
      requestId: randomBytes(16).toString("hex"),
      issuedAt: now(),
    };
    const grant = cls === "apps" ? this.o.wildcardGrant() : undefined;
    const body = {
      account,
      server: this.o.serverFqdn.toLowerCase(),
      order,
      signature: Buffer.from(signServingRecord("certificate-order", order, (m) => this.o.signAsBox(m))).toString("hex"),
      csr: Buffer.from(csrDer).toString("base64url"),
      ...(grant ? { serverWildcardGrant: { issuedAt: grant.issuedAt, signature: grant.signatureHex } } : {}),
    };
    const base = this.o.controlPlaneBaseUrl.replace(/\/$/, "");
    const posted = await this.call(`${base}/api/certificates/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const orderId = String(posted.orderId ?? "");
    if (!/^[0-9a-f]{32}$/.test(orderId)) throw new IssuanceRefused("issuance-malformed", ".com answered without an order id", 502);
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + (this.o.timeoutMs ?? 20 * 60_000);
    let view = posted;
    while (view.status === "pending") {
      if (now() > deadline) throw new IssuanceRefused("issuance-timeout", "the certificate order did not finish", 504);
      await sleep(Math.max(1000, Number(view.pollAfterMs) || this.o.pollIntervalMs || 5000));
      view = await this.call(`${base}/api/certificates/orders/${orderId}`, {});
    }
    if (view.status !== "issued" || typeof view.chainPem !== "string") {
      throw new IssuanceRefused(String(view.code ?? "issuance-acme-failed"), String(view.error ?? "the certificate order failed"), 200);
    }
    const chainPem = view.chainPem;
    // The box checks the leaf too: its names and its key are the ones it asked for.
    const leaf = new X509Certificate(chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0] ?? "");
    const sans = (leaf.subjectAltName ?? "").split(",").map((s) => s.trim().replace(/^DNS:/, "").toLowerCase()).filter(Boolean).sort();
    if (sans.join("\n") !== [...names].sort().join("\n")) throw new IssuanceRefused("issuance-chain-mismatch", "the certificate names other names", 200);
    if (privateKeyPem && !leaf.checkPrivateKey(createPrivateKey(privateKeyPem))) {
      throw new IssuanceRefused("issuance-chain-mismatch", "the certificate is not for this key", 200);
    }
    return { cls, names, chainPem, privateKeyPem, handle, notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo) };
  }

  private async call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.f(url, { ...init, signal: AbortSignal.timeout(30_000) });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON: handled by status */
    }
    if (res.ok) return body;
    const code = String(body.code ?? `http-${res.status}`);
    const msg = String(body.error ?? `.com answered ${res.status}`);
    const now = (this.o.now ?? Date.now)();
    if (res.status === 429) {
      const at = typeof body.dueAt === "number" ? body.dueAt : now + (typeof body.retryAfterMs === "number" ? body.retryAfterMs : 3_600_000);
      throw new IssuanceDeferred(code, at, msg);
    }
    throw new IssuanceRefused(code, msg, res.status);
  }
}
