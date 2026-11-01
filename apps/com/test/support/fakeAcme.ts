/**
 * A small in-process ACME CA (RFC 8555 subset) for the issuance service's tests: it really checks DNS-01 against the
 * fake zone, issues a leaf for the CSR's key signed by its own intermediate, and records revocations. Modes let a test
 * make it misbehave (wrong names on the leaf, rate limits).
 */
import "reflect-metadata";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const BASE = "https://ca.test";
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

export class FakeDns {
  records = new Map<string, { name: string; value: string }>();
  written: string[] = [];
  private n = 0;
  async createTxt(o: { name: string; value: string }): Promise<{ id: string }> {
    const id = `rec${++this.n}`;
    this.records.set(id, { name: o.name, value: o.value });
    this.written.push(o.name);
    return { id };
  }
  async deleteById(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
  has(name: string, value: string): boolean {
    return [...this.records.values()].some((r) => r.name === name && r.value === value);
  }
}

interface Authz {
  identifier: string;
  wildcard: boolean;
  status: string;
  token: string;
}
interface Order {
  status: string;
  names: string[];
  authz: string[];
  cert?: string;
}

export class FakeAcme {
  readonly directory = `${BASE}/dir`;
  accounts = new Map<string, string>();
  orders = new Map<string, Order>();
  authzs = new Map<string, Authz>();
  revoked: Array<{ certificate: string; reason: number }> = [];
  newOrders = 0;
  /** Valid authorizations the account already holds (reused by later orders). */
  validIdentifiers = new Set<string>();
  mode: { leafNames?: string[]; rateLimited?: boolean; processingPolls?: number; failValidation?: boolean } = {};
  private n = 0;
  private ca: Promise<{ keys: CryptoKeyPair; cert: x509.X509Certificate }>;

