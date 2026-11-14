/**
 * Direct access on `.com` (docs/direct-access-and-domains.md §6 step 3; LOCKED 2026-11-08).
 *
 *   POST /api/accounts/<u>/direct-access          the owner's `direct-access/v1` order for one of its boxes
 *   POST /api/direct-access/address               the box's `direct-address/v1` update (+ the order it sits in)
 *   POST /api/accounts/<u>/direct-names           the owner's `direct-name/v1` order for one name on the direct domain
 *   GET  /api/accounts/<u>/direct-access          (read token) the account's orders, names, zone state, probes
 *   POST /api/accounts/<u>/direct-names/<n>/probe (read token) the outside reachability diagnostic
 *
 * `.com` publishes exactly the records the owner signed and nothing else: no relay fallback for IPv4 visitors, no
 * repointing when a box is down, no health check that changes a record. Orders verify under the account's
 * sensitive-order key (the admin root, or an admin-granted device; the IRK only on an account that pins none), the
 * same rule the box applies. An address update verifies under the registered box's STK and must sit inside the
 * box's newest order. A name follows the box's addresses (the newest accepted update, or before any update the
 * order's exact addresses) unless its own order lists addresses. Each name gets a CAA record pinned to the issuance
 * service's ACME account unless its order turns CAA off.
 *
 * The zone is reconciled per name (`reconcileDirectName`): what the rows say against what the zone holds, by
 * (type, content). Every check is redone at reconcile time, so an admin-root rotation, a removed or transferred box
 * or a deleted account withdraws the records on the next pass.
 */
import {
  canonicalIp,
  checkDirectAddressUpdate,
  DIRECT_APEX,
  directAccessOrderProblem,
  directAccessOrderSha256,
  directLabelOf,
  directNameKind,
  directNameOrderProblem,
  parseDirectAccessOrder,
  parseDirectNameOrder,
  verifyDirectAccessOrder,
  verifyDirectNameOrder,
  type DirectAccessOrder,
  type DirectAddressUpdate,
  type DirectNameOrder,
} from "@flagship/protocol";
import { buildCaaIssueValue } from "@flagship/services-zone";
import type {
  DeviceCapabilityGrantStorage,
  DirectAccessRecord,
  DirectAccessStorage,
  DirectNameRecord,
  ServerStorage,
  UsernameRecord,
  UsernameStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { hexToBytes } from "./hex.js";
import { ok, type HandlerResponseWithHeaders } from "./types.js";

const CLOCK_SKEW_MS = 5 * 60_000;
const HEX_SIG = /^[0-9a-f]{128}$/;
/** TTL of every direct record: the owner's address changes reach resolvers quickly (some ignore TTLs). */
export const DIRECT_RECORD_TTL = 60;
/** How often one name may be probed from outside. */
export const DIRECT_PROBE_MIN_INTERVAL_MS = 60_000;
/** Names one cron run reconciles (each is one list and a few creates/deletes). */
export const DIRECT_NAMES_PER_RUN = 4;

export interface DirectAccessDeps {
  usernames: UsernameStorage;
  servers: ServerStorage;
  directAccess: DirectAccessStorage;
  grants?: DeviceCapabilityGrantStorage;
  now?: () => number;
  /** The direct domain. Default `fshp.app`. */
  directApex?: string;
}

/** One record as the zone holds it. */
export interface DirectZoneRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

/** What reconciling needs from the direct zone's DNS provider (CloudflareDnsClient satisfies it). */
export interface DirectZoneDns {
  list(name: string): Promise<DirectZoneRecord[]>;
  createRecord(r: { name: string; type: "A" | "AAAA" | "CAA"; content: string; data?: { flags: number; tag: string; value: string }; ttl?: number }): Promise<{ id: string }>;
  deleteById(id: string): Promise<unknown>;
}

export interface DesiredRecord {
  type: "A" | "AAAA" | "CAA";
  content: string;
  data?: { flags: number; tag: string; value: string };
}

type Refusal = { status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): HandlerResponseWithHeaders => ({ status, body: { error, code } });
const fromRefusal = (r: Refusal) => refuse(r.status, r.code, r.error);

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? Date.now)();
}

