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
import { tr } from "../lib/i18n.js";
import * as os from "../lib/orgSeat.js";

registerView("view-orgs", { tab: "settings" });

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
  const call = os.orgApi();
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
  const people = names ? [...names.values()].filter(Boolean) : [];
  host.innerHTML = `
    <p class="fs-row-title">${escapeHtml(snap.name || seat.orgName)}</p>
    <p class="note">${escapeHtml(granted ? tr("You are in as {0}.", seat.pseudonym || tr("a member")) : tr("Waiting for an admin to let you in. Your code: {0}", seat.code ?? ""))}</p>
    ${seat.custody === "browser" ? `<p class="note">${escapeHtml(tr("This seat's admin key: {0}", CUSTODY_BROWSER_LABEL))}</p>` : ""}
    <p class="fs-detail-label">${escapeHtml(tr("Admins"))}</p><ul>${admins}</ul>
    ${ceremonies.length ? `<p class="fs-detail-label">${escapeHtml(tr("Waiting for your approval"))}</p>` + ceremonies.map((c) => `<div class="stack-sm"><p class="note">${escapeHtml(c.order.split("|")[0])}</p><button data-org-approve="${escapeHtml(c.sha256)}">${escapeHtml(tr("Approve"))}</button></div>`).join("") : ""}
    ${joins.length ? `<p class="fs-detail-label">${escapeHtml(tr("Waiting to join"))}</p>` + joins.map((j) => `<div class="stack-sm"><p class="note">${escapeHtml(tr("Code {0}", os.joinCode(j)))}${j.custody === "browser" ? " · " + escapeHtml(CUSTODY_BROWSER_LABEL) : ""}</p><button data-org-admit="${escapeHtml(j.seatId)}">${escapeHtml(tr("The codes match: let them in"))}</button></div>`).join("") : ""}
    ${isAdminSeat ? `<button class="secondary" data-org-rotate>${escapeHtml(tr("Rotate keys"))}</button>` : ""}
    ${people.length ? `<p class="fs-detail-label">${escapeHtml(tr("People"))}</p><ul>${people.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}
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
  host.querySelector("[data-org-rotate]")?.addEventListener("click", () =>
    act(() => os.rotatePending(seat, snap, { umk: getSession().umk }), (n) => (n ? tr("Rotated {0} keys.", n) : tr("Nothing to rotate."))),
  );
  host.querySelector("[data-org-forget]")?.addEventListener("click", async () => {
    const ok = await inlineConfirm({ title: tr("Remove this organization from this browser?"), message: tr("Your seat stays. Join again from an invitation to use it here."), okLabel: tr("Remove"), danger: true });
    if (!ok) return;
    os.forgetSeat(seat.orgId, seat.seatId);
    await render();
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
