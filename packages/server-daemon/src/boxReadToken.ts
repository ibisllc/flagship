// The box's account read token (docs/account-read-token.md).
//
// `.com` serves an account's app aliases (and its other private reads) only
// to a bearer of a read token for that account. The box mints one with its
// STK, keeps it until shortly before it expires, and mints again once when
// `.com` refuses it (a rotated secret, a restart of the clock).

import { randomBytes } from "node:crypto";
import { signBoxReadTokenRequest, type Bytes } from "@flagship/protocol";
import { AccountGoneGate, accountGoneGate } from "./accountGone.js";

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
  /** Holds calls while `.com` says the account is gone (default: the daemon's one gate). */
  gate?: AccountGoneGate;
}

export class BoxReadToken {
  private cached: { token: string; expiresAt: number } | null = null;
  private minting: Promise<string> | null = null;

  constructor(private readonly deps: BoxReadTokenDeps) {}

  private get gate(): AccountGoneGate {
    return this.deps.gate ?? accountGoneGate;
  }

  /**
   * GET `url` on `.com` with the box's read token, minting it as needed. While `.com` says the account is gone the
   * call stays on the box and gets that 404 (accountGone.ts), instead of a mint and a read per poll.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const user = this.deps.username;
    if (this.gate.held(user)) return AccountGoneGate.localAnswer();
    const attempt = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      const res = await fetchImpl(url, { ...init, headers, signal: this.signal(init.signal) });
      await this.gate.observe(user, res);
      return res;
    };
    const withToken = async (): Promise<string | null> => {
      try {
        return await this.token();
      } catch (e) {
        if (this.gate.held(user)) return null;
        throw e;
      }
    };
    const t1 = await withToken();
    if (t1 === null) return AccountGoneGate.localAnswer();
    const first = await attempt(t1);
    if (first.status !== 401) return first;
    this.cached = null;
    const t2 = await withToken();
    if (t2 === null) return AccountGoneGate.localAnswer();
    return await attempt(t2);
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
    await this.gate.observe(username, r);
    if (!r.ok) throw new Error(`read token refused: status ${r.status}`);
    const body = (await r.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      throw new Error("read token response is malformed");
    }
    this.cached = { token: body.token, expiresAt: body.expiresAt };
    return body.token;
  }
}

const OWN_DEPOSIT = /\/api\/server\/[^/]+\/(?:swk|cgk|pairing|entitlement)-deposit$/;

/**
 * A fetch for the box's pollers: reads of its own consume-once deposits carry its read token
 * (`.com` refuses them otherwise); everything else goes out as before. When no token can be
 * minted (`.com` unreachable, or a demo box) the read goes without one: a demo account is let in
 * and a real one gets its 401, which the poller retries.
 */
export function ownDepositFetch(reader: Pick<BoxReadToken, "fetch">, fetchImpl: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!OWN_DEPOSIT.test(url.split("?")[0]!)) return await fetchImpl(input, init);
    try {
      return await reader.fetch(url, init ?? {});
    } catch {
      return await fetchImpl(input, init);
    }
  };
}
