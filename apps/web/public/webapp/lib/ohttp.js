// Oblivious HTTP (RFC 9458) for the webapp: a voucher spend goes through a
// private relay, so `.com` never sees this browser's address when it pays
// (docs/outbound-proxy.md "Failure handling", docs/payments-privacy-and-rails.md §5.4).
// Port of packages/protocol/src/ohttp.ts, ohttpClient.ts and ohttpPrivacy.ts;
// tested against packages/protocol/test-vectors/ohttp/*.json.
//
// Suite: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. Synchronous
// noble primitives (the same vendor bundle the rest of the webapp uses).

import { gcm, sha256, x25519 } from "../vendor/noble-post-quantum/pq-seal.js";

export const OHTTP_REQUEST_MEDIA_TYPE = "message/ohttp-req";
export const OHTTP_RESPONSE_MEDIA_TYPE = "message/ohttp-res";
export const RELAY_FALLBACK_HEADER = "x-flagship-relay-fallback";
const KEM = 0x0020;
const KDF = 0x0001;
const AEAD = 0x0001;
const NK = 16;
const NN = 12;
const NENC = 32;
const te = new TextEncoder();

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u16 = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
export const fromHex = (h) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function hmac(key, msg) {
  let k = key.length > 64 ? sha256(key) : key;
  const pad = new Uint8Array(64);
  pad.set(k);
  const ipad = pad.map((b) => b ^ 0x36);
  const opad = pad.map((b) => b ^ 0x5c);
  return sha256(concat(opad, sha256(concat(ipad, msg))));
}
const extract = (salt, ikm) => hmac(salt.length ? salt : new Uint8Array(32), ikm);
function expand(prk, info, len) {
  const out = new Uint8Array(len);
  let t = new Uint8Array(0);
  for (let i = 1, o = 0; o < len; i++) {
    t = hmac(prk, concat(t, info, Uint8Array.of(i)));
    out.set(t.subarray(0, Math.min(t.length, len - o)), o);
    o += t.length;
  }
  return out;
}

const KEM_SUITE = concat(te.encode("KEM"), u16(KEM));
const HPKE_SUITE = concat(te.encode("HPKE"), u16(KEM), u16(KDF), u16(AEAD));
const V1 = te.encode("HPKE-v1");
const labeledExtract = (suite, salt, label, ikm) => extract(salt, concat(V1, suite, te.encode(label), ikm));
const labeledExpand = (suite, prk, label, info, len) => expand(prk, concat(u16(len), V1, suite, te.encode(label), info), len);

function keySchedule(shared, info) {
  const e = new Uint8Array(0);
  const ctx = concat(Uint8Array.of(0), labeledExtract(HPKE_SUITE, e, "psk_id_hash", e), labeledExtract(HPKE_SUITE, e, "info_hash", info));
  const secret = labeledExtract(HPKE_SUITE, shared, "secret", e);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", ctx, NK),
    nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, NN),
    exp: labeledExpand(HPKE_SUITE, secret, "exp", ctx, 32),
  };
}

/** A key configuration (RFC 9458 §3): `{keyId, publicKey}` when it offers our suite, else null. */
export function parseOhttpKeyConfig(b) {
  if (!b || b.length < 3 + NENC + 2) return null;
  const keyId = b[0];
  const kem = (b[1] << 8) | b[2];
  if (kem !== KEM) return null;
  const publicKey = b.slice(3, 3 + NENC);
  const len = (b[3 + NENC] << 8) | b[4 + NENC];
  if (len === 0 || len % 4 !== 0 || 5 + NENC + len > b.length) return null;
  for (let o = 5 + NENC; o < 5 + NENC + len; o += 4) {
    if (((b[o] << 8) | b[o + 1]) === KDF && ((b[o + 2] << 8) | b[o + 3]) === AEAD) return { keyId, publicKey };
  }
  return null;
}

export function ohttpKeyConfigFromHex(hex) {
  return typeof hex === "string" && /^([0-9a-f]{2})+$/i.test(hex) ? parseOhttpKeyConfig(fromHex(hex.toLowerCase())) : null;
}

const REQUEST_LABEL = te.encode("message/bhttp request");
const RESPONSE_LABEL = te.encode("message/bhttp response");