  constructor(private readonly dns: FakeDns) {
    this.ca = (async () => {
      const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
      const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: "CN=Fake Intermediate",
        notBefore: new Date(Date.now() - 86_400_000),
        notAfter: new Date(Date.now() + 365 * 86_400_000),
        signingAlgorithm: ALG,
        keys,
        extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
      });
      return { keys, cert };
    })();
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.slice(BASE.length);
    const headers = { "replay-nonce": `n${++this.n}`, "content-type": "application/json" };
    if (path === "/dir") {
      return Response.json({ newNonce: `${BASE}/nonce`, newAccount: `${BASE}/acct`, newOrder: `${BASE}/order`, revokeCert: `${BASE}/revoke` });
    }
    if (path === "/nonce") return new Response(null, { status: 200, headers });
    const jws = JSON.parse(String(init?.body ?? "{}")) as { protected: string; payload: string };
    const prot = JSON.parse(Buffer.from(jws.protected, "base64url").toString()) as { jwk?: Record<string, string>; kid?: string; url: string };
    if (prot.url !== url) return problem(400, "malformed", "url mismatch", headers);
    const payload = jws.payload ? (JSON.parse(Buffer.from(jws.payload, "base64url").toString()) as Record<string, unknown>) : undefined;
    if (path === "/acct") {
      const jwk = prot.jwk!;
      const tp = b64u(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`))));
      const kid = `${BASE}/acct/${tp.slice(0, 8)}`;
      const existed = this.accounts.has(kid);
      this.accounts.set(kid, tp);
      return new Response(JSON.stringify({ status: "valid" }), { status: existed ? 200 : 201, headers: { ...headers, location: kid } });
    }
    const thumbprint = prot.kid ? this.accounts.get(prot.kid) : undefined;
    if (!thumbprint) return problem(401, "accountDoesNotExist", "unknown account", headers);
    if (path === "/order") {
      if (this.mode.rateLimited) return problem(429, "rateLimited", "too many certificates", { ...headers, "retry-after": "7200" });
      this.newOrders++;
      const names = (payload!.identifiers as Array<{ value: string }>).map((i) => i.value);
      const id = `o${++this.n}`;
      const authz = names.map((name) => {
        const aid = `a${++this.n}`;
        const wildcard = name.startsWith("*.");
        this.authzs.set(aid, {
          identifier: name.replace(/^\*\./, ""),
          wildcard,
          status: this.validIdentifiers.has(name) ? "valid" : "pending",
          token: b64u(webcrypto.getRandomValues(new Uint8Array(16))),
        });
        return `${BASE}/authz/${aid}`;
      });
      this.orders.set(id, { status: "pending", names, authz });
      return new Response(JSON.stringify({ status: "pending", authorizations: authz, finalize: `${BASE}/finalize/${id}` }), {
        status: 201,
        headers: { ...headers, location: `${BASE}/orders/${id}` },
      });
    }
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/authz\/(\w+)$/))) {
      const a = this.authzs.get(m[1]!)!;
      if (payload?.status === "deactivated") a.status = "deactivated";
      return Response.json(
        {
          identifier: { type: "dns", value: a.identifier },
          wildcard: a.wildcard || undefined,
          status: a.status,
          challenges: [{ type: "dns-01", url: `${BASE}/chall/${m[1]}`, token: a.token, status: a.status }],
        },
        { headers },
      );
    }
    if ((m = path.match(/^\/chall\/(\w+)$/))) {
      const a = this.authzs.get(m[1]!)!;
      const want = b64u(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(`${a.token}.${thumbprint}`))));
      a.status = !this.mode.failValidation && this.dns.has(`_acme-challenge.${a.identifier}`, want) ? "valid" : "invalid";
      if (a.status === "valid") this.validIdentifiers.add(a.wildcard ? `*.${a.identifier}` : a.identifier);
      return Response.json({ status: a.status }, { headers });
    }
    if ((m = path.match(/^\/finalize\/(\w+)$/))) {
      const o = this.orders.get(m[1]!)!;
      if (o.authz.some((u) => this.authzs.get(u.split("/").pop()!)!.status !== "valid")) return problem(403, "orderNotReady", "not ready", headers);
      const csr = new x509.Pkcs10CertificateRequest(fromB64u(String(payload!.csr)));
      const { keys, cert } = await this.ca;
      const leaf = await x509.X509CertificateGenerator.create({
        serialNumber: (++this.n).toString(16).padStart(4, "0"),
        subject: `CN=${o.names[0]}`,
        issuer: cert.subject,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 90 * 86_400_000),
        signingAlgorithm: ALG,
        publicKey: await csr.publicKey.export(),
        signingKey: keys.privateKey,
        extensions: [new x509.SubjectAlternativeNameExtension((this.mode.leafNames ?? o.names).map((value) => ({ type: "dns" as const, value })))],
      });
      o.cert = `${leaf.toString("pem")}\n${cert.toString("pem")}\n`;
      o.status = this.mode.processingPolls ? "processing" : "valid";
      return Response.json({ status: o.status }, { headers });
    }
    if ((m = path.match(/^\/orders\/(\w+)$/))) {
      const o = this.orders.get(m[1]!)!;
      if (o.status === "processing" && --this.mode.processingPolls! <= 0) o.status = "valid";
      return Response.json({ status: o.status, ...(o.status === "valid" ? { certificate: `${BASE}/cert/${m[1]}` } : {}) }, { headers });
    }
    if ((m = path.match(/^\/cert\/(\w+)$/))) {
      return new Response(this.orders.get(m[1]!)!.cert!, { status: 200, headers: { ...headers, "content-type": "application/pem-certificate-chain" } });
    }
    if (path === "/revoke") {
      this.revoked.push({ certificate: String(payload!.certificate), reason: Number(payload!.reason) });
      return new Response(null, { status: 200, headers });
    }
    return problem(404, "malformed", `no route ${path}`, headers);
  };
}

function problem(status: number, type: string, detail: string, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail }), {
    status,
    headers: { ...headers, "content-type": "application/problem+json" },
  });
}

/** A CSR for `names` with a fresh P-256 key (or the given one). */
export async function makeCsr(names: string[], o: { keys?: CryptoKeyPair; cn?: string; extraIp?: string } = {}): Promise<{ der: Uint8Array; keys: CryptoKeyPair }> {
  const keys = o.keys ?? ((await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair);
  const sans: x509.JsonGeneralName[] = names.map((value) => ({ type: "dns", value }));
  if (o.extraIp) sans.push({ type: "ip", value: o.extraIp });
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: o.cn ? `CN=${o.cn}` : `CN=${names[0]}`,
    keys,
    signingAlgorithm: ALG,
    extensions: [new x509.SubjectAlternativeNameExtension(sans)],
  });
  return { der: new Uint8Array(csr.rawData), keys };
}

export function accountKeyPem(): Promise<string> {
  return (async () => {
    const k = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", k.privateKey));
    return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----\n`;
  })();
}
