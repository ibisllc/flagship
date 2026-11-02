// One conversation with a visitor (docs/voici-and-messages.md §7.3, §7.4, §9.1, §9.2, §11.1). Bubbles are text only:
// each run of text is a text node, and a link the shared matcher finds is a button that asks "Open <host>?" with
// the full address before anything leaves the app. Nothing a visitor wrote is ever parsed as HTML (§12.1).

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { formatWhen } from "../lib/dateFormat.js";
import { inlineChoice, inlineConfirm, inlinePrompt } from "../lib/modal.js";
import { findVoiciLinks, prepareVoiciText, VOICI_REPORT_REASONS } from "../lib/voiciProtocol.js";
import { isRequest, postBlock, postMessageReport, sendReply } from "../lib/voiciOwner.js";
import { changeState, emitWorld, findConversation, refreshWorld, visitorName, world } from "../lib/voiciWorld.js";
import { voiciErrorText, voiciTextProblem } from "../lib/voiciCopy.js";

import { tr } from "../lib/i18n.js";

registerView("view-thread", { tab: "messages" });

let openConv = null;

const REASON_LABEL = {
  spam: () => tr("Spam"),
  harassment: () => tr("Harassment"),
  impersonation: () => tr("Pretending to be someone"),
  illegal: () => tr("Illegal content"),
  other: () => tr("Something else"),
};

/** A message's text as DOM: text nodes, and a confirm-first button per link. */
export function messageNodes(text, onLink) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const l of findVoiciLinks(text)) {
    if (l.start > at) frag.appendChild(document.createTextNode(text.slice(at, l.start)));
    const b = document.createElement("button");
    b.type = "button";
    b.className = "msg-link";
    b.textContent = text.slice(l.start, l.end);
    b.title = l.host;
    b.setAttribute("data-msg-link", l.url);
    b.addEventListener("click", () => onLink(l));
    frag.appendChild(b);
    at = l.end;
  }
  if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
  return frag;
}

async function openLink(l) {
  const ok = await inlineConfirm({ title: tr("Open {0}?", l.host), message: l.url, okLabel: tr("Open") });
  if (ok) window.open(l.url, "_blank", "noopener,noreferrer");
}

function statusFor(m) {
  if (m.fetchedAt) return tr("Delivered");
  return tr("Sent");
}

function render() {
  const cv = findConversation(openConv);
  const list = $("thread-list");
  if (!cv || !list) return;
  $("thread-title").textContent = visitorName(cv.pseudonymPub);
  const notice = $("thread-notice");
  notice.replaceChildren();
  if (cv.gap) {
    const p = document.createElement("p");
    p.className = "note";
    p.setAttribute("data-testid", "thread-gap");
    p.textContent = tr("Some messages haven't arrived yet");
    notice.appendChild(p);
  }
  if (isRequest(cv, world.state)) {
    const card = document.createElement("div");
    card.className = "card stack-sm";
    card.setAttribute("data-testid", "thread-request");
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = tr("This is a message request. Reply or accept it to move it to Messages.");
    const accept = document.createElement("button");
    accept.type = "button";
    accept.id = "thread-accept";
    accept.textContent = tr("Accept");
    accept.addEventListener("click", () => void acceptConv());
    card.append(p, accept);
    notice.appendChild(card);
  }
  list.replaceChildren();
  const lastMine = [...cv.messages].reverse().find((m) => m.mine);
  for (const m of cv.messages) {
    const row = document.createElement("div");
    row.className = `msg ${m.mine ? "msg-mine" : "msg-theirs"}`;
    row.setAttribute("data-msg", m.msgId);
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.appendChild(messageNodes(m.text, openLink));
    const meta = document.createElement("div");
    meta.className = "msg-meta muted-sm";
    meta.textContent = formatWhen(m.sentAt);
    row.append(bubble, meta);
    if (m === lastMine) {
      const st = document.createElement("div");
      st.className = "msg-status muted-sm";
      st.setAttribute("data-testid", "thread-status");
      st.textContent = statusFor(m);
      row.appendChild(st);
    }
    if (!m.mine) {
      const rep = document.createElement("button");
      rep.type = "button";
      rep.className = "ghost msg-report";
      rep.setAttribute("data-msg-report", m.msgId);
      rep.textContent = tr("Report");
      rep.addEventListener("click", () => void report(m));
      row.appendChild(rep);
    }
    list.appendChild(row);
  }
  renderCompose();
}

function renderCompose() {
  const root = $("thread-compose");
  if (root.dataset.wired === "1") return;
  root.dataset.wired = "1";
  root.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.id = "thread-input";
  ta.rows = 2;
  ta.placeholder = tr("Write a reply");
  ta.setAttribute("aria-label", tr("Write a reply"));
  const counter = document.createElement("span");
  counter.className = "muted-sm";
  counter.id = "thread-counter";
  const send = document.createElement("button");
  send.type = "button";
  send.id = "thread-send";
  send.textContent = tr("Send");
  const count = () => {
    const n = [...ta.value.normalize("NFC")].length;
    counter.textContent = n > 1800 ? `${n} / 2000` : "";
  };
  ta.addEventListener("input", count);
  send.addEventListener("click", () => void reply(ta, send));
  root.append(ta, counter, send);
}

