// The Social tab (docs/social-tab.md, docs/social-tabs.md, docs/voici-and-messages.md §11): the title row ("Your
// page", the Public switch, Social options), Profile / Inbox / Requests with their red counts, the conversations, the
// round call button that opens Calls, and the websites this account is signed in to (Social options).
// Text only: every value a visitor wrote reaches the page through textContent (escapeHtml in templates), never as
// HTML (§12.1).

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import { inlinePrompt } from "../lib/modal.js";
import { getSession } from "../lib/state.js";
import { isUnread } from "../lib/voiciOwner.js";
import { changeState, conversationsIn, onWorldChange, refreshWorld, visitorName, world } from "../lib/voiciWorld.js";
import { revokeSignedInSite, parseVoiciSignInLink } from "../lib/voiciSignIn.js";
import { voiciErrorText, VOICI_PUBLISH_ADMIN_ONLY } from "../lib/voiciCopy.js";
import { canPublishPage, editorModel, pageUsername } from "../lib/voiciPageControl.js";
import { moreHorizontalIcon } from "../lib/icons.js";
import { avatarUrl, displayUrl, publicSwitchHtml, renderSamplePage, wirePublicSwitches } from "./page-header.js";
import { isEditingField, openPageOptions, renderBar, renderProfile, resetProfileEdit } from "./page-editor.js";
import { checkReplies, markReplySeen, visitedPages } from "../lib/voiciReplies.js";
import { callButtons } from "./calls.js";
import { callHistory } from "../lib/voiciCallOut.js";
import { callsSeenAt, markProfileSeen, socialCounts, unseenMissed } from "../lib/socialCounts.js";

import { voiciWebOrigin } from "../lib/voiciOwner.js";

import { tr, trn } from "../lib/i18n.js";

registerView("view-messages", { tab: "messages" });
registerView("view-signed-in-sites", { tab: "messages" });

/** Which side of the tab shows: "profile", "inbox" or "requests". */
let side = "profile";
const SIDES = ["profile", "inbox", "requests"];
/** Replies waiting on pages this account wrote to from voi.ci: [{pageId, username, at}]. */
let replyAlerts = [];

function lastLine(cv) {
  const m = cv.messages[cv.messages.length - 1];
  return m ? m.text.replace(/\s+/g, " ").slice(0, 140) : "";
}

const EMPTY_MESSAGES = () =>
  world.page?.acceptsMessages === 1
    ? tr("No messages yet. People who sign in on your page can write to you here.")
    : tr("No messages yet. Turn on Accept messages in Social options to get them.");

