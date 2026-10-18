// The box's account read token (docs/account-read-token.md).
//
// `.com` serves an account's app aliases (and its other private reads) only
// to a bearer of a read token for that account. The box mints one with its
// STK, keeps it until shortly before it expires, and mints again once when
// `.com` refuses it (a rotated secret, a restart of the clock).

import { randomBytes } from "node:crypto";
import { signBoxReadTokenRequest, type Bytes } from "@flagship/protocol";

/** A call to `.com` that has not answered by now is given up, so a hung connection never holds a poller. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Re-mint this long before `.com`'s expiry so a read never races it. */
const REFRESH_MARGIN_MS = 10 * 60_000;

export interface BoxReadTokenDeps {
  comBaseUrl: string;
  username: string;
  serverFqdn: string;
  boxPublicKey: () => Bytes;
  signAsBox: (msg: Bytes) => Bytes;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long one call to `.com` may take (default 20 s). */
  timeoutMs?: number;
}

export class BoxReadToken {
  private cached: { token: string; expiresAt: number } | null = null;
  private minting: Promise<string> | null = null;

  constructor(private readonly deps: BoxReadTokenDeps) {}

  /** GET `url` on `.com` with the box's read token, minting it as needed. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const attempt = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return await fetchImpl(url, { ...init, headers, signal: this.signal(init.signal) });
    };
    const first = await attempt(await this.token());
    if (first.status !== 401) return first;
    this.cached = null;
    return await attempt(await this.token());
  }

  private signal(caller?: AbortSignal | null): AbortSignal {
    const timeout = AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }

  private async token(): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && now < this.cached.expiresAt - REFRESH_MARGIN_MS) return this.cached.token;
    this.minting ??= this.mint().finally(() => { this.minting = null; });
    return await this.minting;
  }

  private async mint(): Promise<string> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const username = this.deps.username.toLowerCase();
    const box = {
      username,
      serverDomain: this.deps.serverFqdn.toLowerCase(),
      stkPubHex: Buffer.from(this.deps.boxPublicKey()).toString("hex"),
      issuedAt: (this.deps.now ?? Date.now)(),
      nonceHex: randomBytes(16).toString("hex"),
    };
    const signature = signBoxReadTokenRequest(box, this.deps.signAsBox);
    const base = this.deps.comBaseUrl.replace(/\/+$/, "");
    const r = await fetchImpl(`${base}/api/accounts/${encodeURIComponent(username)}/read-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ box, signature }),
      signal: this.signal(),
    });
    if (!r.ok) throw new Error(`read token refused: status ${r.status}`);
    const body = (await r.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      throw new Error("read token response is malformed");
    }
    this.cached = { token: body.token, expiresAt: body.expiresAt };
    return body.token;
  }
}
