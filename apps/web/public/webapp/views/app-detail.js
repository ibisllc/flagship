// P2.3 — app-detail view. Calls /api/screens/app-detail/:appId (P1.3).
// Includes a "backup this app" button that calls P1.19, and (when the
// app declares a browser bundle) a "Open browser viewer" button that
// drives the user into views/browser-viewer.js with appId pre-set.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { signWithIrk } from "../keystore.js";
import { enterBrowserViewer } from "./browser-viewer.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

const COM_BASE = "https://flagshipserver.com";

/** V3 — cached app-links per appId for the current render. */
let currentAppLinks = null;

/** Custom domains the user has added in this view. Local-only — the
 *  daemon's P1.22 verify endpoint checks DNS; there is no separate
 *  "register" call. `{ fqdn, status, expectedTxtRecord, reason }`. */
let customDomains = [];

registerView("view-app-detail");

let currentAppId = null;

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

export async function renderAppDetail(appId) {
  currentAppId = appId;
  customDomains = [];
  const root = $("app-detail-content");
  root.innerHTML = skeletonCards(3);
  try {
    const body = await screensFetch(
      `/api/screens/app-detail/${encodeURIComponent(appId)}`,
    );
    const a = body.app;
    // V3 — fetch the per-app URL identity from .com in parallel with
    // the daemon's detail. Tolerated as null if .com is unreachable;
    // the WEB DOMAINS section falls back to the daemon-provided
    // urlLabel in that case.
    const session = getSession();
    currentAppLinks = session.username
      ? await fetchAppLinks(session.username, appId).catch(() => null)
      : null;
    root.innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(a.slug)}</div>
        <div class="muted-sm text-xs mt-1">${
          a.version ? `ver: ${escapeHtml(a.version)}&nbsp;&nbsp;·&nbsp;&nbsp;` : ""
        }id: ${escapeHtml(a.appId)}</div>
        <div class="muted-sm mt-2">${escapeHtml(a.summary || "")}</div>
        <div class="row mt-2">
          <span class="label">creator</span><span class="value">${escapeHtml(a.creator)}</span>
        </div>
      </div>

      ${renderWebDomainsSection(a, currentAppLinks)}
      <div id="ad-custom-domains">${renderCustomDomainsSection()}</div>
      <h2 class="mt-4">Manifest</h2>
      <div class="card">
        <pre class="json-block">${escapeHtml(JSON.stringify(body.manifest, null, 2))}</pre>
      </div>
      <h2 class="mt-4">Data layer</h2>
      ${(body.dataLayerInstances ?? []).length === 0
        ? '<div class="card placeholder">no stores</div>'
        : (body.dataLayerInstances ?? []).map((i) => `
          <div class="card">
            <div class="row"><span class="label">${escapeHtml(i.store)}</span><span class="value">${escapeHtml(i.instanceName)}</span></div>
          </div>
        `).join("")
      }
      <h2 class="mt-4">Members</h2>
      ${(body.members ?? []).length === 0
        ? '<div class="card placeholder">none</div>'
        : (body.members ?? []).map((m) => `
          <div class="card">
            <div class="row">
              <span class="value text-xs">${escapeHtml(m.stableIdPrefix)}…</span>
              <span class="pill">${escapeHtml(m.role)}</span>
            </div>
          </div>
        `).join("")
      }
      ${hasBrowserBundle(body) ? `
        <h2 class="mt-4">Browser bundle</h2>
        <div class="card">
          <p class="note">
            This app ships a Chromium tab the daemon runs on your pod. Open
            the viewer to drive a sign-in or paste-a-cookie flow against it
            from your webapp — frames stream over the paired-session WS.
          </p>
          <button id="ad-open-browser" class="full-width">Open browser viewer</button>
        </div>
      ` : ""}
      <h2 class="mt-4">Invites</h2>
      <div class="card">
        <p class="note">
          Share access via single-use bearer links. Names you attach to an
          invite stay on this device (encrypted user-blob synced lazily); the
          daemon and flagshipserver.com never see them.
        </p>
        <div class="row-2 mt-2">
          <button id="ad-invite-issue" class="secondary">Invite people</button>
          <button id="ad-invite-manage" class="secondary">Manage invites</button>
        </div>
      </div>
      <h2 class="mt-4">Backup</h2>
      <div class="card">
        <p class="note">
          Phone-driven backup of this app's source + (optionally) user data.
          Bytes flow daemon → this device only — flagshipserver.com is never
          in the path.
        </p>
        <label class="inline-check">
          <input type="checkbox" id="ad-include-data" /> Include user data
        </label>
        <input type="password" id="ad-password" placeholder="Optional password (encrypts archive)" autocomplete="off" class="mt-2" />
        <button id="ad-backup-go" class="full-width mt-2">Create backup</button>
        <div id="ad-backup-status" class="mt-2 text-sm"></div>
      </div>
    `;

    $("ad-backup-go")?.addEventListener("click", () => triggerBackup(a.appId));
    $("ad-open-browser")?.addEventListener("click", () => {
      enterBrowserViewer(a.appId).catch((e) => toast(String(e), "err"));
    });
    $("ad-invite-issue")?.addEventListener("click", async () => {
      const { enterInviteIssue } = await import("./invite-issue.js");
      await enterInviteIssue(a);
    });
    $("ad-invite-manage")?.addEventListener("click", async () => {
      const { enterInviteManage } = await import("./invite-manage.js");
      await enterInviteManage(a);
    });
    bindWebDomainsHandlers(a);
    bindCustomDomainsHandlers();
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function triggerBackup(appId) {
  const status = $("ad-backup-status");
  const password = $("ad-password").value;
  const includeUserData = $("ad-include-data").checked;
  status.textContent = "creating backup…";
  try {
    const body = await screensFetch("/api/screens/app-backup/start", {
      method: "POST",
      body: JSON.stringify({
        appId,
        includeUserData,
        password: password || undefined,
      }),
    });
    const fetchUrl = `${getPodBaseUrl()}${body.fetchPath}`;
    status.innerHTML = `
      ready (${(body.bytes / 1024).toFixed(1)} KB${body.encrypted ? ", encrypted" : ""})
      — <a href="${escapeHtml(fetchUrl)}" download>download</a>
    `;
  } catch (e) {
    if (e instanceof ScreensError) {
      status.textContent = `failed: ${e.message}`;
    } else {
      status.textContent = `failed: ${e.message}`;
    }
  }
}

export function initAppDetailView() {
  $("app-detail-back")?.addEventListener("click", async () => {
    const { enterAppsList } = await import("./apps-list.js");
    await enterAppsList();
  });
  $("app-detail-refresh")?.addEventListener("click", () => {
    if (currentAppId) renderAppDetail(currentAppId).catch((e) => toast(String(e), "err"));
  });
}

export async function enterAppDetail(appId) {
  show("view-app-detail");
  await renderAppDetail(appId);
}

// ---------------------------------------------------------------
// V3 — WEB DOMAINS section + Replace ceremony
// ---------------------------------------------------------------

/** Fetch the per-app links bundle from .com — { canonical, short,
 *  instances }. Falls back to the daemon's urlLabel if .com is
 *  unreachable so the section still renders. */
async function fetchAppLinks(username, appId) {
  const r = await fetch(
    `${COM_BASE}/api/users/${encodeURIComponent(username)}/apps/${encodeURIComponent(appId)}/links`,
    { cache: "no-store" },
  );
  if (!r.ok) return null;
  return await r.json();
}

/** Three-group layout: SHORT (top, bold) → CANONICAL → INSTANCES.
 *  Header carries a Replace button that fires the rename ceremony. */
function renderWebDomainsSection(app, links) {
  const stripScheme = (s) => s.replace(/^https?:\/\//, "");
  // Show the bare host (no scheme), HTML-escaped, with a zero-width
  // space after each dot so a long FQDN wraps between segments rather
  // than mid-label. href + data-copy keep the clean URL — only the
  // visible text carries the ZWSP. Mirrors iOS/Android wrapAtDots.
  const displayUrl = (s) =>
    escapeHtml(stripScheme(s)).replace(/\./g, ".&#8203;");
  const fallbackCanonical = `https://${app.urlLabel}.${getSession().username || "you"}.flagship.services`;
  const shortUrl = links?.shortUrl ?? null;
  const canonical = links?.canonicalUrl ?? fallbackCanonical;
  const instances = links?.instances ?? [];

  const shortRow = shortUrl
    ? `
        <div class="row" data-section="short">
          <a class="weight-600 mono" href="${escapeHtml(shortUrl)}" target="_blank" rel="noopener">
            ${displayUrl(shortUrl)}
          </a>
          <button class="ghost" data-copy="${escapeHtml(shortUrl)}" aria-label="Copy short link">📋</button>
        </div>`
    : `
        <div class="row" data-section="short">
          <span class="muted-sm">No short link yet. Tap Replace to mint one.</span>
        </div>`;

  const canonicalRow = `
    <div class="row" data-section="canonical">
      <a class="mono" href="${escapeHtml(canonical)}" target="_blank" rel="noopener">
        ${displayUrl(canonical)}
      </a>
      <button class="ghost" data-copy="${escapeHtml(canonical)}" aria-label="Copy canonical">📋</button>
    </div>`;

  const instancesBlock = instances.length === 0 ? "" : `
    <div class="mt-3">
      <div class="label-tiny">INDIVIDUAL INSTANCES</div>
      ${instances.map((i) => `
        <div class="row muted-sm mono" data-section="instance">
          ${displayUrl(i.url)}
        </div>
      `).join("")}
    </div>`;

  return `
    <div class="row mt-4" style="align-items:baseline;">
      <h2 style="margin:0;">Web domains</h2>
      <button class="danger small" id="ad-replace-stem">Replace</button>
    </div>
    <div class="card">
      <div class="label-tiny">SHORT REDIRECT</div>
      ${shortRow}
      <div class="mt-3">
        <div class="label-tiny">CANONICAL (SHARED BY ALL INSTANCES)</div>
        ${canonicalRow}
      </div>
      ${instancesBlock}
    </div>
  `;
}

