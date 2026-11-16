// An organization's seat invitation opened in the browser (docs/enterprise-accounts.md §7). This page
// shows who invited the person under which name and role. The person joins on this browser (its seat
// admin key sealed under a passkey, docs/webapp-key-custody.md item 1, lib/orgSeat.js) and shows the
// admin the 6-digit code, or opens the same link on their phone (QR code and a copyable link).

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import { formatDateTime } from "../lib/dateFormat.js";
import { loadOrgInvite } from "../lib/orgJoin.js";
import { tr } from "../lib/i18n.js";
import { getSession, adminKeyLabel } from "../lib/state.js";
import { acceptOrgInvite } from "../lib/orgSeat.js";

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
      ${getSession()?.umk ? `<button type="button" id="org-join-here" data-testid="org-join-here">${escapeHtml(tr("Join on this browser"))}</button>
      <p class="muted">${escapeHtml(inv.roles.some((r) => r.role !== "member") ? tr("An admin role makes a key for this browser, protected by a passkey. Admins see it as \"Browser: software key, unlocked with a passkey\".") : tr("You join as a member with your account's key."))}</p>` : `<p>${escapeHtml(tr("Unlock the webapp to join on this browser."))}</p>`}
      <p>${escapeHtml(tr("Or open this link on your phone to join there."))}</p>
      <div class="share-qr" data-org-join-qr></div>
      <p class="muted">${escapeHtml(tr("Valid until {0}", formatDateTime(inv.expiresAt)))}</p>
      <button type="button" class="secondary" id="org-join-copy">${escapeHtml(tr("Copy link"))}</button>`}
    </div>`;
  if (inv.accepted) return;
  $("org-join-copy").addEventListener("click", () => void navigator.clipboard?.writeText(link.link));
  $("org-join-here")?.addEventListener("click", async (ev) => {
    ev.currentTarget.disabled = true;
    const s = getSession();
    try {
      const { code } = await acceptOrgInvite(link, { umk: s.umk, userName: adminKeyLabel(s.username), deps: deps.orgDeps ?? {} });
      box.innerHTML = `<div class="card stack-sm" data-testid="org-join-done">
        <p class="weight-600">${escapeHtml(tr("Show this code to the admin who invited you"))}</p>
        <p class="weight-600" data-testid="org-join-code">${escapeHtml(`${code.slice(0, 3)} ${code.slice(3)}`)}</p>
        <p class="muted">${escapeHtml(tr("They let you in once the code on their screen matches. Your organization is in Settings, Organizations."))}</p>
      </div>`;
    } catch (e) {
      ev.currentTarget.disabled = false;
      box.insertAdjacentHTML("beforeend", `<p class="err-text" data-testid="org-join-failed">${escapeHtml(e?.userMessage ?? tr("That didn't go through. Try again."))}</p>`);
    }
  });
  try {
    const m = await import("/qrEncoder.js");
    box.querySelector("[data-org-join-qr]").innerHTML = m.renderQrSvg(link.link, { size: 200, foreground: "#0f172a", background: "#ffffff" });
  } catch {
    /* the link button still works */
  }
}
