// The owner's Database section (docs/app-apis.md §6): an app's LIVE data over
// the paired owner session. Browsing and SQL run read-only and unsigned; a
// statement that changes data comes back 400 `needsGrant`, and running it
// takes a signed order the box accepts once:
//
//   flagship/app-db-write/v1|<serverDomain>|<serviceId>|<store>|<sha256 hex of the UTF-8 sql>|<issuedAt ms>
//
// signed with the sensitive-order key. `serverDomain` is the box the request
// goes to (the paired pod), never the account's leader. Companion sessions get
// 403 on every call, so the entry is hidden for them.
//
// Must pass packages/protocol/test-vectors/app-db-write/vectors.json.

import { requireOwnerProfile } from "./companionGuard.js";

export const TAG_APP_DB_WRITE = "flagship/app-db-write/v1";
export const DB_PAGE_SIZE = 100;

export const DB_TITLE = "Database";
export const DB_OPEN = "Open database";
export const DB_RUN_SQL = "Run SQL";
export const DB_RUN = "Run";
export const DB_EXPORT_CSV = "Export CSV";
export const DB_CONFIRM_WRITE = "This changes data. Confirm to run it.";
export const DB_CONFIRM_RUN = "Confirm and run";
export const DB_NOTE =
  "Your app's live data. Browsing and queries only read; a statement that changes data asks you to confirm it first.";
export const DB_TRUNCATED_NOTE = "Showing the first rows only: the result was cut off.";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fieldGuard(name, v) {
  if (typeof v !== "string" || v.length === 0) throw new Error(`app-db-write: empty ${name}`);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) throw new Error(`app-db-write: bad character in ${name}`);
  }
}

/** Lowercase hex SHA-256 of the SQL's UTF-8 bytes, exactly as sent. */
export async function appDbSqlSha256(sql) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(sql)));
  return toHex(new Uint8Array(digest));
}

export function canonicalAppDbWriteBytes({ serverDomain, serviceId, store, sqlSha256, issuedAt }) {
  fieldGuard("serverDomain", serverDomain);
  fieldGuard("serviceId", serviceId);
  fieldGuard("store", store);
  if (!SHA256_HEX_RE.test(String(sqlSha256 ?? ""))) throw new Error("app-db-write: bad sqlSha256");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("app-db-write: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_DB_WRITE, serverDomain, serviceId, store, sqlSha256, String(issuedAt)].join("|"),
  );
}

/** Resolves to the POST body `{sql, grant, signature}`. */
export async function signAppDbWrite({ serverDomain, serviceId, store, sql, issuedAt, umk, signWithIrk, bytesToHex = toHex }) {
  const grant = { serverDomain, serviceId, store, sqlSha256: await appDbSqlSha256(sql), issuedAt };
  const sig = await signWithIrk(umk, canonicalAppDbWriteBytes(grant));
  return { sql, grant, signature: bytesToHex(sig) };
}

const dbPath = (serviceId) => `/api/screens/services/${encodeURIComponent(serviceId)}/db`;
const tablePath = (serviceId, store, table) =>
  `${dbPath(serviceId)}/${encodeURIComponent(store)}/tables/${encodeURIComponent(table)}`;
const queryPath = (serviceId, store) => `${dbPath(serviceId)}/${encodeURIComponent(store)}/query`;

export function exportCsvPath(serviceId, store, table) {
  return `${tablePath(serviceId, store, table)}/export.csv`;
}

const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `[{store, tables:[{name, kind, rows, bytes}]}]` from GET …/db. */
export function readDbStores(body) {
  const stores = Array.isArray(body?.stores) ? body.stores : [];
  return stores
    .filter((s) => s && typeof s === "object" && typeof s.store === "string" && s.store)
    .map((s) => ({
      store: s.store,
      tables: (Array.isArray(s.tables) ? s.tables : [])
        .filter((t) => t && typeof t === "object" && typeof t.name === "string" && t.name)
        .map((t) => ({
          name: t.name,
          kind: t.kind === "view" ? "view" : "table",
          rows: finiteOrNull(t.rows),
          bytes: finiteOrNull(t.bytes),
        })),
    }));
}

function readColumns(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter((c) => c && typeof c === "object" && typeof c.name === "string")
    .map((c) => ({ name: c.name, type: typeof c.type === "string" ? c.type : "" }));
}

const readRows = (arr) => (Array.isArray(arr) ? arr.filter((r) => Array.isArray(r)) : []);