/** Wire copy buttons + the Replace flow. */
function bindWebDomainsHandlers(app) {
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      const url = ev.currentTarget.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(url);
        toast("Copied.");
      } catch (e) {
        toast("Couldn't copy — long-press to copy manually.", "err");
      }
    });
  });
  $("ad-replace-stem")?.addEventListener("click", () => openReplaceModal(app));
}

// ---------------------------------------------------------------
// Custom domains — add locally, verify DNS via P1.22.
// ---------------------------------------------------------------

function statusPill(status) {
  switch (status) {
    case "verified": return '<span class="pill ok">Verified</span>';
    case "pending":  return '<span class="pill">Pending DNS</span>';
    case "failed":   return '<span class="pill err">Failed</span>';
    default:         return '<span class="pill">Not yet checked</span>';
  }
}

/** Card with the list of added custom domains (each with a Verify /
 *  Remove control + TXT hint) and an add field. Kept visible so the
 *  custom-domain affordance isn't forgotten. */
function renderCustomDomainsSection() {
  const list = customDomains.map((d, i) => `
    <div class="card" data-cd-row="${i}">
      <div class="row" style="align-items:baseline;">
        <span class="mono text-xs" style="flex:1; min-width:0; word-break:break-all;">${escapeHtml(d.fqdn)}</span>
        ${statusPill(d.status)}
        <button class="ghost mini" data-cd-remove="${i}" aria-label="Remove">✕</button>
      </div>
      ${d.expectedTxtRecord ? `
        <div class="muted-sm text-xs mt-1">Add this TXT record on <span class="mono">_flagship.${escapeHtml(d.fqdn)}</span>:</div>
        <div class="mono text-xs">${escapeHtml(d.expectedTxtRecord)}</div>` : ""}
      ${d.reason ? `<div class="muted-sm text-xs mt-1">${escapeHtml(d.reason)}</div>` : ""}
      <button class="secondary small mt-2" data-cd-verify="${i}">${d.status === "pending" ? "Re-check DNS" : "Verify DNS"}</button>
    </div>
  `).join("");
  return `
    <h2 class="mt-4">Custom domain</h2>
    ${list}
    <div class="card">
      <div class="row">
        <input id="ad-cd-input" placeholder="app.mydomain.com" autocomplete="off" style="flex:1;" />
        <button class="secondary" id="ad-cd-add">Add</button>
      </div>
      <div class="muted-sm text-xs mt-2">
        Custom domains need a DNS CNAME to your pod. Setup hints appear after you add.
      </div>
    </div>
  `;
}

