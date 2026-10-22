// P2.3 — service-detail view. Calls /api/screens/app-detail/:serviceId (P1.3).
// Includes a "backup this service" button that calls P1.19, and (when the
// service declares a browser bundle) a "Open browser viewer" button that
// drives the user into views/browser-viewer.js with serviceId pre-set.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl, currentPodFqdn, makeCurrentPod, boxClient } from "../lib/api.js";
import { backUpApp, formatBackupSize } from "../lib/appBackup.js";
import { inlineConfirm } from "../lib/modal.js";
import {
  REMOVE_APP_BUSY,
  REMOVE_APP_LABEL,
  REMOVE_APP_TITLE,
  REMOVE_CONFIRM_TITLE,
  appServerState,
  appStatePillHtml,
  changeRunsOn,
  fetchRunsOn,
  loadAccountPods,
  removeAppErrorMessage,
  removeAppFromServer,
  removeAppMessage,
  runsOnHtml,
  runsOnModel,
  watchWhileCopying,
} from "../lib/appPlacement.js";
import { getSession } from "../lib/state.js";
import { signWithIrk } from "../keystore.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { ACCESS_ADMIN_ONLY, API_KEYS_ADMIN_ONLY, REMOVE_APP_ADMIN_ONLY, canSignAdminOrders } from "../lib/addServerGate.js";
import { enterBrowserViewer } from "./browser-viewer.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { controlApex, dataApex } from "../lib/apex.js";
import { pencilIcon, usersIcon } from "../lib/icons.js";
import { EDIT_ROW_CAPTION, EDIT_ROW_TITLE } from "../lib/editService.js";
import { openAdapterReport, renderReportRow } from "../lib/adapterReport.js";
import { isCompanionProfile } from "../lib/companionGuard.js";
import {
  EGRESS_ALLOW,
  EGRESS_APPROVED_TITLE,
  EGRESS_COMPANION_NOTE,
  EGRESS_NOTE,
  EGRESS_STOP,
  EGRESS_TITLE,
  egressCardState,
  egressErrorMessage,
  sendEgressGrant,
} from "../lib/appEgress.js";
import {
  ACCESS_ALLOW,
  ACCESS_COMPANION_NOTE,
  ACCESS_DENY,
  ACCESS_DRAFT_DISMISS,
  ACCESS_DRAFT_REVIEW,
  ACCESS_DRAFT_TITLE,
  ACCESS_DRAFT_WAITING,
  ACCESS_IGNORE,
  ACCESS_TITLE,
  ACCESS_VIEW_LIST,
  accessAnsweredText,
  accessErrorMessage,
  accessRequestNote,
  answerAccessRequest,
  dismissAccessDraft,
  dismissAccessRequest,
  fetchServiceAccess,
  parseAccessList,
  readAccessSummary,
  ruleCountText,
} from "../lib/appAccess.js";
import {
  API_KEYS_COMPANION_NOTE,
  API_KEYS_COPY,
  API_KEYS_CREATE,
  API_KEYS_DONE,
  API_KEYS_EMPTY,
  API_KEYS_NOTE,
  API_KEYS_REVOKE,
  API_KEYS_TITLE,
  API_KEY_COPY_WARNING,
  API_KEY_LABEL_MAX,
  API_KEY_SCOPES,
  DEFAULT_API_KEY_SCOPE,
  apiKeyErrorMessage,
  apiKeyUsageLine,
  checkApiKeyLabel,
  createApiKey,
  fetchApiKeys,
  isApiKeyExpired,
  revokeApiKey,
  scopeLabel,
} from "../lib/appApiKeys.js";
import { formatWhen } from "../lib/dateFormat.js";
import { DB_NOTE, DB_OPEN, DB_TITLE, canUseDatabase, dbErrorMessage, fetchDbStores } from "../lib/appDb.js";
import { appStorageLines } from "../lib/appStorage.js";
import { getActiveProfile } from "../lib/profiles.js";
import { isDeviceFullyScoped } from "../lib/usersCheck.js";
import { accountReadFetch } from "../lib/accountRead.js";

import { tr } from "../lib/i18n.js";
import { renderLinkField, bindLinkField } from "../lib/linkField.js";
import { isAdminDevice } from "../lib/memberRoles.js";
const COM_BASE = controlApex();

/** V3 — cached service-links per serviceId for the current render. Carries
 *  `customDomain` + `customDomainConfirmed` from .com's /links. */
let currentServiceLinks = null;

registerView("view-service-detail");

let currentServiceId = null;

/** Custom-domain change rate limit, mirrored on-device (the .com
 *  last_changed column is the real backstop — this is just the UX
 *  cooldown). 300s, identical to the iOS client + the server. */
const CUSTOM_DOMAIN_COOLDOWN_MS = 300_000;
/** 1s countdown ticker handle for the SET CUSTOM DOMAIN section. */
let cdCooldownTicker = null;

/**
 * #32 — browser-viewer is only reachable from here, only when the
 * manifest claims a browser bundle. We treat a non-empty `browserTabs`
 * array OR an explicit `browser:` block in the manifest as proof. The
 * legacy home-grid entry point (with its window.prompt fallback) is
 * gone — see views/browser-viewer.js.
 */
function hasBrowserBundle(body) {
  if ((body.browserTabs ?? []).length > 0) return true;
  const m = body.manifest;
  return !!(m && typeof m === "object" && (m.browser || m.browserBundle));
}

function formatStoreBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return tr("size unknown");
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/** The app's use against its limits (docs/app-runtimes.md §5.3), and why new data is refused when full. */
export function renderAppStorage(storage) {
  const lines = appStorageLines(storage);
  if (lines.length === 0) return "";
  return `
          <div class="card" id="sd-storage">
            ${lines
              .map(
                (l) => `<div class="row"><span class="label">${escapeHtml(l.label)}</span><span class="value">${escapeHtml(l.text)}</span></div>${
                  l.note ? `<p class="note small err" data-sd-storage-full>${escapeHtml(l.note)}</p>` : ""
                }`,
              )
              .join("")}
          </div>`;
}

/** One data-layer store: a Postgres database (by store name) or the app's files folder (with its size). */
function renderStoreRow(i) {
  const label = i.store === "postgres" ? "Postgres" : i.store === "files" ? tr("Files") : String(i.store ?? "");
  const value =
    i.store === "files"
      ? formatStoreBytes(i.bytes)
      : i.store === "postgres" && i.instanceName === "default"
        ? "database"
        : String(i.instanceName ?? "");
  return `
          <div class="card">
            <div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>
          </div>
        `;
}