function apexOf(deps: { directApex?: string }): string {
  return (deps.directApex ?? DIRECT_APEX).toLowerCase();
}

interface SignedBody<T> {
  order: T;
  signatureHex: string;
  pqSignature?: unknown;
}

function readSigned<T>(body: unknown, parse: (raw: unknown) => T | null): SignedBody<T> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const order = parse(b.order);
  if (!order || typeof b.signatureHex !== "string") return null;
  const signatureHex = b.signatureHex.toLowerCase();
  if (!HEX_SIG.test(signatureHex)) return null;
  return { order, signatureHex, ...(b.pqSignature !== undefined ? { pqSignature: b.pqSignature } : {}) };
}

/** The sensitive-order rule the box applies (authorizeSensitiveOrder): admin root or admin-granted device, the IRK only when none is pinned. */
export async function authorizeDirectOrder(deps: DirectAccessDeps, user: UsernameRecord, verify: (pub: Uint8Array) => boolean, now: number): Promise<boolean> {
  const a = await authorizeSensitiveComOp(
    { grants: deps.grants, now: () => now },
    { username: user.username, userRec: user, verifyWith: (pub) => verify(hexToBytes(pub)) },
  );
  return a.ok;
}

/** The box, when it is a live server of `username`. */
async function liveServer(deps: DirectAccessDeps, username: string, serverDomain: string) {
  const s = await deps.servers.get(serverDomain.toLowerCase());
  return s && !s.revokedAt && s.username.toLowerCase() === username.toLowerCase() ? s : null;
}

// ── the owner's direct-access order ───────────────────────────────────────

async function takeAccessOrder(deps: DirectAccessDeps, username: string, signed: SignedBody<DirectAccessOrder>, now: number): Promise<{ ok: true; stored: boolean } | Refusal> {
  const { order } = signed;
  const problem = directAccessOrderProblem(order);
  if (problem) return { status: 422, code: problem, error: "That direct access order isn't valid." };
  if (order.issuedAt > now + CLOCK_SKEW_MS) return { status: 422, code: "not-yet-valid", error: "That direct access order is dated in the future." };
  const user = await deps.usernames.get(username);
  if (!user) return { status: 404, code: "unknown-account", error: "No such account." };
  if (!(await liveServer(deps, username, order.serverDomain))) {
    return { status: 403, code: "not-your-server", error: "That server isn't one of this account's servers." };
  }
  if (!(await authorizeDirectOrder(deps, user, (pub) => verifyDirectAccessOrder(order, hexToBytes(signed.signatureHex), pub), now))) {
    return { status: 403, code: "not-admin", error: "Direct access orders must be signed by an admin device of this account." };
  }
  const put = await deps.directAccess.putOrderIfNewer({
    serverDomain: order.serverDomain,
    username,
    orderJson: JSON.stringify(order),
    signatureHex: signed.signatureHex,
    pqSignatureJson: signed.pqSignature !== undefined ? JSON.stringify(signed.pqSignature) : null,
    orderSha256: directAccessOrderSha256(order),
    enabled: order.enabled,
    issuedAt: order.issuedAt,
    updatedAt: now,
  });
  if (put.ok) await markServerNames(deps, order.serverDomain, now);
  return { ok: true, stored: put.ok };
}

async function markServerNames(deps: DirectAccessDeps, serverDomain: string, now: number): Promise<void> {
  const names = await deps.directAccess.listNamesForServer(serverDomain);
  await deps.directAccess.markPending(names.map((n) => n.name), now);
}

export async function handlePostDirectAccessOrder(deps: DirectAccessDeps, username: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const now = nowOf(deps);
  const signed = readSigned(body, parseDirectAccessOrder);
  if (!signed) return refuse(400, "malformed", "That direct access order can't be read.");
  const r = await takeAccessOrder(deps, u, signed, now);
  if (!("ok" in r)) return fromRefusal(r);
  if (!r.stored) return refuse(409, "replayed", "A newer direct access order is already stored for this server.");
  return ok({ ok: true });
}

// ── the box's address update ──────────────────────────────────────────────

