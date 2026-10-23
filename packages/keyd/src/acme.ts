import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha256";
import { KeydError } from "./wire.js";
import type { TlsKeys } from "./tls.js";

/**
 * The ACME account key, held by keyd (SECURITY-HARDENING-PLAN.md 6.2). keyd does not sign
 * "this JWS": the networking side names a kind of request and keyd builds the protected
 * header and the payload itself, so it can only ever sign a request of a known form to a known
 * directory host, for names the box may have, with a CSR keyd made. The account key never
 * leaves, and rotating it does not touch the TLS or box identity keys.
 */

export const LETS_ENCRYPT_HOSTS: readonly string[] = ["acme-v02.api.letsencrypt.org", "acme-staging-v02.api.letsencrypt.org"];

const b64u = (b: Uint8Array | string): string =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url");

export type AcmeRequest =
  | { kind: "newAccount"; url: string; nonce: string; contact: string }
  | { kind: "newOrder"; url: string; nonce: string; kid: string; names: string[] }
  | { kind: "postAsGet"; url: string; nonce: string; kid: string }
  | { kind: "challenge"; url: string; nonce: string; kid: string }
  | { kind: "finalize"; url: string; nonce: string; kid: string; handle: string }
  | { kind: "revoke"; url: string; nonce: string; kid: string; certificateDer: Uint8Array; reason: number };

export class AcmeAccount {
  #priv: Uint8Array | null = null;
  #jwk: { kty: "EC"; crv: "P-256"; x: string; y: string } | null = null;

  constructor(
    private readonly tls: TlsKeys,
    private readonly hosts: ReadonlySet<string> = new Set(LETS_ENCRYPT_HOSTS),
    private readonly file: string | null = null,
  ) {
    if (file && existsSync(file)) this.#setKey(Uint8Array.from(Buffer.from(readFileSync(file, "utf8").trim(), "hex")));
  }

  get present(): boolean {
    return this.#priv !== null;
  }

  jwk(): { kty: "EC"; crv: "P-256"; x: string; y: string } {
    if (!this.#jwk) throw new KeydError("not-provisioned", "no ACME account key");
    return this.#jwk;
  }

  #setKey(priv: Uint8Array): void {
    const pub = p256.getPublicKey(priv, false);
    this.#priv = priv;
    this.#jwk = { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  }

  #store(priv: Uint8Array): void {
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.file}.tmp`, Buffer.from(priv).toString("hex") + "\n", { mode: 0o400 });
      renameSync(`${this.file}.tmp`, this.file);
    }
    this.#setKey(priv);
  }

  /** Make a fresh account key on this box (the preferred, per-box account). */
  create(): void {
    if (this.#priv) throw new KeydError("forbidden", "an ACME account key already exists");
    this.#store(p256.utils.randomSecretKey());
  }

  /** Take an account key the owner granted to this box (a PKCS#8 EC P-256 PEM, already opened by keyd). */
  importPem(pem: string): void {
    if (this.#priv) throw new KeydError("forbidden", "an ACME account key already exists");
    let raw: Uint8Array;
    try {
      const k = createPrivateKey(pem);
      if (k.asymmetricKeyType !== "ec" || k.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("not P-256");
      const jwk = k.export({ format: "jwk" }) as { d?: string };
      raw = Uint8Array.from(Buffer.from(jwk.d ?? "", "base64url"));
      if (raw.length !== 32) throw new Error("bad key");
    } catch {
      throw new KeydError("bad-request", "the account key must be an EC P-256 private key");
    }
    this.#store(raw);
  }

  /** RFC 7638 thumbprint, base64url (what a key authorization is built from). */
  thumbprint(): string {
    const j = this.jwk();
    return b64u(sha256(new TextEncoder().encode(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }))));
  }

  #checkUrl(url: string, pathPrefix?: string): URL {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new KeydError("bad-request", "bad URL");
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port || !this.hosts.has(u.hostname)) {
      throw new KeydError("forbidden", "that ACME server is not one this box talks to");
    }
    if (pathPrefix && !u.pathname.startsWith(pathPrefix)) throw new KeydError("forbidden", "that ACME resource is not allowed");
    return u;
  }

  /** Build and sign the JWS for one request of a known kind. */
  sign(req: AcmeRequest): { protected: string; payload: string; signature: string } {
    if (!this.#priv) throw new KeydError("not-provisioned", "no ACME account key");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(req.nonce)) throw new KeydError("bad-request", "bad nonce");
    this.#checkUrl(req.url);
    const header: Record<string, unknown> = { alg: "ES256", nonce: req.nonce, url: req.url };
    let payload: string;
    if (req.kind === "newAccount") {
      if (!/^mailto:[^\s@,;<>]{1,64}@[A-Za-z0-9.-]{1,200}$/.test(req.contact)) throw new KeydError("bad-request", "bad contact");
      this.#checkUrl(req.url, "/acme/new-acct");
      header.jwk = this.jwk();
      payload = b64u(JSON.stringify({ termsOfServiceAgreed: true, contact: [req.contact] }));
    } else {
      this.#checkUrl(req.kid, "/acme/acct/");
      header.kid = req.kid;
      switch (req.kind) {
        case "newOrder": {
          this.#checkUrl(req.url, "/acme/new-order");
          const allowed = new Set(this.tls.names());
          const names = [...new Set(req.names.map((n) => n.toLowerCase()))];
          if (names.length === 0 || names.length > 8 || names.some((n) => !allowed.has(n))) {
            throw new KeydError("forbidden", "that order names something this box may not have a certificate for");
          }
          payload = b64u(JSON.stringify({ identifiers: names.map((value) => ({ type: "dns", value })) }));
          break;
        }
        case "postAsGet":
          payload = "";
          break;
        case "challenge":
          this.#checkUrl(req.url, "/acme/chall");
          payload = b64u("{}");
          break;
        case "finalize": {
          this.#checkUrl(req.url, "/acme/finalize/");
          payload = b64u(JSON.stringify({ csr: b64u(this.tls.csr(req.handle)) }));
          break;
        }
        case "revoke": {
          this.#checkUrl(req.url, "/acme/revoke-cert");
          if (![0, 1, 4, 5].includes(req.reason)) throw new KeydError("bad-request", "bad revocation reason");
          let cert: X509Certificate;
          try {
            cert = new X509Certificate(Buffer.from(req.certificateDer));
          } catch {
            throw new KeydError("bad-request", "not a certificate");
          }
          const allowed = new Set(this.tls.names());
          const sans = (cert.subjectAltName ?? "").split(",").map((s) => s.trim().replace(/^DNS:/, "").toLowerCase()).filter(Boolean);
          if (sans.length === 0 || sans.some((n) => !allowed.has(n))) throw new KeydError("forbidden", "that is not one of this box's certificates");
          payload = b64u(JSON.stringify({ certificate: b64u(req.certificateDer), reason: req.reason }));
          break;
        }
      }
    }
    const protectedB64 = b64u(JSON.stringify(header));
    const signingInput = new TextEncoder().encode(`${protectedB64}.${payload}`);
    const sig = p256.sign(sha256(signingInput), this.#priv, { prehash: false, format: "compact" });
    return { protected: protectedB64, payload, signature: b64u(sig) };
  }

  destroy(): void {
    this.#priv?.fill(0);
    this.#priv = null;
  }
}

void createPublicKey;
void generateKeyPairSync;
