// An organization's seat invitation opened in the browser (docs/enterprise-accounts.md §7). The
// person accepts on their phone (the seat's keys live only there); this page shows who invited them
// under which name and role, and hands the same link over as a QR code and a copyable link.

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import { formatDateTime } from "../lib/dateFormat.js";
import { loadOrgInvite } from "../lib/orgJoin.js";
import { tr } from "../lib/i18n.js";

registerView("view-org-join", { tab: "settings" });

function roleText(roles) {
  const lines = [];
  for (const r of roles) {
    if (r.role === "server-admin") lines.push(r.servers === "*" ? tr("Admin of every server") : tr("Admin of {0}", r.servers.join(", ")));
    else if (r.role === "service-admin") lines.push(tr("Admin of the app {0}", r.apps.join(", ")));
    else if (r.role === "member") lines.push(tr("Member"));
  }
  return lines.length ? lines.join(" · ") : tr("Member");
}

function errorText(e) {
  if (e?.code === "org-invite-expired") return tr("This invitation has run out. Ask for a new one.");
  return tr("This invitation couldn't be opened. Check the link and try again.");
}

/** Shows a parsed org-join link (lib/orgJoin.js parseOrgJoinLink). `deps.fetchImpl` is a test seam. */
export async function enterOrgJoin(link, deps = {}) {
  show("view-org-join");
  const box = $("org-join-content");
  box.innerHTML = `<div class="card placeholder">${escapeHtml(tr("Checking the invitation…"))}</div>`;
  let inv;
  try {
    inv = await loadOrgInvite(link, deps.fetchImpl);
  } catch (e) {
    box.innerHTML = `<div class="card"><p data-testid="org-join-error">${escapeHtml(errorText(e))}</p></div>`;
    return;
  }
  box.innerHTML = `
    <div class="card stack-sm" data-testid="org-join-card">
      <p class="weight-600" data-testid="org-join-title">${escapeHtml(tr("{0} invited you to join as {1}", inv.orgName, inv.pseudonym))}</p>
      <p data-testid="org-join-role">${escapeHtml(roleText(inv.roles))}</p>
      <p class="muted">${escapeHtml(tr("The organization knows you only by this name. It can't see your own account or your servers."))}</p>
      ${inv.accepted ? `<p data-testid="org-join-accepted">${escapeHtml(tr("This invitation was already accepted."))}</p>` : `
      <p>${escapeHtml(tr("Open this link on your phone to join. Joining signs with keys only the Flagship app on your phone holds."))}</p>
      <div class="share-qr" data-org-join-qr></div>
      <p class="muted">${escapeHtml(tr("Valid until {0}", formatDateTime(inv.expiresAt)))}</p>
      <button type="button" class="secondary" id="org-join-copy">${escapeHtml(tr("Copy link"))}</button>`}
    </div>`;
  if (inv.accepted) return;
  $("org-join-copy").addEventListener("click", () => void navigator.clipboard?.writeText(link.link));
  try {
    const m = await import("/qrEncoder.js");
    box.querySelector("[data-org-join-qr]").innerHTML = m.renderQrSvg(link.link, { size: 200, foreground: "#0f172a", background: "#ffffff" });
  } catch {
    /* the link button still works */
  }
}
