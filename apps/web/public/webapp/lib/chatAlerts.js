// App chat between owners (N08, packages/server-daemon/src/chat/approvals.ts). A box holds a chat
// request from another owner's app (incoming), or from one of its own apps to another owner's app
// (outgoing), until an admin answers. The webapp lists them under Activity, next to Server approvals,
// and asks about each in a sheet like an internet-access request: on load, on focus, after a
// notification click (the box's content-free `generic` push) and on the screens socket's
// `chat-request` event. Allow / Always allow / Deny is an owner-signed `flagship/chat-approval/v1`
// (lib/chatApproval.js); ending an Always allow needs the session alone.
//
// The sender's name is a claim the remote machine makes, never an identity, so every sentence says so.

import { boxClient, getPodBaseUrl } from "./api.js";
import { loadAccountPods, sessionServers } from "./appPlacement.js";
import { getSession } from "./state.js";
import { sensitiveSigner } from "./adminRoot.js";
import { chatAnswerBody } from "./chatApproval.js";
import { isCompanionProfile } from "./companionGuard.js";
import { canSignAdminOrders } from "./addServerGate.js";
import { pushNotificationsEnabled } from "./pushSetting.js";
import { ACCESS_SW_MESSAGE, SCREENS_EVENT, createAccessAlertController } from "./accessAlerts.js";
import { podShortName } from "./podSwitcher.js";
import { toast } from "./toast.js";
import { humanError } from "./humanError.js";
import { escapeHtml } from "./util.js";
import { tr, trn } from "./i18n.js";

export const CHAT_REQUESTS_PATH = "/api/screens/chat/requests";
export const CHAT_ANSWER_PATH = "/api/screens/chat/answer";
export const CHAT_REVOKE_PATH = "/api/screens/chat/always/revoke";
export const CHAT_EVENT = "chat-request";

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const app = (a) => (a && typeof a.author === "string" && typeof a.slug === "string" ? { author: a.author, slug: a.slug } : null);

/** The box's `{requests, always}`, kept to well-formed entries. */
export function readChatRequests(body) {
  const requests = (Array.isArray(body?.requests) ? body.requests : [])
    .map((r) => {
      const sender = app(r?.claimedSender);
      const receiver = app(r?.receiverApp);
      if (typeof r?.requestId !== "string" || !r.requestId || (r.kind !== "incoming" && r.kind !== "outgoing") || !sender || !receiver) return null;
      return {
        requestId: r.requestId,
        kind: r.kind,
        claimedSender: sender,
        receiverApp: receiver,
        ...(typeof r.phrase === "string" && r.phrase ? { phrase: r.phrase } : {}),
        count: Number.isSafeInteger(r.count) && r.count > 0 ? r.count : 1,
        at: typeof r.at === "number" ? r.at : 0,
      };
    })
    .filter(Boolean);
  const always = (Array.isArray(body?.always) ? body.always : []).map(app).filter((a) => a && NAME.test(a.author) && NAME.test(a.slug));
  return { requests, always };
}

/** Every server this device has a session for, each entry tagged with its `serverDomain`. A server that can't be reached is left out. */
export async function fetchChatOnServers(servers) {
  const lists = await Promise.all(
    (servers ?? []).map(async (s) => {
      try {
        const { requests, always } = readChatRequests(await s.fetchJson(CHAT_REQUESTS_PATH));
        return { requests: requests.map((r) => ({ ...r, serverDomain: s.fqdn })), always: always.map((a) => ({ ...a, serverDomain: s.fqdn })) };
      } catch {
        return { requests: [], always: [] };
      }
    }),
  );
  return { requests: lists.flatMap((l) => l.requests), always: lists.flatMap((l) => l.always) };
}

export const chatRequestKey = (r) => `${r.serverDomain ?? ""}\nchat\n${r.kind}\n${r.requestId}`;

/** The sentence for one request. Incoming: the sender is another owner's machine; outgoing: one of this owner's apps asks to reach out. */
export function chatRequestTitle(r) {
  const s = r.claimedSender;
  const t = r.receiverApp;
  if (r.kind === "incoming") return tr("A remote machine claiming to run {0}/{1} wants to start a chat with your app {2}.", s.author, s.slug, t.slug);
  return tr("Your app {0} wants to start a chat with {1}/{2}, an app on another owner's server.", s.slug, t.author, t.slug);
}

/** The lines under the title: what the name means, the phrase, how many times. */
export function chatRequestNotes(r) {
  const out = [];
  if (r.kind === "incoming") out.push(tr("Flagship can't confirm who runs that machine. Only allow it if you expected this app to get in touch."));
  else out.push(tr("Allowing it lets your app send messages to that app and read its answers."));
  if (r.phrase) out.push(tr("The sender's recognition phrase: {0}", r.phrase));
  if (r.count > 1) out.push(trn(r.count, "It asked {0} time.", "It asked {0} times."));
  return out;
}