function listHtml() {
  const list = conversationsIn(side === "requests" ? "requests" : "messages");
  if (!list.length) {
    const text = side === "requests" ? tr("No message requests.") : EMPTY_MESSAGES();
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

/** The title row: "Your page" (or "Inbox", "Requests"), voi.ci/<u>, Public / Not public with the switch, and ⋯. */
function renderHead() {
  const root = $("social-head");
  if (!root) return;
  const on = Boolean(world.page);
  root.innerHTML = `
    <div class="social-title-row">
      <div class="social-title-text">
        <h2 id="social-title" data-testid="social-title"></h2>
        <span class="muted-sm mono" data-testid="social-address"></span>
      </div>
      ${
        world.sample
          ? ""
          : `<div class="social-actions">
        <span class="social-status" id="social-public-label" data-testid="messages-page-status">${escapeHtml(on ? tr("Public") : tr("Not public"))}</span>
        ${publicSwitchHtml("page-public-switch", { labelledBy: "social-public-label" })}
        <button type="button" class="social-more" id="page-options" aria-label="${escapeHtml(tr("Social options"))}"><span class="icon" aria-hidden="true">${moreHorizontalIcon}</span></button>
      </div>`
      }
    </div>`;
  root.querySelector("#social-title").textContent = world.sample || side === "profile" ? tr("Your page") : side === "inbox" ? tr("Inbox") : tr("Requests");
  root.querySelector("[data-testid=social-address]").textContent = displayUrl();
  $("page-options")?.addEventListener("click", () => openPageOptions());
  wirePublicSwitches(root);
}

function renderNotes() {
  const root = $("social-notes");
  if (!root) return;
  const lines = [];
  if (world.sample) {
    root.replaceChildren();
    return;
  }
  if (world.pageError && !world.page) lines.push(`<p class="note" data-testid="ph-page-error">${escapeHtml(tr("Couldn't check your page."))}</p>`);
  if (!canPublishPage()) lines.push(`<p class="note" data-testid="page-admin-only">${escapeHtml(VOICI_PUBLISH_ADMIN_ONLY())}</p>`);
  root.innerHTML = lines.join("");
}

function renderSides() {
  const profile = side === "profile" || world.sample;
  $("social-switch")?.classList.toggle("hidden", world.sample);
  $("social-call-button")?.classList.toggle("hidden", world.sample);
  for (const b of document.querySelectorAll("[data-social-side]")) b.setAttribute("aria-checked", String(b.getAttribute("data-social-side") === (profile ? "profile" : side)));
  $("social-profile")?.classList.toggle("hidden", !profile);
  $("social-messages")?.classList.toggle("hidden", profile);
  if (!profile) $("social-compact")?.classList.add("hidden");
  renderCounts();
}

/** The four red counts (docs/social-tabs.md) and their total on the Social tab. */
export function currentCounts() {
  if (world.sample) return socialCounts();
  const inbox = conversationsIn("messages");
  return socialCounts({
    inboxUnread: inbox.filter((cv) => isUnread(cv, world.state)).length,
    requests: conversationsIn("requests").length,
    replyAlerts: replyAlerts.length,
    missedCalls: unseenMissed(callHistory(world.missedCalls), callsSeenAt()),
  });
}

function renderCounts() {
  const c = currentCounts();
  const put = (id, n) => {
    const el = $(id);
    if (!el) return;
    el.textContent = n > 99 ? "99+" : n ? String(n) : "";
    el.setAttribute("aria-label", n ? trn(n, "{0} new item", "{0} new items") : "");
  };
  put("social-count-profile", c.profile);
  put("social-count-inbox", c.inbox);
  put("social-count-requests", c.requests);
  put("social-count-calls", c.calls);
  const fab = $("social-call-button");
  if (fab) fab.setAttribute("aria-label", c.calls ? tr("Calls, {0}", trn(c.calls, "{0} new item", "{0} new items")) : tr("Calls"));
  updateBadge(c);
}

/** The page photo and name, pinned at the top once the profile box has scrolled away. */
let compactWatch = null;
function watchCompactHeader() {
  compactWatch?.disconnect();
  compactWatch = null;
  const head = document.querySelector("#social-profile .vp-head");
  const bar = $("social-compact");
  if (!head || !bar || typeof IntersectionObserver !== "function") return;
  const p = editorModel().merged.profile;
  bar.replaceChildren();
  const url = avatarUrl(p.avatar);
  if (url) {
    const img = document.createElement("img");
    img.className = "social-compact-avatar";
    img.alt = "";
    img.src = url;
    bar.appendChild(img);
  }
  const name = document.createElement("strong");
  name.textContent = p.displayName || pageUsername();
  bar.appendChild(name);
  compactWatch = new IntersectionObserver(([e]) => {
    const away = !e.isIntersecting && e.boundingClientRect.bottom < (e.rootBounds?.top ?? 0) + 1;
    bar.classList.toggle("hidden", !away || side !== "profile");
  });
  compactWatch.observe(head);
}

/** Draws the whole tab. */
export function renderMessages() {
  renderHead();
  renderNotes();
  renderSides();
  if (world.sample) {
    renderSamplePage($("social-profile"));
    $("pe-bar-slot")?.replaceChildren();
    return;
  }
  if (side === "profile") {
    renderProfile();
    watchCompactHeader();
    markProfileSeen();
  } else renderBar();
  renderReplyAlerts();
  renderList();
}

function renderList() {
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
  // A caller who revealed who they are: "Display Name (username)" on the row, with the unchecked-name info beside it.
  void import("./thread.js").then(({ revealOf, chosenNameInfo }) => {
    for (const row of list.querySelectorAll("[data-conv]")) {
      const cv = world.conversations.find((c) => c.conv === row.getAttribute("data-conv"));
      const r = cv ? revealOf(cv) : null;
      if (!r) continue;
      const tag = document.createElement("span");
      tag.className = "reveal-pill-text";
      tag.setAttribute("data-testid", "reveal-pill-row");
      tag.textContent = r.displayName ? tr("{0} ({1})", r.displayName, r.username) : r.username;
      row.querySelector(".fs-row-body")?.appendChild(tag);
      if (r.displayName) {
        const info = document.createElement("span");
        info.setAttribute("role", "button");
        info.tabIndex = 0;
        info.className = "icon-btn";
        info.setAttribute("aria-label", tr("About this name"));
        info.textContent = "ⓘ";
        const show = (e) => {
          e.stopPropagation();
          void chosenNameInfo();
        };
        info.addEventListener("click", show);
        info.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && show(e));
        tag.appendChild(info);
      }
    }
  });
}

function renderReplyAlerts() {
  const root = $("messages-reply-alerts");
  if (!root) return;
  root.replaceChildren();
  if (side !== "inbox") return;
  for (const a of replyAlerts) {
    const line = document.createElement("div");
    line.className = "row";
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
      renderCounts();
      window.open(`${voiciWebOrigin()}/${a.username}`, "_blank", "noopener,noreferrer");
    });
    line.append(b, callButtons({ pageId: a.pageId, username: a.username }));
    root.appendChild(line);
  }
  if (replyAlerts.length) {
    const foot = document.createElement("p");
    foot.className = "note";
    foot.textContent = tr("Your conversations with other pages are on voi.ci.");
    root.appendChild(foot);
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
  renderCounts();
}