export async function renderServiceDetail(serviceId) {
  currentServiceId = serviceId;
  const root = $("service-detail-content");
  root.innerHTML = skeletonCards(3);
  try {
    const body = await screensFetch(
      `/api/screens/app-detail/${encodeURIComponent(serviceId)}`,
    );
    const s = body.app;
    if (s && !s.access && body.access && typeof body.access === "object") s.access = body.access;
    // V3 — fetch the per-service URL identity from .com in parallel with
    // the daemon's detail. Tolerated as null if .com is unreachable;
    // the WEB DOMAINS section falls back to the daemon-provided
    // tier-1 instance url in that case.
    const session = getSession();
    currentServiceLinks = session.username
      ? await fetchServiceLinks(session.username, serviceId).catch(() => null)
      : null;
    root.innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(s.slug)}${appStatePillHtml(appServerState(s))}</div>
        <div class="muted-sm text-xs mt-1">${tr("{0}id: {1}", s.version ? `ver: ${escapeHtml(s.version)}&nbsp;&nbsp;·&nbsp;&nbsp;` : "", escapeHtml(s.serviceId))}</div>
        <div class="muted-sm mt-2 truncate">${escapeHtml(s.summary || "")}</div>
        <div class="row mt-2">
          <span class="label">${tr("creator")}</span><span class="value">${escapeHtml(s.creator)}</span>
        </div>
      </div>
      <div id="sd-runs-on">${runsOnHtml([], { companion: isCompanionProfile(), adminOnly: !canSignAdminOrders() })}</div>
      ${body.editable === true ? renderEditRow() : ""}
      ${typeof body.adaptedFrom?.repo === "string" ? renderReportRow(body.adaptedFrom.repo) : ""}
      <div id="sd-egress">${renderInternetSection(s)}</div>
      <div id="sd-api-keys"></div>
      <div id="sd-database"></div>

      ${renderWebDomainsSection(s, currentServiceLinks)}
      <div id="sd-custom-domains">${renderCustomDomainsSection()}</div>
      <h2 class="mt-4">${tr("App config")}</h2>
      <div class="card">
        <pre class="json-block">${escapeHtml(JSON.stringify(body.manifest, null, 2))}</pre>
      </div>
      <h2 class="mt-4">${tr("Data layer")}</h2>
      ${(body.dataLayerInstances ?? []).length === 0
        ? `<div class="card placeholder">${tr("no stores")}</div>`
        : (body.dataLayerInstances ?? []).map(renderStoreRow).join("")}
      ${renderAppStorage(body.storage)}
      ${hasBrowserBundle(body) ? `
        <h2 class="mt-4">${tr("Browser bundle")}</h2>
        <div class="card">
          <p class="note">
            ${tr("This service ships a Chromium tab the daemon runs on your pod. Open the viewer to drive a sign-in or paste-a-cookie flow against it from your webapp — frames stream over the paired-session WS.")}
          </p>
          <button id="sd-open-browser" class="full-width">${tr("Open browser viewer")}</button>
        </div>
      ` : ""}
      <h2 class="mt-4">${tr("Access control")}</h2>
      <button class="card full-width edit-row" id="sd-access" type="button">
        <span class="edit-row-icon" aria-hidden="true">${usersIcon}</span>
        <span class="edit-row-body">
          <strong>${tr("Access control")}</strong>
          <span class="note">${tr("Open to all or members only, and each member's rank")}</span>
        </span>
      </button>
      ${renderRecentLogs(body.recentLogs)}
      <h2 class="mt-4">${tr("Backup")}</h2>
      ${renderBackupCard(body.lastBackup)}
      <h2 class="mt-4">${tr("Environment variables")}</h2>
      <div class="card">
        <p class="note">
          ${tr("Per-app key/value pairs (e.g. <code>OPENAI_API_KEY</code>) the app reads at runtime. Names appear in the editor; values stay sealed on your pod.")}
        </p>
        <button id="sd-configure-env" class="full-width mt-2">${tr("Configure environment")}</button>
      </div>
      ${renderRemoveAppControl()}
    `;

    $("sd-edit")?.addEventListener("click", async () => {
      const { enterEditService } = await import("./edit-service.js");
      enterEditService(s.serviceId);
    });
    $("sd-report-adapter")?.addEventListener("click", () => {
      void openAdapterReport({ serviceId: s.serviceId, fetchJson: (path, init) => screensFetch(path, init) });
    });
    $("sd-backup-go")?.addEventListener("click", () => triggerBackup(s.serviceId));
    $("sd-open-browser")?.addEventListener("click", () => {
      enterBrowserViewer(s.serviceId).catch((e) => { console.error(e); toast(humanError(e), "err"); });
    });
    $("sd-configure-env")?.addEventListener("click", async () => {
      const { enterServiceEnv } = await import("./service-env.js");
      // serverFqdn is whatever pod we're paired to right now; the
      // serverFqdn is canonical-bytes input to the signed envelope.
      const serverFqdn = (getPodBaseUrl() ?? "")
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
      await enterServiceEnv(s.serviceId, s.creator, s.slug, serverFqdn);
    });
    $("sd-access")?.addEventListener("click", async () => {
      const { enterServiceAccess } = await import("./service-access.js");
      await enterServiceAccess(s);
    });
    $("service-detail-remove-btn")?.addEventListener("click", (ev) => void removeAppHere(s, ev.currentTarget));
    bindWebDomainsHandlers(s);
    bindCustomDomainsHandlers();
    if (readAccessSummary(s)) void loadAccessSection(s);
    else bindEgressHandlers(s);
    void loadApiKeysSection(s);
    void loadDatabaseEntry(s);
    void loadRunsOn(s);
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------
// Internet access: the hosts the app declares, allowed only by the owner's
// signature (docs/ai-privacy-and-staging.md §3). Absent on older boxes.
// ---------------------------------------------------------------

function hostList(hosts) {
  return `<ul class="sd-egress-hosts">${hosts.map((h) => `<li class="mono text-sm">${escapeHtml(h)}</li>`).join("")}</ul>`;
}

/**
 * The app's internet access: the "Internet access" section when the box sends
 * `access` (§3a), else the v1 egress card an older box still needs.
 */
export function renderInternetSection(app, opts = {}) {
  const summary = readAccessSummary(app);
  if (summary) return renderAccessSection(app, { summary, ...opts });
  return renderEgressSection(app, opts);
}

/** Why this device sees an app's internet access read-only ("" when it can
 *  change it): a companion asks its owner app; a non-admin device an admin. */
export function accessLockNote({ companion = false, adminOnly = false } = {}) {
  if (companion) return ACCESS_COMPANION_NOTE;
  if (adminOnly) return ACCESS_ADMIN_ONLY;
  return "";
}

/** "Remove app" for a device that may sign the uninstall; the admin-only line
 *  for another device of the account; nothing on a companion. */
export function renderRemoveAppControl({ companion = isCompanionProfile(), adminOnly = !canSignAdminOrders() } = {}) {
  if (companion) return "";
  if (adminOnly) return `<p class="faint-sm mt-4" data-remove-app-locked>${escapeHtml(REMOVE_APP_ADMIN_ONLY)}</p>`;
  return `<button id="service-detail-remove-btn" class="danger full-width mt-4" type="button">${escapeHtml(REMOVE_APP_LABEL)}</button>`;
}

/** The suggested-list card: each host with its reason, Review / Dismiss
 *  (a note instead on a companion or a non-admin device). */
export function renderAccessDraftCard(draft, { companion = isCompanionProfile(), adminOnly = !canSignAdminOrders() } = {}) {
  if (!draft) return "";
  const locked = accessLockNote({ companion, adminOnly });
  const hosts = draft.hosts
    .map(
      (h) => `
          <li><span class="mono text-sm">${escapeHtml(h.host)}</span>${h.why ? `<div class="muted-sm">${escapeHtml(h.why)}</div>` : ""}</li>`,
    )
    .join("");
  return `
        <div class="sd-access-draft mt-2" data-access-draft>
          <div class="weight-600">${escapeHtml(ACCESS_DRAFT_TITLE)}</div>
          <ul class="sd-access-draft-hosts">${hosts}</ul>
          ${locked
            ? `<p class="faint-sm mt-1" data-access-locked>${escapeHtml(locked)}</p>`
            : `<div class="sd-access-actions mt-1">
                <button data-access-draft-act="review">${escapeHtml(ACCESS_DRAFT_REVIEW)}</button>
                <button class="secondary" data-access-draft-act="dismiss">${escapeHtml(ACCESS_DRAFT_DISMISS)}</button>
              </div>`}
        </div>`;
}

/**
 * The "Internet access" section: the rule count, a suggested list (Review /
 * Dismiss), the pending requests (Allow / Deny / Ignore each; read-only on a
 * companion) and View access list. `state` is the box's GET .../access answer
 * once it has arrived.
 */
export function renderAccessSection(app, { summary = readAccessSummary(app), state = null, companion = isCompanionProfile(), adminOnly = !canSignAdminOrders() } = {}) {
  const locked = accessLockNote({ companion, adminOnly });
  const rules = state ? parseAccessList(state.list).rules.length : summary?.rules ?? 0;
  let pendingHtml = "";
  let draftHtml = "";
  if (state) {
    draftHtml = renderAccessDraftCard(state.draft, { companion, adminOnly });
  } else if (summary?.draft) {
    draftHtml = `<p class="muted-sm mt-2">${escapeHtml(ACCESS_DRAFT_WAITING)}</p>`;
  }
  if (state) {
    pendingHtml = state.pending
      .map((r) => `
        <div class="sd-access-req mt-2" data-access-host="${escapeHtml(r.host)}">
          <div class="weight-600">${tr("Wants to reach")} <span class="mono">${escapeHtml(r.host)}</span></div>
          <div class="muted-sm">${escapeHtml(accessRequestNote(r))}</div>
          ${locked
            ? ""
            : `<div class="sd-access-actions mt-1">
                <button data-access-act="allow" data-host="${escapeHtml(r.host)}">${escapeHtml(ACCESS_ALLOW)}</button>
                <button class="secondary" data-access-act="deny" data-host="${escapeHtml(r.host)}">${escapeHtml(ACCESS_DENY)}</button>
                <button class="secondary" data-access-act="ignore" data-host="${escapeHtml(r.host)}">${escapeHtml(ACCESS_IGNORE)}</button>
              </div>`}
        </div>`)
      .join("");
    if (locked && state.pending.length > 0) {
      pendingHtml += `<p class="faint-sm mt-2" data-access-locked>${escapeHtml(locked)}</p>`;
    }
  } else if (summary?.pending > 0) {
    pendingHtml = `<p class="muted-sm mt-2">${tr("{0} waiting…", summary.pending === 1 ? "1 request" : tr("{0} requests", summary.pending))}</p>`;
  }
  return `
      <h2 class="mt-4">${escapeHtml(ACCESS_TITLE)}</h2>
      <div class="card sd-access">
        <div class="row"><span class="label">${tr("Access list")}</span><span class="value" id="sd-access-count">${escapeHtml(ruleCountText(rules))}</span></div>
        <div id="sd-access-draft">${draftHtml}</div>
        <div id="sd-access-pending">${pendingHtml}</div>
        <button id="sd-access-view" class="secondary full-width mt-2">${escapeHtml(ACCESS_VIEW_LIST)}</button>
      </div>`;
}

async function loadAccessSection(app) {
  const fetchJson = (path, init) => screensFetch(path, init);
  let state = null;
  try {
    state = await fetchServiceAccess(app.serviceId, fetchJson);
  } catch {
    state = null;
  }
  if (currentServiceId !== app.serviceId) return;
  paintAccessSection(app, state);
}

function paintAccessSection(app, state) {
  const slot = $("sd-egress");
  if (!slot) return;
  slot.innerHTML = renderAccessSection(app, { state });
  $("sd-access-view")?.addEventListener("click", async () => {
    const { enterAppAccess } = await import("./app-access.js");
    await enterAppAccess(app.serviceId, app.slug);
  });
  if (!state) return;
  slot.querySelectorAll("[data-access-act]").forEach((btn) => {
    btn.addEventListener("click", () => void answerFromPage(app, state, btn));
  });
  slot.querySelectorAll("[data-access-draft-act]").forEach((btn) => {
    btn.addEventListener("click", () => void answerDraftFromPage(app, state, btn));
  });
}

async function answerDraftFromPage(app, state, btn) {
  if (btn.getAttribute("data-access-draft-act") === "review") {
    const { enterAppAccess } = await import("./app-access.js");
    await enterAppAccess(app.serviceId, app.slug, { draft: true });
    return;
  }
  const card = btn.closest(".sd-access-draft");
  card?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  try {
    const next = await dismissAccessDraft({ serviceId: app.serviceId, fetchJson: (path, init) => screensFetch(path, init) });
    if (currentServiceId !== app.serviceId) return;
    paintAccessSection(app, next ?? { ...state, draft: null });
  } catch (e) {
    toast(e?.status ? accessErrorMessage(e) : humanError(e), "err");
    card?.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  }
}

async function answerFromPage(app, state, btn) {
  const act = btn.getAttribute("data-access-act");
  const host = btn.getAttribute("data-host");
  const session = getSession();
  if (act !== "ignore" && !session.umk) return toast(tr("Unlock the webapp first"), "err");
  const row = btn.closest(".sd-access-req");
  row?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const fetchJson = (path, init) => screensFetch(path, init);
  try {
    if (act === "ignore") {
      await dismissAccessRequest({ serviceId: app.serviceId, host, fetchJson });
      paintAccessSection(app, { ...state, pending: state.pending.filter((r) => r.host !== host) });
      return;
    }
    const next = await answerAccessRequest({
      serverDomain: serverDomainOfPod(),
      serviceId: app.serviceId,
      host,
      action: act,
      current: state,
      umk: session.umk,
      signWithIrk: sensitiveSigner(),
      fetchJson,
      bytesToHex,
    });
    const pending = (next.pending.length > 0 ? next.pending : state.pending).filter((r) => r.host !== host);
    paintAccessSection(app, { ...next, pending });
    toast(accessAnsweredText(app.slug, host, act), "ok");
  } catch (e) {
    toast(e?.status || e?.name === "AccessListError" ? accessErrorMessage(e) : humanError(e), "err");
    row?.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  }
}

/** The v1 internet-access cards for `app` (its `egress`), or "" when there
 *  is nothing to show. Only for a box that doesn't send `access`. */
export function renderEgressSection(app, { companion = isCompanionProfile(), adminOnly = !canSignAdminOrders() } = {}) {
  const st = egressCardState(app, { companion: companion || adminOnly });
  if (!st) return "";
  let html = "";
  if (st.pending.length > 0) {
    html += `
      <div class="card mt-2 sd-egress-pending">
        <div class="weight-600">${escapeHtml(EGRESS_TITLE)}</div>
        ${hostList(st.pending)}
        <p class="note mt-2">${escapeHtml(EGRESS_NOTE)}</p>
        ${st.canSign
          ? `<button id="sd-egress-allow" class="full-width mt-2">${escapeHtml(EGRESS_ALLOW)}</button>`
          : `<p class="faint-sm mt-2">${escapeHtml(companion ? EGRESS_COMPANION_NOTE : ACCESS_ADMIN_ONLY)}</p>`}
      </div>`;
  }
  if (st.approved.length > 0) {
    html += `
      <div class="card mt-2 sd-egress-approved">
        <div class="weight-600">${escapeHtml(EGRESS_APPROVED_TITLE)}</div>
        ${hostList(st.approved)}
        ${st.canSign ? `<button id="sd-egress-stop" class="secondary full-width mt-2">${escapeHtml(EGRESS_STOP)}</button>` : ""}
      </div>`;
  }
  return html;
}

function serverDomainOfPod() {
  try {
    return new URL(getPodBaseUrl() ?? "").hostname;
  } catch {
    return "";
  }
}

function bindEgressHandlers(app) {
  const send = async (hosts, btn) => {
    const session = getSession();
    if (!session.umk) return toast(tr("Unlock the webapp first"), "err");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = hosts.length > 0 ? tr("Allowing…") : tr("Stopping…");
    try {
      const egress = await sendEgressGrant({
        serverDomain: serverDomainOfPod(),
        serviceId: app.serviceId,
        hosts,
        umk: session.umk,
        signWithIrk: sensitiveSigner(),
        fetchJson: (path, init) => screensFetch(path, init),
        bytesToHex,
      });
      app.egress = egress;
      const slot = $("sd-egress");
      if (slot) slot.innerHTML = renderEgressSection(app);
      bindEgressHandlers(app);
      toast(hosts.length > 0 ? tr("Internet access allowed") : tr("Internet access stopped"), "ok");
    } catch (e) {
      toast(e instanceof ScreensError ? egressErrorMessage(e) : humanError(e), "err");
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  // Allow opens every host the app declares; Stop access signs an empty list.
  $("sd-egress-allow")?.addEventListener("click", (ev) => void send(app.egress?.declared ?? [], ev.currentTarget));
  $("sd-egress-stop")?.addEventListener("click", (ev) => void send([], ev.currentTarget));
}

// ---------------------------------------------------------------
// Database (docs/app-apis.md §6): the app's live data, owner sessions only.
// Hidden on a companion or restricted device, when the box 404s GET …/db (an
// older box), and for an app with no Postgres stores.
// ---------------------------------------------------------------

function activeDeviceCapability() {
  try {
    return getActiveProfile()?.deviceCapability ?? null;
  } catch {
    return null;
  }
}

export function databaseEntryVisible({ companion = isCompanionProfile(), deviceCapability = activeDeviceCapability() } = {}) {
  return canUseDatabase({ companion, deviceCapability, isFullyScoped: isDeviceFullyScoped });
}

/** The "Database" entry: `stores` from GET …/db (null for an older box), or
 *  `error` when the box couldn't list them. "" when there's nothing to open. */
export function renderDatabaseEntry({ stores = null, error = "" } = {}) {
  if (!error && (!stores || stores.length === 0)) return "";
  const tables = (stores ?? []).reduce((n, s) => n + s.tables.length, 0);
  const line = error
    ? `<p class="err-text text-sm mt-1">${escapeHtml(error)}</p>`
    : `<div class="muted-sm mt-1">${tables === 1 ? "1 table" : tr("{0} tables", tables)}</div>`;
  return `
      <h2 class="mt-4">${escapeHtml(DB_TITLE)}</h2>
      <div class="card">
        <p class="note">${escapeHtml(DB_NOTE)}</p>
        ${line}
        <button id="sd-db-open" class="full-width mt-2">${escapeHtml(DB_OPEN)}</button>
      </div>`;
}

async function loadDatabaseEntry(app) {
  if (!databaseEntryVisible()) return;
  let stores = null;
  let error = "";
  try {
    stores = await fetchDbStores(app.serviceId, (path, init) => screensFetch(path, init));
  } catch (e) {
    if (e?.status === 403) return;
    error = e instanceof ScreensError ? dbErrorMessage(e) : humanError(e);
  }
  if (currentServiceId !== app.serviceId) return;
  const slot = $("sd-database");
  if (!slot) return;
  slot.innerHTML = renderDatabaseEntry({ stores, error });
  $("sd-db-open")?.addEventListener("click", async () => {
    const { enterAppDb } = await import("./app-db.js");
    await enterAppDb(app.serviceId, app.slug);
  });
}

// ---------------------------------------------------------------
// API keys (docs/app-apis.md §3). Hidden when the box 404s the list.
// ---------------------------------------------------------------

function apiKeyRow(k, { companion, adminOnly = false, now }) {
  const expired = isApiKeyExpired(k, now);
  return `
        <div class="sd-api-key mt-2" data-api-key="${escapeHtml(k.keyId)}">
          <div class="sd-api-key-head">
            <span class="weight-600 sd-api-key-label">${escapeHtml(k.label || k.keyId)}</span>
            <span class="pill${k.scope === "write" ? " warn" : ""}">${escapeHtml(scopeLabel(k.scope))}</span>
          </div>
          <div class="muted-sm">${tr("Created {0} · {1}", escapeHtml(formatWhen(k.createdAt, now)), k.lastUsedAt ? tr("Last used {0}", escapeHtml(formatWhen(k.lastUsedAt, now))) : tr("Never used"))}</div>
          ${expired ? `<div class="muted-sm err-text">${tr("Expired {0}", escapeHtml(formatWhen(k.expiresAt, now)))}</div>` : ""}
          ${companion || adminOnly
            ? ""
            : `<button class="secondary sd-api-key-revoke mt-1" data-api-key-revoke="${escapeHtml(k.keyId)}">${escapeHtml(API_KEYS_REVOKE)}</button>`}
        </div>`;
}

function apiKeyForm() {
  const options = (list, selected) =>
    list.map((o) => `<option value="${o.value}"${o.value === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
  return `
        <div class="sd-api-key-form mt-2">
          <label for="sd-api-key-label">${tr("Name")}</label>
          <input id="sd-api-key-label" type="text" placeholder="${tr("Kitchen display")}" autocomplete="off" maxlength="${API_KEY_LABEL_MAX}" />
          <label for="sd-api-key-scope">${tr("Access")}</label>
          <select id="sd-api-key-scope">${options(API_KEY_SCOPES, DEFAULT_API_KEY_SCOPE)}</select>
          <p class="err-text text-sm hidden" id="sd-api-key-error"></p>
          <div class="row-2 mt-2">
            <button class="secondary" id="sd-api-key-cancel">${tr("Cancel")}</button>
            <button id="sd-api-key-go">${escapeHtml(API_KEYS_CREATE)}</button>
          </div>
        </div>`;
}

function apiKeyReveal(revealed) {
  return `
        <div class="sd-api-key-reveal mt-2">
          <div class="weight-600">${escapeHtml(revealed.label)}</div>
          <pre class="json-block mono sd-api-key-secret" id="sd-api-key-secret">${escapeHtml(revealed.key)}</pre>
          <p class="note err-text">${escapeHtml(API_KEY_COPY_WARNING)}</p>
          <p class="muted-sm">${tr("Send it with each request:")}</p>
          <pre class="json-block mono sd-api-key-usage">${escapeHtml(apiKeyUsageLine("<key>"))}</pre>
          <div class="row-2 mt-2">
            <button id="sd-api-key-copy">${escapeHtml(API_KEYS_COPY)}</button>
            <button class="secondary" id="sd-api-key-done">${escapeHtml(API_KEYS_DONE)}</button>
          </div>
        </div>`;
}

/**
 * The "API keys" section. `keys` is the box's list (null hides the section:
 * an older box without API keys); `form` shows the create form, `revealed`
 * the just-created key, once.
 */
export function renderApiKeysSection({ keys, companion = isCompanionProfile(), adminOnly = !canSignAdminOrders(), form = false, revealed = null, error = "", now = Date.now() } = {}) {
  if (!Array.isArray(keys)) return "";
  const list = keys.length === 0
    ? `<p class="muted-sm mt-2">${escapeHtml(API_KEYS_EMPTY)}</p>`
    : keys.map((k) => apiKeyRow(k, { companion, adminOnly, now })).join("");
  let action = "";
  if (companion) action = `<p class="faint-sm mt-2">${escapeHtml(API_KEYS_COMPANION_NOTE)}</p>`;
  else if (adminOnly) action = `<p class="faint-sm mt-2" data-api-keys-locked>${escapeHtml(API_KEYS_ADMIN_ONLY)}</p>`;
  else if (revealed) action = apiKeyReveal(revealed);
  else if (form) action = apiKeyForm();
  else action = `<button id="sd-api-key-new" class="secondary full-width mt-2">${escapeHtml(API_KEYS_CREATE)}</button>`;
  return `
      <h2 class="mt-4">${escapeHtml(API_KEYS_TITLE)}</h2>
      <div class="card sd-api-keys">
        <p class="note">${escapeHtml(API_KEYS_NOTE)}</p>
        ${error ? `<p class="err-text text-sm mt-2">${escapeHtml(error)}</p>` : ""}
        ${action}
        <div id="sd-api-key-list">${list}</div>
      </div>`;
}

let apiKeysState = null;

async function loadApiKeysSection(app) {
  let keys = null;
  let error = "";
  try {
    keys = await fetchApiKeys(app.serviceId, (path, init) => screensFetch(path, init));
  } catch (e) {
    keys = [];
    error = e instanceof ScreensError ? apiKeyErrorMessage(e) : humanError(e);
  }
  if (currentServiceId !== app.serviceId) return;
  apiKeysState = { app, keys, form: false, revealed: null, error };
  paintApiKeysSection();
}

function paintApiKeysSection() {
  const slot = $("sd-api-keys");
  if (!slot || !apiKeysState) return;
  const st = apiKeysState;
  slot.innerHTML = renderApiKeysSection(st);
  const set = (patch) => {
    apiKeysState = { ...apiKeysState, ...patch };
    paintApiKeysSection();
  };
  $("sd-api-key-new")?.addEventListener("click", () => {
    set({ form: true, error: "" });
    $("sd-api-key-label")?.focus({ preventScroll: true });
  });
  $("sd-api-key-cancel")?.addEventListener("click", () => set({ form: false, error: "" }));
  $("sd-api-key-go")?.addEventListener("click", (ev) => void createFromPage(ev.currentTarget));
  $("sd-api-key-label")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); $("sd-api-key-go")?.click(); }
  });
  $("sd-api-key-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(st.revealed.key);
      toast(tr("Copied."));
    } catch {
      toast(tr("Couldn't copy — select the key and copy it by hand."), "err");
    }
  });
  $("sd-api-key-done")?.addEventListener("click", () => set({ revealed: null }));
  slot.querySelectorAll("[data-api-key-revoke]").forEach((btn) => {
    btn.addEventListener("click", () => void revokeFromPage(btn));
  });
}