function parseAddressUpdate(raw: unknown): DirectAddressUpdate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const keys = ["serverDomain", "orderSha256", "addresses", "port", "issuedAt"];
  const have = Object.keys(u);
  if (have.length !== keys.length || !keys.every((k) => have.includes(k))) return null;
  if (
    typeof u.serverDomain !== "string" ||
    typeof u.orderSha256 !== "string" ||
    !Array.isArray(u.addresses) ||
    !u.addresses.every((a) => typeof a === "string") ||
    typeof u.port !== "number" ||
    typeof u.issuedAt !== "number"
  ) {
    return null;
  }
  return { serverDomain: u.serverDomain, orderSha256: u.orderSha256, addresses: [...(u.addresses as string[])], port: u.port, issuedAt: u.issuedAt };
}

/**
 * `{update, signatureHex, directAccess?: {order, signatureHex, pqSignature?}}`: the shape the box serves at
 * `GET /api/screens/direct-access/address`. The bundled order is taken first when it is newer (the box forwards the
 * order its owner gave it); the update must then sit inside the order `.com` holds.
 */
export async function handlePostDirectAddress(deps: DirectAccessDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const update = b ? parseAddressUpdate(b.update) : null;
  const sigHex = b && typeof b.signatureHex === "string" ? b.signatureHex.toLowerCase() : "";
  if (!update || !HEX_SIG.test(sigHex)) return refuse(400, "malformed", "That address update can't be read.");
  const server = await deps.servers.get(update.serverDomain.toLowerCase());
  if (!server || server.revokedAt) return refuse(403, "unknown-server", "That server isn't registered.");
  const username = server.username.toLowerCase();
  if (b!.directAccess !== undefined) {
    const signed = readSigned(b!.directAccess, parseDirectAccessOrder);
    if (!signed) return refuse(400, "malformed", "That direct access order can't be read.");
    const r = await takeAccessOrder(deps, username, signed, now);
    if (!("ok" in r)) return fromRefusal(r);
  }
  const held = await deps.directAccess.getOrder(update.serverDomain);
  const order = held && held.username === username ? parseDirectAccessOrder(safeJson(held.orderJson)) : null;
  if (!order) return refuse(409, "no-order", "This server has no direct access order on record.");
  const check = checkDirectAddressUpdate(update, hexToBytes(sigHex), hexToBytes(server.identityPubKeyHex), order, { serverDomain: server.serverDomain, now });
  if (!check.ok) return refuse(check.reason === "bad-signature" ? 403 : 422, check.reason, "That address update doesn't fit this server's direct access order.");
  const put = await deps.directAccess.putUpdateIfNewer(update.serverDomain, update.orderSha256, {
    updateJson: JSON.stringify(update),
    updateSignatureHex: sigHex,
    updateIssuedAt: update.issuedAt,
    updatedAt: now,
  });
  if (put.ok) await markServerNames(deps, update.serverDomain, now);
  return ok({ ok: true, stored: put.ok });
}

// ── the owner's name order ────────────────────────────────────────────────

export async function handlePostDirectName(deps: DirectAccessDeps, username: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const now = nowOf(deps);
  const apex = apexOf(deps);
  const signed = readSigned(body, parseDirectNameOrder);
  if (!signed) return refuse(400, "malformed", "That direct name order can't be read.");
  const { order } = signed;
  const problem = directNameOrderProblem(order, apex);
  if (problem) return refuse(422, problem, "That direct name order isn't valid.");
  if (order.issuedAt > now + CLOCK_SKEW_MS) return refuse(422, "not-yet-valid", "That direct name order is dated in the future.");
  const label = directLabelOf(order.name, apex)!;
  const kind = directNameKind(label)!;
  if (kind.kind === "vanity") return refuse(403, "vanity-not-available", "Chosen names on the direct domain aren't available yet.");
  if (kind.creator !== u) return refuse(403, "not-your-name", "A derived direct name must end in this account's own name.");
  const user = await deps.usernames.get(u);
  if (!user) return refuse(404, "unknown-account", "No such account.");
  if (!(await liveServer(deps, u, order.serverDomain))) return refuse(403, "not-your-server", "That server isn't one of this account's servers.");
  if (!(await authorizeDirectOrder(deps, user, (pub) => verifyDirectNameOrder(order, hexToBytes(signed.signatureHex), pub, apex), now))) {
    return refuse(403, "not-admin", "Direct name orders must be signed by an admin device of this account.");
  }
  const put = await deps.directAccess.putNameIfNewer({
    name: label,
    username: u,
    kind: kind.kind,
    serverDomain: order.serverDomain,
    enabled: order.enabled,
    orderJson: JSON.stringify(order),
    signatureHex: signed.signatureHex,
    pqSignatureJson: signed.pqSignature !== undefined ? JSON.stringify(signed.pqSignature) : null,
    issuedAt: order.issuedAt,
    now,
  });
  if (!put.ok) {
    return put.reason === "taken"
      ? refuse(409, "taken", "That direct name belongs to another account.")
      : refuse(409, "replayed", "A newer order for this direct name is already stored.");
  }
  return ok({ ok: true, name: order.name });
}