async function enterSocial(which) {
  if (which) side = which === "messages" ? "inbox" : SIDES.includes(which) ? which : "profile";
  resetProfileEdit();
  show("view-messages");
  if (!world.pageLoaded) {
    $("social-profile").innerHTML = skeletonCards(2);
    $("messages-list").innerHTML = skeletonCards(2);
    renderHead();
    renderSides();
  } else renderMessages();
  void refreshReplyAlerts();
  await refreshWorld();
  renderMessages();
}

/** The tab as the bar opens it (and the `messages` deep link): the side last shown, Inbox for a deep link. */
export async function enterMessages({ side: which } = {}) {
  await enterSocial(which);
}

/** Home's and Settings' way to the page: the tab's Profile. */
export async function enterYourPage() {
  await enterSocial("profile");
  window.scrollTo({ top: 0 });
}

function updateBadge(c = currentCounts()) {
  const badge = $("messages-tab-badge");
  if (!badge) return;
  const n = c.total;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.classList.toggle("hidden", n === 0);
}

// ── Social options → Websites you're signed in to ───────────────────────────

export async function enterSignedInSites() {
  show("view-signed-in-sites");
  const root = $("signed-in-sites-content");
  root.innerHTML = skeletonCards(2);
  await refreshWorld();
  renderSignedInSites();
}

function renderSignedInSites() {
  const root = $("signed-in-sites-content");
  if (!root) return;
  const sites = [...world.state.signedInSites].sort((a, b) => b.at - a.at);
  const names = new Map(visitedPages().map((p) => [p.pageId, p.username]));
  root.innerHTML = `
    <div class="card stack-sm" data-testid="messages-signed-in-sites">
      ${sites.length
        ? sites
            .map(
              (s) => `<div class="row" data-site-row="${escapeHtml(s.pageId)}"><span>${escapeHtml(names.has(s.pageId) ? tr("voi.ci/{0}, since {1}", names.get(s.pageId), formatWhen(s.at)) : tr("A voi.ci page, since {0}", formatWhen(s.at)))}</span>
              <button type="button" class="secondary" data-site-signout="${escapeHtml(s.delegatePub)}">${escapeHtml(tr("Sign out"))}</button></div>`,
            )
            .join("")
        : `<p class="note">${escapeHtml(tr("You aren't signed in to any website."))}</p>`}
      <button type="button" class="secondary full-width" id="messages-approve-sign-in">${escapeHtml(tr("Approve a voi.ci sign-in"))}</button>
    </div>`;
  // A page this account knows can be called from here (a voi.ci tab takes the call).
  const called = new Set();
  root.querySelectorAll("[data-site-row]").forEach((row) => {
    const pageId = row.getAttribute("data-site-row");
    if (!names.has(pageId) || called.has(pageId)) return;
    called.add(pageId);
    row.insertBefore(callButtons({ pageId, username: names.get(pageId) }), row.lastElementChild);
  });
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
      renderSignedInSites();
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
}

const typingInProfile = () => {
  const a = document.activeElement;
  return isEditingField() && !!a && !!$("social-profile")?.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName);
};

export function initMessagesView() {
  for (const b of document.querySelectorAll("[data-social-side]")) {
    b.addEventListener("click", () => {
      const want = b.getAttribute("data-social-side");
      side = SIDES.includes(want) ? want : "profile";
      renderMessages();
    });
  }
  $("signed-in-sites-back")?.addEventListener("click", () => void enterMessages());
  $("social-call-button")?.addEventListener("click", () => void import("./calls.js").then((m) => m.enterCalls()));
  // A publish, a draft or a refresh elsewhere: draw again (the field being typed in is kept).
  onWorldChange(() => {
    updateBadge();
    setTimeout(() => {
      if ($("view-messages")?.classList.contains("hidden")) return;
      if (typingInProfile()) {
        renderHead();
        renderBar();
        return;
      }
      renderMessages();
    }, 0);
  });
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
