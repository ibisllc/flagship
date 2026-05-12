// Task #34 — Audit log view.
//
// Router slots:
//   - `view-audit-log`   — full-page entries list (detail view for the
//                          "see more" link from the Activity tab).
//   - `view-audit-entry` — single-entry drill-in: shows the raw signed
//                          envelope JSON so verification-curious users
//                          can re-verify the Ed25519 signature themselves.
//
// The Activity tab's `#activity-audit-log` div is the shell-owned hook
// for the inline preview (latest 5 entries). The shell worker calls
// `renderInlineActivityAuditLog()` from its Activity-tab enter handler.
//
// Consolidates every signed event the user has authored or that affects
// them — AppGrant issue/renew/revoke, Pod register/revoke, URL
// claim/drop, AutoUnlockLease grant/consume/revoke, Cloud-recovery
// setup/use, Username rename, App install/uninstall/update, Invite
// issue/consume/revoke, Recovery J.3 events, MergeBack.
//
// BFF endpoints consumed:
//   GET /api/screens/audit-log?limit=&cursor=&kind=
//   GET /api/screens/audit-log/:eventId        — full signed envelope
//
// TODO(daemon BFF): the production daemon does not yet expose
// /api/screens/audit-log/*. Until that lands the view renders a
// graceful "audit log not yet available" empty state.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-audit-log");
registerView("view-audit-entry");

const PAGE_SIZE = 30;
const INLINE_PREVIEW_SIZE = 5;

let activeKindFilter = "";
let activeCursor = null;

/**
 * Human-readable label for each event kind. Pinned here so the audit
 * log reads consistently no matter which subsystem authored the event.
 */
const KIND_LABELS = {
  "app-grant.issue": "App-grant issued",
  "app-grant.renew": "App-grant renewed",
  "app-grant.revoke": "App-grant revoked",
  "pod.register": "Pod registered",
  "pod.revoke": "Pod revoked",
  "url.claim": "URL claimed",
  "url.drop": "URL dropped",
  "lease.grant": "Auto-unlock lease granted",
  "lease.consume": "Auto-unlock lease consumed",
  "lease.revoke": "Auto-unlock lease revoked",
  "recovery.setup": "Cloud recovery set up",
  "recovery.use": "Cloud recovery used",
  "username.rename": "Username renamed",
  "app.install": "App installed",
  "app.uninstall": "App uninstalled",
  "app.update": "App updated",
  "invite.issue": "Invite issued",
  "invite.consume": "Invite consumed",
  "invite.revoke": "Invite revoked",
  "recovery.j3": "Recovery J.3 (re-pair envelope)",
  "recovery.merge-back": "Recovery merge-back",
};

const KIND_FILTERS = [
  { value: "", label: "All" },
  { value: "lease", label: "Leases" },
  { value: "app-grant", label: "App grants" },
  { value: "url", label: "URLs" },
  { value: "app", label: "Apps" },
  { value: "pod", label: "Pods" },
  { value: "invite", label: "Invites" },
  { value: "recovery", label: "Recovery" },
];

function fmtDate(unixMs) {
  if (typeof unixMs !== "number") return "—";
  return new Date(unixMs).toLocaleString();
}

function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind ?? "(unknown)";
}

function actorLabel(entry) {
  const a = entry.actor;
  if (!a) return "—";
  if (a.kind === "self") return "you (this device)";
  if (a.kind === "sibling") return `sibling pod ${escapeHtml(a.podId ?? "?")}`;
  if (a.kind === "irk") return `IRK ${escapeHtml((a.pubkeyHex ?? "").slice(0, 12))}…`;
  return escapeHtml(String(a.kind));
}

