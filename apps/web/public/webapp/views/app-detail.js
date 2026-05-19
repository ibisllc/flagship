// P2.3 — app-detail view. Calls /api/screens/app-detail/:serviceId (P1.3).
// Includes a "backup this app" button that calls P1.19, and (when the
// app declares a browser bundle) a "Open browser viewer" button that
// drives the user into views/browser-viewer.js with serviceId pre-set.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { signWithIrk } from "../keystore.js";
import { enterBrowserViewer } from "./browser-viewer.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

const COM_BASE = "https://flagshipserver.com";

/** V3 — cached app-links per serviceId for the current render. Carries
 *  `customDomain` + `customDomainConfirmed` from .com's /links. */
let currentAppLinks = null;

registerView("view-app-detail");

let currentAppId = null;

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

export async function renderAppDetail(serviceId) {
  currentAppId = serviceId;
  const root = $("app-detail-content");
  root.innerHTML = skeletonCards(3);
  try {
    const body = await screensFetch(
      `/api/screens/app-detail/${encodeURIComponent(serviceId)}`,
    );
    const a = body.app;
    // V3 — fetch the per-app URL identity from .com in parallel with
    // the daemon's detail. Tolerated as null if .com is unreachable;
    // the WEB DOMAINS section falls back to the daemon-provided
    // urlLabel in that case.
    const session = getSession();
    currentAppLinks = session.username
      ? await fetchAppLinks(session.username, serviceId).catch(() => null)
      : null;
    root.innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(a.slug)}</div>
        <div class="muted-sm text-xs mt-1">${
          a.version ? `ver: ${escapeHtml(a.version)}&nbsp;&nbsp;·&nbsp;&nbsp;` : ""
        }id: ${escapeHtml(a.serviceId)}</div>
        <div class="muted-sm mt-2 truncate">${escapeHtml(a.summary || "")}</div>
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

    $("ad-backup-go")?.addEventListener("click", () => triggerBackup(a.serviceId));
    $("ad-open-browser")?.addEventListener("click", () => {
      enterBrowserViewer(a.serviceId).catch((e) => toast(String(e), "err"));
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

async function triggerBackup(serviceId) {
  const status = $("ad-backup-status");
  const password = $("ad-password").value;
  const includeUserData = $("ad-include-data").checked;
  status.textContent = "creating backup…";
  try {
    const body = await screensFetch("/api/screens/app-backup/start", {
      method: "POST",
      body: JSON.stringify({
        serviceId,
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

export async function enterAppDetail(serviceId) {
  show("view-app-detail");
  await renderAppDetail(serviceId);
}

// ---------------------------------------------------------------
// V3 — WEB DOMAINS section + Replace ceremony
// ---------------------------------------------------------------

/** Fetch the per-app links bundle from .com — { canonical, short,
 *  instances }. Falls back to the daemon's urlLabel if .com is
 *  unreachable so the section still renders. */
async function fetchAppLinks(username, serviceId) {
  const r = await fetch(
    `${COM_BASE}/api/users/${encodeURIComponent(username)}/apps/${encodeURIComponent(serviceId)}/links`,
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

  // CUSTOM DOMAIN sits at the very top of the card, only when one is
  // bound. It's the user's own name — show it first. Surfaced as soon
  // as the order is recorded (even pending); the apps-list short→
  // custom swap is what waits for .com to confirm. Mirrors iOS
  // AppDetailScreen.customDomainGroup.
  const cd = links?.customDomain ?? null;
  const customDomainBlock = !cd ? "" : `
      <div class="label-tiny">CUSTOM DOMAIN</div>
      <div class="row" data-section="custom">
        <a class="weight-600 mono" href="https://${escapeHtml(cd)}" target="_blank" rel="noopener">
          ${displayUrl("https://" + cd)}
        </a>
        <button class="ghost" data-copy="https://${escapeHtml(cd)}" aria-label="Copy custom domain">📋</button>
      </div>
      <div class="mt-3"></div>`;

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
      ${customDomainBlock}
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
// SET CUSTOM DOMAIN — Mock-faithful with the iOS client (#80/#81).
//
// Decoupled request/confirm: a 200 only RECORDS the request; .com
// verifies the CNAME out-of-band and pushes the outcome. Non-200 is
// the ONLY synchronous denial (the 300s rate limit / busy). No
// phone-side CNAME check, no pending UI; the bound domain shows in
// the CUSTOM DOMAIN group on 200, the apps-list swap waits for the
// confirm. Mirrors AppDetailViewModel.submitCustomDomain exactly.
// ---------------------------------------------------------------

const COOLDOWN_KEY_PREFIX = "flagship.customDomain.lastChanged.";

function cdCooldownKey(serviceId) {
  return `${COOLDOWN_KEY_PREFIX}${serviceId}`;
}

/** Remaining cooldown ms for the current app (0 = none). Rebuilt from
 *  the on-device timestamp so it survives a reload — the server 429
 *  is the real backstop if local state is lost. */
function cdCooldownRemainingMs() {
  try {
    const ts = Number(localStorage.getItem(cdCooldownKey(currentAppId)));
    if (!ts) return 0;
    return Math.max(0, ts + CUSTOM_DOMAIN_COOLDOWN_MS - Date.now());
  } catch {
    return 0;
  }
}

function recordCustomDomainChangeLocally() {
  try {
    localStorage.setItem(cdCooldownKey(currentAppId), String(Date.now()));
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
  return `${getSession().username || "you"}.flagship.services`;
}

/** SET CUSTOM DOMAIN card: section label + right-floated M:SS
 *  countdown while cooling, input + Add (disabled during cooldown),
 *  and the CNAME guidance line — all byte-faithful to the iOS UI. */
function renderCustomDomainsSection() {
  const remaining = cdCooldownRemainingMs();
  const cooling = remaining > 0;
  return `
    <h2 class="mt-4">Set custom domain</h2>
    <div class="card">
      <div class="row" style="align-items:baseline;">
        <div class="label-tiny" style="flex:1;">SET CUSTOM DOMAIN</div>
        <div class="label-tiny mono" id="ad-cd-cooldown" ${cooling ? "" : "hidden"}>${cooling ? cooldownLabel(remaining) : ""}</div>
      </div>
      <div class="row mt-2">
        <input id="ad-cd-input" placeholder="www.mydomain.com" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" style="flex:1;" />
        <button class="secondary" id="ad-cd-add" ${cooling ? "disabled" : ""}>Add</button>
      </div>
      <div class="muted-sm text-xs mt-2">
        Prior to claiming a FQDN, you must set a CNAME record targeting
        <span class="mono">${escapeHtml(customDomainRoot())}</span>.
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

/** 1s ticker that keeps the M:SS countdown + disabled state live,
 *  then re-enables Add when it elapses. Single-instance. */
function startCooldownTicker() {
  if (cdCooldownTicker) clearInterval(cdCooldownTicker);
  cdCooldownTicker = setInterval(() => {
    const label = $("ad-cd-cooldown");
    const addBtn = $("ad-cd-add");
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
  $("ad-cd-add")?.addEventListener("click", () => {
    submitCustomDomain().catch((e) => toast(String(e?.message ?? e), "err"));
  });
  if (cdCooldownRemainingMs() > 0) startCooldownTicker();
}

/** Validate the draft and either raise an explanatory prompt or issue
 *  the binding request. Mirrors AppDetailViewModel.submitCustomDomain:
 *  normalize → cooldown gate → apex→www → destructive-replace confirm
 *  → decoupled request. */
async function submitCustomDomain() {
  const input = $("ad-cd-input");
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
      title: "Subdomains only",
      message: `This only supports subdomains — an apex like ${fqdn} can't take a CNAME. Use ${suggested}?`,
      okLabel: `Use ${suggested}`,
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
  const existing = currentAppLinks?.customDomain ?? null;
  if (existing && existing !== fqdn) {
    const ok = await inlineConfirm({
      title: "Replace custom domain?",
      message: `This will permanently replace the current custom domain (${existing}). It can't be undone, even if the new one fails to verify.`,
      okLabel: "Replace",
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
    toast("Sign in first.", "err");
    return;
  }
  const issuedAt = Date.now();
  const canonical = canonicalSetCustomDomain(
    session.username, currentAppId, fqdn, issuedAt,
  );
  let sig;
  try {
    sig = await signWithIrk(session.umk, canonical);
  } catch (e) {
    toast(`Couldn't sign: ${e.message ?? e}`, "err");
    return;
  }
  try {
    const r = await fetch(
      `${COM_BASE}/api/users/${encodeURIComponent(session.username)}/apps/${encodeURIComponent(currentAppId)}/custom-domain`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: {
            username: session.username,
            serviceId: currentAppId,
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
      // again in Ns." string the iOS Mock uses.
      let msg = `Couldn't request custom domain (${r.status}).`;
      try {
        const body = await r.json();
        if (body && typeof body.error === "string") msg = body.error;
      } catch {
        /* keep the status fallback */
      }
      toast(msg, "err");
      return;
    }
    // 200 = recorded (NOT yet confirmed). Start the cooldown + re-
    // render: /links now returns the pending domain so the CUSTOM
    // DOMAIN group surfaces it optimistically. No pending UI by
    // design; the apps-list swap waits for the async confirm.
    recordCustomDomainChangeLocally();
    if (currentAppId) await renderAppDetail(currentAppId);
  } catch (e) {
    toast(`Couldn't request custom domain: ${e.message ?? e}`, "err");
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
  const canonical = canonicalServiceRename(session.username, app.serviceId, newLabel, issuedAt);
  let sig;
  try {
    sig = await signWithIrk(session.umk, canonical);
  } catch (e) {
    toast(`Couldn't sign: ${e.message ?? e}`, "err");
    return;
  }
  try {
    const r = await fetch(
      `${COM_BASE}/api/users/${encodeURIComponent(session.username)}/apps/${encodeURIComponent(app.serviceId)}/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: {
            username: session.username,
            serviceId: app.serviceId,
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
      serviceId: app.serviceId,
      displayLabel: body.displayLabel,
      canonicalUrl: body.canonicalUrl,
      instances: currentAppLinks?.instances ?? [],
      shortUrl: body.shortUrl,
    };
    toast(`Renamed to ${body.displayLabel}. New short link minted.`);
    // Re-render the section in place.
    if (currentAppId === app.serviceId) {
      await renderAppDetail(app.serviceId);
    }
  } catch (e) {
    toast(`Couldn't rename: ${e.message ?? e}`, "err");
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