async function createFromPage(btn) {
  const st = apiKeysState;
  const errEl = $("sd-api-key-error");
  const showError = (msg) => {
    if (!errEl) return toast(msg, "err");
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  };
  const label = $("sd-api-key-label")?.value ?? "";
  const checked = checkApiKeyLabel(label);
  if (checked.error) return showError(checked.error);
  const session = getSession();
  if (!session.umk) return showError(tr("Unlock the webapp first"));
  const scope = $("sd-api-key-scope")?.value ?? DEFAULT_API_KEY_SCOPE;
  btn.disabled = true;
  btn.textContent = tr("Creating…");
  const fetchJson = (path, init) => screensFetch(path, init);
  try {
    const made = await createApiKey({
      serverDomain: serverDomainOfPod(),
      serviceId: st.app.serviceId,
      label: checked.label,
      scope,
      umk: session.umk,
      signWithIrk: sensitiveSigner(),
      fetchJson,
      bytesToHex,
    });
    let keys = await fetchApiKeys(st.app.serviceId, fetchJson).catch(() => null);
    if (!Array.isArray(keys) || !keys.some((k) => k.keyId === made.keyId)) {
      const mine = { keyId: made.keyId, label: made.label, scope: made.scope, createdAt: made.issuedAt, lastUsedAt: 0, expiresAt: 0 };
      keys = [mine, ...(Array.isArray(keys) ? keys : st.keys).filter((k) => k.keyId !== made.keyId)];
    }
    if (currentServiceId !== st.app.serviceId) return;
    apiKeysState = { ...apiKeysState, keys, form: false, revealed: { key: made.key, label: made.label }, error: "" };
    paintApiKeysSection();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = API_KEYS_CREATE;
    showError(e instanceof ScreensError ? apiKeyErrorMessage(e) : humanError(e));
  }
}