/** The app's stores, or null when the box has no Database section (an older box 404s). */
export async function fetchDbStores(serviceId, fetchJson) {
  try {
    return readDbStores(await fetchJson(dbPath(serviceId)));
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
}

/** One page of a table: `{columns, rows, total, offset, limit}`. */
export async function fetchTableRows({ serviceId, store, table, offset = 0, limit = DB_PAGE_SIZE, fetchJson }) {
  const q = `?offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`;
  const r = await fetchJson(`${tablePath(serviceId, store, table)}${q}`);
  return {
    columns: readColumns(r?.columns),
    rows: readRows(r?.rows),
    total: finiteOrNull(r?.total),
    offset,
    limit,
  };
}

export function readQueryResult(r) {
  return {
    command: typeof r?.command === "string" ? r.command : "",
    columns: readColumns(r?.columns),
    rows: readRows(r?.rows),
    rowCount: finiteOrNull(r?.rowCount),
    truncated: r?.truncated === true,
  };
}

/** True when the box refused a read-only run because the statement writes. */
export function needsGrant(e) {
  return e?.status === 400 && e?.body?.needsGrant === true;
}

/** Run `sql` read-only (no signature). Throws the box's refusal; check it with `needsGrant`. */
export async function runQuery({ serviceId, store, sql, fetchJson }) {
  return readQueryResult(
    await fetchJson(queryPath(serviceId, store), { method: "POST", body: JSON.stringify({ sql }) }),
  );
}

let lastIssuedAt = 0;

/** A fresh issuedAt for each signed order, so signing the same statement
 *  again (after a 409) is always a new order. */
export function nextIssuedAt(now = Date.now) {
  lastIssuedAt = Math.max(now(), lastIssuedAt + 1);
  return lastIssuedAt;
}

/**
 * Sign `sql` as a write order for this box and send it. Every call signs a new
 * order; a 409 (that order was already used) is thrown so the owner confirms
 * again rather than the statement silently running twice.
 *
 * @param {object} args
 * @param {string} args.serverDomain  the paired box's FQDN
 * @param {string} args.serviceId
 * @param {string} args.store
 * @param {string} args.sql
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk  the sensitive-order signer
 * @param {(path: string, init?: object) => Promise<any>} args.fetchJson  screensFetch
 * @param {{ now?: () => number, requireOwnerProfile?: () => void }} [deps]
 */
export async function runSignedQuery(args, deps = {}) {
  const { serverDomain, serviceId, store, sql, umk, signWithIrk, fetchJson, bytesToHex } = args;
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  if (!umk || typeof signWithIrk !== "function") throw new Error("Unlock the webapp first");
  if (!serverDomain) throw new Error("Pair with this server first");
  const body = await signAppDbWrite({
    serverDomain,
    serviceId,
    store,
    sql,
    issuedAt: nextIssuedAt(deps.now ?? Date.now),
    umk,
    signWithIrk,
    ...(bytesToHex ? { bytesToHex } : {}),
  });
  return readQueryResult(await fetchJson(queryPath(serviceId, store), { method: "POST", body: JSON.stringify(body) }));
}

/**
 * Run `sql`: read-only first; when the box says it writes (`needsGrant`), ask
 * `confirm(note)` and, on yes, sign it for this box and send it again. A 409
 * (that signed order was already used) asks again with a note and signs a new
 * order. Resolves to `{result, signed}` or `{cancelled: true}`; other refusals
 * throw.
 *
 * @param {object} args
 * @param {string} args.serviceId
 * @param {string} args.store
 * @param {string} args.sql
 * @param {(path: string, init?: object) => Promise<any>} args.fetchJson
 * @param {(note: string) => Promise<boolean>} args.confirm
 * @param {() => {serverDomain: string, umk: Uint8Array, signWithIrk: Function, bytesToHex?: Function}} args.signer
 *        read after the owner confirms
 * @param {{ now?: () => number, requireOwnerProfile?: () => void }} [deps]
 */
export async function executeSql({ serviceId, store, sql, fetchJson, confirm, signer }, deps = {}) {
  try {
    return { result: await runQuery({ serviceId, store, sql, fetchJson }), signed: false };
  } catch (e) {
    if (!needsGrant(e)) throw e;
  }
  let note = "";
  for (;;) {
    if (!(await confirm(note))) return { cancelled: true };
    try {
      const result = await runSignedQuery({ ...signer(), serviceId, store, sql, fetchJson }, deps);
      return { result, signed: true };
    } catch (e) {
      if (e?.status !== 409) throw e;
      note = dbErrorMessage(e);
    }
  }
}

/** `<table>.csv` from the box's content-disposition, else from the table name. */
export function csvFilename(disposition, table) {
  const m = /filename="([^"]+)"/.exec(String(disposition ?? ""));
  if (m) return m[1];
  return `${String(table ?? "table").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "table"}.csv`;
}

