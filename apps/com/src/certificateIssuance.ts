/**
 * The certificate issuance service (plan H1/H9/H7; docs/architecture-v2/issuance-service.md for the API).
 *
 *   POST /api/certificates/orders          a device's signed certificate-order/v1 + its CSR
 *   GET  /api/certificates/orders/:id      advances the order one step and answers its state (the chain once issued)
 *   GET  /api/certificates/account         the service's ACME account URL (the apex CAA pins it)
 *   POST /api/certificates/admin/revoke    (x-admin-secret) revoke a certificate another account issued for our names
 *
 * `.com` owns the ACME account and the DNS-01 records. A device never names what it gets: the names come from the
 * class and `.com`'s own records, the CSR must ask for exactly those, and authorization is checked again before the
 * challenges are answered, before finalizing and once the chain is back. Each poll does a bounded number of CA calls
 * so a request never waits on validation (the Worker's CPU and wall-clock budget).
 */
import {
  AcmeClient,
  AcmeError,
  adminDeviceIds,
  base64ToBytes,
  bytesToBase64Url,
  checkChain,
  checkCsr,
  CloudflareDnsClient,
  constantTimeEqual,
  parseCertificate,
  CLOCK_SKEW_MS,
  dns01Value,
  importAccountKey,
  ISSUANCE_LIMITS,
  issuanceNames,
  LETS_ENCRYPT_PRODUCTION,
  namesKey,
  ORDER_TIMEOUT_MS,
  parseCsr,
  pemBlocks,
  renewalDueAt,
  serverLabelOf,
  toHex,
  WEEK_MS,
  type AcmeAccountKey,
  type IssuanceRefusal,
} from "@flagship/control-plane";
import {
  canonicalCertificateOrder,
  emptyRevocationState,
  servingDecision,
  verifyServerWildcardGrant,
  verifyServingRecord,
  type CertificateOrder,
} from "@flagship/protocol";
import type { D1Database, DeviceCapabilityGrantStorage, UsernameRecord, UsernameStorage } from "@flagship/storage";
import { servingBundle } from "./servingAuthority.js";

export interface IssuanceEnv {
  DB?: D1Database;
  /** Worker secret: the service's ACME account key, PKCS#8 PEM, ECDSA P-256. */
  ISSUANCE_ACME_ACCOUNT_KEY?: string;
  /** Default: Let's Encrypt production. */
  ISSUANCE_ACME_DIRECTORY?: string;
  /** e.g. `mailto:ops@flagship.services`. */
  ISSUANCE_ACME_CONTACT?: string;
  CLOUDFLARE_DNS_API_TOKEN?: string;
  CLOUDFLARE_SERVICES_ZONE_ID?: string;
  SERVICES_APEX?: string;
  FLAGSHIP_ADMIN_SECRET?: string;
}

export interface IssuanceDns {
  createTxt(opts: { name: string; value: string; ttl?: number }): Promise<{ id: string }>;
  deleteById(id: string): Promise<unknown>;
}