async function revokeFromPage(btn) {
  const st = apiKeysState;
  const keyId = btn.getAttribute("data-api-key-revoke");
  const key = st.keys.find((k) => k.keyId === keyId);
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: tr("Revoke \"{0}\"?", key?.label || keyId),
    message: tr("Anything using this key stops working right away. This can't be undone."),
    okLabel: API_KEYS_REVOKE,
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await revokeApiKey({ serviceId: st.app.serviceId, keyId, fetchJson: (path, init) => screensFetch(path, init) });
    if (currentServiceId !== st.app.serviceId) return;
    apiKeysState = { ...apiKeysState, keys: apiKeysState.keys.filter((k) => k.keyId !== keyId), error: "" };
    paintApiKeysSection();
    toast(tr("Key revoked"), "ok");
  } catch (e) {
    btn.disabled = false;
    toast(e instanceof ScreensError ? apiKeyErrorMessage(e) : humanError(e), "err");
  }
}

/** Shown only when the box says the service can be edited here. */
/** The box's recent log lines for the app (app-detail `recentLogs`), shown
 *  only when it sends some, as on iOS and Android. */
export function renderRecentLogs(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === "string");
  if (list.length === 0) return "";
  return `
      <h2 class="mt-4">${tr("Recent logs")}</h2>
      <div class="card" id="sd-recent-logs">
        <pre class="json-block mono">${list.map((l) => escapeHtml(l)).join("\n")}</pre>
      </div>`;
}