/**
 * Fetch a table as CSV. Resolves to `{blob, filename}`; throws a ScreensError-
 * shaped `{status, body}` error on a refusal (413 for a table over 64 MB).
 */
export async function fetchTableCsv({ serviceId, store, table, base, token, fetchImpl = globalThis.fetch, makeError }) {
  if (!base || !token) throw makeError("not paired to a server yet", 0, null);
  const r = await fetchImpl(`${base.replace(/\/+$/, "")}${exportCsvPath(serviceId, store, table)}`, {
    headers: { "x-flagship-session": token },
  });
  if (!r.ok) {
    let body = null;
    try {
      body = JSON.parse(await r.text());
    } catch {
      body = null;
    }
    throw makeError(body && typeof body.error === "string" ? body.error : `HTTP ${r.status}`, r.status, body);
  }
  return { blob: await r.blob(), filename: csvFilename(r.headers?.get?.("content-disposition"), table) };
}

/** Whether this session may see the Database entry: owners only, not a
 *  companion and not a restricted device (`deviceCapability` short of full). */
export function canUseDatabase({ companion, deviceCapability, isFullyScoped }) {
  if (companion) return false;
  if (deviceCapability && !isFullyScoped(deviceCapability)) return false;
  return true;
}

export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "size unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

export function approxRowsText(rows) {
  if (rows === null || rows === undefined) return "rows unknown";
  const n = Math.max(0, Math.round(rows));
  return `~${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
}

/** "Rows 101–200 of 1,234" (or "No rows"). */
export function pageRangeText({ offset, rows, total }) {
  if (rows === 0 && offset === 0) return "No rows";
  const from = offset + 1;
  const to = offset + rows;
  const of = total === null || total === undefined ? "" : ` of ${total.toLocaleString("en-US")}`;
  return `Rows ${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")}${of}`;
}

/** Whether there's a next page after this one. */
export function hasNextPage({ offset, rows, limit, total }) {
  if (total !== null && total !== undefined) return offset + rows < total;
  return rows >= limit;
}

/** "UPDATE · 3 rows" / "SELECT · 1 row" / "CREATE". */
export function queryResultSummary(r) {
  const cmd = r.command || "Done";
  if (r.rowCount === null || r.rowCount === undefined) return cmd;
  return `${cmd} · ${r.rowCount.toLocaleString("en-US")} ${r.rowCount === 1 ? "row" : "rows"}`;
}

/** A cell as text, or null for SQL NULL. */
export function cellText(v, max = 500) {
  if (v === null || v === undefined) return null;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The box's refusal, said plainly. */
export function dbErrorMessage(e) {
  const status = e?.status;
  const raw = typeof e?.body?.error === "string" && e.body.error ? e.body.error : String(e?.message ?? "");
  if (status === 400) {
    const pos = Number.isFinite(e?.body?.position) ? ` (at character ${e.body.position})` : "";
    return `${raw || "Your server refused this statement"}${pos}`;
  }
  if (status === 404) return "This app, store or table isn't on this server anymore.";
  if (status === 409) return "That confirmation was already used. Confirm again to run it.";
  if (status === 413) {
    if (/too long/i.test(raw)) return "This statement is too long to run.";
    return "This table is too big to export at once (over 64 MB). Export it in parts with a query.";
  }
  if (status === 503) return "Your server couldn't reach this app's database. Try again in a moment.";
  if (status === 403) {
    if (/companion|read-only|owner/i.test(raw)) return "Open the database from your owner app.";
    if (/stale|clock|issuedAt/i.test(raw)) return "This device's clock is more than 10 minutes off. Fix the clock and try again.";
    if (/different server|serverDomain/i.test(raw)) return "This confirmation was signed for a different server.";
    if (/not the one that was signed/i.test(raw)) return "The statement changed after you confirmed it. Run it again.";
    if (/signature/i.test(raw)) return "Your server didn't accept this confirmation's signature.";
    return raw || "Your server refused this statement.";
  }
  return raw || "Couldn't reach this app's database.";
}