/** Encrypt a Binary HTTP request for the gateway. `ephemeralSecret` is a test seam. */
export function encapsulateOhttpRequest(cfg, request, ephemeralSecret) {
  const skE = ephemeralSecret ?? x25519.utils.randomSecretKey?.() ?? x25519.utils.randomPrivateKey();
  const enc = x25519.getPublicKey(skE);
  const dh = x25519.getSharedSecret(skE, cfg.publicKey);
  const hdr = concat(Uint8Array.of(cfg.keyId), u16(KEM), u16(KDF), u16(AEAD));
  const eae = labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  const shared = labeledExpand(KEM_SUITE, eae, "shared_secret", concat(enc, cfg.publicKey), 32);
  const ks = keySchedule(shared, concat(REQUEST_LABEL, Uint8Array.of(0), hdr));
  const ct = gcm(ks.key, ks.nonce).encrypt(request);
  return { encapsulated: concat(hdr, enc, ct), context: { enc, secret: labeledExpand(HPKE_SUITE, ks.exp, "sec", RESPONSE_LABEL, NK) } };
}

/** Open an Encapsulated Response; throws on anything that doesn't decrypt. */
export function decapsulateOhttpResponse(context, encapsulated) {
  if (encapsulated.length < NK + 16) throw new Error("ohttp: response too short");
  const nonce = encapsulated.subarray(0, NK);
  const prk = extract(concat(context.enc, nonce), context.secret);
  return gcm(expand(prk, te.encode("key"), NK), expand(prk, te.encode("nonce"), NN)).decrypt(encapsulated.subarray(NK));
}