function renderEditRow() {
  return `
      <button class="card full-width edit-row" id="sd-edit">
        <span class="edit-row-icon" aria-hidden="true">${pencilIcon}</span>
        <span class="edit-row-body">
          <strong>${escapeHtml(EDIT_ROW_TITLE)}</strong>
          <span class="note">${escapeHtml(EDIT_ROW_CAPTION)}</span>
        </span>
        <span class="build-resume-chevron" aria-hidden="true">›</span>
      </button>`;
}

export const BACKUP_CARD_NOTE =
  tr("The app's code, and its data if you include it. It comes straight from your server to this device.");
export const BACKUP_GONE =
  tr("The server no longer has that backup. Back up again.");

export function renderBackupCard(lastBackup) {
  const last =
    lastBackup && Number.isFinite(lastBackup.bytes)
      ? `<p class="note">${tr("Last backup: {0} · {1}", escapeHtml(formatBackupSize(lastBackup.bytes)), escapeHtml(formatWhen(lastBackup.createdAt)))}</p>`
      : "";
  return `
      <div class="card" id="sd-backup">
        ${last}
        <p class="note">${escapeHtml(BACKUP_CARD_NOTE)}</p>
        <label class="inline-check">
          <input type="checkbox" id="sd-include-data" /> ${tr("Include the app's data")}
        </label>
        <input type="password" id="sd-password" placeholder="${tr("Password to encrypt it (optional)")}" autocomplete="new-password" class="mt-2" />
        <div id="sd-backup-status" class="mt-2 text-sm" aria-live="polite"></div>
        <button id="sd-backup-go" class="secondary full-width mt-2">${tr("Back up now")}</button>
      </div>`;
}

// The archive the last "Back up now" fetched, as an object URL kept until the
// next backup, so "Save backup" can be clicked again: the box has already
// deleted its copy.
let backupUrl = "";
function dropBackupUrl() {
  if (backupUrl) URL.revokeObjectURL(backupUrl);
  backupUrl = "";
}

async function triggerBackup(serviceId) {
  const status = $("sd-backup-status");
  const go = $("sd-backup-go");
  const passwordEl = $("sd-password");
  const dataEl = $("sd-include-data");
  if (!status || !go || go.disabled) return;
  dropBackupUrl();
  const busy = (on) => {
    go.disabled = on;
    passwordEl.disabled = on;
    dataEl.disabled = on;
  };
  busy(true);
  status.textContent = "";
  try {
    const r = await backUpApp({
      client: boxClient(),
      serviceId,
      includeUserData: dataEl.checked,
      password: passwordEl.value,
      onPhase: (p) => { go.textContent = p === "creating" ? tr("Packing…") : tr("Downloading…"); },
    });
    if (currentServiceId !== serviceId || !status.isConnected) return;
    passwordEl.value = "";
    backupUrl = URL.createObjectURL(r.blob);
    status.innerHTML = `
      <p class="ok-text" data-backup-ready>${tr("Ready: {0}{1}", escapeHtml(formatBackupSize(r.bytes)), r.encrypted ? ", encrypted" : "")}</p>
      <a class="btn full-width mt-2" id="sd-backup-save" href="${escapeHtml(backupUrl)}" download="${escapeHtml(r.fileName)}">${tr("Save backup")}</a>`;
  } catch (e) {
    console.error("app backup failed", e);
    const gone = e instanceof ScreensError && e.status === 404;
    status.innerHTML = `<p class="err-text" data-backup-error>${escapeHtml(gone ? BACKUP_GONE : humanError(e))}</p>`;
  } finally {
    busy(false);
    go.textContent = tr("Back up now");
  }
}

// ---------------------------------------------------------------
// Runs on (docs/app-placement.md §4): every server's own apps list says
// whether the app is there; tick copies it there, untick removes it.
// ---------------------------------------------------------------

let runsOn = null;

