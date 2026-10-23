import { createHash } from "node:crypto";
import type { DnsChallengeWriter, AcmeIssuancePhase } from "./letsEncryptIssuer.js";

/**
 * A small RFC 8555 client whose account key and certificate key never enter this process
 * (SECURITY-HARDENING-PLAN.md 6.1, 6.2). It does the protocol (directory, nonces, orders,
 * challenges, polling, certificate download) and asks flagship-keyd for each signed request
 * by *kind*; keyd builds the payload, so this code cannot be turned into a way to sign
 * something else. The certificate request is made by keyd for a key keyd generated, and the
 * leaf private key is never seen here, only a handle.
 *
 * DNS-01 only: the box's names are validated through the zone `.com` controls. (TLS-ALPN-01
 * would need an extra key and a challenge responder inside the TLS frontend.)
 */

/** What this client needs from keyd (the daemon's async keyd client implements it). */
export interface KeydAcmeApi {
  jwk(): Promise<{ present: boolean; thumbprint?: string }>;
  create(): Promise<void>;
  sign(args: Record<string, unknown>): Promise<{ protected: string; payload: string; signature: string }>;
  tlsCreateKey(names: string[]): Promise<{ handle: string }>;
  tlsInstall(handle: string, chainPem: string): Promise<{ notAfter: number; names: string[] }>;
}

export interface KeydAcmeOptions {
  keyd: KeydAcmeApi;
  directoryUrl: string;
  email: string;
  dns: DnsChallengeWriter;
  fetchImpl?: typeof fetch;
  onPhase?: (phase: AcmeIssuancePhase) => void;
  /** Wait after publishing DNS-01 records before asking the CA to validate. */
  dns01PropagationDelayMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert: string;
}

export class AcmeProblem extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    detail: string,
  ) {
    super(`${type}: ${detail}`);
    this.name = "AcmeProblem";
  }
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

export class KeydAcmeIssuer {
  private dir: Directory | null = null;
  private kid: string | null = null;
  private nonce: string | null = null;
  private readonly f: typeof fetch;

  constructor(private readonly o: KeydAcmeOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async directory(): Promise<Directory> {
    if (this.dir) return this.dir;
    const res = await this.f(this.o.directoryUrl);
    if (!res.ok) throw new Error(`ACME directory unavailable (${res.status})`);
    const d = (await res.json()) as Partial<Directory>;
    if (!d.newNonce || !d.newAccount || !d.newOrder || !d.revokeCert) throw new Error("ACME directory is incomplete");
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
    if (!n) throw new Error("ACME server gave no nonce");
    return n;
  }

  /** One signed POST. Retries once on badNonce, which the protocol expects. */
  private async post(
    build: (nonce: string) => Promise<{ protected: string; payload: string; signature: string }>,
    url: string,
    accept?: string,
  ): Promise<{ res: Response; body: unknown; text: string }> {
    for (let attempt = 0; ; attempt++) {
      const jws = await build(await this.freshNonce());
      const res = await this.f(url, {
        method: "POST",
        headers: { "content-type": "application/jose+json", ...(accept ? { accept } : {}) },
        body: JSON.stringify(jws),
      });
      this.nonce = res.headers.get("replay-nonce");
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* a certificate download is PEM */
      }
      if (res.ok) return { res, body, text };
      const p = (body ?? {}) as { type?: string; detail?: string };
      if (p.type === "urn:ietf:params:acme:error:badNonce" && attempt < 2) continue;
      throw new AcmeProblem(res.status, p.type ?? "unknown", p.detail ?? text.slice(0, 200));
    }
  }

  private async ensureAccount(): Promise<string> {
    if (this.kid) return this.kid;
    const status = await this.o.keyd.jwk();
    if (!status.present) await this.o.keyd.create();
    const d = await this.directory();
    const { res } = await this.post(
      (nonce) => this.o.keyd.sign({ kind: "newAccount", url: d.newAccount, nonce, contact: `mailto:${this.o.email}` }),
      d.newAccount,
    );
    const kid = res.headers.get("location");
    if (!kid) throw new Error("ACME server gave no account URL");
    this.kid = kid;
    return kid;
  }

  private async postAsGet(url: string, accept?: string) {
    const kid = await this.ensureAccount();
    return this.post((nonce) => this.o.keyd.sign({ kind: "postAsGet", url, nonce, kid }), url, accept);
  }

