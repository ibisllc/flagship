// The Messages tab (docs/voici-and-messages.md §11.1) and Settings → Messages (§11.3). Text only: every value a
// visitor wrote reaches the page through textContent (escapeHtml in templates), never as HTML (§12.1).

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import { inlineConfirm, inlinePrompt } from "../lib/modal.js";
import { canSignAdminOrders } from "../lib/addServerGate.js";
import { getSession } from "../lib/state.js";
import { isUnread, publishVoiciPage } from "../lib/voiciOwner.js";
import { changeState, conversationsIn, emitWorld, onWorldChange, refreshWorld, unreadCount, visitorName, world } from "../lib/voiciWorld.js";
import { revokeSignedInSite, parseVoiciSignInLink } from "../lib/voiciSignIn.js";
import { voiciErrorText, VOICI_RULES_TEXT, VOICI_RULES_TITLE } from "../lib/voiciCopy.js";
import { keepPageHeaderFresh, renderPageHeader } from "./page-header.js";
import { checkReplies, markReplySeen } from "../lib/voiciReplies.js";
import { voiciWebOrigin } from "../lib/voiciOwner.js";

import { tr } from "../lib/i18n.js";

registerView("view-messages", { tab: "messages" });
registerView("view-messages-settings", { tab: "settings" });

let segment = "messages";
/** Replies waiting on pages this account wrote to from voi.ci: [{pageId, username, at}]. */
let replyAlerts = [];

const username = () => String(getSession()?.username ?? "").toLowerCase();


function lastLine(cv) {
  const m = cv.messages[cv.messages.length - 1];
  return m ? m.text.replace(/\s+/g, " ").slice(0, 140) : "";
}

function listHtml() {
  const list = conversationsIn(segment);
  if (!world.page && !world.conversations.length) {
    return `<div class="card placeholder" data-testid="messages-empty">${escapeHtml(tr("No messages yet. Turn on Accept messages on your page to get them."))}</div>`;
  }
  if (!list.length) {
    const text = segment === "requests" ? tr("No message requests.") : tr("No messages yet. Turn on Accept messages on your page to get them.");
    return `<div class="card placeholder" data-testid="messages-empty">${escapeHtml(text)}</div>`;
  }
  return `<div class="fs-group">${list
    .map((cv) => {
      const unread = isUnread(cv, world.state);
      const last = cv.messages[cv.messages.length - 1];
      return `
      <button type="button" class="fs-row conv-row${unread ? " is-unread" : ""}" data-conv="${escapeHtml(cv.conv)}">
        <span class="fs-row-body">
          <span class="fs-row-title" data-conv-name>${escapeHtml(visitorName(cv.pseudonymPub))}</span>
          <span class="fs-row-subtitle conv-last" data-conv-last>${escapeHtml(lastLine(cv))}</span>
        </span>
        <span class="conv-meta">
          <span class="muted-sm">${escapeHtml(last ? formatWhen(last.sentAt) : "")}</span>
          ${unread ? `<span class="conv-dot" data-conv-unread aria-label="${escapeHtml(tr("Unread"))}"></span>` : ""}
        </span>
      </button>`;
    })
    .join("")}</div>`;
}

export function renderMessages() {
  renderPageHeader($("messages-page-row"));
  // A sample account has only its example page: no conversations to list (it can't accept messages).
  for (const id of ["messages-segments", "messages-list", "messages-reply-alerts"]) $(id)?.classList.toggle("hidden", world.sample);
  document.querySelector("#view-messages > h2")?.classList.toggle("hidden", world.sample);
  if (world.sample) return;
  const requests = conversationsIn("requests").length;
  const count = $("messages-requests-count");
  if (count) count.textContent = requests ? `(${requests})` : "";
  for (const b of document.querySelectorAll("[data-messages-tab]")) b.setAttribute("aria-checked", String(b.getAttribute("data-messages-tab") === segment));
  const list = $("messages-list");
  if (!list) return;
  if (world.inboxError && !world.conversations.length) {
    list.innerHTML = `<div class="card placeholder">${escapeHtml(voiciErrorText(world.inboxError))}</div>`;
    return;
  }
  list.innerHTML = listHtml();
  list.querySelectorAll("[data-conv]").forEach((b) =>
    b.addEventListener("click", () => void import("./thread.js").then((m) => m.enterThread(b.getAttribute("data-conv")))),
  );
}

function renderReplyAlerts() {
  const root = $("messages-reply-alerts");
  if (!root) return;
  root.replaceChildren();
  for (const a of replyAlerts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fs-row voici-reply-row mt-2";
    b.setAttribute("data-reply-page", a.pageId);
    const body = document.createElement("span");
    body.className = "fs-row-body";
    const title = document.createElement("span");
    title.className = "fs-row-title";
    title.textContent = tr("You have a reply on voi.ci/{0}", a.username);
    body.appendChild(title);
    b.appendChild(body);
    b.addEventListener("click", () => {
      markReplySeen(a.pageId, a.at);
      replyAlerts = replyAlerts.filter((x) => x.pageId !== a.pageId);
      renderReplyAlerts();
      updateBadge();
      window.open(`${voiciWebOrigin()}/${a.username}`, "_blank", "noopener,noreferrer");
    });
    root.appendChild(b);
  }
}

/** On every open of the tab (no push, no background polling): replies on the pages this account wrote to. */
async function refreshReplyAlerts() {
  try {
    replyAlerts = await checkReplies();
  } catch {
    replyAlerts = [];
  }
  renderReplyAlerts();
  updateBadge();
}