function entryRow(entry) {
  return `
    <div class="card" data-event-id="${escapeHtml(entry.eventId)}">
      <div class="row row-top">
        <div>
          <div class="weight-600">${escapeHtml(kindLabel(entry.kind))}</div>
          <div class="faint-sm">
            ${escapeHtml(fmtDate(entry.at))}
            · actor: ${actorLabel(entry)}
            ${entry.resource ? `· ${escapeHtml(entry.resource)}` : ""}
          </div>
          ${entry.summary ? `<div class="muted-sm mt-1">${escapeHtml(entry.summary)}</div>` : ""}
        </div>
        <button class="secondary" data-action="audit-entry" data-event-id="${escapeHtml(entry.eventId)}">
          inspect
        </button>
      </div>
    </div>
  `;
}

/**
 * Inline preview rendered into the shell's `#activity-audit-log` slot
 * on the Activity tab. Shows the latest ~5 entries plus a "see all"
 * link that navigates to the full-page audit-log view.
 */
export async function renderInlineActivityAuditLog() {
  const root = $("activity-audit-log");
  if (!root) return;
  let body;
  try {
    body = await screensFetch(`/api/screens/audit-log?limit=${INLINE_PREVIEW_SIZE}`);
  } catch (e) {
    if (e instanceof ScreensError && (e.status === 404 || e.status === 503)) {
      root.innerHTML = `
        <div class="card placeholder">
          audit log not yet available — the daemon's
          <code>/api/screens/audit-log</code> surface is on the
          v1-launch checklist (task #34, BFF side pending).
        </div>
      `;
      return;
    }
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message ?? String(e))}</p></div>`;
    return;
  }
  const entries = body.entries ?? [];
  if (!entries.length) {
    root.innerHTML = `
      <div class="card placeholder">
        no signed events yet — actions you take (claiming a URL,
        granting an app, issuing an invite) will land here with the
        underlying envelope you can verify yourself.
      </div>
    `;
    return;
  }
  root.innerHTML = entries.map(entryRow).join("") + `
    <button class="secondary full-width mt-2" id="activity-audit-log-see-all">see all activity</button>
  `;
  $("activity-audit-log-see-all")?.addEventListener("click", () => {
    enterAuditLog().catch((e) => toast(String(e), "err"));
  });
  bindEntryRows(root);
}

export async function renderAuditLog() {
  const root = $("audit-log-content");
  if (!root) return;
  root.innerHTML = '<div class="card placeholder">loading audit log…</div>';

  // Filter chips.
  const chips = $("audit-log-filters");
  if (chips) {
    chips.innerHTML = KIND_FILTERS.map((f) => `
      <button class="pill ${f.value === activeKindFilter ? "accent" : ""}"
              data-action="audit-filter"
              data-value="${escapeHtml(f.value)}">
        ${escapeHtml(f.label)}
      </button>
    `).join("");
    chips.querySelectorAll('[data-action="audit-filter"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        activeKindFilter = btn.getAttribute("data-value") ?? "";
        activeCursor = null;
        void renderAuditLog();
      });
    });
  }

  let body;
  try {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    if (activeKindFilter) params.set("kind", activeKindFilter);
    if (activeCursor) params.set("cursor", activeCursor);
    body = await screensFetch(`/api/screens/audit-log?${params.toString()}`);
  } catch (e) {
    if (e instanceof ScreensError) {
      if (e.status === 404 || e.status === 503) {
        root.innerHTML = `
          <div class="card placeholder">
            audit log not yet available — the daemon's
            <code>/api/screens/audit-log</code> surface is on the
            v1-launch checklist (task #34, BFF side pending). Once
            the daemon exposes the endpoint, every signed event the
            user has authored will land here.
          </div>
        `;
        return;
      }
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
      return;
    }
    throw e;
  }

  const entries = body.entries ?? [];
  if (!entries.length) {
    root.innerHTML = `
      <div class="card placeholder">
        no events yet${activeKindFilter ? ` for filter "${escapeHtml(activeKindFilter)}"` : ""} —
        signed actions you take (claiming a URL, granting an app,
        issuing an invite) will land here with the underlying
        envelope you can verify yourself.
      </div>
    `;
    return;
  }

  const more = body.nextCursor
    ? `<button class="secondary full-width mt-2" id="audit-log-load-more">load more</button>`
    : "";
  root.innerHTML = entries.map(entryRow).join("") + more;
  $("audit-log-load-more")?.addEventListener("click", () => {
    activeCursor = body.nextCursor ?? null;
    void renderAuditLog();
  });
  bindEntryRows(root);
}

function bindEntryRows(root) {
  root.querySelectorAll('[data-action="audit-entry"]').forEach((b) => {
    b.addEventListener("click", () => {
      const eid = b.getAttribute("data-event-id");
      if (eid) void enterAuditEntry(eid);
    });
  });
}

/**
 * Drill into a single entry. The detail surface shows the full signed
 * envelope JSON (the canonical-bytes pre-image plus the Ed25519
 * signature hex and the signer's IRK pubkey) so verification-curious
 * users can re-verify the signature against the canonical-bytes pre-image
 * with their own tool of choice.
 */
export async function enterAuditEntry(eventId) {
  show("view-audit-entry");
  const root = $("audit-entry-content");
  if (!root) return;
  root.innerHTML = '<div class="card placeholder">loading event…</div>';
  try {
    const body = await screensFetch(`/api/screens/audit-log/${encodeURIComponent(eventId)}`);
    const entry = body.entry ?? body;
    const envelope = entry.envelope ?? null;
    const canonicalBytes = entry.canonicalBytesHex ?? entry.canonicalBytes ?? "";
    root.innerHTML = `
      <div class="card">
        <div class="row"><span class="label">event id</span><span class="value text-xs">${escapeHtml(entry.eventId ?? eventId)}</span></div>
        <div class="row"><span class="label">kind</span><span class="value">${escapeHtml(kindLabel(entry.kind))}</span></div>
        <div class="row"><span class="label">at</span><span class="value">${escapeHtml(fmtDate(entry.at))}</span></div>
        <div class="row"><span class="label">actor</span><span class="value">${actorLabel(entry)}</span></div>
        ${entry.resource ? `<div class="row"><span class="label">resource</span><span class="value text-xs">${escapeHtml(entry.resource)}</span></div>` : ""}
        ${entry.signatureHex ? `<div class="row"><span class="label">signature</span><span class="value text-xs">${escapeHtml(entry.signatureHex)}</span></div>` : ""}
        ${entry.signerPubkeyHex ? `<div class="row"><span class="label">signer pubkey</span><span class="value text-xs">${escapeHtml(entry.signerPubkeyHex)}</span></div>` : ""}
        ${entry.canonicalBytesTag ? `<div class="row"><span class="label">tag</span><span class="value text-xs">${escapeHtml(entry.canonicalBytesTag)}</span></div>` : ""}
      </div>
      ${canonicalBytes ? `
        <h3 class="mt-4">Canonical bytes (pre-image)</h3>
        <div class="card">
          <pre class="audit-envelope-pre">${escapeHtml(canonicalBytes)}</pre>
        </div>
      ` : ""}
      ${envelope ? `
        <h3 class="mt-4">Signed envelope</h3>
        <div class="card">
          <pre class="audit-envelope-pre">${escapeHtml(JSON.stringify(envelope, null, 2))}</pre>
        </div>
      ` : ""}
      <div class="card placeholder mt-2">
        Verify this signature yourself: feed the canonical-bytes pre-image
        through Ed25519.verify with the signer's pubkey. The webapp
        never makes you trust its rendering — these bytes are the truth.
      </div>
    `;
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
      return;
    }
    throw e;
  }
}

export function initAuditLogView() {
  $("audit-log-back")?.addEventListener("click", () => show("view-activity"));
  $("audit-log-refresh")?.addEventListener("click", () => {
    activeCursor = null;
    renderAuditLog().catch((e) => toast(String(e), "err"));
  });
  $("audit-entry-back")?.addEventListener("click", () => enterAuditLog().catch(() => {}));
}

export async function enterAuditLog() {
  show("view-audit-log");
  activeCursor = null;
  await renderAuditLog();
}
