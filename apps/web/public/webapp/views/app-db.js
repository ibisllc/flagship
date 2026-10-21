// An app's live database (docs/app-apis.md §6), owner sessions only: its
// stores' tables, a table's rows 100 at a time with Export CSV, and Run SQL.
// Runs are read-only; a statement that writes comes back `needsGrant`, and
// Confirm and run signs it (flagship/app-db-write/v1, sensitive-order key) for
// the paired box and sends it again (lib/appDb.js executeSql).

import { $, registerView, show } from "../lib/router.js";
import { getPodBaseUrl, getSessionToken, screensFetch, ScreensError } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { DB_WRITE_ADMIN_ONLY, canSignAdminOrders } from "../lib/addServerGate.js";
import { podServerDomain } from "../lib/accessAlerts.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import {
  DB_CONFIRM_RUN,
  DB_CONFIRM_WRITE,
  DB_EXPORT_CSV,
  DB_NOTE,
  DB_PAGE_SIZE,
  DB_RUN,
  DB_RUN_SQL,
  DB_TITLE,
  DB_TRUNCATED_NOTE,
  approxRowsText,
  cellText,
  dbErrorMessage,
  fetchDbStores,
  fetchTableCsv,
  fetchTableRows,
  formatBytes,
  hasNextPage,
  executeSql,
  pageRangeText,
  queryResultSummary,
} from "../lib/appDb.js";

import { tr as tr_ } from "../lib/i18n.js";
registerView("view-app-db");

/** @type {{serviceId: string, appName: string, stores: any[], screen: string, store: string, table: string, offset: number, sql: string, src: DbSource} | null} */
let current = null;

/**
 * Where the page reads and how it signs a write. The owner's own server by
 * default: the paired session, the sensitive-order key, and writes only from
 * a device that can sign admin orders. A server shared with this account
 * ("Can see app data", docs/share-a-server.md §5.5) passes its own: the share
 * session, the per-share key, and writes only at "Can manage".
 * @typedef {{ fetchJson: Function, signer: () => object, writeRefusal: () => string, csvAuth: () => Promise<{base: string, token: string}>, back: () => Promise<void> }} DbSource
 */
function ownerSource(serviceId) {
  return {
    fetchJson: (path, init) => screensFetch(path, init),
    signer: () => ({ serverDomain: podServerDomain(), umk: getSession()?.umk ?? null, signWithIrk: sensitiveSigner() }),
    writeRefusal: () => (canSignAdminOrders() ? "" : DB_WRITE_ADMIN_ONLY),
    csvAuth: async () => ({ base: getPodBaseUrl(), token: getSessionToken() }),
    back: async () => {
      const { enterServiceDetail } = await import("./service-detail.js");
      await enterServiceDetail(serviceId);
    },
  };
}
const message = (e) => (e instanceof ScreensError || e?.status ? dbErrorMessage(e) : humanError(e));

export function renderDbTablesHtml(stores) {
  const many = stores.length > 1;
  const body = stores
    .map((s) => {
      const rows = s.tables.length === 0
        ? `<p class="muted-sm mt-1">${tr_("No tables yet.")}</p>`
        : s.tables
            .map(
              (t) => `
            <button class="db-table-row secondary" data-db-store="${escapeHtml(s.store)}" data-db-table="${escapeHtml(t.name)}">
              <span class="db-table-name mono">${escapeHtml(t.name)}${t.kind === "view" ? ' <span class="pill">view</span>' : ""}</span>
              <span class="muted-sm">${escapeHtml(approxRowsText(t.rows))} · ${escapeHtml(formatBytes(t.bytes))}</span>
            </button>`,
            )
            .join("");
      return `
        <div class="card" data-db-store-card="${escapeHtml(s.store)}">
          ${many ? `<div class="weight-600">${escapeHtml(s.store)}</div>` : ""}
          ${rows}
        </div>`;
    })
    .join("");
  return `
      <p class="note">${escapeHtml(DB_NOTE)}</p>
      ${body}
      <button id="app-db-sql" class="full-width mt-2">${escapeHtml(DB_RUN_SQL)}</button>`;
}

