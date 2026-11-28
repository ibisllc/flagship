// The box's org read token (docs/account-read-token.md "Org routes").
//
// `.com` serves an org's private reads (`GET /api/orgs/<orgId>/...`) to a bearer of an org read
// token. An org box mints one as `box:<serverDomain>`, signed with its STK, keeps it until shortly
// before it expires, and mints again once when `.com` refuses it. If no token can be had the read
// goes out without one (a `.com` that does not yet require it still answers); a failed mint is
// logged once and not tried again for a while, so a refusing `.com` never sees a mint per read.

import { randomBytes } from "node:crypto";
import { orgBoxReadSubject, orgReadTokenPath, signOrgReadTokenRequest, type Bytes, type OrgReadTokenRequest } from "@flagship/protocol";

const DEFAULT_TIMEOUT_MS = 20_000;
/** Re-mint this long before `.com`'s expiry so a read never races it. */
const REFRESH_MARGIN_MS = 10 * 60_000;
/** After a failed mint, reads go without a token this long before the next try. */
const DEFAULT_RETRY_AFTER_MS = 5 * 60_000;

export interface OrgReadTokenDeps {
  comBaseUrl: string;
  orgId: string;
  serverDomain: string;
  boxPublicKey: () => Bytes;
  /** Signs with the box's STK (keyd's `sign`, or the in-process custodian). */
  signAsBox: (msg: Bytes) => Bytes;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  retryAfterMs?: number;
  log?: (line: string) => void;
}

export class OrgReadToken {
  private cached: { token: string; expiresAt: number } | null = null;
  private minting: Promise<string | null> | null = null;
  private failedUntil = 0;
  private failureLogged = false;

  constructor(private readonly deps: OrgReadTokenDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get baseFetch(): typeof fetch {
    return this.deps.fetchImpl ?? ((...a) => fetch(...a));
  }

  /** GET `url` on `.com` with the org read token when one can be had, else without. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = (token: string | null) => {
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      else headers.delete("authorization");
      return this.baseFetch(url, { ...init, headers });
    };
    const t1 = await this.token();
    const first = await attempt(t1);
    if (first.status !== 401 || t1 === null) return first;
    this.cached = null;
    const t2 = await this.token();
    if (t2 === null) return first;
    return await attempt(t2);
  }

  /**
   * A fetch for the box's org readers: every GET of this org's private reads carries the token;
   * everything else (posts, other paths) goes out unchanged.
   */
  fetchFor(): typeof fetch {
    const own = new RegExp(`/api/orgs/${this.deps.orgId.toLowerCase()}/(?!read-token$)[^?#]+$`, "i");
    return async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" || input instanceof Request || !own.test(new URL(url).pathname)) return await this.baseFetch(input, init);
      return await this.fetch(url, init ?? {});
    };
  }

  private async token(): Promise<string | null> {
    const now = this.now;
    if (this.cached && now < this.cached.expiresAt - REFRESH_MARGIN_MS) return this.cached.token;
    if (now < this.failedUntil) return null;
    this.minting ??= this.mint().finally(() => { this.minting = null; });
    return await this.minting;
  }

  private async mint(): Promise<string | null> {
    try {
      const token = await this.mintOnce();
      if (this.failureLogged) this.deps.log?.("[org] read token minted again");
      this.failureLogged = false;
      this.failedUntil = 0;
      return token;
    } catch (e) {
      this.cached = null;
      this.failedUntil = this.now + (this.deps.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.deps.log?.(`[org] read token not minted, org reads go without it for now: ${(e as Error).message}`);
      }
      return null;
    }
  }

  private async mintOnce(): Promise<string> {
    const request: OrgReadTokenRequest = {
      orgId: this.deps.orgId.toLowerCase(),
      subject: orgBoxReadSubject(this.deps.serverDomain),
      pubHex: Buffer.from(this.deps.boxPublicKey()).toString("hex"),
      issuedAt: this.now,
      nonceHex: randomBytes(16).toString("hex"),
    };
    const signature = signOrgReadTokenRequest(request, this.deps.signAsBox);
    const base = this.deps.comBaseUrl.replace(/\/+$/, "");
    const r = await this.baseFetch(`${base}${orgReadTokenPath(request.orgId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, signature }),
      signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body = (await r.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof body.token !== "string" || typeof body.expiresAt !== "number") throw new Error("malformed response");
    this.cached = { token: body.token, expiresAt: body.expiresAt };
    return body.token;
  }
}