async function reply(ta, btn) {
  const cv = findConversation(openConv);
  if (!cv || !world.page) return;
  const prepared = prepareVoiciText("messageText", ta.value);
  if (!prepared.ok) return void toast(voiciTextProblem(prepared.code, 2000), "err");
  btn.disabled = true;
  try {
    const env = await sendReply(world.page, cv, prepared.text);
    cv.messages.push({ msgId: env.msgId, seq: env.seq, sentAt: env.sentAt, mine: true, text: prepared.text, envelope: env, fetchedAt: null, direct: false });
    ta.value = "";
    emitWorld();
    render();
  } catch (e) {
    toast(voiciErrorText(e), "err");
  } finally {
    btn.disabled = false;
  }
}

async function acceptConv() {
  const cv = findConversation(openConv);
  if (!cv) return;
  try {
    // `.com` can't read the sealed state: a signed `unblock` order is its Accept (it lifts the awaiting-reply cap).
    if (world.page) await postBlock(world.page, cv.pseudonymPub, "unblock");
    await changeState((s) => ({ ...s, accepted: [...new Set([...s.accepted, cv.conv])].sort() }));
  } catch (e) {
    toast(voiciErrorText(e), "err");
  }
  render();
}

async function rename() {
  const cv = findConversation(openConv);
  if (!cv) return;
  const name = await inlinePrompt({
    title: tr("Rename"),
    message: tr("Only you see this name. It syncs to your other devices."),
    initial: world.state.nicknames[cv.pseudonymPub]?.name ?? "",
    okLabel: tr("Save"),
    validate: (v) => {
      const p = prepareVoiciText("nickname", v);
      return p.ok ? "" : voiciTextProblem(p.code, 40);
    },
  });
  if (name === null || name === undefined) return;
  const p = prepareVoiciText("nickname", name);
  if (!p.ok) return;
  try {
    await changeState((s) => ({ ...s, nicknames: { ...s.nicknames, [cv.pseudonymPub]: { name: p.text, at: Date.now() } } }));
  } catch (e) {
    toast(voiciErrorText(e), "err");
  }
  render();
}

async function block() {
  const cv = findConversation(openConv);
  if (!cv || !world.page) return;
  const ok = await inlineConfirm({
    title: tr("Block {0}?", visitorName(cv.pseudonymPub)),
    message: tr("You won't get messages from them on this page. They aren't told."),
    okLabel: tr("Block"),
    danger: true,
  });
  if (!ok) return;
  try {
    await postBlock(world.page, cv.pseudonymPub, "block");
    await changeState((s) => ({ ...s, blocks: [...new Set([...s.blocks, cv.pseudonymPub])].sort() }));
    toast(tr("Blocked."));
    await leave();
  } catch (e) {
    toast(voiciErrorText(e), "err");
  }
}

async function report(m) {
  if (!world.page) return;
  const reason = await inlineChoice({
    title: tr("Report this message?"),
    message: tr("Flagship gets the message and can see which account sent it, not what it says."),
    choices: VOICI_REPORT_REASONS.map((r) => ({ id: r, label: REASON_LABEL[r](), secondary: true })),
  });
  if (!reason) return;
  try {
    await postMessageReport(world.page, m.envelope, reason);
    toast(tr("Reported. Thank you."));
  } catch (e) {
    toast(voiciErrorText(e), "err");
  }
}

async function deleteConv() {
  const cv = findConversation(openConv);
  if (!cv) return;
  const ok = await inlineConfirm({
    title: tr("Delete this conversation?"),
    message: tr("It's removed from your devices."),
    okLabel: tr("Delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await changeState((s) => ({ ...s, archived: [...new Set([...s.archived, cv.conv])].sort() }));
    await leave();
  } catch (e) {
    toast(voiciErrorText(e), "err");
  }
}

async function menu() {
  const cv = findConversation(openConv);
  if (!cv) return;
  const choices = [{ id: "rename", label: tr("Rename"), secondary: true }];
  if (isRequest(cv, world.state)) choices.push({ id: "accept", label: tr("Accept"), secondary: true });
  choices.push({ id: "block", label: tr("Block"), danger: true }, { id: "report", label: tr("Report"), secondary: true }, { id: "delete", label: tr("Delete conversation"), danger: true });
  const pick = await inlineChoice({ title: visitorName(cv.pseudonymPub), choices });
  if (pick === "rename") await rename();
  else if (pick === "accept") await acceptConv();
  else if (pick === "block") await block();
  else if (pick === "delete") await deleteConv();
  else if (pick === "report") {
    const last = [...cv.messages].reverse().find((m) => !m.mine);
    if (last) await report(last);
  }
}

async function leave() {
  openConv = null;
  const { enterMessages } = await import("./messages.js");
  await enterMessages();
}

/** Marks the conversation read up to its newest message (one state write, only when it moved). */
async function markRead(cv) {
  const last = cv.messages[cv.messages.length - 1];
  if (!last || world.state.readUpTo[cv.conv] === last.msgId) return;
  try {
    await changeState((s) => ({ ...s, readUpTo: { ...s.readUpTo, [cv.conv]: last.msgId } }));
  } catch {
    /* read marks are a courtesy */
  }
}

export async function enterThread(conv) {
  if (openConv !== conv && $("thread-input")) $("thread-input").value = "";
  openConv = conv;
  show("view-thread");
  if (!findConversation(conv)) await refreshWorld();
  render();
  const cv = findConversation(conv);
  if (cv) void markRead(cv);
}

export function initThreadView() {
  $("thread-back")?.addEventListener("click", () => void leave());
  $("thread-menu")?.addEventListener("click", () => void menu());
}