export function renderDbGridHtml(columns, rows) {
  if (columns.length === 0) return "";
  const head = columns
    .map((c) => `<th><div>${escapeHtml(c.name)}</div>${c.type ? `<div class="db-col-type">${escapeHtml(c.type)}</div>` : ""}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${columns
          .map((_, i) => {
            const t = cellText(r[i]);
            return t === null ? '<td class="db-null">NULL</td>' : `<td>${escapeHtml(t)}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="db-grid-wrap"><table class="db-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function renderDbTablePageHtml(page) {
  const prev = page.offset > 0;
  const next = hasNextPage({ offset: page.offset, rows: page.rows.length, limit: page.limit, total: page.total });
  return `
      <div class="card">
        <div class="row"><span class="muted-sm" id="app-db-range">${escapeHtml(
          pageRangeText({ offset: page.offset, rows: page.rows.length, total: page.total }),
        )}</span>
          <button id="app-db-export" class="secondary db-inline-btn">${escapeHtml(DB_EXPORT_CSV)}</button></div>
        ${renderDbGridHtml(page.columns, page.rows)}
        <div class="row-2 mt-2">
          <button id="app-db-prev" class="secondary"${prev ? "" : " disabled"}>${tr_("Previous")}</button>
          <button id="app-db-next" class="secondary"${next ? "" : " disabled"}>${tr_("Next")}</button>
        </div>
      </div>`;
}

export function renderDbSqlHtml({ stores, store, sql }) {
  const select = stores.length > 1
    ? `<label for="app-db-store">${tr_("Store")}</label>
       <select id="app-db-store">${stores
         .map((s) => `<option value="${escapeHtml(s.store)}"${s.store === store ? " selected" : ""}>${escapeHtml(s.store)}</option>`)
         .join("")}</select>`
    : "";
  return `
      <div class="card">
        ${select}
        <textarea id="app-db-sql-text" class="db-sql-editor mt-2" rows="6" spellcheck="false" autocapitalize="off"
          autocomplete="off" aria-label="${tr_("SQL")}" placeholder="${tr_("SELECT * FROM items LIMIT 10")}">${escapeHtml(sql)}</textarea>
        <button id="app-db-run" class="full-width mt-2">${escapeHtml(DB_RUN)}</button>
      </div>
      <div id="app-db-result" aria-live="polite"></div>`;
}

export function renderQueryResultHtml(r) {
  return `
      <div class="card" data-db-result>
        <div class="weight-600">${escapeHtml(queryResultSummary(r))}</div>
        ${r.truncated ? `<p class="muted-sm mt-1" data-db-truncated>${escapeHtml(DB_TRUNCATED_NOTE)}</p>` : ""}
        ${renderDbGridHtml(r.columns, r.rows)}
      </div>`;
}

export function renderQueryErrorHtml(text, { sqlState } = {}) {
  return `
      <div class="card" data-db-error>
        <p class="err-text">${escapeHtml(text)}</p>
        ${sqlState ? `<p class="faint-sm mono">${tr_("SQLSTATE {0}", escapeHtml(sqlState))}</p>` : ""}
      </div>`;
}

/** "This changes data. Confirm to run it." with Confirm and run; `note` is
 *  shown above it (e.g. a used confirmation). A device that can't sign the
 *  write (not an admin device: the box takes it only under the admin root;
 *  a share below "Can manage") gets `refusal`, why not, and no button. */
export function renderNeedsGrantHtml(note = "", { refusal = "" } = {}) {
  if (refusal) {
    return `
      <div class="card" data-db-needs-grant data-db-write-refused>
        <p class="weight-600">${escapeHtml(refusal)}</p>
      </div>`;
  }
  return `
      <div class="card" data-db-needs-grant>
        ${note ? `<p class="err-text">${escapeHtml(note)}</p>` : ""}
        <p class="weight-600">${escapeHtml(DB_CONFIRM_WRITE)}</p>
        <button id="app-db-confirm" class="full-width mt-2">${escapeHtml(DB_CONFIRM_RUN)}</button>
      </div>`;
}

function setTitle(text) {
  const t = $("app-db-title");
  if (t) t.textContent = text;
}

async function renderTables() {
  const ctx = current;
  ctx.screen = "tables";
  setTitle(`${ctx.appName}: ${DB_TITLE}`);
  const root = $("app-db-content");
  root.innerHTML = skeletonCards(2);
  let stores;
  try {
    stores = await fetchDbStores(ctx.serviceId, ctx.src.fetchJson);
  } catch (e) {
    if (current !== ctx) return;
    root.innerHTML = renderQueryErrorHtml(message(e));
    return;
  }
  if (current !== ctx) return;
  if (stores === null) {
    root.innerHTML = renderQueryErrorHtml(tr_("This server can't show app data yet. Update it first."));
    return;
  }
  ctx.stores = stores;
  ctx.store ||= stores[0]?.store ?? "";
  root.innerHTML = renderDbTablesHtml(stores);
  root.querySelectorAll("[data-db-table]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.store = btn.getAttribute("data-db-store");
      ctx.table = btn.getAttribute("data-db-table");
      ctx.offset = 0;
      void renderTable();
    });
  });
  $("app-db-sql")?.addEventListener("click", () => renderSql());
}