function rerenderCustomDomains() {
  const el = $("ad-custom-domains");
  if (!el) return;
  el.innerHTML = renderCustomDomainsSection();
  bindCustomDomainsHandlers();
}

function bindCustomDomainsHandlers() {
  $("ad-cd-add")?.addEventListener("click", () => {
    const input = $("ad-cd-input");
    const v = (input?.value || "").trim().toLowerCase();
    if (!v || customDomains.some((d) => d.fqdn === v)) return;
    customDomains.push({ fqdn: v, status: null, expectedTxtRecord: "", reason: "" });
    rerenderCustomDomains();
  });
  document.querySelectorAll("[data-cd-remove]").forEach((b) => {
    b.addEventListener("click", () => {
      customDomains.splice(Number(b.getAttribute("data-cd-remove")), 1);
      rerenderCustomDomains();
    });
  });
  document.querySelectorAll("[data-cd-verify]").forEach((b) => {
    b.addEventListener("click", () => verifyCustomDomain(Number(b.getAttribute("data-cd-verify"))));
  });
}

async function verifyCustomDomain(idx) {
  const d = customDomains[idx];
  if (!d) return;
  try {
    const r = await screensFetch("/api/screens/url-controller/verify", {
      method: "POST",
      body: JSON.stringify({ fqdn: d.fqdn }),
    });
    customDomains[idx] = {
      fqdn: r.fqdn,
      status: r.status,
      expectedTxtRecord: r.expectedTxtRecord || "",
      reason: r.reason || "",
    };
  } catch (e) {
    customDomains[idx] = {
      ...d,
      status: "failed",
      reason: e instanceof ScreensError ? e.message : String(e),
    };
  }
  rerenderCustomDomains();
}