// ── what the zone should hold ─────────────────────────────────────────────

export type DesiredReason =
  | "off"
  | "suspended"
  | "account-gone"
  | "server-gone"
  | "order-unverified"
  | "direct-access-off"
  | "no-addresses"
  | "caa-account-unknown";

export interface DesiredInput {
  name: DirectNameOrder;
  suspended: boolean;
  /** The box's direct-access state, already verified, or null. */
  access: { order: DirectAccessOrder; update: DirectAddressUpdate | null } | null;
  /** The issuance service's ACME account URL, for the pinned CAA. */
  caaAccountUri: string | null;
}

/** The records a name should have, or the reason it has none. Pure. */
export function desiredDirectRecords(i: DesiredInput): { records: DesiredRecord[]; reason: DesiredReason | null } {
  const none = (reason: DesiredReason) => ({ records: [], reason });
  if (i.suspended) return none("suspended");
  if (!i.name.enabled) return none("off");
  let addresses = i.name.addresses;
  if (addresses.length === 0) {
    if (!i.access || !i.access.order.enabled) return none("direct-access-off");
    addresses = i.access.update ? i.access.update.addresses : i.access.order.addresses;
  }
  addresses = [...new Set(addresses.filter((a) => canonicalIp(a) === a))].sort();
  if (addresses.length === 0) return none("no-addresses");
  if (i.name.caa === "pin" && !i.caaAccountUri) return none("caa-account-unknown");
  const records: DesiredRecord[] = addresses.map((a) => ({ type: a.includes(":") ? "AAAA" : "A", content: a }));
  if (i.name.caa === "pin") {
    const value = buildCaaIssueValue({ accountUri: i.caaAccountUri! });
    records.push({ type: "CAA", content: caaContent(0, "issue", value), data: { flags: 0, tag: "issue", value } });
    records.push({ type: "CAA", content: caaContent(0, "issuewild", ";"), data: { flags: 0, tag: "issuewild", value: ";" } });
  }
  return { records, reason: null };
}

const caaContent = (flags: number, tag: string, value: string) => `${flags} ${tag} "${value}"`;

