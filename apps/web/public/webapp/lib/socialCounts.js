// The red counts on the Social page (docs/social-tabs.md): Profile, Inbox, Requests, the floating call button, and
// their total on the Social tab. Every count comes from what the webapp already holds; the "seen" markers (calls,
// profile) are this browser's own, per account, in localStorage, never sent anywhere. Mirrors iOS SocialBadges.swift.
//
//   socialCounts({ inboxUnread, requests, replyAlerts, missedSince })   -> { profile, inbox, requests, calls, total }
//   unseenMissed(history, seenAt)                                        -> missed incoming calls newer than seenAt
//   callsSeenAt(deps?) / markCallsSeen(deps?) / markProfileSeen(deps?)

import { getSession } from "./state.js";

const key = (what, account) => `flagship.social.${what}SeenAt.${account}`;
const accountOf = (deps) => String((deps.session ?? getSession())?.username ?? "").toLowerCase();

function read(what, deps = {}) {
  try {
    const n = Number((deps.storage ?? globalThis.localStorage)?.getItem(key(what, accountOf(deps))) ?? 0);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function mark(what, deps = {}) {
  const account = accountOf(deps);
  if (!account) return;
  try {
    (deps.storage ?? globalThis.localStorage)?.setItem(key(what, account), String((deps.now ?? Date.now)()));
  } catch {
    /* private window: the count simply stays */
  }
}

/** Missed incoming calls newer than `seenAt` (call-history rows, lib/voiciCallOut.js callHistory). */
export function unseenMissed(history, seenAt = 0) {
  return (Array.isArray(history) ? history : []).filter((r) => r?.direction === "in" && r.outcome === "missed" && r.at > seenAt).length;
}

/**
 * The four counts and their total. Profile counts new comments and reactions on the owner's posts, which are not
 * built yet (docs/social-tab.md §3.3), so it is 0 until they are. Inbox counts unread conversations and replies
 * waiting on pages this account wrote to.
 */
export function socialCounts({ inboxUnread = 0, requests = 0, replyAlerts = 0, missedCalls = 0 } = {}) {
  const c = { profile: 0, inbox: inboxUnread + replyAlerts, requests, calls: missedCalls };
  return { ...c, total: c.profile + c.inbox + c.requests + c.calls };
}

export const callsSeenAt = (deps) => read("calls", deps);
export const markCallsSeen = (deps) => mark("calls", deps);
export const markProfileSeen = (deps) => mark("profile", deps);