async function renderTable() {
  const ctx = current;
  ctx.screen = "table";
  setTitle(ctx.table);
  const root = $("app-db-content");
  root.innerHTML = skeletonCards(1);
  let page;
  try {
    page = await fetchTableRows({
      serviceId: ctx.serviceId,
      store: ctx.store,
      table: ctx.table,
      offset: ctx.offset,
      limit: DB_PAGE_SIZE,
      fetchJson: ctx.src.fetchJson,
    });
  } catch (e) {
    if (current !== ctx) return;
    root.innerHTML = renderQueryErrorHtml(message(e), { sqlState: e?.body?.sqlState });
    return;
  }
  if (current !== ctx || ctx.screen !== "table") return;
  root.innerHTML = renderDbTablePageHtml(page);
  $("app-db-prev")?.addEventListener("click", () => {
    ctx.offset = Math.max(0, ctx.offset - DB_PAGE_SIZE);
    void renderTable();
  });
  $("app-db-next")?.addEventListener("click", () => {
    ctx.offset += DB_PAGE_SIZE;
    void renderTable();
  });
  $("app-db-export")?.addEventListener("click", (ev) => void exportCsv(ev.currentTarget));
}

async function exportCsv(btn) {
  const ctx = current;
  btn.disabled = true;
  try {
    const { blob, filename } = await fetchTableCsv({
      serviceId: ctx.serviceId,
      store: ctx.store,
      table: ctx.table,
      ...(await ctx.src.csvAuth()),
      makeError: (msg, status, body) => new ScreensError(msg, status, body),
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (e) {
    toast(message(e), "err");
  } finally {
    btn.disabled = false;
  }
}

function renderSql() {
  const ctx = current;
  ctx.screen = "sql";
  setTitle(`${ctx.appName}: ${DB_RUN_SQL}`);
  const root = $("app-db-content");
  root.innerHTML = renderDbSqlHtml({ stores: ctx.stores, store: ctx.store, sql: ctx.sql });
  const text = $("app-db-sql-text");
  text.addEventListener("input", () => {
    ctx.sql = text.value;
    if (cancelConfirm()) showResult("");
  });
  $("app-db-store")?.addEventListener("change", (ev) => {
    ctx.store = ev.currentTarget.value;
    cancelConfirm();
    showResult("");
  });
  $("app-db-run")?.addEventListener("click", (ev) => void run(ev.currentTarget));
}

function showResult(html) {
  const slot = $("app-db-result");
  if (slot) slot.innerHTML = html;
}

/** The pending "Confirm and run" answer, so an edit or Back can withdraw it. */
let pendingConfirm = null;

function cancelConfirm() {
  const resolve = pendingConfirm;
  pendingConfirm = null;
  resolve?.(false);
  return !!resolve;
}

function askConfirm(note) {
  cancelConfirm();
  const refusal = current?.src.writeRefusal() ?? "";
  if (refusal) {
    showResult(renderNeedsGrantHtml("", { refusal }));
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    pendingConfirm = resolve;
    showResult(renderNeedsGrantHtml(note));
    $("app-db-confirm")?.addEventListener("click", (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      b.textContent = tr_("Running…");
      pendingConfirm = null;
      resolve(true);
    });
  });
}

async function run(btn) {
  const ctx = current;
  const { sql, store } = ctx;
  if (!sql.trim()) return;
  btn.disabled = true;
  showResult(skeletonCards(1));
  try {
    const out = await executeSql({
      serviceId: ctx.serviceId,
      store,
      sql,
      fetchJson: ctx.src.fetchJson,
      confirm: (note) => (current === ctx && ctx.screen === "sql" ? askConfirm(note) : Promise.resolve(false)),
      signer: () => ctx.src.signer(),
    });
    if (current !== ctx || ctx.screen !== "sql" || out.cancelled) return;
    showResult(renderQueryResultHtml(out.result));
    if (out.signed) toast(tr_("Statement ran"), "ok");
  } catch (e) {
    if (current === ctx && ctx.screen === "sql") showResult(renderQueryErrorHtml(message(e), { sqlState: e?.body?.sqlState }));
  } finally {
    btn.disabled = false;
  }
}

export function initAppDbView() {
  $("app-db-back")?.addEventListener("click", async () => {
    cancelConfirm();
    if (current && current.screen !== "tables") {
      void renderTables();
      return;
    }
    if (current) {
      await current.src.back();
    } else {
      show("view-services-list");
    }
  });
  $("app-db-refresh")?.addEventListener("click", () => {
    if (!current) return;
    const go = current.screen === "table" ? renderTable() : current.screen === "sql" ? Promise.resolve(renderSql()) : renderTables();
    go.catch((e) => {
      console.error(e);
      toast(humanError(e), "err");
    });
  });
}

/** Open an app's Database. `source` overrides where it reads (a shared server). */
export async function enterAppDb(serviceId, appName, source = null) {
  cancelConfirm();
  const src = { ...ownerSource(serviceId), ...(source ?? {}) };
  current = { serviceId, appName: appName || serviceId, stores: [], screen: "tables", store: "", table: "", offset: 0, sql: "", src };
  show("view-app-db");
  await renderTables();
}