export interface IssuanceDeps {
  usernames: Pick<UsernameStorage, "get">;
  grants: Pick<DeviceCapabilityGrantStorage, "listForUser">;
  /** Default: Cloudflare with the Worker's DNS token. */
  dns?: IssuanceDns;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Wait between publishing the TXT records and answering the challenges (Let's Encrypt caches NXDOMAIN). */
  propagationMs?: number;
  waitUntil?(p: Promise<unknown>): void;
}

const RE_ORDER = /^\/api\/certificates\/orders\/([0-9a-f]{32})$/;
export const ISSUANCE_ORDERS_PATH = "/api/certificates/orders";
export const ISSUANCE_ACCOUNT_PATH = "/api/certificates/account";
export const ISSUANCE_ADMIN_REVOKE_PATH = "/api/certificates/admin/revoke";
export function isIssuancePath(path: string): boolean {
  return path === ISSUANCE_ORDERS_PATH || path === ISSUANCE_ACCOUNT_PATH || path === ISSUANCE_ADMIN_REVOKE_PATH || RE_ORDER.test(path);
}

const POLL_MS = 5_000;
const DEFAULT_PROPAGATION_MS = 10_000;
const LOCK_MS = 30_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MAX_CSR_BYTES = 8192;

const SENTENCES: Record<IssuanceRefusal, string> = {
  "issuance-malformed": "This certificate request could not be read.",
  "issuance-clock": "This device's clock is off. Check its date and time, then try again.",
  "issuance-signature": "This certificate request is not signed by the device that sent it.",
  "issuance-unknown-device": "This device isn't one of this account's servers or devices.",
  "issuance-revoked": "This server was removed from the account, so it can't get certificates any more.",
  "issuance-reg-gen": "This server was set up again since. Restart it and try again.",
  "issuance-not-admin": "Only an admin device of this account can get the account's own certificate.",
  "issuance-no-serving": "This server isn't allowed to serve apps right now, so it can't get a certificate for them. An admin opening Flagship renews that.",
  "issuance-wildcard-grant": "The permission for this server to serve the account's app names doesn't check out.",
  "issuance-csr-signature": "The certificate request's signature doesn't check out.",
  "issuance-csr-key": "The certificate request uses a key type that isn't supported.",
  "issuance-csr-names": "The certificate request asks for names this device may not have.",
  "issuance-request-reused": "This request id was already used for a different request.",
  "issuance-not-due": "This device's certificate isn't due for renewal yet.",
  "issuance-rate-limited": "Too many certificates were requested. Try again later.",
  "issuance-not-configured": "Certificates can't be issued right now.",
  "issuance-acme-failed": "The certificate authority didn't issue the certificate.",
  "issuance-timeout": "The certificate took too long. Try again.",
  "issuance-revoked-during-order": "This device lost its permission while the certificate was being made.",
  "issuance-chain-mismatch": "The certificate that came back was not the one requested.",
  "issuance-superseded": "A newer request from this device replaced this one.",
};

const STATUS: Partial<Record<IssuanceRefusal, number>> = {
  "issuance-malformed": 400,
  "issuance-reg-gen": 409,
  "issuance-request-reused": 409,
  "issuance-not-due": 429,
  "issuance-rate-limited": 429,
  "issuance-not-configured": 503,
};

const HEADERS = { "content-type": "application/json", "cache-control": "private, no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
function refuse(code: IssuanceRefusal, extra: Record<string, unknown> = {}): Response {
  return json({ error: SENTENCES[code], code, ...extra }, STATUS[code] ?? 403);
}

// ── state ────────────────────────────────────────────────────────────────

interface OrderRow {
  order_id: string;
  request_id: string;
  device_pub: string;
  username: string;
  server_domain: string | null;
  class: CertificateOrder["class"];
  reg_gen: number;
  names: string;
  zone: string;
  csr_b64: string;
  csr_spki_sha256: string;
  order_json: string;
  signature: string;
  status: "pending" | "issued" | "failed";
  step: "new" | "published" | "validating" | "finalizing" | "done";
  acme_order_url: string | null;
  acme_json: string | null;
  published_at: number | null;
  acme_ordered_at: number | null;
  chain_pem: string | null;
  not_before: number | null;
  not_after: number | null;
  error_code: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface AcmeState {
  finalize: string;
  authz: Array<{ url: string; identifier: string; status: string; challengeUrl?: string; recordId?: string }>;
  /** The wildcard grant the request carried, so later re-checks see the same names. */
  grant?: { issuedAt: number; signature: string } | null;
}

// ── authorization (checked at the request, before answering, before finalizing and after issuance) ──

interface Authorized {
  names: string[];
}
type AuthResult = { ok: true; value: Authorized } | { ok: false; code: IssuanceRefusal; extra?: Record<string, unknown> };

interface ServerRow {
  username: string;
  identity_pubkey_hex: string;
  reg_gen: number;
  revoked_at: number | null;
}

async function authorize(
  db: D1Database,
  deps: IssuanceDeps,
  apex: string,
  now: number,
  r: { class: CertificateOrder["class"]; device: string; regGen: number; account: string; server: string | null; grant: AcmeState["grant"] },
): Promise<AuthResult> {
  const user = await deps.usernames.get(r.account);
  if (!user) return { ok: false, code: "issuance-unknown-device" };
  if (r.class === "phone") return authorizePhone(db, deps, apex, now, user, r);
  if (!r.server) return { ok: false, code: "issuance-malformed" };
  const label = serverLabelOf(r.server, r.account, apex);
  const row = await db
    .prepare("SELECT username, identity_pubkey_hex, reg_gen, revoked_at FROM servers WHERE server_domain = ?")
    .bind(r.server.toLowerCase())
    .first<ServerRow>();
  if (!label || !row || row.username.toLowerCase() !== r.account || row.identity_pubkey_hex.toLowerCase() !== r.device) {
    return { ok: false, code: "issuance-unknown-device" };
  }
  if (row.revoked_at != null) return { ok: false, code: "issuance-revoked" };
  if (row.reg_gen !== r.regGen) return { ok: false, code: "issuance-reg-gen" };
  if (r.class === "control") return { ok: true, value: { names: issuanceNames({ class: "control", account: r.account, apex, server: label }) } };

  let accountWildcard = false;
  if (r.grant) {
    const signer = user.adminRootPubHex ?? user.irkPubHex;
    const valid =
      !!signer &&
      Number.isSafeInteger(r.grant.issuedAt) &&
      HEX128.test(r.grant.signature) &&
      verifyServerWildcardGrant(
        { username: r.account, serverDomain: r.server.toLowerCase(), stkPubHex: r.device, issuedAt: r.grant.issuedAt },
        hexBytes(r.grant.signature),
        hexBytes(signer),
      );
    if (!valid) return { ok: false, code: "issuance-wildcard-grant" };
    accountWildcard = true;
  }
  const bundle = await servingBundle(db, r.account, r.device);
  if (!bundle || bundle.revoked) return { ok: false, code: "issuance-revoked" };
  const admin = (user.adminRootPubHex ?? user.irkPubHex).toLowerCase();
  const d = servingDecision({
    account: r.account,
    box: r.device,
    regGen: row.reg_gen,
    adminKeyFromCom: admin,
    adminKeyFromBox: admin,
    policies: bundle.policy ? [bundle.policy] : [],
    leases: bundle.leases,
    revocations: emptyRevocationState(),
    now,
  });
  if (!d.apps) return { ok: false, code: "issuance-no-serving", extra: { reason: d.reason } };
  return { ok: true, value: { names: issuanceNames({ class: "apps", account: r.account, apex, server: label, accountWildcard }) } };
}

async function authorizePhone(
  db: D1Database,
  deps: IssuanceDeps,
  apex: string,
  now: number,
  user: UsernameRecord,
  r: { device: string; account: string; server: string | null },
): Promise<AuthResult> {
  if (r.server) return { ok: false, code: "issuance-malformed" };
  if (!user.adminRootPubHex) return { ok: false, code: "issuance-not-admin" };
  const device = await db
    .prepare("SELECT device_id, revoked_at FROM device_identities WHERE account_id = ? AND device_pub_hex = ?")
    .bind(r.account, r.device)
    .first<{ device_id: string; revoked_at: number | null }>();
  if (!device) return { ok: false, code: "issuance-not-admin" };
  if (device.revoked_at != null) return { ok: false, code: "issuance-revoked" };
  const admins = await adminDeviceIds(deps.grants, r.account, user.adminRootPubHex, now);
  if (!admins.has(device.device_id)) return { ok: false, code: "issuance-not-admin" };
  return { ok: true, value: { names: issuanceNames({ class: "phone", account: r.account, apex }) } };
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── the ACME side ─────────────────────────────────────────────────────────

interface Service {
  db: D1Database;
  dns: IssuanceDns;
  key: AcmeAccountKey;
  directory: string;
  contact: string | null;
  apex: string;
  deps: IssuanceDeps;
  now: number;
}

const accountKeys = new Map<string, Promise<AcmeAccountKey>>();

function service(env: IssuanceEnv, deps: IssuanceDeps, now: number): Promise<Service> | null {
  const db = env.DB;
  const pem = env.ISSUANCE_ACME_ACCOUNT_KEY;
  const dns =
    deps.dns ??
    (env.CLOUDFLARE_DNS_API_TOKEN && env.CLOUDFLARE_SERVICES_ZONE_ID
      ? new CloudflareDnsClient({ apiToken: env.CLOUDFLARE_DNS_API_TOKEN, zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID })
      : null);
  if (!db || !pem || !dns) return null;
  let key = accountKeys.get(pem);
  if (!key) {
    key = importAccountKey(pem);
    key.catch(() => accountKeys.delete(pem));
    accountKeys.set(pem, key);
  }
  return key.then((k) => ({
    db,
    dns,
    key: k,
    directory: env.ISSUANCE_ACME_DIRECTORY || LETS_ENCRYPT_PRODUCTION,
    contact: env.ISSUANCE_ACME_CONTACT || null,
    apex: (env.SERVICES_APEX ?? "flagship.services").toLowerCase(),
    deps,
    now,
  }));
}

async function acmeClient(s: Service): Promise<AcmeClient> {
  const row = await s.db
    .prepare("SELECT account_url FROM issuance_acme_accounts WHERE directory = ? AND thumbprint = ?")
    .bind(s.directory, s.key.thumbprint)
    .first<{ account_url: string }>();
  const client = new AcmeClient({
    directoryUrl: s.directory,
    key: s.key,
    kid: row?.account_url ?? null,
    contact: s.contact,
    ...(s.deps.fetchImpl ? { fetchImpl: s.deps.fetchImpl } : {}),
  });
  if (!row) {
    const kid = await client.ensureAccount();
    await s.db
      .prepare("INSERT OR IGNORE INTO issuance_acme_accounts (directory, thumbprint, account_url, created_at) VALUES (?, ?, ?, ?)")
      .bind(s.directory, s.key.thumbprint, kid, s.now)
      .run();
  }
  return client;
}

// ── routes ────────────────────────────────────────────────────────────────

export async function tryIssuanceRoute(request: Request, env: IssuanceEnv, deps: IssuanceDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isIssuancePath(path)) return null;
  const method = request.method.toUpperCase();
  const now = (deps.now ?? Date.now)();
  const svcP = service(env, deps, now);
  if (!svcP) return refuse("issuance-not-configured");
  let s: Service;
  try {
    s = await svcP;
  } catch (e) {
    console.error(JSON.stringify({ event: "issuance-key-unusable", error: e instanceof Error ? e.message : String(e) }));
    return refuse("issuance-not-configured");
  }

  if (path === ISSUANCE_ACCOUNT_PATH && method === "GET") {
    try {
      const client = await acmeClient(s);
      return json({ directory: s.directory, accountUri: client.kid, thumbprint: s.key.thumbprint });
    } catch (e) {
      return json({ error: SENTENCES["issuance-not-configured"], code: "issuance-not-configured", detail: errText(e) }, 503);
    }
  }
  if (path === ISSUANCE_ORDERS_PATH && method === "POST") return postOrder(s, request);
  if (path === ISSUANCE_ADMIN_REVOKE_PATH && method === "POST") {
    const secret = request.headers.get("x-admin-secret") ?? "";
    if (!env.FLAGSHIP_ADMIN_SECRET || !constantTimeEqual(secret, env.FLAGSHIP_ADMIN_SECRET)) return json({ error: "Not authorized.", code: "unauthorized" }, 401);
    return adminRevoke(s, request);
  }
  const m = path.match(RE_ORDER);
  if (m && method === "GET") return getOrder(s, m[1]!);
  return null;
}

function parseOrder(v: unknown): CertificateOrder | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const order = {
    class: o.class,
    device: o.device,
    regGen: o.regGen,
    csrSha256: o.csrSha256,
    requestId: o.requestId,
    issuedAt: o.issuedAt,
  } as CertificateOrder;
  try {
    canonicalCertificateOrder(order);
    return order;
  } catch {
    return null;
  }
}

async function postOrder(s: Service, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const raw = (await request.json()) as unknown;
    if (!raw || typeof raw !== "object") return refuse("issuance-malformed");
    body = raw as Record<string, unknown>;
  } catch {
    return refuse("issuance-malformed");
  }
  const order = parseOrder(body.order);
  const account = typeof body.account === "string" ? body.account.toLowerCase() : null;
  const server = body.server === undefined || body.server === null ? null : typeof body.server === "string" ? body.server.toLowerCase() : undefined;
  const signature = typeof body.signature === "string" ? body.signature : null;
  const csrText = typeof body.csr === "string" ? body.csr : null;
  const g = body.serverWildcardGrant as { issuedAt?: unknown; signature?: unknown } | undefined | null;
  if (!order || !account || server === undefined || !signature || !csrText || csrText.length > (MAX_CSR_BYTES * 4) / 3 + 4) return refuse("issuance-malformed");
  if (g != null && (typeof g !== "object" || order.class !== "apps")) return refuse("issuance-malformed");
  const grant = g ? { issuedAt: g.issuedAt as number, signature: String(g.signature ?? "") } : null;
  if (Math.abs(s.now - order.issuedAt) > CLOCK_SKEW_MS) return refuse("issuance-clock");
  if (!verifyServingRecord("certificate-order", order, signature, order.device)) return refuse("issuance-signature");

  const orderJson = JSON.stringify(order);
  const existing = await s.db
    .prepare("SELECT * FROM certificate_orders WHERE device_pub = ? AND request_id = ?")
    .bind(order.device, order.requestId)
    .first<OrderRow>();
  if (existing) {
    if (existing.order_json !== orderJson || existing.signature !== signature) return refuse("issuance-request-reused");
    return json(view(existing), existing.status === "pending" ? 202 : 200);
  }

  const auth = await authorize(s.db, s.deps, s.apex, s.now, { class: order.class, device: order.device, regGen: order.regGen, account, server, grant });
  if (!auth.ok) return refuse(auth.code, auth.extra);
  const names = auth.value.names;

  let csrDer: Uint8Array;
  try {
    csrDer = base64ToBytes(csrText);
  } catch {
    return refuse("issuance-malformed");
  }
  if (csrDer.length === 0 || csrDer.length > MAX_CSR_BYTES) return refuse("issuance-malformed");
  const csr = await checkCsr(csrDer, order.csrSha256, names);
  if (!csr.ok) return refuse(csr.code);

  const key = namesKey(names);
  const zone = `${account}.${s.apex}`;
  const limited = await limits(s, { device: order.device, cls: order.class, key, zone, account, spki: csr.spkiSha256 });
  if (limited) return limited;

  await supersedePending(s, order.device, order.class);
  const orderId = toHex(crypto.getRandomValues(new Uint8Array(16)));
  await s.db
    .prepare(
      "INSERT INTO certificate_orders (order_id, request_id, device_pub, username, server_domain, class, reg_gen, names, zone, csr_b64, csr_spki_sha256, " +
        "order_json, signature, status, step, acme_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'new', ?, ?, ?)",
    )
    .bind(
      orderId,
      order.requestId,
      order.device,
      account,
      server,
      order.class,
      order.regGen,
      key,
      zone,
      bytesToBase64Url(csrDer),
      csr.spkiSha256,
      orderJson,
      signature,
      JSON.stringify({ finalize: "", authz: [], grant } satisfies AcmeState),
      s.now,
      s.now,
    )
    .run();
  await housekeeping(s);
  return json({ orderId, status: "pending", step: "new", class: order.class, names, pollAfterMs: POLL_MS }, 202);
}

/** H7: refuse what is not due, and stay under the CA's limits. Null when the order may go ahead. */
async function limits(
  s: Service,
  o: { device: string; cls: string; key: string; zone: string; account: string; spki: string },
): Promise<Response | null> {
  const backoff = await s.db.prepare("SELECT until FROM issuance_backoff WHERE scope = 'ca' AND until > ?").bind(s.now).first<{ until: number }>();
  if (backoff) return refuse("issuance-rate-limited", { retryAfterMs: backoff.until - s.now });

  const prev = await s.db
    .prepare(
      "SELECT names, csr_spki_sha256, not_before, not_after FROM certificate_orders WHERE device_pub = ? AND class = ? AND status = 'issued' AND not_after > ? " +
        "ORDER BY not_after DESC LIMIT 1",
    )
    .bind(o.device, o.cls, s.now)
    .first<{ names: string; csr_spki_sha256: string; not_before: number; not_after: number }>();
  if (prev && prev.names === o.key) {
    const dueAt = renewalDueAt({ notBefore: prev.not_before, notAfter: prev.not_after });
    if (s.now < dueAt) {
      const rekeyed = await s.db
        .prepare("SELECT COUNT(*) AS n FROM certificate_orders WHERE device_pub = ? AND class = ? AND status = 'issued' AND created_at > ?")
        .bind(o.device, o.cls, s.now - ISSUANCE_LIMITS.rekeyWindowMs)
        .first<{ n: number }>();
      if (prev.csr_spki_sha256 === o.spki || (rekeyed?.n ?? 0) > 1) return refuse("issuance-not-due", { dueAt });
    }
  }

  const [nameSet, zone, service, account, failures] = await Promise.all([
    count(s, "SELECT COUNT(*) AS n FROM certificate_orders WHERE names = ? AND status = 'issued' AND created_at > ?", o.key, s.now - WEEK_MS),
    count(s, "SELECT COUNT(*) AS n FROM certificate_orders WHERE zone = ? AND status = 'issued' AND created_at > ?", o.zone, s.now - WEEK_MS),
    count(s, "SELECT COUNT(*) AS n FROM certificate_orders WHERE acme_ordered_at > ?", s.now - 3 * 3_600_000),
    count(s, "SELECT COUNT(*) AS n FROM certificate_orders WHERE username = ? AND created_at > ?", o.account, s.now - 86_400_000),
    count(s, "SELECT COUNT(*) AS n FROM certificate_orders WHERE names = ? AND status = 'failed' AND error_code = 'issuance-acme-failed' AND updated_at > ?", o.key, s.now - 3_600_000),
  ]);
  const over =
    nameSet >= ISSUANCE_LIMITS.perNameSetPerWeek
      ? WEEK_MS
      : zone >= ISSUANCE_LIMITS.perZonePerWeek
        ? WEEK_MS
        : failures >= ISSUANCE_LIMITS.failuresPerNameSetPerHour
          ? 3_600_000
          : service >= ISSUANCE_LIMITS.serviceOrdersPer3h
            ? 3 * 3_600_000
            : account >= ISSUANCE_LIMITS.perAccountPerDay
              ? 86_400_000
              : 0;
  if (over > 0) {
    console.warn(JSON.stringify({ event: "issuance-limit", nameSet, zone, service, account, failures }));
    // The window slides, so the earliest it can clear is not known without the rows; tell the device the window's
    // length as an upper bound (devices also back off on their own).
    return refuse("issuance-rate-limited", { retryAfterMs: over });
  }
  return null;
}

async function count(s: Service, sql: string, ...args: unknown[]): Promise<number> {
  return (await s.db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;
}

async function supersedePending(s: Service, device: string, cls: string): Promise<void> {
  const r = await s.db
    .prepare("SELECT * FROM certificate_orders WHERE device_pub = ? AND class = ? AND status = 'pending'")
    .bind(device, cls)
    .all<OrderRow>();
  for (const row of r.results ?? []) await fail(s, row, "issuance-superseded", null);
}

/** Old pending orders whose device stopped polling still hold DNS records; clear a few per request. */
async function housekeeping(s: Service): Promise<void> {
  const stale = await s.db
    .prepare("SELECT * FROM certificate_orders WHERE status = 'pending' AND created_at < ? LIMIT 3")
    .bind(s.now - ORDER_TIMEOUT_MS)
    .all<OrderRow>();
  for (const row of stale.results ?? []) await fail(s, row, "issuance-timeout", null);
  // A removed box or device keeps no certificate: the service ordered it, so the service revokes it at the CA
  // (the relay's revocation already ended its routes; this ends its Web PKI authority too).
  const orphaned = await s.db
    .prepare(
      "SELECT o.order_id, o.chain_pem, o.class FROM certificate_orders o " +
        "LEFT JOIN servers sv ON o.class <> 'phone' AND sv.server_domain = o.server_domain " +
        "LEFT JOIN device_identities d ON o.class = 'phone' AND d.account_id = o.username AND d.device_pub_hex = o.device_pub " +
        "WHERE o.status = 'issued' AND o.not_after > ? AND o.chain_pem IS NOT NULL " +
        "AND NOT EXISTS (SELECT 1 FROM certificate_revocations r WHERE r.order_id = o.order_id) " +
        "AND ((o.class <> 'phone' AND (sv.server_domain IS NULL OR sv.revoked_at IS NOT NULL OR lower(sv.identity_pubkey_hex) <> o.device_pub OR sv.reg_gen <> o.reg_gen)) " +
        "  OR (o.class = 'phone' AND (d.device_id IS NULL OR d.revoked_at IS NOT NULL))) LIMIT 2",
    )
    .bind(s.now)
    .all<{ order_id: string; chain_pem: string }>();
  for (const o of orphaned.results ?? []) {
    const leaf = pemBlocks(o.chain_pem)[0];
    if (leaf) await queueRevocation(s, o.order_id, leaf, "revoked-during-order");
  }
  const queued = await s.db
    .prepare("SELECT order_id, leaf_b64, reason FROM certificate_revocations WHERE status = 'queued' AND updated_at < ? LIMIT 1")
    .bind(s.now - 10 * 60_000)
    .first<{ order_id: string; leaf_b64: string; reason: string }>();
  if (queued) await revokeAtCa(s, queued.order_id, base64ToBytes(queued.leaf_b64), queued.reason);
}

function view(row: OrderRow): Record<string, unknown> {
  const names = row.names.split("\n");
  const base = { orderId: row.order_id, status: row.status, class: row.class, names };
  if (row.status === "issued") return { ...base, chainPem: row.chain_pem, notBefore: row.not_before, notAfter: row.not_after };
  if (row.status === "failed") {
    const code = (row.error_code ?? "issuance-acme-failed") as IssuanceRefusal;
    return { ...base, code, error: SENTENCES[code] ?? SENTENCES["issuance-acme-failed"] };
  }
  return { ...base, step: row.step, pollAfterMs: POLL_MS };
}

async function getOrder(s: Service, orderId: string): Promise<Response> {
  let row = await s.db.prepare("SELECT * FROM certificate_orders WHERE order_id = ?").bind(orderId).first<OrderRow>();
  if (!row) return json({ error: "No such order.", code: "issuance-unknown-order" }, 404);
  if (row.status === "pending") {
    await advance(s, row);
    row = (await s.db.prepare("SELECT * FROM certificate_orders WHERE order_id = ?").bind(orderId).first<OrderRow>()) ?? row;
  }
  return json(view(row));
}

// ── the order's steps ─────────────────────────────────────────────────────

/** Writes the order's columns and releases the step lock (`keepLock` for a write in the middle of a step). */
async function save(s: Service, row: OrderRow, set: Partial<OrderRow>, keepLock = false): Promise<void> {
  const cols = Object.keys(set);
  await s.db
    .prepare(`UPDATE certificate_orders SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ?${keepLock ? "" : ", lock_until = NULL"} WHERE order_id = ?`)
    .bind(...cols.map((c) => (set as Record<string, unknown>)[c] ?? null), s.now, row.order_id)
    .run();
}

function stateOf(row: OrderRow): AcmeState {
  try {
    return JSON.parse(row.acme_json ?? "") as AcmeState;
  } catch {
    return { finalize: "", authz: [] };
  }
}

async function reauthorize(s: Service, row: OrderRow, st: AcmeState): Promise<IssuanceRefusal | null> {
  const a = await authorize(s.db, s.deps, s.apex, s.now, {
    class: row.class,
    device: row.device_pub,
    regGen: row.reg_gen,
    account: row.username,
    server: row.server_domain,
    grant: st.grant ?? null,
  });
  if (!a.ok) return a.code === "issuance-no-serving" ? "issuance-no-serving" : "issuance-revoked-during-order";
  return namesKey(a.value.names) === row.names ? null : "issuance-revoked-during-order";
}

async function advance(s: Service, row: OrderRow): Promise<void> {
  if (s.now - row.created_at > ORDER_TIMEOUT_MS) {
    await fail(s, row, "issuance-timeout", null);
    return;
  }
  const lock = await s.db
    .prepare("UPDATE certificate_orders SET lock_until = ? WHERE order_id = ? AND status = 'pending' AND (lock_until IS NULL OR lock_until < ?)")
    .bind(s.now + LOCK_MS, row.order_id, s.now)
    .run();
  if ((lock.meta?.changes ?? 0) !== 1) return;
  const st = stateOf(row);
  try {
    const client = await acmeClient(s);
    if (row.step === "new") return await stepNew(s, row, st, client);
    if (row.step === "published") return await stepAnswer(s, row, st, client);
    if (row.step === "validating") return await stepValidate(s, row, st, client);
    if (row.step === "finalizing") return await stepFinish(s, row, st, client);
  } catch (e) {
    if (e instanceof AcmeError && e.rateLimited) {
      const until = s.now + Math.max(e.retryAfterMs ?? 0, ISSUANCE_LIMITS.caBackoffMinMs);
      await s.db
        .prepare("INSERT INTO issuance_backoff (scope, until, reason) VALUES ('ca', ?, ?) ON CONFLICT(scope) DO UPDATE SET until = MAX(until, excluded.until), reason = excluded.reason")
        .bind(until, e.message.slice(0, 300))
        .run();
      await fail(s, row, "issuance-rate-limited", e.message, st);
      return;
    }
    if (e instanceof AcmeError && e.status >= 400 && e.status < 500) {
      await fail(s, row, "issuance-acme-failed", e.message, st);
      return;
    }
    // A network error or the CA's 5xx: release the lock, the next poll tries again (the timeout bounds it).
    console.warn(JSON.stringify({ event: "issuance-step-retry", orderId: row.order_id, step: row.step, error: errText(e) }));
    await s.db.prepare("UPDATE certificate_orders SET lock_until = NULL WHERE order_id = ?").bind(row.order_id).run();
  }
}

async function stepNew(s: Service, row: OrderRow, st: AcmeState, client: AcmeClient): Promise<void> {
  const denied = await reauthorize(s, row, st);
  if (denied) return fail(s, row, denied, null, st);
  // A retried first step: what the interrupted attempt published goes first.
  if (st.authz.length > 0) await cleanup(s, st, client, true);
  const names = row.names.split("\n");
  const order = await client.newOrder(names);
  await save(s, row, { acme_order_url: order.url, acme_ordered_at: s.now }, true);
  const next: AcmeState = { finalize: order.finalize, authz: [], grant: st.grant ?? null };
  try {
    for (const url of order.authorizations) {
      const a = await client.get<{ identifier: { value: string }; status: string; wildcard?: boolean; challenges: Array<{ type: string; url: string; token: string }> }>(url);
      const identifier = a.wildcard ? `*.${a.identifier.value}` : a.identifier.value;
      // Only the names this order asked for get a record, whatever the CA lists.
      if (!names.includes(identifier.toLowerCase()) && !names.includes(a.identifier.value.toLowerCase())) throw new AcmeError(400, "unexpected-identifier", identifier);
      if (a.status === "valid") {
        next.authz.push({ url, identifier, status: "valid" });
        continue;
      }
      const ch = a.challenges.find((c) => c.type === "dns-01");
      if (!ch) throw new AcmeError(400, "no-dns01", `no DNS-01 challenge for ${identifier}`);
      const value = await dns01Value(ch.token, s.key.thumbprint);
      const record = await s.dns.createTxt({ name: `_acme-challenge.${a.identifier.value.replace(/^\*\./, "")}`, value, ttl: 60 });
      next.authz.push({ url, identifier, status: a.status, challengeUrl: ch.url, recordId: record.id });
    }
  } catch (e) {
    await save(s, row, { acme_json: JSON.stringify(next) });
    throw e;
  }
  await save(s, row, { step: "published", published_at: s.now, acme_json: JSON.stringify(next) });
}

async function stepAnswer(s: Service, row: OrderRow, st: AcmeState, client: AcmeClient): Promise<void> {
  if (s.now < (row.published_at ?? 0) + (s.deps.propagationMs ?? DEFAULT_PROPAGATION_MS)) {
    await save(s, row, {});
    return;
  }
  const denied = await reauthorize(s, row, st);
  if (denied) return fail(s, row, denied, null, st);
  for (const a of st.authz) if (a.status !== "valid" && a.challengeUrl) await client.respond(a.challengeUrl);
  await save(s, row, { step: "validating" });
}

async function stepValidate(s: Service, row: OrderRow, st: AcmeState, client: AcmeClient): Promise<void> {
  for (const a of st.authz) {
    if (a.status === "valid") continue;
    const now = await client.get<{ status: string; challenges?: Array<{ error?: { detail?: string } }> }>(a.url);
    a.status = now.status;
    if (now.status === "invalid") {
      const detail = now.challenges?.find((c) => c.error)?.error?.detail ?? "validation failed";
      return fail(s, row, "issuance-acme-failed", `${a.identifier}: ${detail}`, st);
    }
  }
  if (st.authz.some((a) => a.status !== "valid")) {
    await save(s, row, { acme_json: JSON.stringify(st) });
    return;
  }
  const denied = await reauthorize(s, row, st);
  if (denied) return fail(s, row, denied, null, st);
  await client.finalize(st.finalize, base64ToBytes(row.csr_b64));
  await save(s, row, { step: "finalizing", acme_json: JSON.stringify(st) });
}

async function stepFinish(s: Service, row: OrderRow, st: AcmeState, client: AcmeClient): Promise<void> {
  const order = await client.get<{ status: string; certificate?: string }>(row.acme_order_url!);
  if (order.status === "invalid") return fail(s, row, "issuance-acme-failed", "the order became invalid", st);
  if (order.status !== "valid" || !order.certificate) {
    await save(s, row, {});
    return;
  }
  const pem = await client.download(order.certificate);
  const csrSpki = parseCsr(base64ToBytes(row.csr_b64)).publicKey.spki;
  const chain = await checkChain(pem, row.names.split("\n"), csrSpki, s.now);
  if (!chain.ok) {
    if (chain.leafDer) await queueRevocation(s, row.order_id, chain.leafDer, "chain-mismatch");
    return fail(s, row, "issuance-chain-mismatch", chain.why, st);
  }
  // Revocation can win the race with the CA: then the certificate exists but is never delivered, and is revoked.
  const denied = await reauthorize(s, row, st);
  if (denied) {
    await queueRevocation(s, row.order_id, chain.leafDer, "revoked-during-order");
    return fail(s, row, "issuance-revoked-during-order", null, st);
  }
  await cleanup(s, st, client, false);
  await save(s, row, { status: "issued", step: "done", chain_pem: pem, not_before: chain.notBefore, not_after: chain.notAfter });
}

async function cleanup(s: Service, st: AcmeState, client: AcmeClient | null, deactivate: boolean): Promise<void> {
  for (const a of st.authz) {
    if (a.recordId) {
      try {
        await s.dns.deleteById(a.recordId);
        delete a.recordId;
      } catch (e) {
        console.warn(JSON.stringify({ event: "issuance-dns-cleanup-failed", record: a.recordId, error: errText(e) }));
      }
    }
    // A failed order's pending authorizations are closed so nothing can finish them later.
    if (deactivate && client && a.status === "pending") {
      try {
        await client.deactivateAuthorization(a.url);
        a.status = "deactivated";
      } catch {
        /* the authorization expires on its own */
      }
    }
  }
}

async function fail(s: Service, row: OrderRow, code: IssuanceRefusal, detail: string | null, st = stateOf(row)): Promise<void> {
  let client: AcmeClient | null = null;
  if (st.authz.some((a) => a.status === "pending")) client = await acmeClient(s).catch(() => null);
  await cleanup(s, st, client, true);
  if (detail) console.warn(JSON.stringify({ event: "issuance-order-failed", orderId: row.order_id, code, detail: detail.slice(0, 300) }));
  await save(s, row, { status: "failed", step: "done", error_code: code, error: detail?.slice(0, 500) ?? null, acme_json: JSON.stringify(st) });
}

async function queueRevocation(s: Service, orderId: string, leaf: Uint8Array, reason: string): Promise<void> {
  await s.db
    .prepare(
      "INSERT OR IGNORE INTO certificate_revocations (order_id, leaf_b64, reason, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?)",
    )
    .bind(orderId, bytesToBase64Url(leaf), reason, s.now, s.now)
    .run();
  await revokeAtCa(s, orderId, leaf, reason);
}

/** RFC 5280 reasons: 5 cessationOfOperation for a device that lost its permission, 4 superseded otherwise. */
async function revokeAtCa(s: Service, orderId: string, leaf: Uint8Array, reason: string): Promise<void> {
  try {
    const client = await acmeClient(s);
    await client.revoke(leaf, reason === "revoked-during-order" ? 5 : 4);
    await s.db.prepare("UPDATE certificate_revocations SET status = 'revoked', attempts = attempts + 1, updated_at = ? WHERE order_id = ?").bind(s.now, orderId).run();
  } catch (e) {
    const done = e instanceof AcmeError && e.type === "urn:ietf:params:acme:error:alreadyRevoked";
    await s.db
      .prepare("UPDATE certificate_revocations SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE order_id = ?")
      .bind(done ? "revoked" : "queued", errText(e).slice(0, 300), s.now, orderId)
      .run();
    if (!done) console.error(JSON.stringify({ event: "issuance-ca-revocation-failed", orderId, error: errText(e) }));
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}


// ── residual authority (docs/runbooks/issuance-migration.md) ──────────────

/**
 * Revoke a certificate some other ACME account got for names under our apex (a box's old account, before this service
 * existed). RFC 8555 §7.6 lets any account revoke a certificate when it holds valid authorizations for every name in
 * it, so the service authorizes those names itself (DNS-01 in the zone it controls) and revokes. Admin only; runs in
 * one request (a rare operation: up to about a minute).
 */
async function adminRevoke(s: Service, request: Request): Promise<Response> {
  let pem: string;
  let reason = 1;
  try {
    const b = (await request.json()) as { certificatePem?: unknown; reason?: unknown };
    pem = String(b.certificatePem ?? "");
    if (typeof b.reason === "number" && [0, 1, 3, 4, 5].includes(b.reason)) reason = b.reason;
  } catch {
    return refuse("issuance-malformed");
  }
  const leaf = pemBlocks(pem)[0];
  if (!leaf) return refuse("issuance-malformed");
  let names: string[];
  try {
    const sans = parseCertificate(leaf).sans;
    if (sans.some((x) => x.type !== "dns")) return json({ error: "The certificate names something other than DNS names.", code: "issuance-malformed" }, 400);
    names = [...new Set(sans.map((x) => (x as { value: string }).value.toLowerCase()))];
  } catch {
    return refuse("issuance-malformed");
  }
  if (names.length === 0 || names.some((n) => !n.replace(/^\*\./, "").endsWith(`.${s.apex}`))) {
    return json({ error: "Only certificates for names under the services apex can be revoked here.", code: "issuance-malformed" }, 400);
  }
  const client = await acmeClient(s);
  const st: AcmeState = { finalize: "", authz: [] };
  try {
    const order = await client.newOrder(names);
    for (const url of order.authorizations) {
      const a = await client.get<{ identifier: { value: string }; status: string; challenges: Array<{ type: string; url: string; token: string }> }>(url);
      if (a.status === "valid") {
        st.authz.push({ url, identifier: a.identifier.value, status: "valid" });
        continue;
      }
      const ch = a.challenges.find((c) => c.type === "dns-01");
      if (!ch) throw new AcmeError(400, "no-dns01", a.identifier.value);
      const record = await s.dns.createTxt({ name: `_acme-challenge.${a.identifier.value}`, value: await dns01Value(ch.token, s.key.thumbprint), ttl: 60 });
      st.authz.push({ url, identifier: a.identifier.value, status: a.status, challengeUrl: ch.url, recordId: record.id });
    }
    if (st.authz.some((a) => a.status !== "valid")) {
      await sleep(s.deps.propagationMs ?? DEFAULT_PROPAGATION_MS);
      for (const a of st.authz) if (a.status !== "valid" && a.challengeUrl) await client.respond(a.challengeUrl);
      for (let i = 0; i < 30 && st.authz.some((a) => a.status !== "valid"); i++) {
        for (const a of st.authz) {
          if (a.status === "valid") continue;
          a.status = (await client.get<{ status: string }>(a.url)).status;
          if (a.status === "invalid") throw new AcmeError(400, "validation", `${a.identifier} did not validate`);
        }
        if (st.authz.some((a) => a.status !== "valid")) await sleep(2000);
      }
      if (st.authz.some((a) => a.status !== "valid")) throw new AcmeError(504, "timeout", "the names did not validate in time");
    }
    await client.revoke(leaf, reason);
    return json({ revoked: true, names });
  } catch (e) {
    const already = e instanceof AcmeError && e.type === "urn:ietf:params:acme:error:alreadyRevoked";
    return already ? json({ revoked: true, already: true, names }) : json({ error: errText(e), code: "issuance-acme-failed" }, 502);
  } finally {
    await cleanup(s, st, client, true);
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