async function loadRunsOn(app) {
  runsOn?.stop?.();
  const state = { app, rows: [], busy: "", error: "", stop: null };
  runsOn = state;
  const live = () => runsOn === state && currentServiceId === app.serviceId && !$("view-service-detail")?.classList.contains("hidden");
  const pods = await loadAccountPods(getSession()?.username ?? "");
  const load = () => fetchRunsOn({ serviceId: app.serviceId, pods });
  state.load = load;
  state.live = live;
  state.rows = await load();
  if (!live()) return;
  paintRunsOn(state);
  watchRunsOn(state);
}

function watchRunsOn(state) {
  if (state.stop || !state.rows.some((r) => r.state === "copying")) return;
  state.stop = watchWhileCopying({
    load: state.load,
    active: state.live,
    onRows: (rows) => {
      state.rows = rows;
      paintRunsOn(state);
    },
  });
}

function paintRunsOn(state) {
  const slot = $("sd-runs-on");
  if (!slot || runsOn !== state) return;
  const companion = isCompanionProfile();
  const adminOnly = !canSignAdminOrders();
  slot.innerHTML = runsOnHtml(
    runsOnModel(state.rows, { companion: companion || adminOnly, busy: state.busy, busyChecked: state.busyChecked }),
    { companion, adminOnly, error: state.error },
  );
  slot.querySelectorAll("[data-runs-on-toggle]").forEach((box) => {
    box.addEventListener("change", () => void toggleRunsOn(state, box.getAttribute("data-runs-on-toggle"), box.checked));
  });
}

async function toggleRunsOn(state, fqdn, checked) {
  if (state.busy) return;
  const session = getSession();
  if (!session?.umk) {
    state.error = tr("Unlock the webapp first.");
    return paintRunsOn(state);
  }
  const { app } = state;
  state.busy = fqdn;
  state.busyChecked = checked;
  state.error = "";
  paintRunsOn(state);
  const out = await changeRunsOn({
    rows: state.rows,
    fqdn,
    checked,
    app,
    umk: session.umk,
    signWithIrk: sensitiveSigner(),
    confirmRemove: (row) =>
      inlineConfirm({
        title: REMOVE_CONFIRM_TITLE,
        message: tr("{0} and its data on {1} are deleted. Your other servers keep their copies.", app.slug, row.name),
        okLabel: tr("Remove"),
        danger: true,
      }),
  });
  state.busy = "";
  state.busyChecked = null;
  state.rows = out.rows;
  state.error = out.error ?? "";
  if (out.message) toast(out.message, "ok");
  // Removed from the server this page reads: carry on from a server that
  // still has it.
  const gone = out.rows.find((r) => r.fqdn === fqdn)?.state === "missing";
  if (!checked && gone && fqdn === currentPodFqdn()) {
    const next = out.rows.find((r) => r.state === "has");
    if (next && makeCurrentPod(next.fqdn)) {
      await renderServiceDetail(app.serviceId);
      return;
    }
  }
  paintRunsOn(state);
  watchRunsOn(state);
}

