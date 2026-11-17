// The Google Play Developer API, as much as the voucher rail needs (docs/payments-privacy-and-rails.md §11): an
// OAuth access token from a service account (RS256 JWT bearer grant), `purchases.products.get` and
// `purchases.products.acknowledge`. The service account's JSON key is the `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` secret.

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

export interface GoogleServiceAccount {
  clientEmail: string;
  privateKeyPem: string;
  tokenUri: string;
}

export function googleServiceAccountFromEnv(raw: string | undefined): GoogleServiceAccount | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.client_email !== "string" || typeof j.private_key !== "string") return null;
    const tokenUri = typeof j.token_uri === "string" && j.token_uri.startsWith("https://") ? j.token_uri : "https://oauth2.googleapis.com/token";
    return { clientEmail: j.client_email, privateKeyPem: j.private_key, tokenUri };
  } catch {
    return null;
  }
}

/** The fields of a ProductPurchase the rail reads. */
export interface PlayProductPurchase {
  purchaseState?: number;
  consumptionState?: number;
  acknowledgementState?: number;
  purchaseType?: number;
  quantity?: number;
  orderId?: string;
  obfuscatedExternalAccountId?: string;
  obfuscatedExternalProfileId?: string;
}

export interface GooglePlayApi {
  /** The purchase, null when Google says it doesn't exist (404/410); throws on any other failure. */
  getProductPurchase(productId: string, purchaseToken: string): Promise<PlayProductPurchase | null>;
  acknowledge(productId: string, purchaseToken: string): Promise<void>;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The signed assertion a service account trades for an access token. */
export async function googleServiceAccountAssertion(sa: GoogleServiceAccount, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const te = new TextEncoder();
  const head = b64url(te.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(te.encode(JSON.stringify({ iss: sa.clientEmail, scope: SCOPE, aud: sa.tokenUri, iat, exp: iat + 3600 })));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, te.encode(`${head}.${claims}`)));
  return `${head}.${claims}.${b64url(sig)}`;
}

/** One access token per service account per isolate, renewed five minutes before Google's expiry. */
const tokenCache = new Map<string, { token: string; until: number }>();

export function googlePlayApi(opts: { account: GoogleServiceAccount; packageName: string; fetch?: typeof fetch; now?: () => number }): GooglePlayApi {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;
  const pkg = encodeURIComponent(opts.packageName);

  async function token(): Promise<string> {
    const hit = tokenCache.get(opts.account.clientEmail);
    if (hit && hit.until > now()) return hit.token;
    const assertion = await googleServiceAccountAssertion(opts.account, now());
    const r = await f(opts.account.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!r.ok) throw new Error(`google token ${r.status}`);
    const j = (await r.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string") throw new Error("google token: no access_token");
    const ttl = typeof j.expires_in === "number" ? j.expires_in : 3600;
    tokenCache.set(opts.account.clientEmail, { token: j.access_token, until: now() + Math.max(60, ttl - 300) * 1000 });
    return j.access_token;
  }

  const url = (productId: string, purchaseToken: string, suffix = "") =>
    `${API}/${pkg}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}${suffix}`;

  return {
    async getProductPurchase(productId, purchaseToken) {
      const r = await f(url(productId, purchaseToken), { headers: { authorization: `Bearer ${await token()}` } });
      if (r.status === 404 || r.status === 410 || r.status === 400) return null;
      if (!r.ok) throw new Error(`google purchase ${r.status}`);
      return (await r.json()) as PlayProductPurchase;
    },
    async acknowledge(productId, purchaseToken) {
      const r = await f(url(productId, purchaseToken, ":acknowledge"), {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
        body: "{}",
      });
      // 400 = already acknowledged or consumed: fine.
      if (!r.ok && r.status !== 400) throw new Error(`google acknowledge ${r.status}`);
    },
  };
}

/** Tests: forget cached access tokens. */
export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}