/** Modal-style scare sheet for the Replace ceremony. Inline (no
 *  external modal lib) so this view stays self-contained. */
async function openReplaceModal(app) {
  const { inlineConfirm } = await import("../lib/modal.js");
  const currentLabel = currentAppLinks?.displayLabel ?? app.urlLabel ?? "";
  const draft = window.prompt(
    "Replace access URLs.\n\n" +
      `This will update all the links to this service, replacing "${currentLabel}" ` +
      "with a new stem. All existing links break immediately, including the short " +
      "link. If you have attached external domains, those stay unaffected.\n\n" +
      "New stem (lowercase letters, digits, hyphens; 1–40 chars; no leading/trailing hyphen):",
    currentLabel,
  );
  if (draft === null) return; // cancelled
  const trimmed = (draft || "").trim().toLowerCase();
  if (trimmed === "" || trimmed === currentLabel) return;
  // Mirrors the Worker's DNS_LABEL_RE in appRename.ts.
  if (!/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(trimmed)) {
    toast("Stem must be a DNS label: lowercase, [a-z0-9-], 1–40 chars, no leading/trailing hyphen.", "err");
    return;
  }
  // Final scare confirm before we fire the destructive op.
  const ok = await inlineConfirm({
    title: `Replace stem with '${trimmed}'?`,
    message:
      "Every link to this service changes immediately, including the short link. " +
      "Attached external domains are unaffected. Other devices see the new URL " +
      "on next refresh.",
    okLabel: "Replace",
    danger: true,
  });
  if (!ok) return;
  await runRename(app, trimmed);
}

/** Sign the canonical bytes with the user's IRK, POST to .com, swap
 *  the surfaced URLs in place on success. */
async function runRename(app, newLabel) {
  const session = getSession();
  if (!session.username || !session.umk) {
    toast("Sign in first.", "err");
    return;
  }
  toast("Renaming…");
  const issuedAt = Date.now();
  const canonical = canonicalAppRename(session.username, app.appId, newLabel, issuedAt);
  let sig;
  try {
    sig = await signWithIrk(session.umk, canonical);
  } catch (e) {
    toast(`Couldn't sign: ${e.message ?? e}`, "err");
    return;
  }
  try {
    const r = await fetch(
      `${COM_BASE}/api/users/${encodeURIComponent(session.username)}/apps/${encodeURIComponent(app.appId)}/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: {
            username: session.username,
            appId: app.appId,
            newDisplayLabel: newLabel,
            issuedAt,
          },
          signature: bytesToHex(sig),
        }),
      },
    );
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 409) {
        toast("Another app already uses that name.", "err");
      } else if (r.status === 400) {
        toast("That name isn't valid (lowercase letters, digits, hyphens; 1–40 chars).", "err");
      } else {
        toast(`Couldn't rename: ${text}`, "err");
      }
      return;
    }
    const body = await r.json();
    currentAppLinks = {
      appId: app.appId,
      displayLabel: body.displayLabel,
      canonicalUrl: body.canonicalUrl,
      instances: currentAppLinks?.instances ?? [],
      shortUrl: body.shortUrl,
    };
    toast(`Renamed to ${body.displayLabel}. New short link minted.`);
    // Re-render the section in place.
    if (currentAppId === app.appId) {
      await renderAppDetail(app.appId);
    }
  } catch (e) {
    toast(`Couldn't rename: ${e.message ?? e}`, "err");
  }
}

function canonicalAppRename(username, appId, newDisplayLabel, issuedAt) {
  const enc = new TextEncoder();
  return enc.encode(
    [
      "flagship/app-rename/v1",
      username,
      appId,
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