function safeJson(s: string | null | undefined): unknown {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/**
 * Re-verify a name's state as of now: the account and box still stand, and both orders and the box's update still
 * verify under today's keys. Returns the input for `desiredDirectRecords`, or the reason nothing may be published.
 */
export async function directNameState(
  deps: DirectAccessDeps,
  row: DirectNameRecord,
  caaAccountUri: string | null,
): Promise<{ input: DesiredInput } | { reason: DesiredReason }> {
  const now = nowOf(deps);
  const apex = apexOf(deps);
  const name = parseDirectNameOrder(safeJson(row.orderJson));
  if (!name) return { reason: "order-unverified" };
  const user = await deps.usernames.get(row.username);
  if (!user) return { reason: "account-gone" };
  if (!name.enabled && !row.suspendedAt) return { input: { name, suspended: false, access: null, caaAccountUri } };
  const server = await liveServer(deps, row.username, name.serverDomain);
  if (!server) return { reason: "server-gone" };
  if (!(await authorizeDirectOrder(deps, user, (pub) => verifyDirectNameOrder(name, hexToBytes(row.signatureHex), pub, apex), now))) {
    return { reason: "order-unverified" };
  }
  let access: DesiredInput["access"] = null;
  if (name.addresses.length === 0) access = await verifiedAccess(deps, user, server.identityPubKeyHex, await deps.directAccess.getOrder(name.serverDomain), now);
  return { input: { name, suspended: !!row.suspendedAt, access, caaAccountUri } };
}

async function verifiedAccess(
  deps: DirectAccessDeps,
  user: UsernameRecord,
  stkHex: string,
  held: DirectAccessRecord | null,
  now: number,
): Promise<DesiredInput["access"]> {
  if (!held || held.username !== user.username.toLowerCase()) return null;
  const order = parseDirectAccessOrder(safeJson(held.orderJson));
  if (!order) return null;
  if (!(await authorizeDirectOrder(deps, user, (pub) => verifyDirectAccessOrder(order, hexToBytes(held.signatureHex), pub), now))) return null;
  let update: DirectAddressUpdate | null = null;
  const u = parseAddressUpdate(safeJson(held.updateJson));
  if (u && held.updateSignatureHex && HEX_SIG.test(held.updateSignatureHex)) {
    const check = checkDirectAddressUpdate(u, hexToBytes(held.updateSignatureHex), hexToBytes(stkHex), order, { serverDomain: order.serverDomain, now });
    if (check.ok) update = u;
  }
  return { order, update };
}

// ── publishing ────────────────────────────────────────────────────────────

export interface PublishDeps extends DirectAccessDeps {
  dns: DirectZoneDns;
  caaAccountUri: string | null;
}

/**
 * Make the zone hold exactly what one name should: delete records at the name that aren't wanted (any type the
 * publisher writes), create the missing ones, record the outcome. A name whose account is gone is withdrawn and its
 * row dropped, which releases it.
 */
export async function reconcileDirectName(deps: PublishDeps, row: DirectNameRecord): Promise<{ state: "published" | "empty" | "pending"; reason: string | null }> {
  const now = nowOf(deps);
  const fqdn = `${row.name}.${apexOf(deps)}`;
  const st = await directNameState(deps, row, deps.caaAccountUri);
  const want = "input" in st ? desiredDirectRecords(st.input) : { records: [], reason: st.reason };
  try {
    const held = (await deps.dns.list(fqdn)).filter((r) => r.name.toLowerCase() === fqdn && (r.type === "A" || r.type === "AAAA" || r.type === "CAA"));
    const key = (t: string, c: string) => `${t} ${c}`;
    const wanted = new Set(want.records.map((r) => key(r.type, r.content)));
    for (const r of held) if (!wanted.has(key(r.type, r.content))) await deps.dns.deleteById(r.id);
    const have = new Set(held.map((r) => key(r.type, r.content)));
    for (const r of want.records) {
      if (have.has(key(r.type, r.content))) continue;
      await deps.dns.createRecord({ name: fqdn, type: r.type, content: r.content, ...(r.data ? { data: r.data } : {}), ttl: DIRECT_RECORD_TTL });
    }
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    await deps.directAccess.setPublished(row.name, row.updatedAt, { publishedJson: row.publishedJson, state: "pending", reason: want.reason, error, now });
    return { state: "pending", reason: want.reason };
  }
  const state = want.records.length > 0 ? "published" : "empty";
  const publishedJson = JSON.stringify(want.records.map((r) => ({ type: r.type, content: r.content })));
  if (want.reason === "account-gone") {
    await deps.directAccess.delete(row.name);
  } else {
    await deps.directAccess.setPublished(row.name, row.updatedAt, { publishedJson, state, reason: want.reason, error: null, now });
  }
  return { state, reason: want.reason };
}

/** The cron pass: reconcile the oldest pending names. */
export async function runDirectNamesPublish(deps: PublishDeps, limit = DIRECT_NAMES_PER_RUN): Promise<{ reconciled: number; failed: number }> {
  const rows = await deps.directAccess.listPending(limit);
  let failed = 0;
  for (const row of rows) {
    const r = await reconcileDirectName(deps, row);
    if (r.state === "pending") failed++;
  }
  return { reconciled: rows.length, failed };
}

// ── reading it back, and the outside probe ────────────────────────────────

function nameView(row: DirectNameRecord, apex: string) {
  const order = parseDirectNameOrder(safeJson(row.orderJson));
  return {
    name: `${row.name}.${apex}`,
    kind: row.kind,
    serverDomain: row.serverDomain,
    enabled: row.enabled,
    caa: order?.caa ?? "pin",
    addresses: order?.addresses ?? [],
    issuedAt: row.issuedAt,
    state: row.publishState,
    reason: row.publishReason ?? null,
    error: row.publishError ?? null,
    published: safeJson(row.publishedJson) ?? [],
    publishedAt: row.publishedAt ?? null,
    suspended: row.suspendedAt ? { at: row.suspendedAt, reason: row.suspendedReason ?? null } : null,
    probe: row.probeJson ? { at: row.probeAt ?? null, ...(safeJson(row.probeJson) as object) } : null,
  };
}

/** The account's direct-access state for its apps (the read token gates the route). */
export async function handleGetDirectAccess(deps: DirectAccessDeps, username: string): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const apex = apexOf(deps);
  const [orders, names] = await Promise.all([deps.directAccess.listOrdersForUser(u), deps.directAccess.listNamesForUser(u)]);
  return ok({
    apex,
    servers: orders.map((o) => {
      const order = parseDirectAccessOrder(safeJson(o.orderJson));
      const update = parseAddressUpdate(safeJson(o.updateJson));
      return {
        serverDomain: o.serverDomain,
        on: o.enabled,
        addresses: order?.addresses ?? [],
        prefixes: order?.prefixes ?? [],
        port: order?.port ?? null,
        issuedAt: o.issuedAt,
        boxAddresses: update?.addresses ?? null,
        boxReportedAt: update?.issuedAt ?? null,
      };
    }),
    names: names.map((n) => nameView(n, apex)),
  });
}