export async function enterMessages() {
  show("view-messages");
  if (!world.pageLoaded) {
    $("messages-list").innerHTML = skeletonCards(2);
    $("messages-page-row").innerHTML = "";
  } else renderMessages();
  void refreshReplyAlerts();
  await refreshWorld();
  renderMessages();
}

/** Home's and Settings' way to the page: the Messages tab, scrolled to its header (§11.1). */
export async function enterPageHeader() {
  await enterMessages();
  window.scrollTo({ top: 0 });
  $("messages-page-header")?.focus({ preventScroll: true });
}

function updateBadge() {
  const badge = $("messages-tab-badge");
  if (!badge) return;
  const n = unreadCount() + replyAlerts.length;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.classList.toggle("hidden", n === 0);
}

// ── Settings → Messages ───────────────────────────────────────────────────

export async function enterMessagesSettings() {
  show("view-messages-settings");
  const root = $("messages-settings-content");
  root.innerHTML = skeletonCards(2);
  await refreshWorld();
  renderMessagesSettings();
}

function renderMessagesSettings() {
  const root = $("messages-settings-content");
  if (!root) return;
  const sites = [...world.state.signedInSites].sort((a, b) => b.at - a.at);
  const admin = canSignAdminOrders();
  root.innerHTML = `
    <h3 class="mt-2">${escapeHtml(tr("Websites you're signed in to"))}</h3>
    <div class="card stack-sm" data-testid="messages-signed-in-sites">
      ${sites.length
        ? sites
            .map(
              (s) => `<div class="row"><span>${escapeHtml(tr("A voi.ci page, since {0}", formatWhen(s.at)))}</span>
              <button type="button" class="secondary" data-site-signout="${escapeHtml(s.delegatePub)}">${escapeHtml(tr("Sign out"))}</button></div>`,
            )
            .join("")
        : `<p class="note">${escapeHtml(tr("You aren't signed in to any website."))}</p>`}
      <button type="button" class="secondary full-width" id="messages-approve-sign-in">${escapeHtml(tr("Approve a voi.ci sign-in"))}</button>
    </div>
    <h3 class="mt-3">${escapeHtml(tr("Inbox key"))}</h3>
    <div class="card stack-sm">
      <p class="note">${escapeHtml(tr("Make a new key for messages people send to your page. Messages you already have stay readable."))}</p>
      ${admin
        ? `<button type="button" class="secondary full-width" id="messages-rotate-inbox"${world.page ? "" : " disabled"}>${escapeHtml(tr("Rotate inbox key"))}</button>`
        : `<p class="note" data-testid="messages-rotate-admin-only">${escapeHtml(tr("Only an admin device can rotate the inbox key."))}</p>`}
    </div>
    <h3 class="mt-3">${escapeHtml(VOICI_RULES_TITLE())}</h3>
    <div class="card"><p class="note">${escapeHtml(VOICI_RULES_TEXT())}</p></div>`;
  root.querySelectorAll("[data-site-signout]").forEach((b) =>
    b.addEventListener("click", async () => {
      const site = world.state.signedInSites.find((s) => s.delegatePub === b.getAttribute("data-site-signout"));
      if (!site) return;
      b.disabled = true;
      try {
        await revokeSignedInSite(site, { updateState: (fn, d) => changeState(fn, d) });
        toast(tr("Signed out of that website."));
      } catch (e) {
        toast(voiciErrorText(e), "err");
      }
      renderMessagesSettings();
    }),
  );
  $("messages-approve-sign-in")?.addEventListener("click", async () => {
    const text = await inlinePrompt({
      title: tr("Approve a voi.ci sign-in"),
      message: tr("Paste the link voi.ci shows under its code."),
      placeholder: "https://…/voici-sign-in?…",
      okLabel: tr("Continue"),
      validate: (v) => (parseVoiciSignInLink(v) ? "" : tr("That isn't a voi.ci sign-in link.")),
    });
    if (text === null || text === undefined) return;
    const { enterVoiciSignIn } = await import("./voici-sign-in.js");
    await enterVoiciSignIn(parseVoiciSignInLink(text));
  });
  $("messages-rotate-inbox")?.addEventListener("click", async (ev) => {
    const ok = await inlineConfirm({
      title: tr("Rotate inbox key?"),
      message: tr("New messages will be sealed to a new key. People already writing to you keep their conversations."),
      okLabel: tr("Rotate"),
    });
    if (!ok) return;
    ev.currentTarget.disabled = true;
    try {
      world.page = await publishVoiciPage({ ops: [], rotate: true }, { published: world.page });
      emitWorld();
      toast(tr("Inbox key rotated."));
    } catch (e) {
      toast(voiciErrorText(e), "err");
    }
    renderMessagesSettings();
  });
}

export function initMessagesView() {
  for (const b of document.querySelectorAll("[data-messages-tab]")) {
    b.addEventListener("click", () => {
      segment = b.getAttribute("data-messages-tab") === "requests" ? "requests" : "messages";
      renderMessages();
    });
  }
  $("messages-settings-back")?.addEventListener("click", () => show("view-settings-tab"));
  onWorldChange(() => {
    updateBadge();
  });
  keepPageHeaderFresh(() => $("messages-page-row"));
  // Once per open of the app, after the unlock: the reply check, so the tab's badge shows it.
  let checkedOnOpen = false;
  document.addEventListener("flagship:view-shown", (ev) => {
    const id = ev.detail?.id ?? "";
    if (checkedOnOpen || /^view-(bootstrap|unlock|pin-|wizard|dock-start)/.test(id)) return;
    if (!(getSession()?.umk instanceof Uint8Array) || id === "view-messages") return;
    checkedOnOpen = true;
    void refreshReplyAlerts();
  });
}

