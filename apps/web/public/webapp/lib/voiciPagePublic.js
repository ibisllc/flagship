// The page's Public switch (docs/voici-and-messages.md §3.3, §11.1): what this device remembers about it. Pure
// helpers over a Storage (localStorage by default), so the Messages header, the editor and Home agree:
//
//   * the one-time "everything is public" warning, per account, on this device;
//   * the removed page's content: `.com` deletes every piece when the owner turns the page off, so the device that
//     removed it keeps the profile, posts and images it had published, to publish them again when it's turned on.
//     Only what was already public goes here; drafts never do.
//   * what Home shows: the full welcome card, the compact row, or nothing.

import { b64Decode, b64Encode } from "./voiciProtocol.js";

const WARNED = "flagship.voici.publicWarned.v1:";
const REMOVED = "flagship.voici.removedPage.v1:";

const store = (s) => s ?? globalThis.localStorage;
const key = (prefix, username) => prefix + String(username ?? "").toLowerCase();

function get(s, k) {
  try {
    return store(s)?.getItem(k) ?? null;
  } catch {
    return null;
  }
}
function set(s, k, v) {
  try {
    if (v === null) store(s)?.removeItem(k);
    else store(s)?.setItem(k, v);
    return true;
  } catch {
    return false;
  }
}

export function hasSeenPublicWarning(username, s) {
  return get(s, key(WARNED, username)) === "1";
}

export function markPublicWarningSeen(username, s) {
  set(s, key(WARNED, username), "1");
}

/** The images a published page shows: its avatar and its link cards' images. */
function shownImages(page) {
  const out = new Set();
  if (page.profile?.avatar) out.add(page.profile.avatar);
  for (const posts of page.chunks ?? []) for (const p of posts) for (const l of p.links ?? []) if (l.card?.image) out.add(l.card.image);
  return out;
}

/** Keeps the published page `page` ({index, profile, acceptsMessages, chunks, issuedAt, pieces}) after its removal at `seq`. */
export function saveRemovedSnapshot(username, page, seq, s) {
  if (!page?.index) return false;
  const images = {};
  for (const sha of shownImages(page)) {
    const bytes = page.pieces?.get?.(sha);
    if (bytes instanceof Uint8Array) images[sha] = b64Encode(bytes);
  }
  const snap = {
    v: 1,
    pageId: page.index.pageId,
    seq,
    inboxEpoch: page.index.inboxEpoch,
    profile: page.profile,
    acceptsMessages: page.acceptsMessages ? 1 : 0,
    chunks: page.chunks ?? [],
    issuedAt: page.issuedAt ?? 0,
    images,
  };
  if (set(s, key(REMOVED, username), JSON.stringify(snap))) return true;
  // Too big for this browser's storage: keep the words, drop the pictures.
  return set(s, key(REMOVED, username), JSON.stringify({ ...snap, images: {}, profile: { ...snap.profile, avatar: null } }));
}

/** The removed page as a publish base (voiciOwner.publishVoiciPage `removed`), or null. */
export function loadRemovedSnapshot(username, s) {
  const raw = get(s, key(REMOVED, username));
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw);
    if (snap?.v !== 1 || !/^[0-9a-f]{32}$/.test(snap.pageId) || !Number.isSafeInteger(snap.seq) || !snap.profile) return null;
    const pieces = new Map(Object.entries(snap.images ?? {}).map(([sha, b]) => [sha, b64Decode(b)]));
    return {
      profile: snap.profile,
      acceptsMessages: snap.acceptsMessages ? 1 : 0,
      chunks: Array.isArray(snap.chunks) ? snap.chunks : [],
      issuedAt: snap.issuedAt ?? 0,
      pieces,
      index: { pageId: snap.pageId, seq: snap.seq, inboxEpoch: Number.isSafeInteger(snap.inboxEpoch) ? snap.inboxEpoch : 1, pieces: [] },
    };
  } catch {
    return null;
  }
}

export function clearRemovedSnapshot(username, s) {
  set(s, key(REMOVED, username), null);
}

/**
 * Home's pointer to the page (§11.1): "card" (the short welcome, until the page is first published or the card is
 * dismissed), "row" (the compact "Your page" row after that), or null (no account, `.com` hasn't answered, or a
 * sample account, which can't publish).
 */
export function pageHomeState({ hasAccount, checked, published, removed, pendingChanges, dismissed } = {}) {
  if (!hasAccount || !checked) return null;
  if (published || removed || pendingChanges || dismissed === "true" || dismissed === true) return "row";
  return "card";
}

/** The Public switch: on, and whether this device may flip it. */
export function publicSwitchState({ published, canPublish, busy = false }) {
  return { on: Boolean(published), disabled: !canPublish || busy };
}