export interface DirectProbeResult {
  /** Did an HTTPS request to the name finish a TLS handshake valid for the name? */
  ok: boolean;
  status?: number;
  error?: string;
}

/** Reaches a direct name from outside the owner's network (the Worker's `fetch`, in production). */
export interface DirectProber {
  https(fqdn: string, port: number): Promise<DirectProbeResult>;
}

/**
 * The outside reachability diagnostic (§5): an HTTPS request to the published name. A diagnostic, never a gate:
 * the answer is stored for the owner's apps and changes no record. With the default CAA only the owner's box can
 * hold a valid certificate for the name, so an answer that completes TLS came from it (or, with CAA off, from the
 * host the owner chose).
 */
export async function handleProbeDirectName(
  deps: DirectAccessDeps & { prober: DirectProber },
  username: string,
  label: string,
): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const apex = apexOf(deps);
  const row = await deps.directAccess.getName(label.toLowerCase());
  if (!row || row.username !== username.toLowerCase()) return refuse(404, "unknown-name", "No such direct name on this account.");
  if (row.probeAt && now - row.probeAt < DIRECT_PROBE_MIN_INTERVAL_MS) {
    return refuse(429, "probe-too-soon", "This name was checked a moment ago. Try again in a minute.");
  }
  const published = (safeJson(row.publishedJson) as Array<{ type: string; content: string }> | null) ?? [];
  const addresses = published.filter((r) => r.type === "A" || r.type === "AAAA").map((r) => r.content);
  let result: { reachable: boolean | null; addresses: string[]; https?: DirectProbeResult; why?: string };
  if (addresses.length === 0) {
    result = { reachable: null, addresses, why: "not-published" };
  } else {
    const access = await deps.directAccess.getOrder(row.serverDomain);
    const port = parseDirectAccessOrder(safeJson(access?.orderJson))?.port ?? 443;
    let https: DirectProbeResult;
    try {
      https = await deps.prober.https(`${row.name}.${apex}`, port);
    } catch (e) {
      https = { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
    }
    result = { reachable: https.ok, addresses, https };
  }
  await deps.directAccess.setProbe(row.name, JSON.stringify(result), now);
  return ok({ name: `${row.name}.${apex}`, at: now, ...result });
}