export const CHAT_ALWAYS_NOTE = (slug) => tr("Always allow lets any remote machine start a chat with {0} without asking you. You can stop this under Activity.", slug);
export const CHAT_ALWAYS_LINE = (slug) => tr("Any remote machine can start a chat with {0} without asking you.", slug);

export function chatAnsweredText(r, decision) {
  if (decision === "deny") return tr("Chat request denied");
  if (decision === "always") return tr("{0} now accepts chats without asking", r.receiverApp.slug);
  return tr("Chat request allowed");
}

/** Answer one request on the server that holds it, signed with this session's sensitive-order key. */
export async function answerChatRequest(r, decision, { client = boxClient(r.serverDomain || ""), sign, now = Date.now } = {}) {
  const session = getSession();
  if (!session?.umk) throw new Error(tr("Unlock the webapp first"));
  const signer = sign ?? ((bytes) => sensitiveSigner()(session.umk, bytes));
  const serverDomain = client.fqdn || r.serverDomain;
  const body = await chatAnswerBody({ serverDomain, requestId: r.requestId, kind: r.kind, decision, issuedAt: now() }, signer);
  return client.fetch(CHAT_ANSWER_PATH, { method: "POST", body: JSON.stringify(body) });
}

/** End an Always allow for one of this server's apps. */
export async function revokeChatAlways(a, { client = boxClient(a.serverDomain || "") } = {}) {
  return client.fetch(CHAT_REVOKE_PATH, { method: "POST", body: JSON.stringify({ author: a.author, slug: a.slug }) });
}

function chatError(e) {
  const reason = e?.body && typeof e.body === "object" && typeof e.body.error === "string" ? e.body.error : "";
  if (e?.status === 404) return tr("That request is no longer waiting.");
  if (e?.status === 409) return tr("That request was already answered.");
  if (e?.status === 403) return tr("Only an admin device can answer chat requests.");
  return reason || humanError(e);
}

// ───────────────────────────── the sheet ─────────────────────────────

function openSheet(html) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `<div class="modal-card" role="document">${html}</div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      if (!document.querySelector(".modal-overlay")) document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close("later");
      }
    };
    overlay.querySelectorAll("[data-choice]").forEach((b) => b.addEventListener("click", () => close(b.getAttribute("data-choice"))));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close("later");
    });
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => overlay.querySelector('[data-choice="deny"]')?.focus({ preventScroll: true }));
  });
}

/** Allow / Always allow (incoming only) / Deny / Not now. Resolves to the choice. */
export function showChatRequestSheet(r) {
  const notes = chatRequestNotes(r).map((n) => `<p class="modal-message">${escapeHtml(n)}</p>`).join("");
  return openSheet(`
    <h3 class="modal-title" data-chat-sheet>${escapeHtml(chatRequestTitle(r))}</h3>
    ${notes}
    ${r.kind === "incoming" ? `<p class="note">${escapeHtml(CHAT_ALWAYS_NOTE(r.receiverApp.slug))}</p>` : ""}
    <div class="row-2 mt-3">
      <button class="secondary" data-choice="deny">${escapeHtml(tr("Deny"))}</button>
      <button data-choice="allow">${escapeHtml(tr("Allow"))}</button>
    </div>
    ${r.kind === "incoming" ? `<button class="secondary full-width mt-2" data-choice="always">${escapeHtml(tr("Always allow"))}</button>` : ""}
    <div class="access-sheet-later mt-2"><button class="linklike" data-choice="later">${escapeHtml(tr("Not now"))}</button></div>
  `);
}

// ───────────────────────────── Activity's list ─────────────────────────────

function requestCardHtml(r, i, canAnswer, multi) {
  const notes = chatRequestNotes(r).map((n) => `<p class="note small">${escapeHtml(n)}</p>`).join("");
  const server = multi ? `<p class="note small">${escapeHtml(podShortName(r.serverDomain))}</p>` : "";
  const buttons = canAnswer
    ? `<div class="row-2 mt-2">
        <button class="secondary" data-chat-answer="deny" data-chat-i="${i}">${escapeHtml(tr("Deny"))}</button>
        <button data-chat-answer="allow" data-chat-i="${i}">${escapeHtml(tr("Allow"))}</button>
      </div>
      ${r.kind === "incoming" ? `<button class="secondary full-width mt-2" data-chat-answer="always" data-chat-i="${i}">${escapeHtml(tr("Always allow"))}</button>` : ""}`
    : `<p class="note small">${escapeHtml(tr("Only an admin device can answer chat requests."))}</p>`;
  return `<div class="card" data-chat-request="${escapeHtml(r.requestId)}">
    <p class="value">${escapeHtml(chatRequestTitle(r))}</p>
    ${server}${notes}${buttons}
  </div>`;
}

function alwaysCardHtml(a, i, multi) {
  return `<div class="card" data-chat-always="${escapeHtml(`${a.author}/${a.slug}`)}">
    <p class="value">${escapeHtml(CHAT_ALWAYS_LINE(a.slug))}</p>
    ${multi ? `<p class="note small">${escapeHtml(podShortName(a.serverDomain))}</p>` : ""}
    <button class="secondary full-width mt-2" data-chat-revoke="${i}">${escapeHtml(tr("Ask me each time"))}</button>
  </div>`;
}

/**
 * Fill Activity's App chat section (`#activity-chat`): the waiting requests with their answers, then
 * the apps that take chats without asking, each with Ask me each time. Hidden when there is neither.
 */