  private async poll<T extends { status?: string }>(url: string, done: string[], what: string): Promise<T> {
    const interval = this.o.pollIntervalMs ?? 2000;
    const deadline = Date.now() + (this.o.pollTimeoutMs ?? 5 * 60_000);
    for (;;) {
      const { body } = await this.postAsGet(url);
      const obj = body as T & { error?: { detail?: string } };
      if (obj.status && done.includes(obj.status)) return obj;
      if (obj.status === "invalid") throw new Error(`ACME ${what} failed: ${obj.error?.detail ?? "invalid"}`);
      if (Date.now() > deadline) throw new Error(`ACME ${what} timed out`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async issue(names: string[], perIssue?: { dns?: DnsChallengeWriter }): Promise<{ handle: string; chainPem: string; notAfter: number }> {
    if (names.length === 0) throw new Error("issue() requires at least one name");
    const dns = perIssue?.dns ?? this.o.dns;
    const phase = (p: AcmeIssuancePhase) => {
      try {
        this.o.onPhase?.(p);
      } catch {
        /* observability never breaks issuance */
      }
    };
    const kid = await this.ensureAccount();
    const d = await this.directory();
    const thumbprint = (await this.o.keyd.jwk()).thumbprint!;
    // The key is made first so its names are fixed by keyd before the CA hears of them.
    const { handle } = await this.o.keyd.tlsCreateKey(names);
    const order = await this.post((nonce) => this.o.keyd.sign({ kind: "newOrder", url: d.newOrder, nonce, kid, names }), d.newOrder);
    const orderUrl = order.res.headers.get("location");
    const orderBody = order.body as { authorizations: string[]; finalize: string };
    if (!orderUrl || !orderBody.finalize) throw new Error("ACME order is incomplete");
    phase("acme-order");
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const pending: Array<{ authz: string; challengeUrl: string }> = [];
      for (const authz of orderBody.authorizations) {
        const a = (await this.postAsGet(authz)).body as { identifier: { value: string }; status: string; challenges: Array<{ type: string; url: string; token: string; status: string }> };
        if (a.status === "valid") continue;
        const ch = a.challenges.find((c) => c.type === "dns-01");
        if (!ch) throw new Error(`no DNS-01 challenge for ${a.identifier.value}`);
        const keyAuth = `${ch.token}.${thumbprint}`;
        const txt = b64u(createHash("sha256").update(keyAuth).digest());
        const host = a.identifier.value.replace(/^\*\./, "");
        phase("dns01-publish-attempt");
        cleanups.push(await dns.publishTxt(`_acme-challenge.${host}`, txt));
        phase("dns01-publish-ok");
        pending.push({ authz, challengeUrl: ch.url });
      }
      if (pending.length > 0 && (this.o.dns01PropagationDelayMs ?? 10_000) > 0) {
        phase("dns01-propagation-wait");
        await new Promise((r) => setTimeout(r, this.o.dns01PropagationDelayMs ?? 10_000));
      }
      phase("acme-validating");
      for (const p of pending) {
        await this.post((nonce) => this.o.keyd.sign({ kind: "challenge", url: p.challengeUrl, nonce, kid }), p.challengeUrl);
      }
      for (const p of pending) await this.poll(p.authz, ["valid"], "validation");
      await this.post((nonce) => this.o.keyd.sign({ kind: "finalize", url: orderBody.finalize, nonce, kid, handle }), orderBody.finalize);
      const done = await this.poll<{ status: string; certificate?: string }>(orderUrl, ["valid"], "order");
      if (!done.certificate) throw new Error("ACME order finished without a certificate");
      const cert = await this.postAsGet(done.certificate, "application/pem-certificate-chain");
      const installed = await this.o.keyd.tlsInstall(handle, cert.text);
      return { handle, chainPem: cert.text, notAfter: installed.notAfter };
    } finally {
      for (const c of cleanups.reverse()) await c();
    }
  }

  async revoke(certificateDer: Uint8Array, reason = 1): Promise<void> {
    const kid = await this.ensureAccount();
    const d = await this.directory();
    await this.post(
      (nonce) => this.o.keyd.sign({ kind: "revoke", url: d.revokeCert, nonce, kid, certificate: Buffer.from(certificateDer).toString("hex"), reason }),
      d.revokeCert,
    );
  }
}