// "Remove app": the owner's signed uninstall (flagship/uninstall-service/v1)
// to the box this page reads, as iOS's Remove service. Unlike unticking a
// Runs on row, it also removes the app's only copy.
async function removeAppHere(app, btn) {
  const session = getSession();
  if (!session?.umk) {
    toast(tr("Unlock the webapp first."), "err");
    return;
  }
  const fqdn = currentPodFqdn();
  const otherCopies = (runsOn?.app?.serviceId === app.serviceId ? runsOn.rows : [])
    .filter((r) => r.state === "has" && r.fqdn !== fqdn).length;
  const ok = await inlineConfirm({
    title: REMOVE_APP_TITLE,
    message: removeAppMessage({ slug: app.slug, server: fqdn, otherCopies }),
    okLabel: REMOVE_APP_LABEL,
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = REMOVE_APP_BUSY;
  try {
    await removeAppFromServer({
      serverFqdn: fqdn,
      serviceId: app.serviceId,
      creator: app.creator,
      slug: app.slug,
      umk: session.umk,
      signWithIrk: sensitiveSigner(),
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = REMOVE_APP_LABEL;
    toast(removeAppErrorMessage(e), "err");
    return;
  }
  runsOn?.stop?.();
  toast(tr("Removed {0}.", app.slug), "ok");
  if (backToServer) {
    const { enterServerDetail } = await import("./server-detail.js");
    await enterServerDetail(backToServer);
    return;
  }
  const { enterServicesList } = await import("./services-list.js");
  await enterServicesList();
}

// Where Back goes: the services list, or the server page the app was opened from.
let backToServer = "";

export function initServiceDetailView() {
  $("service-detail-back")?.addEventListener("click", async () => {
    runsOn?.stop?.();
    if (backToServer) {
      const { enterServerDetail } = await import("./server-detail.js");
      await enterServerDetail(backToServer);
      return;
    }
    const { enterServicesList } = await import("./services-list.js");
    await enterServicesList();
  });
  $("service-detail-refresh")?.addEventListener("click", () => {
    if (currentServiceId) renderServiceDetail(currentServiceId).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

/** Open an app's page. `server` names the box it was picked on (a server's
 *  page, the all-servers list); the page then reads that box. `from` is
 *  "server" when Back should return to that server's page. */
export async function enterServiceDetail(serviceId, { server = "", from = "" } = {}) {
  const fqdn = typeof server === "string" ? server.toLowerCase() : "";
  if (fqdn && fqdn !== currentPodFqdn()) makeCurrentPod(fqdn);
  // A return from one of the page's own screens keeps where Back goes.
  if (fqdn || from || serviceId !== currentServiceId) backToServer = from === "server" ? fqdn : "";
  show("view-service-detail");
  await renderServiceDetail(serviceId);
}

// ---------------------------------------------------------------
// V3 — WEB DOMAINS section + Replace ceremony
// ---------------------------------------------------------------

/** Fetch the per-service links bundle from .com — { canonical, short,
 *  instances }. Falls back to the daemon's urlLabel if .com is
 *  unreachable so the section still renders. */
async function fetchServiceLinks(username, serviceId) {
  const r = await accountReadFetch(
    `${COM_BASE}/api/users/${encodeURIComponent(username)}/apps/${encodeURIComponent(serviceId)}/links`,
    { cache: "no-store" },
  );
  if (!r.ok) return null;
  return await r.json();
}

/** Three-group layout: SHORT (top, bold) → CANONICAL → INSTANCES.
 *  Header carries a Replace button that fires the rename ceremony. */
function renderWebDomainsSection(service, links) {
  const stripScheme = (s) => s.replace(/^https?:\/\//, "");
  // Show the bare host (no scheme), HTML-escaped, with a zero-width
  // space after each dot so a long FQDN wraps between segments rather
  // than mid-label. href + data-copy keep the clean URL — only the
  // visible text carries the ZWSP. Mirrors iOS/Android wrapAtDots.
  const displayUrl = (s) =>
    escapeHtml(stripScheme(s)).replace(/\./g, ".&#8203;");
  // Fallback = the daemon-reported tier-1 instance URL (`https://<urlLabel>.
  // <server>.<user>.flagship.services`) — the per-box wildcard cert covers it
  // (model A′); a locally-derived `<label>.<user>` form would be a tier-2
  // name with no valid cert until shared service certs ship.
  const canonical = links?.canonicalUrl ?? service.url;
  const instances = links?.instances ?? [];

  const canonicalRow = `
    <div class="row" data-section="canonical">
      <a class="mono" href="${escapeHtml(canonical)}" target="_blank" rel="noopener">
        ${displayUrl(canonical)}
      </a>
      <button class="ghost" data-copy="${escapeHtml(canonical)}" aria-label="${tr("Copy canonical")}">📋</button>
    </div>`;

  // CUSTOM DOMAIN sits at the very top of the card, only when one is
  // bound. It's the user's own name — show it first. Surfaced as soon
  // as the order is recorded (even pending); the services-list short→
  // custom swap is what waits for .com to confirm. Mirrors iOS
  // ServiceDetailScreen.customDomainGroup.
  const cd = links?.customDomain ?? null;
  const customDomainBlock = !cd ? "" : `
      <div class="label-tiny">${tr("CUSTOM DOMAIN")}</div>
      <div class="row" data-section="custom">
        <a class="weight-600 mono" href="https://${escapeHtml(cd)}" target="_blank" rel="noopener">
          ${displayUrl("https://" + cd)}
        </a>
        <button class="ghost" data-copy="https://${escapeHtml(cd)}" aria-label="${tr("Copy custom domain")}">📋</button>
      </div>
      <div class="mt-3"></div>`;

  const instancesBlock = instances.length === 0 ? "" : `
    <div class="mt-3">
      <div class="label-tiny">${tr("INDIVIDUAL INSTANCES")}</div>
      ${instances.map((i) => `
        <div class="row muted-sm mono" data-section="instance">
          ${displayUrl(i.url)}
        </div>
      `).join("")}
    </div>`;

  return `
    <div class="row mt-4" style="align-items:baseline;">
      <h2 style="margin:0;">${tr("Web domains")}</h2>
      <button class="danger small" id="sd-replace-stem">${tr("Replace")}</button>
    </div>
    <div class="card">
      ${customDomainBlock}
      ${links?.link ? renderLinkField({ link: links.link, shortCode: links.shortCode, admin: isAdminDevice(getSession()) }) : ""}
      <div class="mt-3">
        <div class="label-tiny">${tr("CANONICAL (SHARED BY ALL INSTANCES)")}</div>
        <div class="muted-sm text-xs">${tr("Permanent, verifiable address — share this when the exact name matters.")}</div>
        ${canonicalRow}
      </div>
      ${instancesBlock}
    </div>
  `;
}

/** Wire copy buttons + the Replace flow. */
function bindWebDomainsHandlers(service) {
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      const url = ev.currentTarget.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(url);
        toast(tr("Copied."));
      } catch (e) {
        toast(tr("Couldn't copy — long-press to copy manually."), "err");
      }
    });
  });
  $("sd-replace-stem")?.addEventListener("click", () => openReplaceModal(service));
  const lf = document.querySelector('[data-lf="root"]');
  if (lf && currentServiceLinks?.link) {
    const session = getSession();
    bindLinkField(lf, {
      username: session.username,
      serviceId: service.serviceId,
      link: currentServiceLinks.link,
      shortCode: currentServiceLinks.shortCode,
      admin: isAdminDevice(session),
      onChanged: (link) => { currentServiceLinks = { ...currentServiceLinks, link }; },
      onDibs: async (name) => {
        const { enterNameDibs } = await import("./name-dibs.js");
        await enterNameDibs({ name, kind: "link", onDone: () => renderServiceDetail(service.serviceId) });
      },
    });
  }
}

// ---------------------------------------------------------------
// SET CUSTOM DOMAIN — same behaviour as the iOS client (#80/#81).
//
// Decoupled request/confirm: a 200 only RECORDS the request; .com
// verifies the CNAME out-of-band and pushes the outcome. Non-200 is
// the ONLY synchronous denial (the 300s rate limit / busy). No
// phone-side CNAME check, no pending UI; the bound domain shows in
// the CUSTOM DOMAIN group on 200, the services-list swap waits for the
// confirm. Mirrors ServiceDetailViewModel.submitCustomDomain exactly.
// ---------------------------------------------------------------

const COOLDOWN_KEY_PREFIX = "flagship.customDomain.lastChanged.";

function cdCooldownKey(serviceId) {
  return `${COOLDOWN_KEY_PREFIX}${serviceId}`;
}

/** Remaining cooldown ms for the current service (0 = none). Rebuilt from
 *  the on-device timestamp so it survives a reload — the server 429
 *  is the real backstop if local state is lost. */
function cdCooldownRemainingMs() {
  try {
    const ts = Number(localStorage.getItem(cdCooldownKey(currentServiceId)));
    if (!ts) return 0;
    return Math.max(0, ts + CUSTOM_DOMAIN_COOLDOWN_MS - Date.now());
  } catch {
    return 0;
  }
}

function recordCustomDomainChangeLocally() {
  try {
    localStorage.setItem(cdCooldownKey(currentServiceId), String(Date.now()));
  } catch {
    /* private mode / disabled storage — the server 429 still backstops */
  }
}

/** M:SS, matching the iOS cooldownLabel (ceil seconds). */
function cooldownLabel(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function customDomainRoot() {
  return `${getSession().username || "you"}.${dataApex()}`;
}

/** SET CUSTOM DOMAIN card: section label + right-floated M:SS
 *  countdown while cooling, input + Add (disabled during cooldown),
 *  and the CNAME guidance line — all byte-faithful to the iOS UI. */
function renderCustomDomainsSection() {
  const remaining = cdCooldownRemainingMs();
  const cooling = remaining > 0;
  return `
    <h2 class="mt-4">${tr("Set custom domain")}</h2>
    <div class="card">
      <div class="row" style="align-items:baseline;">
        <div class="label-tiny" style="flex:1;">${tr("SET CUSTOM DOMAIN")}</div>
        <div class="label-tiny mono" id="sd-cd-cooldown" ${cooling ? "" : "hidden"}>${cooling ? cooldownLabel(remaining) : ""}</div>
      </div>
      <div class="row mt-2">
        <input id="sd-cd-input" placeholder="www.mydomain.com" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" style="flex:1;" />
        <button class="secondary" id="sd-cd-add" ${cooling ? "disabled" : ""}>${tr("Add")}</button>
      </div>
      <div class="muted-sm text-xs mt-2">
        ${tr("Custom domains come with <a href=\"/pro\">Pro</a> (one) and Pro Max (unlimited). To add one, first point a CNAME record from it to")}
        <span class="mono">${escapeHtml(customDomainRoot())}</span> ${tr("— that proves you control it.")}
      </div>
    </div>
  `;
}

function rerenderCustomDomains() {
  const el = $("sd-custom-domains");
  if (!el) return;
  el.innerHTML = renderCustomDomainsSection();
  bindCustomDomainsHandlers();
}

/** 1s ticker that keeps the M:SS countdown + disabled state live,
 *  then re-enables Add when it elapses. Single-instance. */
function startCooldownTicker() {
  if (cdCooldownTicker) clearInterval(cdCooldownTicker);
  cdCooldownTicker = setInterval(() => {
    const label = $("sd-cd-cooldown");
    const addBtn = $("sd-cd-add");
    if (!label || !addBtn) {
      clearInterval(cdCooldownTicker);
      cdCooldownTicker = null;
      return;
    }
    const remaining = cdCooldownRemainingMs();
    if (remaining > 0) {
      label.hidden = false;
      label.textContent = cooldownLabel(remaining);
      addBtn.disabled = true;
    } else {
      label.hidden = true;
      addBtn.disabled = false;
      clearInterval(cdCooldownTicker);
      cdCooldownTicker = null;
    }
  }, 1000);
}

function bindCustomDomainsHandlers() {
  $("sd-cd-add")?.addEventListener("click", () => {
    submitCustomDomain().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
  if (cdCooldownRemainingMs() > 0) startCooldownTicker();
}

/** Validate the draft and either raise an explanatory prompt or issue
 *  the binding request. Mirrors ServiceDetailViewModel.submitCustomDomain:
 *  normalize → cooldown gate → apex→www → destructive-replace confirm
 *  → decoupled request. */
async function submitCustomDomain() {
  const input = $("sd-cd-input");
  const fqdn = (input?.value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (!fqdn) return;

  // Client mirror of the server's last_changed rate limit.
  if (cdCooldownRemainingMs() > 0) return;

  const { inlineConfirm } = await import("../lib/modal.js");

  // (a) Apex / no subdomain — fewer than 3 labels means there's no
  // subdomain to CNAME (example.com). Offer the www form. Structural
  // (not a DNS check) so it stays instant + local.
  if (fqdn.split(".").length < 3) {
    const suggested = `www.${fqdn}`;
    const ok = await inlineConfirm({
      title: tr("Subdomains only"),
      message: tr("This only supports subdomains — an apex like {0} can't take a CNAME. Use {1}?", fqdn, suggested),
      okLabel: tr("Use {0}", suggested),
    });
    if (!ok) return;
    if (input) input.value = suggested;
    return submitCustomDomain();
  }

  // No phone-side CNAME check: .com re-validates authoritatively
  // anyway, so we take the claim at face value and let the binding
  // POST test it. A failed CNAME comes back asynchronously, not here.

  // (b) Replacing an existing binding — confirm first. The swap is
  // destructive + irreversible: this device drops its memory of the
  // old domain immediately, even if the new one never confirms
  // (there's no "forget a domain" affordance otherwise).
  const existing = currentServiceLinks?.customDomain ?? null;
  if (existing && existing !== fqdn) {
    const ok = await inlineConfirm({
      title: tr("Replace custom domain?"),
      message: tr("This will permanently replace the current custom domain ({0}). It can't be undone, even if the new one fails to verify.", existing),
      okLabel: tr("Replace"),
      danger: true,
    });
    if (!ok) return;
  }

  // (c) Clean path — decoupled request. A 200 only means "recorded;
  // .com will verify the CNAME out-of-band and push the outcome".
  await bindCustomDomain(fqdn);
}

async function bindCustomDomain(fqdn) {
  const session = getSession();
  if (!session.username || !session.umk) {
    toast(tr("Sign in first."), "err");
    return;
  }
  const issuedAt = Date.now();
  const canonical = canonicalSetCustomDomain(
    session.username, currentServiceId, fqdn, issuedAt,
  );
  let sig;
  try {
    // Slice D: attach-custom-domain is a SENSITIVE order — admin master root
    // when this account has one, else the owner IRK (legacy).
    sig = await sensitiveSigner()(session.umk, canonical);
  } catch (e) {
    toast(tr("Couldn't sign: {0}", e.message ?? e), "err");
    return;
  }
  try {
    const r = await fetch(
      `${COM_BASE}/api/users/${encodeURIComponent(session.username)}/apps/${encodeURIComponent(currentServiceId)}/custom-domain`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: {
            username: session.username,
            serviceId: currentServiceId,
            fqdn,
            issuedAt,
          },
          signature: bytesToHex(sig),
        }),
      },
    );
    if (!r.ok) {
      // Non-200 is the ONLY synchronous denial — rate-limit / busy,
      // never a CNAME verdict (that's async). Show .com's reason
      // verbatim; for 429 it is the byte-identical "Too soon — try
      // again in Ns." string the iOS client shows.
      // Prefer .com's own reason string (e.g. the byte-identical 429
      // "Too soon — try again in Ns." the iOS client shows); only fall back
      // to generic human copy when there's no usable server message.
      let msg = humanError(r.status);
      try {
        const body = await r.json();
        if (body && typeof body.error === "string") msg = body.error;
      } catch {
        /* keep the human fallback */
      }
      console.error("custom-domain request failed", r.status);
      toast(msg, "err");
      return;
    }
    // 200 = recorded (NOT yet confirmed). Start the cooldown + re-
    // render: /links now returns the pending domain so the CUSTOM
    // DOMAIN group surfaces it optimistically. No pending UI by
    // design; the services-list swap waits for the async confirm.
    recordCustomDomainChangeLocally();
    if (currentServiceId) await renderServiceDetail(currentServiceId);
  } catch (e) {
    toast(tr("Couldn't request custom domain: {0}", e.message ?? e), "err");
  }
}

/** Mirrors @flagship/protocol canonicalSetCustomDomain
 *  (flagship/custom-domain/v1 | username | serviceId | fqdn | issuedAt).
 *  Same shape the iOS Live client + the .com verifier expect. */
function canonicalSetCustomDomain(username, serviceId, fqdn, issuedAt) {
  const enc = new TextEncoder();
  return enc.encode(
    [
      "flagship/custom-domain/v1",
      username,
      serviceId,
      fqdn.toLowerCase(),
      String(issuedAt),
    ].join("|"),
  );
}

/** Modal-style scare sheet for the Replace ceremony. Inline (no
 *  external modal lib) so this view stays self-contained. */
async function openReplaceModal(service) {
  const { inlineConfirm } = await import("../lib/modal.js");
  const currentLabel = currentServiceLinks?.displayLabel ?? service.urlLabel ?? "";
  const draft = window.prompt(
    tr("Replace access URLs. This will update all the links to this service, replacing \"{0}\" with a new stem. All existing links break immediately. If you have attached external domains, those stay unaffected. New stem (lowercase letters, digits, hyphens; 1–40 chars; no leading/trailing hyphen):", currentLabel),
    currentLabel,
  );
  if (draft === null) return; // cancelled
  const trimmed = (draft || "").trim().toLowerCase();
  if (trimmed === "" || trimmed === currentLabel) return;
  // Mirrors the Worker's DNS_LABEL_RE in serviceRename.ts.
  if (!/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(trimmed)) {
    toast(tr("Stem must be a DNS label: lowercase, [a-z0-9-], 1–40 chars, no leading/trailing hyphen."), "err");
    return;
  }
  // Final scare confirm before we fire the destructive op.
  const ok = await inlineConfirm({
    title: tr("Replace stem with '{0}'?", trimmed),
    message:
      tr("Every link to this service changes immediately. Attached external domains are unaffected. Other devices see the new URL on next refresh."),
    okLabel: tr("Replace"),
    danger: true,
  });
  if (!ok) return;
  await runRename(service, trimmed);
}

/** Sign the canonical bytes with the user's IRK, POST to .com, swap
 *  the surfaced URLs in place on success. */
async function runRename(service, newLabel) {
  const session = getSession();
  if (!session.username || !session.umk) {
    toast(tr("Sign in first."), "err");
    return;
  }
  toast(tr("Renaming…"));
  const issuedAt = Date.now();
  const canonical = canonicalServiceRename(session.username, service.serviceId, newLabel, issuedAt);
  let sig;
  try {
    sig = await signWithIrk(session.umk, canonical);
  } catch (e) {
    toast(tr("Couldn't sign: {0}", e.message ?? e), "err");
    return;
  }
  try {
    const r = await fetch(
      `${COM_BASE}/api/users/${encodeURIComponent(session.username)}/apps/${encodeURIComponent(service.serviceId)}/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: {
            username: session.username,
            serviceId: service.serviceId,
            newDisplayLabel: newLabel,
            issuedAt,
          },
          signature: bytesToHex(sig),
        }),
      },
    );
    if (!r.ok) {
      const text = await r.text();
      console.error("service rename failed", r.status, text);
      if (r.status === 409) {
        toast(tr("Another service already uses that name."), "err");
      } else if (r.status === 400) {
        toast(tr("That name isn't valid (lowercase letters, digits, hyphens; 1–40 chars)."), "err");
      } else {
        toast(humanError(r.status), "err");
      }
      return;
    }
    const body = await r.json();
    currentServiceLinks = {
      serviceId: service.serviceId,
      displayLabel: body.displayLabel,
      canonicalUrl: body.canonicalUrl,
      instances: currentServiceLinks?.instances ?? [],
      shortCode: body.shortCode ?? currentServiceLinks?.shortCode,
      link: currentServiceLinks?.link,
    };
    toast(tr("Renamed to {0}.", body.displayLabel));
    // Re-render the section in place.
    if (currentServiceId === service.serviceId) {
      await renderServiceDetail(service.serviceId);
    }
  } catch (e) {
    toast(tr("Couldn't rename: {0}", e.message ?? e), "err");
  }
}

function canonicalServiceRename(username, serviceId, newDisplayLabel, issuedAt) {
  const enc = new TextEncoder();
  return enc.encode(
    [
      "flagship/service-rename/v1",
      username,
      serviceId,
      newDisplayLabel.toLowerCase(),
      String(issuedAt),
    ].join("|"),
  );
}

function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
