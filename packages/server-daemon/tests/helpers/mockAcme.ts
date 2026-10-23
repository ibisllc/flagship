import "reflect-metadata";
import { createHash, createPublicKey, createVerify } from "node:crypto";
import { BasicConstraintsExtension, KeyUsageFlags, KeyUsagesExtension, Pkcs10CertificateRequest, SubjectAlternativeNameExtension, X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";

const b64uToBuf = (s: string) => Buffer.from(s, "base64url");

export interface MockAcmeLog {
  requests: Array<{ method: string; url: string; kind?: string; payload?: unknown }>;
}

/**
 * An in-process ACME server speaking enough of RFC 8555 to exercise a client end to end:
 * it checks every JWS (signature under the account key, nonce used once, url matches),
 * validates DNS-01 against a TXT map the test fills, and issues leaves from a throwaway CA.
 */
export class MockAcme {
  readonly log: MockAcmeLog = { requests: [] };
  readonly txt = new Map<string, Set<string>>();
  readonly host = "acme.test";
  private nonces = new Set<string>();
  private accounts = new Map<string, JsonWebKey>();
  private orders = new Map<string, { names: string[]; authzIds: string[]; status: string; cert?: string; acct: string }>();
  private authz = new Map<string, { name: string; token: string; status: string; acct: string }>();
  private n = 0;
  private ca: { cert: string; key: CryptoKey; subject: string } | null = null;
  revoked: Array<{ certificate: string; reason: number }> = [];
  failBadNonceOnce = false;
  invalidateDns = false;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const u = new URL(url);
    if (u.hostname !== this.host) throw new Error(`unexpected host ${u.hostname}`);
    const res = await this.handle(method, u.pathname, init?.body ? JSON.parse(String(init.body)) : null, url);
    return res;
  };

  private nonce(): string {
    const n = `nonce${++this.n}abcdefghij`;
    this.nonces.add(n);
    return n;
  }

  private reply(status: number, body: unknown, extra: Record<string, string> = {}, raw?: string): Response {
    return new Response(raw ?? (body === null ? "" : JSON.stringify(body)), {
      status,
      headers: { "replay-nonce": this.nonce(), "content-type": raw ? "application/pem-certificate-chain" : "application/json", ...extra },
    });
  }

  private problem(status: number, type: string, detail: string): Response {
    return this.reply(status, { type: `urn:ietf:params:acme:error:${type}`, detail });
  }

  private async caInfo() {
    if (this.ca) return this.ca;
    cryptoProvider.set(globalThis.crypto);
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await X509CertificateGenerator.createSelfSigned({
      serialNumber: "01", name: "CN=Mock CA", notBefore: new Date(Date.now() - 86400_000), notAfter: new Date(Date.now() + 3650 * 86400_000),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keys,
      extensions: [new BasicConstraintsExtension(true, undefined, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign)],
    });
    this.ca = { cert: cert.toString("pem"), key: keys.privateKey, subject: cert.subject };
    return this.ca;
  }

  private verifyJws(body: { protected: string; payload: string; signature: string } | null, url: string): { header: Record<string, any>; payload: any; acct: string } | Response {
    if (!body) return this.problem(400, "malformed", "no body");
    const header = JSON.parse(b64uToBuf(body.protected).toString());
    if (header.alg !== "ES256") return this.problem(400, "badSignatureAlgorithm", "ES256 only");
    if (header.url !== url) return this.problem(400, "unauthorized", `url mismatch ${header.url} vs ${url}`);
    if (this.failBadNonceOnce) {
      this.failBadNonceOnce = false;
      return this.problem(400, "badNonce", "try again");
    }
    if (!this.nonces.delete(header.nonce)) return this.problem(400, "badNonce", "unknown or reused nonce");
    let jwk: JsonWebKey | undefined = header.jwk;
    let acct = "";
    if (!jwk) {
      const kid = String(header.kid);
      acct = kid.slice(kid.lastIndexOf("/") + 1);
      jwk = this.accounts.get(acct);
      if (!jwk) return this.problem(400, "accountDoesNotExist", "no such account");
    }
    const pub = createPublicKey({ key: jwk, format: "jwk" });
    const ok = createVerify("SHA256").update(`${body.protected}.${body.payload}`).verify({ key: pub, dsaEncoding: "ieee-p1363" }, b64uToBuf(body.signature));
    if (!ok) return this.problem(403, "unauthorized", "bad signature");
    const payload = body.payload === "" ? null : JSON.parse(b64uToBuf(body.payload).toString());
    return { header, payload, acct };
  }

  private async handle(method: string, path: string, body: any, url: string): Promise<Response> {
    const base = `https://${this.host}`;
    const entry: MockAcmeLog["requests"][number] = { method, url };
    this.log.requests.push(entry);
    if (path === "/directory") {
      return new Response(JSON.stringify({ newNonce: `${base}/acme/new-nonce`, newAccount: `${base}/acme/new-acct`, newOrder: `${base}/acme/new-order`, revokeCert: `${base}/acme/revoke-cert` }), { status: 200 });
    }
    if (path === "/acme/new-nonce") return this.reply(200, null);
    const v = this.verifyJws(body, url);
    if (v instanceof Response) return v;
    entry.payload = v.payload;
    if (path === "/acme/new-acct") {
      const id = `acct${++this.n}`;
      this.accounts.set(id, v.header.jwk);
      entry.kind = "newAccount";
      return this.reply(201, { status: "valid", contact: v.payload.contact }, { location: `${base}/acme/acct/${id}` });
    }
    if (path === "/acme/new-order") {
      entry.kind = "newOrder";
      const names = (v.payload.identifiers as Array<{ value: string }>).map((i) => i.value);
      const id = `order${++this.n}`;
      const authzIds = names.map((name) => {
        const aid = `authz${++this.n}`;
        this.authz.set(aid, { name, token: `tok${aid}`, status: "pending", acct: v.acct });
        return aid;
      });
      this.orders.set(id, { names, authzIds, status: "pending", acct: v.acct });
      return this.reply(201, { status: "pending", identifiers: names.map((value) => ({ type: "dns", value })), authorizations: authzIds.map((a) => `${base}/acme/authz/${a}`), finalize: `${base}/acme/finalize/${id}` }, { location: `${base}/acme/order/${id}` });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/acme\/authz\/(.+)$/.exec(path))) {
      entry.kind = "authz";
      const a = this.authz.get(m[1]!)!;
      return this.reply(200, { status: a.status, identifier: { type: "dns", value: a.name }, challenges: [{ type: "dns-01", url: `${base}/acme/chall/${m[1]}`, token: a.token, status: a.status }, { type: "http-01", url: `${base}/acme/chall-http/${m[1]}`, token: a.token, status: "pending" }] });
    }
    if ((m = /^\/acme\/chall\/(.+)$/.exec(path))) {
      entry.kind = "challenge";
      const a = this.authz.get(m[1]!)!;
      const jwk = this.accounts.get(v.acct)!;
      const thumb = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
      const want = createHash("sha256").update(`${a.token}.${thumb}`).digest("base64url");
      const have = this.txt.get(`_acme-challenge.${a.name.replace(/^\*\./, "")}`);
      a.status = have?.has(want) && !this.invalidateDns ? "valid" : "invalid";
      return this.reply(200, { status: "processing", url, type: "dns-01", token: a.token });
    }
    if ((m = /^\/acme\/order\/(.+)$/.exec(path))) {
      entry.kind = "order";
      const o = this.orders.get(m[1]!)!;
      return this.reply(200, { status: o.status, ...(o.cert ? { certificate: `${base}/acme/cert/${m[1]}` } : {}), identifiers: o.names.map((value) => ({ type: "dns", value })), authorizations: [], finalize: `${base}/acme/finalize/${m[1]}` });
    }
    if ((m = /^\/acme\/finalize\/(.+)$/.exec(path))) {
      entry.kind = "finalize";
      const o = this.orders.get(m[1]!)!;
      if (o.authzIds.some((a) => this.authz.get(a)!.status !== "valid")) return this.problem(403, "orderNotReady", "authorizations not valid");
      const csr = new Pkcs10CertificateRequest(Buffer.from(b64uToBuf(v.payload.csr)));
      if (!(await csr.verify())) return this.problem(400, "badCSR", "bad signature");
      const san = csr.extensions.find((e) => e.type === "2.5.29.17");
      const names = san ? new SubjectAlternativeNameExtension(san.rawData).names.items.map((n) => n.value).sort() : [];
      if (JSON.stringify(names) !== JSON.stringify([...o.names].sort())) return this.problem(400, "badCSR", "names differ from the order");
      const ca = await this.caInfo();
      const leaf = await X509CertificateGenerator.create({
        serialNumber: String(++this.n + 100), subject: csr.subject, issuer: ca.subject, notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 90 * 86400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, publicKey: csr.publicKey, signingKey: ca.key,
        extensions: [new SubjectAlternativeNameExtension(names.map((value) => ({ type: "dns" as const, value })))],
      });
      o.cert = leaf.toString("pem") + "\n" + ca.cert + "\n";
      o.status = "valid";
      return this.reply(200, { status: "valid", certificate: `${base}/acme/cert/${m[1]}`, identifiers: [], authorizations: [], finalize: url }, { location: `${base}/acme/order/${m[1]}` });
    }
    if ((m = /^\/acme\/cert\/(.+)$/.exec(path))) {
      entry.kind = "cert";
      return this.reply(200, null, {}, this.orders.get(m[1]!)!.cert!);
    }
    if (path === "/acme/revoke-cert") {
      entry.kind = "revoke";
      this.revoked.push({ certificate: v.payload.certificate, reason: v.payload.reason });
      return this.reply(200, null);
    }
    return this.problem(404, "malformed", `no route ${path}`);
  }
}
