/**
 * An RFC 8555 client for the issuance service, on `fetch` and WebCrypto (ES256) so it runs in the Worker. It holds no
 * state between calls apart from what the caller passes back (the account URL); every order step is one or two of
 * these calls, so a poll never waits on the CA.
 */
import { base64ToBytes, bytesToBase64Url } from "./x509.js";

export const LETS_ENCRYPT_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

export class AcmeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    detail: string,
    /** From the CA's `Retry-After`, in ms, when it sent one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`${type}: ${detail}`);
    this.name = "AcmeError";
  }
  get rateLimited(): boolean {
    return this.type === "urn:ietf:params:acme:error:rateLimited";
  }
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert: string;
}

export interface AcmeAccountKey {
  privateKey: Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  thumbprint: string;
}

const enc = new TextEncoder();
const b64uJson = (v: unknown) => bytesToBase64Url(enc.encode(JSON.stringify(v)));

/** Import the service's account key (PKCS#8 PEM, ECDSA P-256). */
export async function importAccountKey(pem: string): Promise<AcmeAccountKey> {
  const m = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (!m) throw new Error("ISSUANCE_ACME_ACCOUNT_KEY is not a PKCS#8 PEM key");
  const der = base64ToBytes(m[1]!.replace(/\s+/g, ""));
  const subtle = globalThis.crypto.subtle;
  const extractable = await subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const full = (await subtle.exportKey("jwk", extractable)) as { crv?: string; x?: string; y?: string };
  if (full.crv !== "P-256" || !full.x || !full.y) throw new Error("ISSUANCE_ACME_ACCOUNT_KEY must be an ECDSA P-256 key");
  const jwk = { kty: "EC" as const, crv: "P-256" as const, x: full.x, y: full.y };
  const privateKey = await subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // RFC 7638: the required members in lexicographic order.
  const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  const thumbprint = bytesToBase64Url(new Uint8Array(await subtle.digest("SHA-256", enc.encode(canonical))));
  return { privateKey, jwk, thumbprint };
}

/** The DNS-01 TXT value for a challenge token (RFC 8555 §8.4). */
export async function dns01Value(token: string, thumbprint: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(`${token}.${thumbprint}`));
  return bytesToBase64Url(new Uint8Array(d));
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export interface AcmeResponse<T = unknown> {
  status: number;
  location: string | null;
  body: T;
  text: string;
}

export class AcmeClient {
  private dir: Directory | null = null;
  private nonce: string | null = null;
  private readonly f: typeof fetch;

