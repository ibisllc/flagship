// Settings → Organizations on the webapp (docs/webapp-key-custody.md item 1; docs/enterprise-accounts.md
// §7, docs/org-directory.md §7). The org seats this browser joined: each org's admins with where their
// keys live, the ceremonies waiting for this seat, people waiting to be admitted (compare the code
// first), keys to rotate after someone left, and the directory. An admin seat's signature asks for the
// passkey once per action (lib/orgSeat.js).

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { inlineConfirm } from "../lib/modal.js";
import { tr, dateLocale } from "../lib/i18n.js";
import { formatDateTime } from "../lib/dateFormat.js";
import * as os from "../lib/orgSeat.js";
import * as dc from "../lib/orgDirectoryConsole.js";
import { renderOrgPlan } from "./orgPlan.js";

registerView("view-orgs", { tab: "settings" });

/**
 * A delayed change (founder removal, recovery) counts from when Flagship saw its notice, not from the date it
 * carries: the notice's ceremony shows that observed time.
 */
function noticeSeenLine(c) {
  if (!String(c.order).startsWith("flagship/org-delayed-change/") || typeof c.openedAt !== "number") return "";
  return `<p class="note">${escapeHtml(tr("Flagship saw this notice on {0}. Its waiting period counts from then.", formatDateTime(c.openedAt)))}</p>`;
}

export const CUSTODY_BROWSER_LABEL = tr("Browser: software key, unlocked with a passkey");
export const CUSTODY_HARDWARE_LABEL = tr("Phone: hardware key");

/** One admin line. Exported for tests. */
export function adminLine(a, names) {
  const who = names?.get?.(a.seatId) ?? tr("Seat {0}", a.seatId.slice(0, 6));
  const kind = a.kind === "admin" ? tr("Admin") : a.kind === "board" ? tr("Board") : tr("Recovery");
  return `${who} · ${kind} · ${a.custody === "browser" ? CUSTODY_BROWSER_LABEL : CUSTODY_HARDWARE_LABEL}`;
}

function failText(e) {
  if (e?.userMessage) return e.userMessage;
  if (e?.code === "org-custody" || e?.code === "custody") return tr("The organization's rules need an approval from a phone's hardware key for this.");
  return tr("That didn't go through. Try again.");
}

