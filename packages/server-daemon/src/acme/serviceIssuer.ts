import acme from "acme-client";
import { createHash, createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { serverWildcardGrantInDate, signServingRecord, type CertificateOrder } from "@flagship/protocol";

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

/** `.com` could not be reached or failed on its side (network, timeout, 5xx): the order may still stand. */
export class IssuanceUnreachable extends IssuanceRefused {
  constructor(message: string, status: number) {
    super("issuance-unreachable", message, status);
    this.name = "IssuanceUnreachable";
  }
}

const CALL_TIMEOUT_MS = 30_000;
const POST_ATTEMPTS = 3;

interface PendingOrder {
  orderId: string;
  names: string[];
  privateKeyPem: string;
  handle: string | null;
  /** The answer the POST gave, followed first. */
  view: Record<string, unknown> | null;
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return [...a].map((n) => n.toLowerCase()).sort().join("\n") === [...b].map((n) => n.toLowerCase()).sort().join("\n");
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
  private readonly pending = new Map<BoxCertClass, PendingOrder>();
  constructor(private readonly o: ServiceIssuerOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  names(cls: BoxCertClass): string[] {
    return boxClassNames(this.o.serverFqdn, cls, cls === "apps" && this.grant() !== undefined);
  }

  /** The admin's grant while `.com` still takes it (serverWildcardGrantInDate); past its age the box orders without
   *  the account wildcard instead of being refused, and the apps' upkeep brings a fresh grant. */
  private grant(): { issuedAt: number; signatureHex: string } | undefined {
    const g = this.o.wildcardGrant();
    return g && serverWildcardGrantInDate(g.issuedAt, (this.o.now ?? Date.now)()) ? g : undefined;
  }

  /** An order this box placed and has not yet got an answer for (resumed by the next `issue`). */
  hasPending(cls: BoxCertClass): boolean {
    return this.pending.has(cls);
  }

  /**
   * Orders a certificate and follows the order until `.com` hands back the chain. An order `.com` accepted is never
   * dropped for a lost answer: a POST is re-sent with the same body (its `requestId` makes it idempotent), a poll that
   * fails on the way (network, timeout, 5xx, 429) is simply polled again, and an order still unanswered at the deadline
   * is resumed by the next call instead of a new one being placed. A new key per class is let through once a month, so
   * an order abandoned after `.com` issued it left the box refused (`issuance-not-due`) for weeks (stack switch, gym 24).
   */
  async issue(cls: BoxCertClass): Promise<IssuedCertificate> {
    const names = this.names(cls);
    let p = this.pending.get(cls);
    if (p && !sameNames(p.names, names)) {
      this.pending.delete(cls);
      p = undefined;
    }
    if (!p) p = await this.place(cls, names);
    return await this.follow(cls, p);
  }

  private async place(cls: BoxCertClass, names: string[]): Promise<PendingOrder> {
    const now = this.o.now ?? Date.now;
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
    const grant = cls === "apps" ? this.grant() : undefined;
    const body = JSON.stringify({
      account,
      server: this.o.serverFqdn.toLowerCase(),
      order,
      signature: Buffer.from(signServingRecord("certificate-order", order, (m) => this.o.signAsBox(m))).toString("hex"),
      csr: Buffer.from(csrDer).toString("base64url"),
      ...(grant ? { serverWildcardGrant: { issuedAt: grant.issuedAt, signature: grant.signatureHex } } : {}),
    });
    let posted: Record<string, unknown> | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        posted = await this.call(`${this.base()}/api/certificates/orders`, { method: "POST", headers: { "content-type": "application/json" }, body });
        break;
      } catch (e) {
        if (!(e instanceof IssuanceUnreachable) || attempt >= POST_ATTEMPTS) throw e;
        await this.sleep(this.o.pollIntervalMs ?? 5000);
      }
    }
    const orderId = String(posted?.orderId ?? "");
    if (!/^[0-9a-f]{32}$/.test(orderId)) throw new IssuanceRefused("issuance-malformed", ".com answered without an order id", 502);
    const p: PendingOrder = { orderId, names, privateKeyPem, handle, view: posted };
    this.pending.set(cls, p);
    return p;
  }

  private async follow(cls: BoxCertClass, p: PendingOrder): Promise<IssuedCertificate> {
    const now = this.o.now ?? Date.now;
    const deadline = now() + (this.o.timeoutMs ?? 20 * 60_000);
    let view = p.view ?? { status: "pending" };
    p.view = null;
    let lastError = "";
    while (view.status === "pending") {
      if (now() > deadline) {
        throw new IssuanceRefused("issuance-timeout", `the certificate order did not finish${lastError ? ` (${lastError})` : ""}`, 504);
      }
      await this.sleep(Math.max(1000, Number(view.pollAfterMs) || this.o.pollIntervalMs || 5000));
      try {
        view = await this.call(`${this.base()}/api/certificates/orders/${p.orderId}`, {});
      } catch (e) {
        // A poll that got no answer (or a busy answer) leaves the order where it was: ask again.
        if (!(e instanceof IssuanceUnreachable) && !(e instanceof IssuanceDeferred)) {
          this.pending.delete(cls);
          throw e;
        }
        lastError = e.message;
        view = { status: "pending", pollAfterMs: Math.min(30_000, Math.max(5000, (this.o.pollIntervalMs ?? 5000) * 2)) };
      }
    }
    this.pending.delete(cls);
    if (view.status !== "issued" || typeof view.chainPem !== "string") {
      throw new IssuanceRefused(String(view.code ?? "issuance-acme-failed"), String(view.error ?? "the certificate order failed"), 200);
    }
    const chainPem = view.chainPem;
    const names = p.names;
    // The box checks the leaf too: its names and its key are the ones it asked for.
    const leaf = new X509Certificate(chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0] ?? "");
    const sans = (leaf.subjectAltName ?? "").split(",").map((s) => s.trim().replace(/^DNS:/, "").toLowerCase()).filter(Boolean).sort();
    if (sans.join("\n") !== [...names].sort().join("\n")) throw new IssuanceRefused("issuance-chain-mismatch", "the certificate names other names", 200);
    if (p.privateKeyPem && !leaf.checkPrivateKey(createPrivateKey(p.privateKeyPem))) {
      throw new IssuanceRefused("issuance-chain-mismatch", "the certificate is not for this key", 200);
    }
    return { cls, names, chainPem, privateKeyPem: p.privateKeyPem, handle: p.handle, notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo) };
  }

  private base(): string {
    return this.o.controlPlaneBaseUrl.replace(/\/$/, "");
  }

  private sleep(ms: number): Promise<void> {
    return (this.o.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  private async call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    let body: Record<string, unknown> = {};
    let parsed = false;
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      try {
        body = (await res.json()) as Record<string, unknown>;
        parsed = true;
      } catch {
        /* non-JSON: handled by status */
      }
    } catch (e) {
      throw new IssuanceUnreachable(`.com did not answer: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    if (res.ok && !parsed) throw new IssuanceUnreachable(`.com answered ${res.status} without a body`, res.status);
    if (res.ok) return body;
    const code = String(body.code ?? `http-${res.status}`);
    const msg = String(body.error ?? `.com answered ${res.status}`);
    const now = (this.o.now ?? Date.now)();
    if (res.status === 429) {
      const at = typeof body.dueAt === "number" ? body.dueAt : now + (typeof body.retryAfterMs === "number" ? body.retryAfterMs : 3_600_000);
      throw new IssuanceDeferred(code, at, msg);
    }
    if (res.status >= 500) throw new IssuanceUnreachable(msg, res.status);
    throw new IssuanceRefused(code, msg, res.status);
  }
}