  constructor(
    private readonly o: {
      directoryUrl: string;
      key: AcmeAccountKey;
      /** The account URL, when already known. */
      kid?: string | null;
      contact?: string | null;
      fetchImpl?: typeof fetch;
      /**
       * Called after the CA said a stored account URL does not exist (a test CA such as Pebble forgets every account
       * on restart) and the client registered the key again, so the caller can replace what it stored.
       */
      onAccountReplaced?: (kid: string, staleKid: string) => Promise<void>;
    },
  ) {
    this.f = o.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get kid(): string | null {
    return this.o.kid ?? null;
  }

  private async directory(): Promise<Directory> {
    if (this.dir) return this.dir;
    const res = await this.f(this.o.directoryUrl);
    if (!res.ok) throw new AcmeError(res.status, "directory", `ACME directory unavailable (${res.status})`);
    const d = (await res.json()) as Partial<Directory>;
    if (!d.newNonce || !d.newAccount || !d.newOrder || !d.revokeCert) throw new AcmeError(502, "directory", "ACME directory is incomplete");
    this.dir = d as Directory;
    return this.dir;
  }

  private async freshNonce(): Promise<string> {
    if (this.nonce) {
      const n = this.nonce;
      this.nonce = null;
      return n;
    }
    const res = await this.f((await this.directory()).newNonce, { method: "HEAD" });
    const n = res.headers.get("replay-nonce");
    if (!n) throw new AcmeError(502, "nonce", "ACME server gave no nonce");
    return n;
  }

  private async jws(url: string, payload: unknown | undefined, nonce: string, useJwk: boolean): Promise<string> {
    const header: Record<string, unknown> = { alg: "ES256", nonce, url };
    if (useJwk) header.jwk = this.o.key.jwk;
    else header.kid = this.o.kid;
    const protectedB64 = b64uJson(header);
    const payloadB64 = payload === undefined ? "" : b64uJson(payload);
    const sig = await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.o.key.privateKey, enc.encode(`${protectedB64}.${payloadB64}`));
    return JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: bytesToBase64Url(new Uint8Array(sig)) });
  }

  /** A signed POST; `payload` undefined is POST-as-GET. Retries a badNonce twice, as the protocol expects. */
  async post<T = unknown>(url: string, payload: unknown | undefined, opts: { useJwk?: boolean; accept?: string } = {}): Promise<AcmeResponse<T>> {
    if (!opts.useJwk && !this.o.kid) await this.ensureAccount();
    let reRegistered = false;
    for (let attempt = 0; ; attempt++) {
      const body = await this.jws(url, payload, await this.freshNonce(), opts.useJwk === true);
      const res = await this.f(url, {
        method: "POST",
        headers: { "content-type": "application/jose+json", ...(opts.accept ? { accept: opts.accept } : {}) },
        body,
      });
      this.nonce = res.headers.get("replay-nonce");
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* a certificate download is PEM */
      }
      if (res.ok) return { status: res.status, location: res.headers.get("location"), body: parsed as T, text };
      const p = (parsed ?? {}) as { type?: string; detail?: string };
      if (p.type === "urn:ietf:params:acme:error:badNonce" && attempt < 2) continue;
      if (p.type === "urn:ietf:params:acme:error:accountDoesNotExist" && !opts.useJwk && !reRegistered && this.o.kid) {
        reRegistered = true;
        const stale = this.o.kid;
        this.o.kid = null;
        const kid = await this.ensureAccount();
        if (this.o.onAccountReplaced) await this.o.onAccountReplaced(kid, stale);
        continue;
      }
      throw new AcmeError(res.status, p.type ?? "unknown", p.detail ?? text.slice(0, 200), retryAfterMs(res));
    }
  }

  /** Create the account, or find it (the CA answers 200 with the same URL for a key it knows). */
  async ensureAccount(): Promise<string> {
    if (this.o.kid) return this.o.kid;
    const d = await this.directory();
    const r = await this.post(d.newAccount, { termsOfServiceAgreed: true, ...(this.o.contact ? { contact: [this.o.contact] } : {}) }, { useJwk: true });
    if (!r.location) throw new AcmeError(502, "account", "ACME server gave no account URL");
    this.o.kid = r.location;
    return r.location;
  }

  async newOrder(names: readonly string[]): Promise<{ url: string; authorizations: string[]; finalize: string; status: string }> {
    const d = await this.directory();
    const r = await this.post<{ authorizations?: string[]; finalize?: string; status?: string }>(d.newOrder, {
      identifiers: names.map((value) => ({ type: "dns", value })),
    });
    if (!r.location || !r.body?.finalize || !Array.isArray(r.body.authorizations)) throw new AcmeError(502, "order", "ACME order is incomplete");
    return { url: r.location, authorizations: r.body.authorizations, finalize: r.body.finalize, status: r.body.status ?? "pending" };
  }

  async get<T>(url: string): Promise<T> {
    return (await this.post<T>(url, undefined)).body;
  }

  async respond(challengeUrl: string): Promise<void> {
    await this.post(challengeUrl, {});
  }

  async finalize(finalizeUrl: string, csrDer: Uint8Array): Promise<void> {
    await this.post(finalizeUrl, { csr: bytesToBase64Url(csrDer) });
  }

  async download(certificateUrl: string): Promise<string> {
    return (await this.post(certificateUrl, undefined, { accept: "application/pem-certificate-chain" })).text;
  }

  async deactivateAuthorization(url: string): Promise<void> {
    await this.post(url, { status: "deactivated" });
  }

  /** RFC 8555 §7.6, by the account that ordered it (or one holding valid authorizations for every name). */
  async revoke(certificateDer: Uint8Array, reason: number): Promise<void> {
    const d = await this.directory();
    await this.post(d.revokeCert, { certificate: bytesToBase64Url(certificateDer), reason });
  }

  async deactivateAccount(): Promise<void> {
    const kid = await this.ensureAccount();
    await this.post(kid, { status: "deactivated" });
  }
}