async function renderSeat(seat, host) {
  const call = os.orgApi({ seat });
  const umk = getSession()?.umk;
  let snap;
  try {
    snap = await os.orgSnapshot(call, seat.orgId, seat.genesisHash);
  } catch {
    host.innerHTML = `<p class="note">${escapeHtml(tr("{0} couldn't be checked. Try again later.", seat.orgName || seat.orgId))}</p>`;
    return;
  }
  const granted = snap.book.seats.has(seat.seatId);
  let names = null;
  if (granted && umk) {
    try {
      const view = await os.readDirectory(seat, snap, { umk });
      if (view) names = new Map([...view.bySeat].map(([k, v]) => [k, v.name ?? v.pseudonym ?? ""]));
    } catch {
      names = null;
    }
  }
  const admins = os.adminsWithCustody(snap).map((a) => `<li>${escapeHtml(adminLine(a, names))}</li>`).join("");
  const isAdminSeat = !!seat.adminBinding && granted;
  const ceremonies = isAdminSeat
    ? snap.ceremonies.filter((c) => !(c.approvals ?? []).some((a) => a.seatId === seat.seatId))
    : [];
  const joins = isAdminSeat ? os.pendingJoins(snap) : [];
  const invited = isAdminSeat ? os.pendingInvites(snap) : [];
  const people = names ? [...names.values()].filter(Boolean) : [];
  const isOrgAdmin = granted && !!seat.adminBinding && snap.state.current.admins.some((a) => a.seatId === seat.seatId && a.kind === "admin");
  host.innerHTML = `
    <p class="fs-row-title">${escapeHtml(snap.name || seat.orgName)}</p>
    <p class="note">${escapeHtml(granted ? tr("You are in as {0}.", seat.pseudonym || tr("a member")) : tr("Waiting for an admin to let you in. Your code: {0}", seat.code ?? ""))}</p>
    ${seat.custody === "browser" ? `<p class="note">${escapeHtml(tr("This seat's admin key: {0}", CUSTODY_BROWSER_LABEL))}</p>` : ""}
    <p class="fs-detail-label">${escapeHtml(tr("Admins"))}</p><ul>${admins}</ul>
    ${ceremonies.length ? `<p class="fs-detail-label">${escapeHtml(tr("Waiting for your approval"))}</p>` + ceremonies.map((c) => `<div class="stack-sm"><p class="note">${escapeHtml(c.order.split("|")[0])}</p>${noticeSeenLine(c)}<button data-org-approve="${escapeHtml(c.sha256)}">${escapeHtml(tr("Approve"))}</button></div>`).join("") : ""}
    ${joins.length ? `<p class="fs-detail-label">${escapeHtml(tr("Waiting to join"))}</p>` + joins.map((j) => `<div class="stack-sm"><p class="note">${escapeHtml(tr("Code {0}", os.joinCode(j)))}${j.custody === "browser" ? " · " + escapeHtml(CUSTODY_BROWSER_LABEL) : ""}</p><button data-org-admit="${escapeHtml(j.seatId)}">${escapeHtml(tr("The codes match: let them in"))}</button><button class="secondary" data-org-mismatch="${escapeHtml(j.seatId)}">${escapeHtml(tr("The codes don't match"))}</button></div>`).join("") : ""}
    ${invited.length ? `<p class="fs-detail-label">${escapeHtml(tr("Invited, not accepted yet"))}</p>` + invited.map((i) => `<div class="stack-sm"><p class="note">${escapeHtml(names?.get?.(i.seatId) || tr("Seat {0}", i.seatId.slice(0, 6)))}</p><button class="secondary" data-org-withdraw="${escapeHtml(i.seatId)}">${escapeHtml(tr("Withdraw invitation"))}</button></div>`).join("") : ""}
    ${isAdminSeat ? `<button class="secondary" data-org-rotate>${escapeHtml(tr("Rotate keys"))}</button>` : ""}
    ${people.length ? `<p class="fs-detail-label">${escapeHtml(tr("People"))}</p><ul>${people.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}
    <div data-org-plan></div>
    <div data-org-directory></div>
    <button class="secondary" data-org-forget>${escapeHtml(tr("Remove from this browser"))}</button>`;

  const act = async (fn, done) => {
    try {
      const r = await fn();
      toast(typeof done === "function" ? done(r) : done, "ok");
    } catch (e) {
      toast(failText(e), "err");
    }
    await renderSeat(seat, host);
  };
  for (const b of host.querySelectorAll("[data-org-approve]")) {
    const c = snap.ceremonies.find((x) => x.sha256 === b.dataset.orgApprove);
    b.addEventListener("click", () => act(() => os.approveCeremony(seat, snap, c, { umk: getSession().umk }), tr("Approved.")));
  }
  for (const b of host.querySelectorAll("[data-org-admit]")) {
    const j = joins.find((x) => x.seatId === b.dataset.orgAdmit);
    b.addEventListener("click", async () => {
      const ok = await inlineConfirm({ title: tr("Let them in?"), message: tr("Only if the code on their screen is {0}.", os.joinCode(j)), okLabel: tr("Let them in") });
      if (ok) await act(() => os.admit(seat, snap, j, { umk: getSession().umk }), (r) => (r === "admitted" ? tr("Admitted.") : tr("Another admin needs to approve this before it takes effect.")));
    });
  }
  const withdraw = (seatId, title, message) => async () => {
    const ok = await inlineConfirm({ title, message, okLabel: tr("Withdraw invitation"), danger: true });
    if (ok) await act(() => os.withdrawInvite(seat, snap, seatId, { umk: getSession().umk }), tr("Invitation withdrawn."));
  };
  for (const b of host.querySelectorAll("[data-org-mismatch]")) {
    b.addEventListener("click", withdraw(b.dataset.orgMismatch, tr("The codes don't match"), tr("Someone other than the person you invited accepted this invitation. Withdraw it and send them a new one.")));
  }
  for (const b of host.querySelectorAll("[data-org-withdraw]")) {
    b.addEventListener("click", withdraw(b.dataset.orgWithdraw, tr("Withdraw this invitation?"), tr("The link stops working, and nobody who accepted it is let in.")));
  }
  host.querySelector("[data-org-rotate]")?.addEventListener("click", () =>
    act(() => os.rotatePending(seat, snap, { umk: getSession().umk }), (n) => (n ? tr("Rotated {0} keys.", n) : tr("Nothing to rotate."))),
  );
  const planHost = host.querySelector("[data-org-plan]");
  if (planHost && granted) renderOrgPlan(seat, snap, planHost, { isOrgAdmin, refresh: () => renderSeat(seat, host) }).catch(() => {});
  const dirHost = host.querySelector("[data-org-directory]");
  if (dirHost && umk) {
    if (isOrgAdmin) renderConsole(seat, snap, dirHost, () => renderSeat(seat, host)).catch(() => {});
    else if (granted) renderSharedWith(seat, snap, dirHost).catch(() => {});
  }
  host.querySelector("[data-org-forget]")?.addEventListener("click", async () => {
    const ok = await inlineConfirm({ title: tr("Remove this organization from this browser?"), message: tr("Your seat stays. Join again from an invitation to use it here."), okLabel: tr("Remove"), danger: true });
    if (!ok) return;
    os.forgetSeat(seat.orgId, seat.seatId);
    await render();
  });
}

/* ---------- the directory (docs/org-directory.md) ---------- */

export function standingText(st) {
  if (!st || st.state === "ok") return tr("Running");
  if (st.state === "needs-reapproval") return tr("The admin who approved it left. It stops on {0} unless an admin approves it again.", new Date(st.suspendAt ?? Date.now()).toLocaleDateString(dateLocale()));
  return tr("Stopped: approve it again to restart it.");
}

function proposalText(p) {
  const who = p.entry?.pseudonym || tr("someone");
  if (p.kind === "invite") return tr("Invite {0} (from the {1} directory)", who, p.connectorKind.toUpperCase());
  if (p.kind === "offboard") return tr("Remove {0} (they left the directory)", who);
  if (p.kind === "entry-update") return tr("Update {0}'s details", who);
  return tr("Change {0}'s role", who);
}

function directoryFail(e) {
  if (e?.userMessage) return e.userMessage;
  switch (e?.code) {
    case "box-key-missing":
      return tr("That server hasn't announced its key yet. Try again in a few minutes.");
    case "ldap-form":
      return tr("Fill in an ldaps:// address, the bind account, its password and the base DN.");
    case "mapping-line":
      return tr("Each line reads like Sales = member, Ops = server-admin home.acme.flagship.services or Wiki = app-admin acme--wiki.");
    case "needs-new-invite":
      return tr("An admin role needs this person to accept a new invitation. Decline this and invite them again.");
    case "name-missing":
      return tr("Give this person a name the organization will know them by.");
    case "org-seat-limit":
      return tr("Your plan has no free seats. Remove someone or add seats first.");
    default:
      return tr("That didn't go through. Try again.");
  }
}

function shownOnce(box, title, lines) {
  box.innerHTML = `<div class="card stack-sm" data-org-shown-once><p class="weight-600">${escapeHtml(title)}</p>${lines.map((l) => `<p class="mono">${escapeHtml(l)}</p>`).join("")}<p class="muted">${escapeHtml(tr("Copy it now: it isn't shown again."))}</p></div>`;
}

async function renderSharedWith(seat, snap, box) {
  const c = await dc.loadSlice(seat, snap, { umk: getSession().umk }).catch(() => null);
  if (!c) return;
  box.innerHTML = `<p class="fs-detail-label">${escapeHtml(tr("Shared with"))}</p>
    <ul>${c.entries.map((e) => `<li>${escapeHtml(e.pseudonym)}</li>`).join("")}</ul>
    ${c.servers.length ? `<p class="note">${escapeHtml(tr("Servers: {0}", c.servers.join(", ")))}</p>` : ""}`;
}

async function renderConsole(seat, snap, box, refresh) {
  const umk = getSession().umk;
  const c = await dc.loadConsole(seat, snap, { umk });
  const servers = [...c.plan.ctx.servers].sort();
  const serverOptions = servers.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  box.innerHTML = `
    <p class="fs-detail-label">${escapeHtml(tr("Invite someone"))}</p>
    <input id="org-inv-name" placeholder="${escapeHtml(tr("The name the organization will know them by"))}">
    <select id="org-inv-role"><option value="member">${escapeHtml(tr("Member"))}</option><option value="server-admin">${escapeHtml(tr("Admin of a server"))}</option><option value="app-admin">${escapeHtml(tr("Admin of an app"))}</option></select>
    <input id="org-inv-target" placeholder="${escapeHtml(tr("Server or app (for an admin role)"))}">
    <button data-org-invite>${escapeHtml(tr("Make the invitation"))}</button>
    <div data-org-out></div>
    ${c.proposals.length ? `<p class="fs-detail-label">${escapeHtml(tr("Proposed by the directory"))}</p>` + c.proposals.map((p, i) => `<div class="stack-sm"><p class="note">${escapeHtml(proposalText(p))}</p><button data-org-prop-ok="${i}">${escapeHtml(p.kind === "role-change" ? tr("Change it") : tr("Do it"))}</button> <button class="secondary" data-org-prop-no="${i}">${escapeHtml(tr("Decline"))}</button></div>`).join("") : ""}
    <p class="fs-detail-label">${escapeHtml(tr("Directory connectors"))}</p>
    ${c.connectors.map((x, i) => {
      const k = x.connector;
      const retired = k.status === "retired";
      return `<div class="stack-sm" data-org-conn="${i}"><p class="note">${escapeHtml(`${k.kind.toUpperCase()} · ${k.serverDomain} · ${k.status === "paused" ? tr("Paused") : retired ? tr("Retired") : standingText(x.standing)}`)}</p>
        ${retired ? "" : `${x.standing && x.standing.state !== "ok" ? `<button data-org-conn-reapprove="${i}">${escapeHtml(tr("Approve again"))}</button>` : ""}
        <button class="secondary" data-org-conn-pause="${i}">${escapeHtml(k.status === "paused" ? tr("Resume") : tr("Pause"))}</button>
        ${k.kind === "scim" ? `<button class="secondary" data-org-conn-token="${i}">${escapeHtml(tr("New SCIM token"))}</button>` : ""}
        <button class="secondary" data-org-conn-retire="${i}">${escapeHtml(tr("Retire"))}</button>
        <textarea data-org-conn-map="${i}" rows="3" placeholder="${escapeHtml(tr("One line per group, like Sales = member, Ops = server-admin home.acme.flagship.services or Wiki = app-admin acme--wiki"))}">${escapeHtml(dc.mappingToLines(x.mapping))}</textarea>
        <label><input type="checkbox" data-org-conn-default="${i}" ${x.mapping ? ((x.mapping.defaultRoles ?? []).length ? "checked" : "") : "checked"}> ${escapeHtml(tr("Propose people in no listed group as members"))}</label>
        <button class="secondary" data-org-conn-savemap="${i}">${escapeHtml(tr("Save the mapping"))}</button>`}</div>`;
    }).join("")}
    ${servers.length ? `<select id="org-conn-server">${serverOptions}</select>
    <button class="secondary" data-org-add-scim>${escapeHtml(tr("Add a SCIM connector"))}</button>
    <details><summary>${escapeHtml(tr("Add an LDAP connector"))}</summary>
      <input id="org-ldap-url" value="ldaps://"><input id="org-ldap-bind" placeholder="${escapeHtml(tr("Bind account"))}">
      <input id="org-ldap-pass" type="password" placeholder="${escapeHtml(tr("Password"))}"><input id="org-ldap-base" placeholder="${escapeHtml(tr("Base DN"))}">
      <input id="org-ldap-filter" placeholder="${escapeHtml(tr("User filter (optional)"))}">
      <label><input type="checkbox" id="org-ldap-openldap"> ${escapeHtml(tr("OpenLDAP (not Active Directory)"))}</label>
      <button class="secondary" data-org-add-ldap>${escapeHtml(tr("Add"))}</button>
    </details>` : ""}
    <button class="secondary" data-org-slices>${escapeHtml(tr("Update what members see"))}</button>`;

  const out = box.querySelector("[data-org-out]");
  const act = async (fn, done) => {
    try {
      const r = await fn();
      if (done) toast(typeof done === "function" ? done(r) : done, "ok");
      return r;
    } catch (e) {
      toast(directoryFail(e), "err");
      return null;
    }
  };
  const again = () => refresh();
  box.querySelector("[data-org-invite]")?.addEventListener("click", async () => {
    const role = $("org-inv-role").value;
    const target = $("org-inv-target").value.trim().toLowerCase();
    const roles = role === "server-admin" ? [{ role: "server-admin", servers: [target] }] : role === "app-admin" ? [{ role: "service-admin", apps: [target] }] : [{ role: "member" }];
    const r = await act(() => dc.invite(seat, snap, c, { name: $("org-inv-name").value, roles, umk }));
    if (r) shownOnce(out, tr("Share this link with them"), [r.link]);
  });
  for (const b of box.querySelectorAll("[data-org-prop-ok]")) {
    const p = c.proposals[Number(b.dataset.orgPropOk)];
    b.addEventListener("click", async () => {
      const r = await act(() => dc.approveProposal(seat, snap, c, p, { umk }));
      if (r?.link) shownOnce(out, tr("Invitation made. Share the link with them."), [r.link]);
      else if (r) {
        toast(r.ceremony ? tr("Another admin needs to approve this before it takes effect.") : tr("Done."), "ok");
        await again();
      }
    });
  }
  for (const b of box.querySelectorAll("[data-org-prop-no]")) {
    const p = c.proposals[Number(b.dataset.orgPropNo)];
    b.addEventListener("click", async () => {
      if (await act(() => dc.declineProposal(seat, snap, p, { umk }), tr("Declined."))) await again();
    });
  }
  const conn = (attr) => [...box.querySelectorAll(`[${attr}]`)].map((b) => [b, c.connectors[Number(b.getAttribute(attr))]]);
  for (const [b, x] of conn("data-org-conn-reapprove")) b.addEventListener("click", async () => { await act(() => dc.updateConnector(seat, snap, c, x.connector.connectorId, { umk }), tr("Approved again.")); await again(); });
  for (const [b, x] of conn("data-org-conn-pause")) b.addEventListener("click", async () => { await act(() => dc.updateConnector(seat, snap, c, x.connector.connectorId, { umk, status: x.connector.status === "paused" ? "active" : "paused" })); await again(); });
  for (const [b, x] of conn("data-org-conn-retire")) {
    b.addEventListener("click", async () => {
      const ok = await inlineConfirm({ title: tr("Retire this connector?"), message: tr("It stops for good. Its proposals stay as they are."), okLabel: tr("Retire"), danger: true });
      if (ok) { await act(() => dc.updateConnector(seat, snap, c, x.connector.connectorId, { umk, status: "retired" })); await again(); }
    });
  }
  for (const [b, x] of conn("data-org-conn-token")) {
    b.addEventListener("click", async () => {
      const r = await act(() => dc.rotateScimToken(seat, snap, c, x.connector.connectorId, { umk }));
      if (r) shownOnce(out, tr("The SCIM address and token"), [r.url, r.token]);
    });
  }
  for (const [b, x] of conn("data-org-conn-savemap")) {
    const i = b.getAttribute("data-org-conn-savemap");
    b.addEventListener("click", async () => {
      await act(() => {
        const base = x.mapping ?? dc.defaultMapping(x.connector.kind);
        const m = dc.mappingFromLines(base, box.querySelector(`[data-org-conn-map="${i}"]`).value, box.querySelector(`[data-org-conn-default="${i}"]`).checked);
        return dc.updateConnector(seat, snap, c, x.connector.connectorId, { umk, mapping: m });
      }, tr("Saved. The server uses it at its next check."));
    });
  }
  box.querySelector("[data-org-add-scim]")?.addEventListener("click", async () => {
    const r = await act(() => dc.addScimConnector(seat, snap, c, { serverDomain: $("org-conn-server").value, umk }));
    if (r) shownOnce(out, tr("The SCIM address and token"), [r.url, r.token]);
  });
  box.querySelector("[data-org-add-ldap]")?.addEventListener("click", async () => {
    const form = { url: $("org-ldap-url").value, bindDn: $("org-ldap-bind").value, password: $("org-ldap-pass").value, baseDn: $("org-ldap-base").value, userFilter: $("org-ldap-filter").value, openLdap: $("org-ldap-openldap").checked };
    if (await act(() => dc.addLdapConnector(seat, snap, c, { serverDomain: $("org-conn-server").value, form, umk }), tr("Saved. The server reads the directory within 15 minutes."))) await again();
  });
  box.querySelector("[data-org-slices]")?.addEventListener("click", async () => {
    await act(() => dc.publishSlices(seat, snap, c, { umk }), (n) => (n ? tr("Updated what {0} members see.", n) : tr("Members already see the latest.")));
  });
}

async function render() {
  const host = $("orgs-content");
  if (!host) return;
  const seats = os.listSeats();
  if (!seats.length) {
    host.innerHTML = `<p class="note">${escapeHtml(tr("This browser isn't in any organization. Open an invitation link to join."))}</p>`;
    return;
  }
  host.innerHTML = seats.map((s, i) => `<div class="fs-card" data-org-seat="${i}"><p class="note">${escapeHtml(tr("Loading…"))}</p></div>`).join("");
  await Promise.all(seats.map((s, i) => renderSeat(s, host.querySelector(`[data-org-seat="${i}"]`))));
}

export function initOrgsView() {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-orgs") render().catch(() => {});
  });
  $("orgs-back")?.addEventListener("click", () => show("view-settings-tab"));
}

export { render as renderOrgs };