export async function renderChatSection({ section = document.getElementById("activity-chat"), servers } = {}) {
  if (!section) return;
  const content = section.querySelector("#activity-chat-content");
  if (!content) return;
  if (isCompanionProfile()) {
    section.hidden = true;
    return;
  }
  const list = servers ?? sessionServers(await loadAccountPods(getSession()?.username));
  const { requests, always } = await fetchChatOnServers(list);
  if (requests.length === 0 && always.length === 0) {
    section.hidden = true;
    content.innerHTML = "";
    return;
  }
  const multi = new Set([...requests, ...always].map((x) => x.serverDomain)).size > 1;
  const canAnswer = canSignAdminOrders();
  content.innerHTML = `
    ${requests.length ? requests.map((r, i) => requestCardHtml(r, i, canAnswer, multi)).join("") : `<div class="card placeholder">${escapeHtml(tr("No chat requests are waiting."))}</div>`}
    ${always.length ? `<h3 class="mt-3" id="activity-chat-always-heading">${escapeHtml(tr("Apps that take chats without asking"))}</h3>${always.map((a, i) => alwaysCardHtml(a, i, multi)).join("")}` : ""}
  `;
  section.hidden = false;
  content.querySelectorAll("[data-chat-answer]").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = requests[Number(b.getAttribute("data-chat-i"))];
      const decision = b.getAttribute("data-chat-answer");
      if (!r) return;
      content.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        await answerChatRequest(r, decision);
        toast(chatAnsweredText(r, decision), "ok");
      } catch (e) {
        toast(chatError(e), "err");
      }
      await renderChatSection({ section, servers: list });
    }),
  );
  content.querySelectorAll("[data-chat-revoke]").forEach((b) =>
    b.addEventListener("click", async () => {
      const a = always[Number(b.getAttribute("data-chat-revoke"))];
      if (!a) return;
      b.disabled = true;
      try {
        await revokeChatAlways(a);
        toast(tr("{0} asks you again before taking a chat", a.slug), "ok");
      } catch (e) {
        toast(chatError(e), "err");
      }
      await renderChatSection({ section, servers: list });
    }),
  );
}

// ───────────────────────────── the shell ─────────────────────────────

/** Ask about each waiting request in a sheet; nothing over the lock, on a companion, on a device that can't sign, or with Push notifications off. */
export function startChatAlerts({ isUnlocked }) {
  const isActive = () => {
    try {
      return isUnlocked() && pushNotificationsEnabled() && !isCompanionProfile() && canSignAdminOrders() && !!getPodBaseUrl() && !!getSession()?.umk;
    } catch {
      return false;
    }
  };
  const refreshActivity = () => {
    const section = document.getElementById("activity-chat");
    const view = document.getElementById("view-activity");
    if (section && view && !view.classList.contains("hidden")) void renderChatSection({ section }).catch(() => {});
  };
  const controller = createAccessAlertController({
    isActive,
    keyOf: chatRequestKey,
    fetchRequests: async () => (await fetchChatOnServers(sessionServers(await loadAccountPods(getSession()?.username)))).requests,
    handle: async (r) => {
      const choice = await showChatRequestSheet(r);
      if (choice !== "allow" && choice !== "always" && choice !== "deny") return "later";
      try {
        await answerChatRequest(r, choice);
      } catch (e) {
        toast(chatError(e), "err");
        return "failed";
      }
      toast(chatAnsweredText(r, choice), "ok");
      refreshActivity();
      return choice;
    },
  });
  const poke = (force = false) => void controller.check({ force });
  document.addEventListener(SCREENS_EVENT, (ev) => {
    if (ev.detail?.type !== CHAT_EVENT) return;
    poke(true);
    refreshActivity();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poke();
  });
  window.addEventListener("focus", () => poke());
  document.addEventListener("flagship:view-shown", () => poke());
  try {
    navigator.serviceWorker?.addEventListener("message", (ev) => {
      if (ev.data?.type === ACCESS_SW_MESSAGE) poke(true);
    });
  } catch {
    /* no service worker */
  }
  poke();
  return { controller, check: (force = true) => poke(force) };
}
