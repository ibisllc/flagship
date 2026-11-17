// Calls and social entries on the Activity tab (docs/activity-social.md). Built in this browser each time Activity
// draws, from what it already holds: the call history (lib/voiciCallOut.js callHistory), the conversations and the
// published page (lib/voiciWorld.js). Nothing is stored or sent for it, so deleting a conversation (which drops its
// messages, missed calls and placed calls on every device) removes its entries too. Mirrors iOS SocialActivity.swift
// and Android SocialActivity.kt (parity row activity-social).
//
//   buildSocialActivity({ history, conversations, isRequest, name, page }) -> [{id, kind, at, name, snippet, video, target}]
//   socialEntryTitle(e) / socialEntryDetail(e) / socialEntryIcon(e)
//
// kind: "call.missed" | "call.declined" | "call.answered" | "call.placed" | "conversation.new" |
// "conversation.request" | "page.published" | "page.updated" | "post.published". Comments and reactions are not built
// yet (docs/social-tab.md §3.3); when they are, "comment.new" and "reaction.new" join here.
// target: {kind: "thread", conv} | {kind: "calls"} | {kind: "page"}.

import { tr } from "./i18n.js";

/** A post's first line, shortened to 80 characters. */
export function postSnippet(text) {
  const line = String(text ?? "").split(/\r?\n/)[0].trim();
  if (!line) return null;
  const chars = [...line];
  return chars.length > 80 ? chars.slice(0, 79).join("") + "…" : line;
}

/**
 * Every entry, newest first. `conversations` are the ones Inbox and Requests show (deleted, archived and blocked ones
 * are left out); `page` is the published page (world.page: {index, chunks, issuedAt}) or null while it isn't public.
 */
export function buildSocialActivity({ history = [], conversations = [], isRequest = () => false, name = (p) => p, page = null } = {}) {
  const out = [];
  const convs = new Set(conversations.map((c) => c.conv));
  for (const r of history) {
    if (!r || typeof r.at !== "number") continue;
    const kind =
      r.direction === "out" ? "call.placed" : r.outcome === "answered" ? "call.answered" : r.outcome === "declined" ? "call.declined" : "call.missed";
    const peer = r.peer ?? {};
    const who =
      peer.kind === "page" ? String(peer.username ?? "") : peer.anonymous || !peer.pseudonymPub ? tr("Anonymous caller") : name(peer.pseudonymPub);
    const target = peer.kind === "visitor" && convs.has(peer.conv) ? { kind: "thread", conv: peer.conv } : { kind: "calls" };
    out.push({ id: `call:${r.id}`, kind, at: r.at, name: who, snippet: null, video: !!r.video, target });
  }
  for (const c of conversations) {
    const first = c.messages.find((m) => !m.mine) ?? c.messages[0];
    if (!first) continue;
    out.push({
      id: `conv:${c.conv}`,
      kind: isRequest(c) ? "conversation.request" : "conversation.new",
      at: first.sentAt,
      name: name(c.pseudonymPub),
      snippet: null,
      video: false,
      target: { kind: "thread", conv: c.conv },
    });
  }
  if (page?.index) {
    out.push({
      id: `page:${page.index.seq}`,
      kind: page.index.seq <= 1 ? "page.published" : "page.updated",
      at: page.index.issuedAt,
      name: "",
      snippet: null,
      video: false,
      target: { kind: "page" },
    });
    for (const p of (page.chunks ?? []).flat()) {
      out.push({ id: `post:${p.id}`, kind: "post.published", at: p.createdAt, name: "", snippet: postSnippet(p.text), video: false, target: { kind: "page" } });
    }
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function socialEntryTitle(e) {
  switch (e.kind) {
    case "call.missed":
      return tr("Missed call from {0}", e.name);
    case "call.declined":
      return tr("Declined a call from {0}", e.name);
    case "call.answered":
      return tr("Call with {0}", e.name);
    case "call.placed":
      return tr("You called {0}", e.name);
    case "conversation.new":
      return tr("New conversation with {0}", e.name);
    case "conversation.request":
      return tr("Message request from {0}", e.name);
    case "page.published":
      return tr("Your page went public");
    case "page.updated":
      return tr("Your page was updated");
    default:
      return tr("You posted on your page");
  }
}

export function socialEntryDetail(e) {
  if (e.kind === "post.published") return e.snippet ?? "";
  return e.video ? tr("Video call") : "";
}

const ICONS = {
  "call.missed": "📵",
  "call.declined": "📵",
  "call.answered": "📞",
  "call.placed": "📞",
  "conversation.new": "💬",
  "conversation.request": "📥",
  "page.published": "🌐",
  "page.updated": "🌐",
  "post.published": "📝",
};

export function socialEntryIcon(e) {
  return ICONS[e.kind] ?? "•";
}