// ── Binary HTTP, known length (RFC 9292) ──
function varint(n) {
  if (n < 0x40) return Uint8Array.of(n);
  if (n < 0x4000) return Uint8Array.of(0x40 | (n >> 8), n & 0xff);
  if (n < 0x40000000) return Uint8Array.of(0x80 | (n >>> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  throw new Error("value too large");
}
const lp = (b) => concat(varint(b.length), b);
const fields = (h) => lp(concat(...h.map(([n, v]) => concat(lp(te.encode(n.toLowerCase())), lp(te.encode(v))))));

export function encodeBhttpRequest({ method, scheme, authority, path, headers, body }) {
  return concat(varint(0), lp(te.encode(method)), lp(te.encode(scheme)), lp(te.encode(authority)), lp(te.encode(path)), fields(headers), lp(body), varint(0));
}

export function decodeBhttpResponse(b) {
  let o = 0;
  const vi = () => {
    if (o >= b.length) throw new Error("bhttp: truncated");
    const len = 1 << (b[o] >> 6);
    if (o + len > b.length || len === 8) throw new Error("bhttp: bad varint");
    let v = b[o] & 0x3f;
    for (let i = 1; i < len; i++) v = v * 256 + b[o + i];
    o += len;
    return v;
  };
  const bytes = () => {
    const n = vi();
    if (o + n > b.length) throw new Error("bhttp: truncated");
    const out = b.slice(o, o + n);
    o += n;
    return out;
  };
  const section = () => {
    if (o >= b.length) return [];
    const s = bytes();
    const out = [];
    let p = 0;
    const sub = () => {
      const len = 1 << (s[p] >> 6);
      let v = s[p] & 0x3f;
      for (let i = 1; i < len; i++) v = v * 256 + s[p + i];
      p += len;
      const r = new TextDecoder().decode(s.slice(p, p + v));
      p += v;
      return r;
    };
    while (p < s.length) out.push([sub(), sub()]);
    return out;
  };
  if (vi() !== 1) throw new Error("bhttp: not a known-length response");
  let status = vi();
  while (status >= 100 && status < 200) {
    section();
    status = vi();
  }
  const headers = section();
  const body = o >= b.length ? new Uint8Array(0) : bytes();
  return { status, headers, body };
}

// ── relay config and the fallback rule (ohttpPrivacy.ts) ──
export function isForbiddenRelayHost(host, controlApex) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  const under = (d) => h === d || h.endsWith(`.${d}`);
  return [String(controlApex).toLowerCase(), "cloudflare.com", "cloudflare.net", "workers.dev", "pages.dev", "cloudflare-gateway.com", "cloudflareclient.com"].some(under);
}

function relayEntryOf(r, controlApex) {
  if (!r || typeof r !== "object" || typeof r.url !== "string" || typeof r.operator !== "string" || typeof r.interim !== "boolean") return null;
  let u;
  try {
    u = new URL(r.url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash) return null;
  if (controlApex && isForbiddenRelayHost(u.hostname, controlApex)) return null;
  const operator = r.operator.trim();
  if (!operator || operator.length > 80) return null;
  return { url: r.url, operator, interim: r.interim };
}

/** `.com`'s `ohttp` config: bad relays dropped; no valid key means no relays. */
export function parseOhttpPublicConfig(v, controlApex = null) {
  const empty = { v: 1, keyConfigHex: null, relays: [] };
  if (!v || typeof v !== "object") return empty;
  const key = typeof v.keyConfigHex === "string" && /^([0-9a-f]{2})+$/.test(v.keyConfigHex) ? v.keyConfigHex : null;
  if (!key || !ohttpKeyConfigFromHex(key)) return empty;
  const relays = (Array.isArray(v.relays) ? v.relays : []).map((r) => relayEntryOf(r, controlApex)).filter(Boolean).slice(0, 4);
  return { v: 1, keyConfigHex: key, relays };
}

export const DIRECT_BEFORE_LAPSE_MS = 24 * 3_600_000;

/** After every relay failed, may this spend go directly (marked)? */
export function ohttpSpendMayGoDirect(kind, lapseInMs) {
  if (kind === "interactive") return true;
  if (kind === "overage") return false;
  return lapseInMs === null || lapseInMs < DIRECT_BEFORE_LAPSE_MS;
}

export function relayRetryAfterMs(failures) {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  return Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** Math.min(20, Math.floor(failures) - 1));
}

export function planLapseInMs(paidUntil, graceMs, now) {
  if (!paidUntil || paidUntil <= 0) return null;
  return paidUntil + graceMs - now;
}

export class RelayUnavailableError extends Error {
  constructor(reason) {
    super(`private relay unavailable (${reason})`); // i18n: keep
    this.name = "RelayUnavailableError";
    this.reason = reason;
  }
}

async function timed(ms, run) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Send `{url, method, headers: [[n, v]], body: Uint8Array}` through the first relay that answers, else directly
 * with `x-flagship-relay-fallback` when `mayGoDirect(reason)` allows, else throw RelayUnavailableError.
 * Resolves `{status, headers, body: Uint8Array, path: "ohttp"|"direct", fallbackReason?}`.
 */
export async function sendThroughRelays(req, { config, mayGoDirect, fetch: f = (...a) => globalThis.fetch(...a), timeoutMs = 15_000, ephemeralSecret } = {}) {
  const method = (req.method ?? "POST").toUpperCase();
  const headers = req.headers ?? [];
  const body = req.body ?? new Uint8Array(0);
  const key = config?.keyConfigHex ? ohttpKeyConfigFromHex(config.keyConfigHex) : null;
  const relays = key ? (config.relays ?? []).map((r) => r.url) : [];
  let reason = "unconfigured";
  if (key && relays.length > 0) {
    const u = new URL(req.url);
    for (const relayUrl of relays) {
      const { encapsulated, context } = encapsulateOhttpRequest(
        key,
        encodeBhttpRequest({ method, scheme: "https", authority: u.host, path: `${u.pathname}${u.search}`, headers, body }),
        ephemeralSecret,
      );
      let res;
      try {
        res = await timed(timeoutMs, (signal) =>
          f(relayUrl, { method: "POST", headers: { "content-type": OHTTP_REQUEST_MEDIA_TYPE }, body: encapsulated, credentials: "omit", cache: "no-store", signal }),
        );
      } catch (e) {
        reason = e?.name === "AbortError" ? "relay-timeout" : "relay-unreachable";
        continue;
      }
      if (!res.ok) {
        reason = `relay-${res.status}`;
        continue;
      }
      if ((res.headers.get("content-type") ?? "").split(";")[0].trim() !== OHTTP_RESPONSE_MEDIA_TYPE) {
        reason = "relay-bad-response";
        continue;
      }
      try {
        const inner = decodeBhttpResponse(decapsulateOhttpResponse(context, new Uint8Array(await res.arrayBuffer())));
        return { ...inner, path: "ohttp", relay: relayUrl };
      } catch {
        reason = "relay-bad-response";
      }
    }
  }
  if (!mayGoDirect(reason)) throw new RelayUnavailableError(reason);
  const h = Object.fromEntries(headers);
  // `.com` counts the marker as a relay failure; "no relay set up" isn't one.
  if (reason !== "unconfigured") h[RELAY_FALLBACK_HEADER] = reason;
  const res = await timed(timeoutMs, (signal) =>
    f(req.url, { method, headers: h, ...(method === "GET" ? {} : { body }), credentials: "omit", cache: "no-store", signal }),
  );
  const out = [];
  res.headers.forEach?.((v, k) => out.push([k, v]));
  return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()), path: "direct", fallbackReason: reason };
}
